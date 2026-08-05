/**
 * agents/timeline.js — what has happened here and what is coming.
 *
 * Reads only the two research agents that carry dates. Connectivity and
 * infrastructure describe a place as it is now; asking a model to build a
 * chronology out of them invites invented years.
 */
const { synthesise } = require('./_synthesis');

/** @param {object} ctx @returns {Promise<{evidence:object, sources:Array, usage:object}>} */
function run(ctx) {
  return synthesise({
    ctx,
    only: ['government', 'news'],
    instruction: `Lay out a timeline for this area under three headings: Recent (already delivered or reported), Under way (in progress now), and Expected (announced or planned).

Put each item under the heading its own evidence supports, with a date or year wherever the research states one. Where the research gives no date, say the timing is not stated rather than estimating it. If a heading has no items, say so in one line.`,
  });
}
module.exports = { run };
