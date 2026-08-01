/**
 * tasks/reportWorker.js — the Research Controller.
 *
 * Runs as a Cloud Task (via createReportJob's enqueue), not inline on the
 * client's request — the full pipeline (plan -> research -> write -> render
 * -> upload) can legitimately take well past what a browser fetch() should
 * be held open for. Receives {reportId, site, nearby} as the task payload
 * (not re-read from Postgres) — the site/nearby the client actually sent is
 * what gets researched, with `reportId` used to resolve the site's row for
 * Evidence Store lookups.
 *
 * Any failure anywhere in the pipeline is caught here, written to the report
 * as a sanitized error, and NOT rethrown — a caught failure marks the task
 * done rather than triggering a Cloud Tasks retry, since retrying a
 * partially-completed AI pipeline risks double-spending Gemini calls rather
 * than fixing whatever actually went wrong.
 */
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const db = require('../lib/db');
const ledger = require('../lib/ledger');
const cache = require('../lib/cache');
const planner = require('../agents/planner');
const context = require('../agents/context');
const writer = require('../agents/writer');
const connectivity = require('../agents/connectivity');
const infrastructure = require('../agents/infrastructure');
const government = require('../agents/government');
const news = require('../agents/news');
const { renderPdf } = require('../report/renderPdf');
const { renderDocx } = require('../report/renderDocx');
const { uploadReportFile } = require('../lib/storage');
const secrets = require('../lib/secrets');

const AGENT_MODULES = { connectivity, infrastructure, government, news };

/** @param {string} reportId @param {string} status @param {object} [fields] */
async function setStatus(reportId, status, fields) {
  await db.updateReportStatus(reportId, status, fields);
  await cache.cacheReportStatus(reportId, { status, ...fields });
}

/**
 * Run one research agent (or reuse a prior run's evidence), recording the
 * agent_runs row either way — this is what makes the Evidence Store
 * complete even when an agent was skipped.
 * @param {string} reportId @param {string} agentName
 * @param {object|null} reusable
 * @param {{site:object, nearby:object}} ctx
 */
async function runOrReuseAgent(reportId, agentName, reusable, ctx) {
  const runId = await db.startAgentRun(reportId, agentName);
  if (reusable) {
    await db.completeAgentRun(runId, 'reused', {
      evidence: reusable.evidence, sources: reusable.sources,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    return;
  }
  try {
    const { evidence, sources, usage } = await AGENT_MODULES[agentName].run(ctx);
    await db.completeAgentRun(runId, 'done', { evidence, sources, usage });
  } catch (e) {
    console.error(`Agent "${agentName}" failed for report ${reportId}:`, e);
    await db.completeAgentRun(runId, 'error', { error: e.message });
  }
}

/** @param {{reportId:string, site:object, nearby:object}} input */
async function runReportPipeline({ reportId, site, nearby }) {
  const report = await db.getReport(reportId);
  if (!report) throw new Error(`Report ${reportId} not found`);
  const siteId = report.site_id;

  await setStatus(reportId, 'planning');
  const agentNames = planner.planAgents();
  const reusable = await context.findReusableEvidence(siteId, agentNames);

  await setStatus(reportId, 'researching');
  await Promise.all(agentNames.map(agentName =>
    runOrReuseAgent(reportId, agentName, reusable[agentName], { site, nearby })
  ));

  const agentRuns = await db.getAgentRuns(reportId);
  const allFailed = agentRuns.length > 0 && agentRuns.every(r => r.status === 'error');
  if (allFailed) {
    await setStatus(reportId, 'error', { error: 'Every research step failed — please try again in a moment.' });
    await ledger.recordReportOutcome(false);
    return;
  }

  await setStatus(reportId, 'writing');
  const document = await writer.run({ site, agentRuns });

  await setStatus(reportId, 'rendering');
  const [pdfBuffer, docxBuffer] = await Promise.all([renderPdf(document), renderDocx(document)]);

  await setStatus(reportId, 'uploading');
  const [pdfResult, docxResult] = await Promise.all([
    uploadReportFile(reportId, 'pdf', pdfBuffer),
    uploadReportFile(reportId, 'docx', docxBuffer),
  ]);

  await setStatus(reportId, 'done', {
    pdf_path: pdfResult.path, docx_path: docxResult.path,
    pdf_url: pdfResult.url, docx_url: docxResult.url,
    expires_at: pdfResult.expiresAt,
  });
  await ledger.recordReportOutcome(true);
}

const reportWorker = onTaskDispatched({
  region: 'asia-south1',
  retryConfig: { maxAttempts: 1 }, // see file header — failures are handled inline, not via Cloud Tasks retry
  rateLimits: { maxConcurrentDispatches: 5 },
  memory: '1GiB',
  timeoutSeconds: 480,
  secrets: secrets.ALL,
}, async (req) => {
  const { reportId, site, nearby } = req.data || {};
  if (!reportId || !site) { console.error('reportWorker: missing reportId/site in task payload', req.data); return; }
  try {
    await runReportPipeline({ reportId, site, nearby: nearby || {} });
  } catch (e) {
    console.error(`reportWorker: report ${reportId} failed:`, e);
    try {
      await setStatus(reportId, 'error', { error: 'Something went wrong generating this report — please try again.' });
      await ledger.recordReportOutcome(false);
    } catch (inner) {
      console.error('reportWorker: failed to record the failure itself:', inner);
    }
  }
});

module.exports = { reportWorker, runReportPipeline };
