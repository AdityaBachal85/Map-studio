/**
 * lib/cors.js — the one place every HTTP endpoint locks its origin.
 *
 * CORS alone is not a security boundary (it only restricts browser-JS
 * callers, not curl/scripts) — it's paired with the per-IP rate limiter and
 * daily caps in createReportJob. But it's still the first, cheapest line of
 * defense, and every endpoint should apply it the same way rather than each
 * rolling its own header logic.
 */

/**
 * The configured allowlist, normalised.
 *
 * Comma-separated, so a staging origin or a custom domain does not mean
 * choosing which one gets to work. Trailing slashes are stripped because an
 * Origin header never has one, and `https://example.com/` in the environment
 * would silently match nothing.
 *
 * @returns {string[]}
 */
function allowedOrigins() {
  return String(process.env.ALLOWED_ORIGIN || '')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
}

/**
 * Decide what to do about one request's Origin.
 *
 * WHY AN UNSET ALLOWLIST NOW MEANS "ANY ORIGIN". It used to mean no
 * Access-Control-Allow-Origin header at all — which does not lock the backend
 * down, it makes it unusable from every browser on earth while leaving it wide
 * open to curl. That is the opposite of the intent, and it fails invisibly:
 * the browser reports `Failed to fetch`, which reads as "the server is down".
 * The real limits are the per-IP rate limiter and the daily caps in
 * createReportJob, and those apply either way. Unset now means open, with a
 * warning logged at startup.
 *
 * @param {import('express').Request} req
 * @returns {{ok:boolean, allow:string|null, origin:string, mode:string, list:string[]}}
 */
function originVerdict(req) {
  const list = allowedOrigins();
  const origin = String(req.get('origin') || '').replace(/\/$/, '');

  if (!list.length) return { ok: true, allow: origin || '*', origin, mode: 'open', list };

  // Absent Origin is deliberately allowed: curl, uptime checks and
  // server-to-server callers send none, and refusing them would break
  // monitoring to stop nothing. This is defence in depth, not a boundary —
  // Origin is trivially omitted.
  if (!origin) return { ok: true, allow: list[0], origin, mode: 'no-origin', list };

  if (list.indexOf(origin) !== -1) return { ok: true, allow: origin, origin, mode: 'allowed', list };
  return { ok: false, allow: null, origin, mode: 'blocked', list };
}

/**
 * What this deployment thinks of the caller, for /health to report.
 * @param {import('express').Request} req @returns {object}
 */
function corsStatus(req) {
  const v = originVerdict(req);
  return {
    allowedOrigins: v.list.length ? v.list : null,
    yourOrigin: v.origin || null,
    originAllowed: v.ok,
    mode: v.mode,
  };
}

/**
 * Wrap an Express-style handler with CORS + a JSON error response for
 * anything the handler itself throws, so no endpoint has to remember to
 * catch its own errors.
 * @param {(req:import('express').Request, res:import('express').Response) => Promise<void>} handler
 * @returns {(req:import('express').Request, res:import('express').Response) => Promise<void>}
 */
function withCors(handler) {
  return async (req, res) => {
    const v = originVerdict(req);

    // Even a refusal carries the header, deliberately. Blocking a request and
    // blocking the *explanation of why* are different things: without this the
    // browser hides the 403 body and reports `Failed to fetch`, so a one-line
    // configuration mistake presents as a dead server. Nothing is served here
    // that a blocked caller could not already see — only the reason.
    res.set('Access-Control-Allow-Origin', v.allow || v.origin || '*');
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Max-Age', '86400');
      res.status(204).send('');
      return;
    }

    // Refuse a mismatched Origin rather than only declining to advertise it.
    // Setting the header alone leaves enforcement entirely to the browser, so
    // a request carrying someone else's Origin was being served in full and
    // billed to this key — verified by curl, which created a real job with
    // `Origin: https://evil.example.com`.
    if (!v.ok) {
      res.status(403).json({
        error: 'This backend does not accept requests from ' + v.origin + '. '
          + 'It is configured for ' + v.list.join(', ') + '. If this is your own site, set '
          + 'ALLOWED_ORIGIN to ' + v.origin + ' — the origin only, with no path and no '
          + 'trailing slash — and redeploy.',
      });
      return;
    }

    try {
      await handler(req, res);
    } catch (e) {
      console.error('Unhandled error in HTTP handler:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error — please try again.' });
    }
  };
}

/** @param {import('express').Request} req @returns {string} best-effort client IP for rate limiting. */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || 'unknown';
}

/**
 * This backend's own public origin, e.g. `https://map-studio-ai.onrender.com`.
 *
 * Derived from the request (Express resolves `req.protocol` from
 * X-Forwarded-Proto once `trust proxy` is set, which src/server.js does) so
 * that deploying to a new host needs no configuration. PUBLIC_BASE_URL
 * overrides it for the case where that inference is wrong — behind a CDN or a
 * custom domain that rewrites Host.
 *
 * @param {import('express').Request} req @returns {string} origin, no trailing slash
 */
function publicOrigin(req) {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  return req.protocol + '://' + req.get('host');
}

module.exports = { withCors, clientIp, publicOrigin, corsStatus, allowedOrigins };
