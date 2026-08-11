/**
 * services/aiReports.js — client for the AI report backend (see server/).
 *
 * The backend owns the Gemini key and every provider call; this module only
 * talks to our own HTTPS endpoints via plain fetch(), matching every other
 * service in this app. No SDK, no realtime listeners — a report is a job you
 * create and then poll, same shape as everything else here.
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

/* ---------------------------------------------------------------------------
 * Waking a backend that sleeps
 * ------------------------------------------------------------------------ */

/**
 * WHY EVERY REQUEST HERE RETRIES, AND WHY "FAILED TO FETCH" WAS SO USELESS.
 *
 * This backend runs on a free hosting tier that stops the container after
 * about fifteen minutes with no traffic. The next request wakes it, and the
 * wake takes the better part of a minute — during which the host's edge, not
 * our server, answers with a 502. That edge response carries no
 * Access-Control-Allow-Origin header, because it never reached the code that
 * sets one. A browser refuses to show a cross-origin response with no CORS
 * header, and reports the refusal as `TypeError: Failed to fetch`.
 *
 * So the single most common state of this feature — first use of the day —
 * produced a message indistinguishable from the server having been deleted,
 * and the fix was invisible: press the button again in a minute.
 *
 * Hence: a network failure or a 502/503/504 is treated as "still waking" and
 * retried on a backoff, with progress reported so the wait is explained rather
 * than merely endured. Any other HTTP status is a real answer from our own
 * code and is never retried — a 429 means the daily cap, and hammering it is
 * both pointless and rude.
 */

/** Backoff between wake attempts, ms. Sums to ~90s, past a typical cold start. */
const AI_WAKE_DELAYS_MS = [1500, 3000, 5000, 7000, 10000, 13000, 16000, 18000, 20000];

/** Statuses that mean the host answered but our server had not started yet. */
const AI_WAKING_STATUS = [502, 503, 504];

/** Whether the backend has answered at least once this session. */
let aiBackendAwake = false;

/**
 * Tell "the server is unreachable" apart from "the browser hid its answer".
 *
 * Both arrive at JavaScript as the same `TypeError: Failed to fetch`, and they
 * need opposite things done about them — restart the backend, or change one
 * environment variable on it. This is the one way to separate them from inside
 * a page: a `no-cors` request is allowed to complete, giving back an opaque
 * response that carries no readable data but does prove the host answered. If
 * that succeeds where the real request failed, the server is up and CORS is
 * what stopped us.
 *
 * @returns {Promise<'reachable'|'unreachable'>}
 */
async function aiProbeReachable() {
  try {
    await fetch(aiBaseUrl() + '/health', { mode: 'no-cors', cache: 'no-store' });
    return 'reachable';
  } catch (e) {
    return 'unreachable';
  }
}

/**
 * The sentence to show when a request never came back, the cold-start window
 * having already been waited out.
 * @returns {Promise<string>}
 */
async function aiUnreachableMessage() {
  let base = '';
  try { base = aiBaseUrl(); } catch (e) { return e.message; }
  // Points at /health, not the base URL: the root answers 404 by design, which
  // would tell someone checking that their working server is broken.
  const health = base + '/health';

  if (await aiProbeReachable() === 'reachable') {
    return 'The report server is running but is refusing this site. That is a CORS setting, '
      + 'not a fault: on Render, set ALLOWED_ORIGIN to ' + location.origin
      + ' — the origin only, no path, no trailing slash — and redeploy. Open ' + health
      + ' to see what it is currently configured for.';
  }
  return 'The report server did not respond. Open ' + health + ' in a new tab — '
    + 'if it shows {"ok":true} this was a temporary blip and trying again will work; '
    + 'if it does not load, the backend is stopped and needs restarting on Render.';
}

/**
 * fetch(), but patient with a server that is still starting.
 *
 * @param {string} url
 * @param {object} [init]
 * @param {object} [opts] `{onWaking(secondsWaited)}`
 * @returns {Promise<Response>}
 */
async function aiFetch(url, init, opts) {
  const onWaking = (opts && opts.onWaking) || null;
  const startedAt = Date.now();

  for (let attempt = 0; ; attempt++) {
    let res = null, networkError = null;
    try {
      res = await fetch(url, init);
    } catch (e) {
      networkError = e;
    }

    if (res && AI_WAKING_STATUS.indexOf(res.status) === -1) {
      aiBackendAwake = true;
      return res;
    }

    // Out of attempts: report the last thing that actually happened rather than
    // a generic failure, since a 503 and an unreachable host need different
    // things done about them.
    if (attempt >= AI_WAKE_DELAYS_MS.length) {
      if (res) throw new Error('The report server is not responding (' + res.status + '). '
        + 'It has been starting for ' + Math.round((Date.now() - startedAt) / 1000)
        + 's — give it another minute and try again.');
      throw new Error(await aiUnreachableMessage());
    }

    if (onWaking) onWaking(Math.round((Date.now() - startedAt) / 1000));
    await new Promise(r => setTimeout(r, AI_WAKE_DELAYS_MS[attempt]));
  }
}

/**
 * Read a response, preferring the server's own error text over a status code.
 * @param {Response} res @returns {Promise<object>}
 */
async function aiReadJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
  return data;
}

/**
 * POST helper. Throws with the server's own message when the response isn't ok,
 * so callers can show something more useful than "failed to fetch".
 * @param {string} path @param {object} body @param {object} [opts]
 * @returns {Promise<object>}
 */
async function aiPost(path, body, opts) {
  return aiReadJson(await aiFetch(aiBaseUrl() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }, opts));
}

/** GET helper, same error handling as aiPost. @param {string} path @param {object} [opts] @returns {Promise<object>} */
async function aiGet(path, opts) {
  return aiReadJson(await aiFetch(aiBaseUrl() + path, undefined, opts));
}

/**
 * Wake the backend and report whether it is up.
 *
 * Called when the panel opens, so the minute of starting up is spent while
 * someone is choosing a site rather than after they press Generate.
 *
 * @param {function(number):void} [onWaking] called with seconds waited so far
 * @returns {Promise<{ok:boolean, ms:number, error?:string}>}
 */
async function aiWakeBackend(onWaking) {
  const t0 = Date.now();
  try {
    await aiGet('/health', { onWaking });
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.message };
  }
}

/** @returns {boolean} whether the backend has answered at least once this session */
function aiBackendIsAwake() { return aiBackendAwake; }

/**
 * Start a report job for a site.
 * @param {{site:{name:string,lat:number,lng:number}, nearby:object}} payload
 * @returns {Promise<{jobId:string}>}
 */
function createReportJob(payload, opts) {
  return aiPost('/createReportJob', payload, opts);
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
function getUsage(opts) {
  return aiGet('/getUsage', opts);
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
