/**
 * pipeline/runReport.js — the Research Controller.
 *
 * Runs in the background on this process, started by http/createReportJob.js
 * via lib/jobs.js and never awaited by the request that triggered it — the
 * full pipeline (plan -> research -> write -> render -> store) can
 * legitimately take minutes, well past what a browser fetch() should be held
 * open for. The client polls http/getReportStatus.js instead.
 *
 * Receives {reportId, site, nearby} directly rather than re-reading it from
 * Postgres — the site/nearby the client actually sent is what gets
 * researched, with `reportId` used to resolve the site's row for Evidence
 * Store lookups.
 *
 * Failures are recorded, never rethrown to the caller: there is no caller
 * left. `failReport` is what lib/jobs.js invokes if this throws, and it's
 * exported so that path is the same one used everywhere else.
 */
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
const { saveReportFiles } = require('../lib/storage');

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

  await setStatus(reportId, 'storing');
  const { expiresAt } = await saveReportFiles(reportId, { pdf: pdfBuffer, docx: docxBuffer });

  // The download URLs aren't stored — http/getReportStatus.js builds them per
  // request from its own origin, so they survive a change of host.
  await setStatus(reportId, 'done', { expires_at: expiresAt });
  await ledger.recordReportOutcome(true);
}

/**
 * Record a pipeline failure against the report, so the client's poll gets a
 * real answer instead of a status that never advances. Passed to
 * lib/jobs.js as the error handler for every report job.
 *
 * The user-facing message is deliberately generic — the real error is logged
 * server-side, where it can name an internal service or a prompt, neither of
 * which should reach a browser.
 *
 * @param {string} reportId @param {Error} error
 */
async function failReport(reportId, error) {
  console.error(`report ${reportId} failed:`, error);
  await setStatus(reportId, 'error', { error: 'Something went wrong generating this report — please try again.' });
  await ledger.recordReportOutcome(false);
}

module.exports = { runReportPipeline, failReport };
