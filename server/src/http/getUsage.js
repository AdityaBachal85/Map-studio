/**
 * http/getUsage.js — today's self-counted ledger, for the client's
 * "credits used today" widget. Deliberately the simplest possible endpoint —
 * it exists first (before any agent logic) to validate the whole chain: DB
 * connectivity, CORS, and the deploy pipeline.
 */
const { onRequest } = require('firebase-functions/v2/https');
const { withCors } = require('../lib/cors');
const ledger = require('../lib/ledger');
const secrets = require('../lib/secrets');

const getUsage = onRequest({ region: 'asia-south1', cors: false, secrets: secrets.DB }, withCors(async (req, res) => {
  const summary = await ledger.getTodaySummary();
  res.status(200).json({
    reportsGenerated: summary.reportsGenerated,
    reportsCap: summary.reportsCap,
    resetsAt: summary.resetsAt,
    gemini: summary.byModel['gemini-2.5-flash'] || { totalTokens: summary.totalTokens },
  });
}));

module.exports = { getUsage };
