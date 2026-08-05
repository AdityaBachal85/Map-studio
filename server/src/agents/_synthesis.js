/**
 * agents/_synthesis.js — the shared body of every interpretation agent.
 *
 * SWOT, risk, investment, timeline and insights all do the same thing: read
 * the Evidence Store, add no new facts, and return prose. They differ only in
 * the question asked, so the machinery lives here once and each agent is its
 * prompt plus which research it is allowed to see.
 *
 * These are labelled interpretation in the report, not findings, and they run
 * after the research agents rather than beside them — there is nothing to
 * interpret until the evidence exists.
 */
const router = require('../lib/aiRouter');
const { siteLine, evidenceDigest, formatScorecard, INTERPRETATION_RULES } = require('./_shared');

/**
 * @param {object} opts
 * @param {string} opts.instruction what this agent is being asked for
 * @param {{site:object, place:object, agentRuns:object[], scorecard:object}} opts.ctx
 * @param {string[]} [opts.only] restrict the evidence to these agents
 * @param {boolean} [opts.withScorecard] include the measured scores
 * @returns {Promise<{evidence:object, sources:Array, usage:object}>}
 */
async function synthesise({ instruction, ctx, only, withScorecard }) {
  const { site, place, agentRuns, scorecard } = ctx;
  const digest = evidenceDigest(agentRuns, only);

  // With nothing sourced there is nothing to interpret, and asking anyway is
  // how a model ends up writing a SWOT analysis out of its own memory of what
  // Indian suburbs are usually like.
  if (!digest.sourced.length) {
    return {
      evidence: { summary: '', unsourced: 'no research could be sourced for this site, so there is nothing to interpret' },
      sources: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  const prompt = `${siteLine(site, place)}

${instruction}

${withScorecard ? `Measured scores for this site (computed from route times and place counts, not estimated):\n${formatScorecard(scorecard)}\n` : ''}
Research gathered for this site:
${digest.text}

${INTERPRETATION_RULES}`;

  const { text, usage, provider } = await router.ask({ task: 'write', prompt, evidence: false });
  return {
    evidence: { summary: (text || '').trim(), provider, interpretation: true },
    // Deliberately empty. These agents cite nothing of their own; the
    // citations belong to the research they read, and repeating them here
    // would inflate the reference list with duplicates.
    sources: [],
    usage,
  };
}

module.exports = { synthesise };
