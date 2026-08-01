/**
 * agents/context.js — Project Context Agent: decides which research agents
 * can reuse a prior report's evidence for this exact site instead of
 * spending a fresh Gemini call.
 *
 * The staleness window is per agent, not one global number, because "recent
 * enough" means very different things for different topics — a school
 * doesn't relocate in a week, but yesterday's news is not today's news. Keep
 * `news` reuse essentially off; it's the one category where serving stale
 * data silently is worse than spending the extra call.
 */
const db = require('../lib/db');

/** Days a prior successful run of each agent stays reusable for the same site. */
const STALENESS_DAYS = {
  connectivity: 30,
  infrastructure: 30,
  government: 14,
  news: 1,
};

/**
 * @param {string} siteId @param {string[]} agentNames
 * @returns {Promise<Object<string, object|null>>} agentName -> reusable prior
 *   agent_runs row, or null if nothing reusable was found.
 */
async function findReusableEvidence(siteId, agentNames) {
  const out = {};
  await Promise.all(agentNames.map(async agentName => {
    const windowDays = STALENESS_DAYS[agentName];
    if (!windowDays) { out[agentName] = null; return; }
    const prior = await db.mostRecentAgentRun(siteId, agentName);
    if (!prior || !prior.completed_at) { out[agentName] = null; return; }
    const ageMs = Date.now() - new Date(prior.completed_at).getTime();
    out[agentName] = ageMs <= windowDays * 24 * 60 * 60 * 1000 ? prior : null;
  }));
  return out;
}

module.exports = { findReusableEvidence, STALENESS_DAYS };
