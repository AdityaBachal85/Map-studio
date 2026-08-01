/**
 * http/getReportStatus.js — polled every ~4s by the client while a report
 * runs. Reads through Redis first (short TTL, see lib/cache.js) so this
 * frequent poll doesn't hit Postgres on every request; falls back to
 * Postgres on a cache miss and re-populates the cache.
 */
const { onRequest } = require('firebase-functions/v2/https');
const { withCors } = require('../lib/cors');
const db = require('../lib/db');
const cache = require('../lib/cache');
const secrets = require('../lib/secrets');

const getReportStatus = onRequest({ region: 'asia-south1', cors: false, secrets: secrets.DB_CACHE }, withCors(async (req, res) => {
  const jobId = req.query.jobId;
  if (!jobId || typeof jobId !== 'string') { res.status(400).json({ error: 'jobId is required' }); return; }

  const cached = await cache.getCachedReportStatus(jobId);
  if (cached) { res.status(200).json(cached); return; }

  const report = await db.getReport(jobId);
  if (!report) { res.status(404).json({ error: 'That report was not found.' }); return; }

  const payload = {
    status: report.status,
    pdfUrl: report.pdf_url || undefined,
    docxUrl: report.docx_url || undefined,
    expiresAt: report.expires_at ? new Date(report.expires_at).toISOString() : undefined,
    error: report.error || undefined,
  };
  await cache.cacheReportStatus(jobId, payload);
  res.status(200).json(payload);
}));

module.exports = { getReportStatus };
