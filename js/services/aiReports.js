/**
 * services/aiReports.js — client for the AI report backend (Cloud Functions).
 *
 * The backend owns the Gemini key and every provider call; this module only
 * talks to our own HTTPS endpoints via plain fetch(), matching every other
 * service in this app. No Firebase SDK, no realtime listeners — a report is a
 * job you create and then poll, same shape as everything else here.
 *
 * AI_FUNCTIONS_BASE_URL (js/config.js) is empty until the backend is deployed
 * (see docs/AI-REPORTS-SETUP.md); every function here throws a clear error in
 * that case instead of attempting a request against an empty URL.
 */

/** @returns {string} the configured base URL, or throws if it isn't set. */
function aiBaseUrl() {
  const base = (typeof AI_FUNCTIONS_BASE_URL === 'string' ? AI_FUNCTIONS_BASE_URL : '').trim();
  if (!base) throw new Error('AI reports are not configured yet — set AI_FUNCTIONS_BASE_URL in js/config.js once the backend is deployed.');
  return base.replace(/\/$/, '');
}

/**
 * POST helper. Throws with the server's own message when the response isn't ok,
 * so callers can show something more useful than "failed to fetch".
 * @param {string} path @param {object} body @returns {Promise<object>}
 */
async function aiPost(path, body) {
  const res = await fetch(aiBaseUrl() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** GET helper, same error handling as aiPost. @param {string} path @returns {Promise<object>} */
async function aiGet(path) {
  const res = await fetch(aiBaseUrl() + path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/**
 * Start a report job for a site.
 * @param {{site:{name:string,lat:number,lng:number}, nearby:object}} payload
 * @returns {Promise<{jobId:string}>}
 */
function createReportJob(payload) {
  return aiPost('/createReportJob', payload);
}

/**
 * Poll one report job's status.
 * @param {string} jobId
 * @returns {Promise<{status:string, pdfUrl?:string, docxUrl?:string, expiresAt?:string, error?:string}>}
 */
function getReportStatus(jobId) {
  return aiGet('/getReportStatus?jobId=' + encodeURIComponent(jobId));
}

/**
 * Today's usage ledger, for the "credits used" widget. See Phase B/E of the
 * design: this is a real, self-counted ledger (we're the only caller of the
 * key), not an estimate — but it is *our* count, not something Gemini itself
 * reports back.
 * @returns {Promise<{reportsGenerated:number, reportsCap:number, resetsAt:string, gemini:object}>}
 */
function getUsage() {
  return aiGet('/getUsage');
}

/**
 * Ask a follow-up question about a completed report. The backend answers from
 * that report's already-gathered evidence when it can, and only spends a new
 * grounded search when the question needs something not already researched.
 * @param {string} reportId @param {string} message
 * @returns {Promise<{reply:string, researched:boolean}>}
 */
function sendChatMessage(reportId, message) {
  return aiPost('/chat', { reportId, message });
}
