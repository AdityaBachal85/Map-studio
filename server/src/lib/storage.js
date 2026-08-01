/**
 * lib/storage.js — where a report's rendered PDF/DOCX live between generation
 * and download.
 *
 * These are stored as BYTEA on the report's own row rather than in an object
 * store. That is a deliberate trade for this deployment's actual shape: the
 * files are small (a few hundred KB), short-lived (48h), and low-volume
 * (capped in lib/ledger.js) — and on every major cloud, the blob store is the
 * component that forces a billing account onto an otherwise-free stack.
 * Postgres is already a hard dependency here; the object store was not.
 *
 * This module is the only place those columns are read or written, so
 * swapping in S3/R2/Supabase later is a change to this file alone.
 *
 * The 48h promise is enforced two ways: `expires_at` is checked on every
 * download request (so an expired file is never served even if its bytes are
 * still present), and `sweepExpiredFiles()` actually frees them.
 */
const db = require('./db');

const FILE_TTL_MS = 48 * 60 * 60 * 1000;

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * Persist both rendered documents against a report.
 * @param {string} reportId @param {{pdf:Buffer, docx:Buffer}} buffers
 * @returns {Promise<{expiresAt:string}>}
 */
async function saveReportFiles(reportId, buffers) {
  const expiresAt = new Date(Date.now() + FILE_TTL_MS).toISOString();
  await db.query(
    `UPDATE reports SET pdf_bytes = $2, docx_bytes = $3, expires_at = $4 WHERE id = $1`,
    [reportId, buffers.pdf, buffers.docx, expiresAt]
  );
  return { expiresAt };
}

/**
 * Fetch one rendered document for download, or explain why it isn't available.
 * Expiry is enforced here rather than trusted to the sweep, so a file is never
 * served past its stated TTL even if the sweep hasn't run yet.
 *
 * @param {string} reportId @param {'pdf'|'docx'} kind
 * @returns {Promise<{ok:true, buffer:Buffer, contentType:string, filename:string}
 *                  | {ok:false, reason:'not_found'|'expired'}>}
 */
async function getReportFile(reportId, kind) {
  const column = kind === 'pdf' ? 'pdf_bytes' : 'docx_bytes';
  const res = await db.query(
    `SELECT r.${column} AS bytes, r.expires_at, s.name AS site_name
     FROM reports r JOIN sites s ON s.id = r.site_id
     WHERE r.id = $1`,
    [reportId]
  );
  const row = res.rows[0];
  if (!row || !row.bytes) return { ok: false, reason: 'not_found' };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  const safeName = String(row.site_name || 'site').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
  return {
    ok: true,
    buffer: row.bytes,
    contentType: CONTENT_TYPES[kind],
    filename: `${safeName}-location-report.${kind}`,
  };
}

/**
 * Free the bytes of every report whose files have expired. The report row
 * itself stays — its agent_runs are still useful evidence for a future report
 * on the same site, and the UI is explicit that an expired report has to be
 * regenerated rather than recovered.
 * @returns {Promise<number>} how many reports were cleared
 */
async function sweepExpiredFiles() {
  const res = await db.query(
    `UPDATE reports SET pdf_bytes = NULL, docx_bytes = NULL
     WHERE expires_at IS NOT NULL AND expires_at < now()
       AND (pdf_bytes IS NOT NULL OR docx_bytes IS NOT NULL)`
  );
  return res.rowCount || 0;
}

module.exports = { saveReportFiles, getReportFile, sweepExpiredFiles, FILE_TTL_MS, CONTENT_TYPES };
