/**
 * lib/secrets.js — named secret groups for each function's `secrets: [...]`
 * option.
 *
 * Firebase Functions v2 only populates `process.env.SECRET_NAME` for a
 * function that explicitly lists that secret in its own options — declaring
 * a secret with `firebase functions:secrets:set` is not enough on its own.
 * Every function in this codebase must list exactly what it uses; these
 * groups exist so that's one array reference instead of four repeated
 * string literals per file.
 */
const ALLOWED_ORIGIN = 'ALLOWED_ORIGIN';
const GEMINI_API_KEY = 'GEMINI_API_KEY';
const DATABASE_URL = 'DATABASE_URL';
const UPSTASH_REDIS_REST_URL = 'UPSTASH_REDIS_REST_URL';
const UPSTASH_REDIS_REST_TOKEN = 'UPSTASH_REDIS_REST_TOKEN';

/** Every HTTP endpoint applies CORS, so every one needs this regardless of what else it uses. */
const CORS = [ALLOWED_ORIGIN];
/** Endpoints that only read Postgres (getUsage). */
const DB = [...CORS, DATABASE_URL];
/** Endpoints that read Postgres + the Redis status/rate-limit cache (createReportJob, getReportStatus). */
const DB_CACHE = [...DB, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN];
/** Endpoints/tasks that also call Gemini (chat, reportWorker). */
const ALL = [...DB_CACHE, GEMINI_API_KEY];

module.exports = { ALLOWED_ORIGIN, GEMINI_API_KEY, DATABASE_URL, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, CORS, DB, DB_CACHE, ALL };
