/**
 * agents/insights.js — the things a reader would miss.
 *
 * Runs over everything, including the interpretation agents' own output, so
 * it can notice where two sections disagree — which is often the most useful
 * observation in the whole report.
 */
const { synthesise } = require('./_synthesis');

/** @param {object} ctx @returns {Promise<{evidence:object, sources:Array, usage:object}>} */
function run(ctx) {
  return synthesise({
    ctx,
    withScorecard: true,
    instruction: `Write the observations a careful reader would take from this research but might miss on a first pass, under three headings: Key Insights, Overlooked Opportunities, Overlooked Risks.

Prefer the non-obvious: a tension between two sections, something the measured scores reveal that the prose does not, a gap between what is planned and what exists. Five to eight points in total across the three headings, each one sentence. "The area is well connected" is not an insight; "the airport run degrades 47% at peak, which the distance figure hides" is.`,
  });
}
module.exports = { run };
