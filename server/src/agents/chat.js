/**
 * agents/chat.js — AI Chat Agent.
 *
 * Follow-up questions on a completed report. Answers from the report's
 * Evidence Store first — most follow-ups ("what about the school district",
 * "how far is the airport") are already covered by research that's already
 * been paid for. Only issues a fresh grounded search when the evidence
 * genuinely doesn't cover the question (e.g. "compare this with Pune").
 *
 * The evidence-vs-research decision is made by the model itself via an
 * explicit escape hatch in the prompt (the NEED_RESEARCH sentinel) rather
 * than a separate classifier call — one extra classification step would cost
 * as much as just trying the cheap path first and falling back.
 */
const router = require('../lib/aiRouter');
const db = require('../lib/db');
const { siteLine, areaName, NEWS_DOMAINS, GOV_DOMAINS } = require('./_shared');

const NEED_RESEARCH_SENTINEL = 'NEED_RESEARCH';

/**
 * @param {{reportId:string, message:string}} opts
 * @returns {Promise<{reply:string, researched:boolean}>}
 */
async function answer({ reportId, message }) {
  const report = await db.getReport(reportId);
  if (!report) throw new Error('That report no longer exists.');

  const agentRuns = await db.getAgentRuns(reportId);
  const evidenceBlock = agentRuns
    .filter(r => r.evidence && r.evidence.summary)
    .map(r => `## ${r.agent_name}\n${r.evidence.summary}`)
    .join('\n\n');

  const site = { name: report.site_name || '', lat: report.site_lat, lng: report.site_lng };

  const evidencePrompt = `${siteLine(site)}

Previously gathered research for this site:
${evidenceBlock || '(no research on file)'}

Question: ${message}

Answer the question using only the research above. If — and only if — that research genuinely does not contain enough information to answer, respond with exactly "${NEED_RESEARCH_SENTINEL}" followed by a colon and a one-line reason, and nothing else. Otherwise answer directly and concisely.`;

  const first = await router.ask({ task: 'chat', prompt: evidencePrompt, evidence: false });

  if (!first.text.trim().startsWith(NEED_RESEARCH_SENTINEL)) {
    return { reply: first.text.trim(), researched: false };
  }

  // The escalation is a real web search, not an ungrounded model asked to
  // remember. Both domain lists are offered because a follow-up could be
  // about either a civic project or something in the news.
  const second = await router.ask({
    task: 'chat',
    prompt: siteLine(site),
    evidence: 'web',
    web: {
      question: `${siteLine(site)}\n\nQuestion: ${message}\n\nAnswer concisely using current information. If the sources do not answer it, say so.`,
      query: `${areaName(null, site)} ${message}`,
      domains: [...GOV_DOMAINS.slice(0, 5), ...NEWS_DOMAINS.slice(0, 5)],
      recency: 'year',
    },
  });
  if (second.unsourced) {
    return {
      reply: 'That is not covered by the research on file, and live search is unavailable right now'
        + ' (' + second.unsourced + ').',
      researched: false,
    };
  }
  return { reply: second.text.trim(), researched: true };
}

module.exports = { answer, NEED_RESEARCH_SENTINEL };
