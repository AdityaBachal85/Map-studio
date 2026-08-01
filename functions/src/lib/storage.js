/**
 * lib/storage.js — uploads a report's PDF/DOCX to Cloud Storage and mints the
 * signed URLs the client is handed.
 *
 * The bucket's own Object Lifecycle rule (see docs/AI-REPORTS-SETUP.md) is a
 * coarse, day-granular backstop that deletes objects within ~48-72h — the
 * precise "expires in 48 hours" promise the UI makes is enforced here, by
 * the signed URL's own TTL, not by that rule.
 */
const { getStorage } = require('firebase-admin/storage');

const SIGNED_URL_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * @param {string} reportId @param {'pdf'|'docx'} kind @param {Buffer} buffer
 * @returns {Promise<{path:string, url:string, expiresAt:string}>}
 */
async function uploadReportFile(reportId, kind, buffer) {
  const bucket = getStorage().bucket();
  const path = `reports/${reportId}/report.${kind}`;
  const contentType = kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const file = bucket.file(path);
  await file.save(buffer, { contentType, resumable: false });

  const expiresAtMs = Date.now() + SIGNED_URL_TTL_MS;
  const [url] = await file.getSignedUrl({ action: 'read', expires: expiresAtMs });
  return { path, url, expiresAt: new Date(expiresAtMs).toISOString() };
}

module.exports = { uploadReportFile, SIGNED_URL_TTL_MS };
