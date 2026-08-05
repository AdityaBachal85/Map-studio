/**
 * http/getProviders.js — GET /health/providers
 *
 * One request that says which of the five external services this pipeline
 * depends on actually answer, using the credentials the deployment really
 * holds. Hit it first after every deploy and after any key change.
 *
 * WHY IT REPORTS RESPONSE SHAPE. Two of these services could not be reached
 * from the environment this code was written in — the egress policy denies
 * api.perplexity.ai and openrouter.ai outright (403 to CONNECT). Everything
 * else here was verified by direct probe; those two were written against
 * documentation. So this endpoint returns the top-level keys Perplexity's
 * response actually had, turning the one remaining guess into one
 * measurement rather than a second guess. If `citationShape` comes back
 * "none" while the answer has content, the parser in lib/webSearch.js is
 * looking in the wrong place and that is the thing to fix.
 *
 * Safe to expose: it reports whether a key works, never the key, and the
 * probes are the cheapest call each service offers.
 */
const router = require('../lib/aiRouter');
const webSearch = require('../lib/webSearch');
const { resolvePlace } = require('../lib/placeContext');
const db = require('../lib/db');
const { lastMigration } = require('../lib/migrate');

/** A point with dense, stable data, so "no result" means the service is off. */
const PROBE_SITE = { lat: 19.1547, lng: 72.9986 };

/**
 * Run one probe, turning any failure into a reported row rather than a 500.
 * @param {string} name @param {function(): Promise<object>} fn
 */
async function probe(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    return { name, ok: detail.ok !== false, ms: Date.now() - startedAt, ...detail };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - startedAt, error: String(e.message || e).slice(0, 240) };
  }
}

/**
 * @param {import('express').Request} req @param {import('express').Response} res
 */
async function getProviders(req, res) {
  const checks = await Promise.all([
    // First, because nothing else matters if this is broken: a report writes
    // to Postgres at every step, so a missing schema fails everything while
    // /health still cheerfully reports ok.
    probe('database', async () => {
      const r = await db.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
      const tables = r.rows.map(x => x.tablename);
      const need = ['agent_runs', 'projects', 'reports', 'sites', 'usage_ledger'];
      const missing = need.filter(n => !tables.includes(n));
      return {
        ok: missing.length === 0,
        tables: tables.length,
        missing: missing.length ? missing : undefined,
        migration: lastMigration(),
      };
    }),

    probe('gemini.text', async () => {
      const r = await router.callGemini(router.MODEL_BY_TASK.write, 'Reply with exactly: OK', null);
      return { model: r.model, reply: r.text.slice(0, 20), tokens: r.usage.totalTokens };
    }),

    probe('gemini.mapsGrounding', async () => {
      const r = await router.callGemini(
        router.MODEL_BY_TASK.research,
        'Name one school near Airoli, Navi Mumbai. One sentence.', 'maps');
      return {
        model: r.model,
        sources: r.sources.length,
        // Grounding silently returning nothing is the failure that matters
        // here: the call succeeds, the prose reads fine, and every claim in
        // it is unsourced.
        ok: r.sources.length > 0,
        note: r.sources.length ? undefined : 'answered but cited nothing — grounding is not active',
      };
    }),

    probe('places.reverseGeocode', async () => {
      const p = await resolvePlace(PROBE_SITE);
      return {
        ok: p.resolved,
        resolved: p.formattedAddress || null,
        reason: p.reason,
        note: p.resolved ? undefined : 'web queries will fall back to raw coordinates, which search engines do not index',
      };
    }),

    probe('perplexity', async () => {
      if (!webSearch.perplexityConfigured()) {
        return { ok: false, configured: false, reason: 'PERPLEXITY_API_KEY is not set' };
      }
      const a = await webSearch.answer({
        question: 'Name one infrastructure project under construction in Navi Mumbai. One sentence.',
        domains: ['timesofindia.indiatimes.com', 'hindustantimes.com'],
        recency: 'year',
      });
      if (!a.ok) return { ok: false, configured: true, reason: a.reason, rawKeys: a.rawKeys };
      return {
        configured: true,
        sources: a.sources.length,
        // The whole reason this endpoint exists — see the file header.
        rawKeys: a.rawKeys,
        citationShape: a.sources.length ? 'parsed' : 'none',
        note: a.sources.length ? undefined
          : 'answered but no citations were parsed — check rawKeys against extractCitations() in lib/webSearch.js',
      };
    }),

    probe('customSearch', async () => {
      if (!webSearch.customSearchConfigured()) {
        return { ok: false, configured: false, reason: 'GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_CX are not set' };
      }
      const r = await webSearch.results({ query: 'Navi Mumbai infrastructure project', recency: 'y' });
      return r.ok ? { configured: true, results: r.results.length } : { ok: false, configured: true, reason: r.reason };
    }),

    probe('openrouter', async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        return { ok: false, configured: false, reason: 'OPENROUTER_API_KEY is not set (optional — inference fallback only)' };
      }
      const r = await router.callOpenRouter('Reply with exactly: OK');
      return { configured: true, model: r.model, reply: r.text.slice(0, 20) };
    }),
  ]);

  // Which report sections these results actually allow — the question an
  // operator is really asking, and one they should not have to derive from
  // five rows of provider status.
  const by = Object.fromEntries(checks.map(c => [c.name, c]));
  // A section cannot be "sourced" if the result has nowhere to be stored.
  const database = by.database.ok;
  const maps = database && by['gemini.mapsGrounding'].ok;
  const web = by.perplexity.ok || by.customSearch.ok;
  const sections = {
    connectivity: maps ? 'sourced' : 'unavailable',
    infrastructure: maps ? 'sourced' : 'unavailable',
    government: database && web ? 'sourced' : 'unavailable',
    news: database && web ? 'sourced' : 'unavailable',
    executiveSummary: database && by['gemini.text'].ok ? 'sourced' : 'unavailable',
  };

  const degraded = Object.values(sections).some(v => v === 'unavailable');
  res.status(200).json({
    ok: !degraded,
    // A report still generates with some sections unavailable, so this is not
    // a 500 — it is a working service with less to say.
    summary: !database
      ? 'The database is not ready — no report can be generated. See the "database" check below.'
      : degraded
        ? 'Reports will generate, but some sections will report that they could not be sourced.'
        : 'Every section can be sourced.',
    sections,
    checks,
  });
}

module.exports = { getProviders };
