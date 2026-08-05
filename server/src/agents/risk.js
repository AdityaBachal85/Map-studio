/**
 * agents/risk.js — Risk Assessment.
 *
 * Deliberately narrative rather than scored. A "Legal Risk: 7/10" would be
 * invented — title searches, litigation history and environmental clearances
 * are not in any source this pipeline reads — and the scorecard's rule
 * against unmeasured numbers applies here too.
 */
const { synthesise } = require('./_synthesis');

/** @param {object} ctx @returns {Promise<{evidence:object, sources:Array, usage:object}>} */
function run(ctx) {
  return synthesise({
    ctx,
    instruction: `Assess the risks of this site as a property investment. Cover, only where the research supports it: market risk, infrastructure and delivery risk, regulatory or planning risk, and any locality-specific concerns raised in the news coverage.

For each risk name what it is, what in the research points to it, and how material it looks. Do not assign numeric risk scores — nothing here measures them. Explicitly list which risk categories could NOT be assessed from the available research (for example legal title, flood exposure and environmental clearance, none of which are covered by these sources) so a reader knows what still needs separate due diligence.`,
  });
}
module.exports = { run };
