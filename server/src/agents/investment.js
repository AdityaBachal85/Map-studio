/**
 * agents/investment.js — the investment view.
 *
 * The most quoted section of any such report and the easiest to fabricate, so
 * the prompt refuses the two things a reader would most like and no source
 * supports: a predicted appreciation percentage and a price.
 */
const { synthesise } = require('./_synthesis');

/** @param {object} ctx @returns {Promise<{evidence:object, sources:Array, usage:object}>} */
function run(ctx) {
  return synthesise({
    ctx,
    withScorecard: true,
    instruction: `Give an investment view of this site in three short parts: what the evidence supports as its strongest case, what argues against it, and what a buyer should verify before committing.

Refer to the measured scores where they are relevant, and say what they are based on. Do NOT state an expected appreciation percentage, a rental yield, a price, or a target ROI — no source in this research measures any of them, and a number here would be invention. If a reader would want those figures, say plainly that they require market data this report does not have.`,
  });
}
module.exports = { run };
