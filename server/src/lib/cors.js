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
 * Wrap an Express-style handler with CORS + a JSON error response for
 * anything the handler itself throws, so no endpoint has to remember to
 * catch its own errors.
 * @param {(req:import('express').Request, res:import('express').Response) => Promise<void>} handler
 * @returns {(req:import('express').Request, res:import('express').Response) => Promise<void>}
 */
function withCors(handler) {
  return async (req, res) => {
    const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
    if (allowedOrigin) res.set('Access-Control-Allow-Origin', allowedOrigin);
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

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

module.exports = { withCors, clientIp, publicOrigin };
