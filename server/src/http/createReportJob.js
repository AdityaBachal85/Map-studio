/**
 * http/createReportJob.js — the Research Controller's front door.
 *
 * Fast (<2s): validates the request, runs every abuse/cap gate, writes the
 * report row, enqueues the actual work as a Cloud Task, and returns
 * immediately. All the slow work happens in tasks/reportWorker.js.
 */
const { onRequest } = require('firebase-functions/v2/https');
const { getFunctions } = require('firebase-admin/functions');
const { withCors, clientIp } = require('../lib/cors');
const db = require('../lib/db');
const ledger = require('../lib/ledger');
const cache = require('../lib/cache');
const secrets = require('../lib/secrets');

/** How many reports may be in-flight across the whole deployment at once — the real defense against per-minute quota bursts, independent of the daily budget. */
const MAX_CONCURRENT_REPORTS = 3;
/** Per-IP: at most this many report requests per window. */
const RATE_LIMIT_PER_IP = 5;
const RATE_LIMIT_WINDOW_S = 600;

/** @param {*} body @returns {string|null} an error message, or null if valid. */
function validate(body) {
  const site = body && body.site;
  if (!site || typeof site.name !== 'string' || typeof site.lat !== 'number' || typeof site.lng !== 'number') {
    return 'A valid site {name, lat, lng} is required.';
  }
  if (Math.abs(site.lat) > 90 || Math.abs(site.lng) > 180) return 'Site coordinates are out of range.';
  return null;
}

const createReportJob = onRequest({ region: 'asia-south1', cors: false, secrets: secrets.DB_CACHE }, withCors(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const ip = clientIp(req);
  const allowed = await cache.checkRateLimit(ip, RATE_LIMIT_PER_IP, RATE_LIMIT_WINDOW_S);
  if (!allowed) { res.status(429).json({ code: 'rate_limited', error: 'Too many report requests from this connection — please wait a few minutes.' }); return; }

  const invalidReason = validate(req.body);
  if (invalidReason) { res.status(400).json({ error: invalidReason }); return; }

  // Every error response below puts the human-readable sentence in `error`
  // (what js/services/aiReports.js surfaces via status()) and a stable
  // machine `code` alongside it, for any caller that wants to branch on the
  // reason rather than just display it.
  const activeCount = await db.countActiveReports();
  if (activeCount >= MAX_CONCURRENT_REPORTS) {
    res.status(429).json({ code: 'concurrency_limit', error: 'Several reports are already being generated — please try again shortly.' });
    return;
  }

  const usage = await ledger.getTodaySummary();
  if (usage.reportsGenerated >= usage.reportsCap) {
    res.status(429).json({ code: 'daily_quota_reached', resetsAt: usage.resetsAt, error: `Today's report limit has been reached. Resets ${new Date(usage.resetsAt).toLocaleString()}.` });
    return;
  }
  if (usage.totalTokens >= usage.tokenBudget) {
    res.status(429).json({ code: 'daily_quota_reached', resetsAt: usage.resetsAt, error: `Today's usage budget has been reached. Resets ${new Date(usage.resetsAt).toLocaleString()}.` });
    return;
  }

  const site = { name: String(req.body.site.name).slice(0, 200), lat: req.body.site.lat, lng: req.body.site.lng };
  const nearby = (req.body.nearby && typeof req.body.nearby === 'object') ? req.body.nearby : {};

  const siteId = await db.findOrCreateSite(site);
  const reportId = await db.createReportRow(siteId);

  const queue = getFunctions().taskQueue('reportWorker');
  await queue.enqueue({ reportId, site, nearby });

  res.status(200).json({ jobId: reportId });
}));

module.exports = { createReportJob, MAX_CONCURRENT_REPORTS, RATE_LIMIT_PER_IP, RATE_LIMIT_WINDOW_S };
