/**
 * agents/planner.js — Research Planner: decides which research agents run.
 *
 * v6 ships exactly one report type ("standard site report"), so this always
 * returns the same fixed roster today. It exists as a real decision point
 * from the start specifically so that adding a second report type later
 * (e.g. "Developer Analysis" needing Market + Competitor but not
 * Connectivity — see the "documented for later" roster) is a change to this
 * one function, not a pipeline rewrite.
 */

/** The only report type v6 supports. */
const STANDARD_REPORT = 'standard';

/**
 * @param {{reportType?: string}} [opts]
 * @returns {string[]} agent names to run, in the order the Writer expects
 *   their sections.
 */
function planAgents(opts) {
  const reportType = (opts && opts.reportType) || STANDARD_REPORT;
  if (reportType !== STANDARD_REPORT) {
    console.warn(`Research Planner: unknown reportType "${reportType}", falling back to the standard roster.`);
  }
  return ['connectivity', 'infrastructure', 'government', 'news'];
}

module.exports = { planAgents, STANDARD_REPORT };
