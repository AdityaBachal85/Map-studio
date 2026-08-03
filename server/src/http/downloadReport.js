/**
 * http/downloadReport.js — serves a finished report's PDF or DOCX.
 *
 * This replaces the signed Cloud Storage URLs of the original design. The
 * files live in Postgres now (see lib/storage.js), so they need an endpoint
 * to come back out of; that turns out to be an improvement on signed URLs,
 * because expiry is decided here, at request time, against the report row —
 * rather than baked into a URL that can't be revoked once handed out.
 *
 * Not rate-limited: it spends no Gemini quota, and a user re-downloading a
 * report they already generated is exactly the behaviour the 48h window is
 * there to allow.
 */
const { withCors } = require('../lib/cors');
const storage = require('../lib/storage');

const downloadReport = withCors(async (req, res) => {
  const jobId = req.query.jobId;
  const format = req.query.format;

  if (!jobId || typeof jobId !== 'string') { res.status(400).json({ error: 'jobId is required' }); return; }
  if (format !== 'pdf' && format !== 'docx') { res.status(400).json({ error: 'format must be pdf or docx' }); return; }

  const file = await storage.getReportFile(jobId, format);
  if (!file.ok) {
    if (file.reason === 'expired') {
      // 410 rather than 404: the distinction is real and the UI promises it —
      // this report existed, its 48 hours are up, and regenerating is the
      // only way back. A 404 would read as "wrong link".
      res.status(410).json({ code: 'expired', error: 'This report has expired — reports are kept for 48 hours. Please generate a new one.' });
      return;
    }
    res.status(404).json({ code: 'not_found', error: 'That report was not found, or it has not finished generating yet.' });
    return;
  }

  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Length', file.buffer.length);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  // These are per-user documents behind a short expiry: never let a shared
  // cache hold one, and don't let a browser serve a stale copy after expiry.
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).send(file.buffer);
});

module.exports = { downloadReport };
