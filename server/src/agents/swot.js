/**
 * agents/swot.js — SWOT, strictly over evidence that was actually gathered.
 */
const { synthesise } = require('./_synthesis');

/** @param {object} ctx @returns {Promise<{evidence:object, sources:Array, usage:object}>} */
function run(ctx) {
  return synthesise({
    ctx,
    withScorecard: true,
    instruction: `Write a SWOT analysis of this site as a property investment, under four headings: Strengths, Weaknesses, Opportunities, Threats.

Strengths and Weaknesses describe what is true of the site today. Opportunities and Threats describe what could change it. Give three to five points under each heading, each one sentence, each traceable to something in the research below. If a heading has fewer real points, give fewer — do not pad to four.`,
  });
}
module.exports = { run };
