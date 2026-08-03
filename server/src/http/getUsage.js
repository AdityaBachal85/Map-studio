/**
 * http/getUsage.js — today's self-counted ledger, for the client's
 * "credits used today" widget. Deliberately the simplest possible endpoint —
 * it exists first (before any agent logic) to validate the whole chain: DB
 * connectivity, CORS, and the deploy pipeline.
 */
const { withCors } = require('../lib/cors');
const ledger = require('../lib/ledger');

const getUsage = withCors(async (req, res) => {
  const summary = await ledger.getTodaySummary();
  res.status(200).json({
    reportsGenerated: summary.reportsGenerated,
    reportsCap: summary.reportsCap,
    resetsAt: summary.resetsAt,
    // Report the total across whichever models actually ran, rather than
    // naming one: lib/aiRouter.js picks the model per task and falls back to
    // another when quota runs out, so hardcoding a single key here would
    // silently report zero the moment the router routed somewhere else.
    gemini: { totalTokens: summary.totalTokens, byModel: summary.byModel },
  });
});

module.exports = { getUsage };
