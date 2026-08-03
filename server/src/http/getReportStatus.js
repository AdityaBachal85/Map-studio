/**
 * http/getReportStatus.js — polled every ~4s by the client while a report
 * runs. Reads through the cache first (short TTL, see lib/cache.js) so this
 * frequent poll doesn't hit Postgres on every request; falls back to
 * Postgres on a cache miss and re-populates the cache.
 */
const { withCors, publicOrigin } = require('../lib/cors');
const db = require('../lib/db');
const cache = require('../lib/cache');

/**
 * Build the client-facing download links for a finished report.
 *
 * Absolute, and derived from the incoming request rather than stored at
 * generation time or read from config: the client sets these straight onto an
 * <a href>, so a relative path would resolve against the *static site's*
 * origin (GitHub Pages), not this backend. Deriving them per-request also
 * means moving the backend to a new host needs no config change and leaves no
 * stale absolute URLs in the database.
 *
 * @param {import('express').Request} req @param {string} reportId
 */
function downloadLinks(req, reportId) {
  const base = publicOrigin(req) + '/downloadReport?jobId=' + encodeURIComponent(reportId);
  return { pdfUrl: base + '&format=pdf', docxUrl: base + '&format=docx' };
}

const getReportStatus = withCors(async (req, res) => {
  const jobId = req.query.jobId;
  if (!jobId || typeof jobId !== 'string') { res.status(400).json({ error: 'jobId is required' }); return; }

  // The cached entry deliberately holds no URLs — they're request-derived
  // (see above), so they're added on the way out of both paths instead.
  const cached = await cache.getCachedReportStatus(jobId);
  if (cached) {
    res.status(200).json(cached.status === 'done' ? { ...cached, ...downloadLinks(req, jobId) } : cached);
    return;
  }

  const report = await db.getReport(jobId);
  if (!report) { res.status(404).json({ error: 'That report was not found.' }); return; }

  const payload = {
    status: report.status,
    expiresAt: report.expires_at ? new Date(report.expires_at).toISOString() : undefined,
    error: report.error || undefined,
  };
  await cache.cacheReportStatus(jobId, payload);
  res.status(200).json(payload.status === 'done' ? { ...payload, ...downloadLinks(req, jobId) } : payload);
});

module.exports = { getReportStatus };
