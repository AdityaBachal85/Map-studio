/**
 * lib/cache.js — short-TTL job-status reads, per-IP rate-limit counters, and
 * near-duplicate research caching.
 *
 * Redis is OPTIONAL here. This backend runs as a single long-lived process, so
 * an in-memory Map is a correct implementation of all three: there is one
 * instance, and every counter it holds is visible to every request it serves.
 * Requiring Redis would have meant one more account to create for zero benefit
 * at this scale.
 *
 * Set UPSTASH_REDIS_REST_URL/_TOKEN and this transparently switches to Redis —
 * which is what you'd want the day this runs as more than one instance, since
 * that's the point where in-memory counters stop being shared and the rate
 * limiter silently starts allowing N times what it should.
 */
const MEMORY_SWEEP_INTERVAL_MS = 60 * 1000;

let _redis = null;
let _redisChecked = false;

/** @returns {object|null} a Redis client, or null when none is configured. */
function redis() {
  if (_redisChecked) return _redis;
  _redisChecked = true;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const { Redis } = require('@upstash/redis');
    _redis = new Redis({ url, token });
    console.log('cache: using Redis');
  } else {
    console.log('cache: using in-process memory (no Redis configured — expected for a single-instance deploy)');
  }
  return _redis;
}

/**
 * The in-memory stand-in for Redis. Entries carry their own expiry and are
 * swept periodically so a long-running process doesn't accumulate dead keys
 * (lazy expiry alone would leak keys that are never read again — every
 * rate-limit key for an IP that never returns, for instance).
 */
const _mem = new Map();

function memSet(key, value, ttlS) {
  _mem.set(key, { value, expiresAt: Date.now() + ttlS * 1000 });
}

function memGet(key) {
  const entry = _mem.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { _mem.delete(key); return null; }
  return entry.value;
}

/** Increment a counter, creating it with `ttlS` if absent. @returns {number} */
function memIncr(key, ttlS) {
  const current = memGet(key);
  const next = (typeof current === 'number' ? current : 0) + 1;
  // Keep the original window's expiry: re-setting the TTL on every hit would
  // make the window slide forward forever and never actually reset.
  const existing = _mem.get(key);
  const expiresAt = existing && existing.expiresAt > Date.now() ? existing.expiresAt : Date.now() + ttlS * 1000;
  _mem.set(key, { value: next, expiresAt });
  return next;
}

const _memSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _mem) if (entry.expiresAt < now) _mem.delete(key);
}, MEMORY_SWEEP_INTERVAL_MS);
// Don't hold the process open just for cache maintenance.
if (_memSweep.unref) _memSweep.unref();

/** Seconds a cached job-status read stays valid before the next poll hits Postgres again. */
const STATUS_CACHE_TTL_S = 3;

/** @param {string} reportId @param {object} status @returns {Promise<void>} */
async function cacheReportStatus(reportId, status) {
  const key = 'report:' + reportId + ':status';
  const client = redis();
  if (!client) { memSet(key, status, STATUS_CACHE_TTL_S); return; }
  try { await client.set(key, JSON.stringify(status), { ex: STATUS_CACHE_TTL_S }); }
  catch (e) { console.warn('cacheReportStatus failed (non-fatal):', e.message); }
}

/** @param {string} reportId @returns {Promise<object|null>} */
async function getCachedReportStatus(reportId) {
  const key = 'report:' + reportId + ':status';
  const client = redis();
  if (!client) return memGet(key);
  try {
    const raw = await client.get(key);
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
  const key = 'ratelimit:' + ipHash;
  const client = redis();
  if (!client) return memIncr(key, windowS) <= limit;
  try {
    const count = await client.incr(key);
    if (count === 1) await client.expire(key, windowS);
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
  const key = 'research:' + cacheKey;
  const client = redis();
  if (!client) return memGet(key);
  try {
    const raw = await client.get(key);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (e) {
    console.warn('getCachedResearch failed (non-fatal):', e.message);
    return null;
  }
}

/** @param {string} cacheKey @param {object} value @param {number} [ttlS] */
async function setCachedResearch(cacheKey, value, ttlS) {
  const key = 'research:' + cacheKey;
  const ttl = ttlS || 600;
  const client = redis();
  if (!client) { memSet(key, value, ttl); return; }
  try { await client.set(key, JSON.stringify(value), { ex: ttl }); }
  catch (e) { console.warn('setCachedResearch failed (non-fatal):', e.message); }
}

module.exports = { redis, cacheReportStatus, getCachedReportStatus, checkRateLimit, getCachedResearch, setCachedResearch };
