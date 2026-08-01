/**
 * lib/cache.js — Redis (Upstash) for the things that don't belong in
 * Postgres: short-TTL job-status reads, per-IP rate-limit counters, and
 * near-duplicate research caching. Upstash's REST client needs no persistent
 * TCP connection, which matters here since a Cloud Functions instance can be
 * frozen between invocations.
 */
const { Redis } = require('@upstash/redis');

let _redis = null;

/** @returns {Redis} */
function redis() {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set — see docs/AI-REPORTS-SETUP.md');
  _redis = new Redis({ url, token });
  return _redis;
}

/** Seconds a cached job-status read stays valid before the next poll hits Postgres again. */
const STATUS_CACHE_TTL_S = 3;

/** @param {string} reportId @param {object} status @returns {Promise<void>} */
async function cacheReportStatus(reportId, status) {
  try { await redis().set('report:' + reportId + ':status', JSON.stringify(status), { ex: STATUS_CACHE_TTL_S }); }
  catch (e) { console.warn('cacheReportStatus failed (non-fatal):', e.message); }
}

/** @param {string} reportId @returns {Promise<object|null>} */
async function getCachedReportStatus(reportId) {
  try {
    const raw = await redis().get('report:' + reportId + ':status');
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (e) {
    console.warn('getCachedReportStatus failed (non-fatal):', e.message);
    return null;
  }
}

/**
 * Sliding-window-ish per-IP rate limit: a fixed-window counter keyed by a
 * hash of the IP, resetting every `windowS` seconds. Good enough for an abuse
 * backstop without the complexity of a real sliding-window log — burst
 * traffic right at a window boundary can undercount slightly, which is an
 * acceptable trade for a limiter that's this cheap to run.
 * @param {string} ipHash @param {number} limit @param {number} windowS
 * @returns {Promise<boolean>} true if the request should be allowed
 */
async function checkRateLimit(ipHash, limit, windowS) {
  try {
    const key = 'ratelimit:' + ipHash;
    const count = await redis().incr(key);
    if (count === 1) await redis().expire(key, windowS);
    return count <= limit;
  } catch (e) {
    console.warn('checkRateLimit failed — allowing the request rather than failing closed:', e.message);
    return true;
  }
}

/**
 * Short-TTL cache for near-duplicate research queries, so researching the
 * same site twice within a few minutes doesn't spend Gemini quota twice.
 * @param {string} cacheKey @returns {Promise<object|null>}
 */
async function getCachedResearch(cacheKey) {
  try {
    const raw = await redis().get('research:' + cacheKey);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (e) {
    console.warn('getCachedResearch failed (non-fatal):', e.message);
    return null;
  }
}

/** @param {string} cacheKey @param {object} value @param {number} [ttlS] */
async function setCachedResearch(cacheKey, value, ttlS) {
  try { await redis().set('research:' + cacheKey, JSON.stringify(value), { ex: ttlS || 600 }); }
  catch (e) { console.warn('setCachedResearch failed (non-fatal):', e.message); }
}

module.exports = { redis, cacheReportStatus, getCachedReportStatus, checkRateLimit, getCachedResearch, setCachedResearch };
