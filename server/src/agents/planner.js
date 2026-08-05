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

/**
 * The interpretation agents, which run *after* research rather than beside
 * it — they add no facts, they read what the research found. Ordered as the
 * report presents them.
 *
 * Separate from planAgents() because the two rosters fail differently: a
 * research agent failing costs a section of evidence, an interpretation agent
 * failing costs a reading of evidence that is still there.
 * @returns {string[]}
 */
function planSynthesisAgents() {
  return ['swot', 'risk', 'investment', 'timeline', 'insights'];
}

module.exports = { planAgents, planSynthesisAgents, STANDARD_REPORT };
