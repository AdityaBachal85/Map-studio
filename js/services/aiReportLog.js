/**
 * services/aiReportLog.js — a local record of the reports this browser made.
 *
 * WHY THIS EXISTS. The usage meter said "2 / 20 today" and there was nothing
 * to click: a count of things you cannot open is just a scold. The AI tab shows
 * the download links for the report you generated *this session*, and they are
 * gone the moment you switch tabs or refresh — while the files themselves stay
 * downloadable for 48 hours.
 *
 * WHY LOCAL RATHER THAN A SERVER LIST. Both, in the end — /listReports is the
 * authoritative source and is merged in when it answers. But the local log is
 * the one that works: it needs no round trip, it survives the backend being
 * asleep, and it still lists your reports when the network is down. The signed
 * URLs are already in the browser when the report finishes, so writing them
 * down costs nothing.
 *
 * Entries past their expiry are dropped on read rather than kept and greyed
 * out. A download button that cannot work is worse than an empty list.
 */

const AI_LOG_KEY = 'dbot.aiReports.v1';
const AI_LOG_MAX = 40;

/** @returns {object[]} the log, newest first, expired entries removed */
function aiReportLog() {
  let raw = null;
  try { raw = localStorage.getItem(AI_LOG_KEY); } catch (e) { return []; }
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch (e) { return []; }
  if (!Array.isArray(list)) return [];

  const now = Date.now();
  const live = list.filter(r => {
    if (!r || !r.id) return false;
    const exp = r.expiresAt ? Date.parse(r.expiresAt) : NaN;
    // No expiry recorded: keep it for the 48 hours the backend promises, timed
    // from when it was made. Better than keeping it forever.
    const until = isFinite(exp) ? exp : (Date.parse(r.createdAt || '') || now) + 48 * 3600e3;
    return until > now;
  });
  if (live.length !== list.length) aiReportLogWrite(live);
  return live.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/** @param {object[]} list */
function aiReportLogWrite(list) {
  try { localStorage.setItem(AI_LOG_KEY, JSON.stringify(list.slice(0, AI_LOG_MAX))); }
  catch (e) { /* private mode, or full — the menu just stays empty */ }
}

/**
 * Record a finished report.
 *
 * @param {object} job the completed status payload
 * @param {string} [siteName] what it was about, for the list
 */
function aiReportLogAdd(job, siteName) {
  if (!job || (!job.pdfUrl && !job.docxUrl)) return;
  const id = job.reportId || job.jobId || job.id || String(Date.now());
  const list = aiReportLog().filter(r => r.id !== id);
  list.unshift({
    id,
    site: siteName || job.siteName || 'Site report',
    createdAt: job.createdAt || new Date().toISOString(),
    expiresAt: job.expiresAt || '',
    pdfUrl: job.pdfUrl || '',
    docxUrl: job.docxUrl || '',
  });
  aiReportLogWrite(list);
}

/** @param {string} iso @returns {string} a short, local-time label */
function aiReportWhen(iso) {
  const t = Date.parse(iso || '');
  if (!isFinite(t)) return '';
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? 'Today ' + time : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + time;
}

/** @param {string} iso @returns {string} how long the links have left */
function aiReportLeft(iso) {
  const t = Date.parse(iso || '');
  if (!isFinite(t)) return '';
  const h = Math.round((t - Date.now()) / 3600e3);
  if (h <= 0) return 'expired';
  return h < 24 ? 'expires in ' + h + 'h' : 'expires in ' + Math.round(h / 24) + 'd';
}
