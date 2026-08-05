/**
 * lib/webSearch.js — live web evidence, from a provider that can actually see
 * the web.
 *
 * WHY THIS EXISTS. The four research agents were written against Gemini's
 * Google Search grounding. On the Gemini free tier that grounding is not
 * rate-limited — it is *zero*. Measured against two separate keys: an
 * ungrounded call to `gemini-3.5-flash-lite` returns 200, the identical call
 * with `google_search` returns 429, and the model families that do carry a
 * search-grounding allowance (Gemini 2.x) answer 404 "no longer available to
 * new users". Every combination is closed, so web research has to come from
 * somewhere else.
 *
 * TWO PROVIDERS, TWO SHAPES.
 *   answer()  — Perplexity. Searches *and* writes, returning prose with
 *               citations. One call, and `search_domain_filter` is a hard
 *               restriction rather than the polite suggestion Gemini's
 *               grounding could only ever be.
 *   results() — Google Programmable Search. Returns links and snippets and
 *               nothing else; the caller synthesises. Free (100/day) and
 *               already available on the project, so it is the fallback that
 *               keeps a report sourced when Perplexity credits run out.
 *
 * NOTHING HERE THROWS. Every function resolves to `{ok:false, reason}` on
 * failure. A research agent that cannot source its section must be able to
 * say so in the report; an exception would instead take down a pipeline that
 * still has three other sections' worth of good evidence.
 *
 * ON THE DEFENSIVE PARSING. This sandbox's egress policy blocks
 * api.perplexity.ai outright (403 to CONNECT), so unlike everything else in
 * this project the Perplexity path could not be verified against the live
 * service. It is written against the documented shape and tolerates the
 * variants that shape has taken — citations as bare URL strings, and
 * search_results as objects — because guessing wrong should degrade a
 * section, not corrupt it. `rawKeys` is returned so /health/providers can
 * report what the response actually looked like on the first real call.
 */

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const CUSTOM_SEARCH_URL = 'https://customsearch.googleapis.com/customsearch/v1';

/** Perplexity caps search_domain_filter at ten entries; keep prompts inside it. */
const MAX_DOMAINS = 10;
const REQUEST_TIMEOUT_MS = 90 * 1000;

/**
 * fetch with a deadline. A research agent that hangs holds a job slot
 * (MAX_CONCURRENT_JOBS is 3) until the ten-minute sweep reclaims it.
 * @param {string} url @param {object} init @param {number} ms
 */
async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {boolean} */
function perplexityConfigured() { return !!process.env.PERPLEXITY_API_KEY; }
/** @returns {boolean} */
function customSearchConfigured() {
  return !!(process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX);
}
/** @returns {boolean} true when at least one web provider can be used. */
function webSearchConfigured() { return perplexityConfigured() || customSearchConfigured(); }

/**
 * Pull citations out of a Perplexity response.
 *
 * The API has carried these in more than one place across versions, so all
 * the known shapes are accepted rather than betting on one:
 *   - `search_results: [{title, url, date}]`      — richest, preferred
 *   - `citations: ["https://…", …]`               — bare URLs
 *   - `choices[0].message.citations`              — same, nested
 * A URL with no title falls back to its hostname, which is what a reader
 * needs anyway: "nmmc.gov.in" says more than "Untitled".
 *
 * @param {object} json @returns {Array<{title:string, uri:string, date?:string}>}
 */
function extractCitations(json) {
  const out = [];
  const push = (uri, title, date) => {
    if (!uri || typeof uri !== 'string' || !/^https?:\/\//i.test(uri)) return;
    let label = title;
    if (!label) {
      try { label = new URL(uri).hostname.replace(/^www\./, ''); } catch (e) { label = uri; }
    }
    out.push(date ? { title: label, uri, date } : { title: label, uri });
  };

  const rich = json && json.search_results;
  if (Array.isArray(rich)) rich.forEach(r => r && push(r.url || r.uri, r.title, r.date));

  const flat = (json && json.citations)
    || (json && json.choices && json.choices[0] && json.choices[0].message
      && json.choices[0].message.citations);
  if (Array.isArray(flat)) {
    flat.forEach(c => (typeof c === 'string' ? push(c) : c && push(c.url || c.uri, c.title, c.date)));
  }

  const seen = new Set();
  return out.filter(s => !seen.has(s.uri) && seen.add(s.uri));
}

/**
 * Ask Perplexity a research question, restricted to a set of domains.
 *
 * @param {object} opts
 * @param {string} opts.question the actual research question, in full
 * @param {string[]} [opts.domains] hard allow-list, trimmed to ten
 * @param {'day'|'week'|'month'|'year'} [opts.recency]
 * @param {string} [opts.model]
 * @returns {Promise<{ok:boolean, text?:string, sources?:Array, usage?:object,
 *   provider?:string, rawKeys?:string[], reason?:string}>}
 */
async function answer({ question, domains, recency, model }) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return { ok: false, reason: 'PERPLEXITY_API_KEY is not set' };

  const body = {
    model: model || process.env.PERPLEXITY_MODEL || 'sonar-pro',
    messages: [{ role: 'user', content: question }],
  };
  if (domains && domains.length) body.search_domain_filter = domains.slice(0, MAX_DOMAINS);
  if (recency) body.search_recency_filter = recency;

  let res;
  try {
    res = await fetchWithTimeout(PERPLEXITY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, reason: `Perplexity unreachable: ${e.name === 'AbortError' ? 'timed out' : e.message}` };
  }

  const raw = await res.text();
  if (!res.ok) return { ok: false, reason: `Perplexity HTTP ${res.status}: ${raw.slice(0, 200)}` };

  let json;
  try { json = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'Perplexity returned non-JSON' }; }

  const text = json.choices && json.choices[0] && json.choices[0].message
    && json.choices[0].message.content;
  if (!text || !text.trim()) {
    return { ok: false, reason: 'Perplexity returned no content', rawKeys: Object.keys(json) };
  }

  const sources = extractCitations(json);
  const u = json.usage || {};
  return {
    ok: true,
    text: text.trim(),
    sources,
    usage: {
      promptTokens: u.prompt_tokens || 0,
      completionTokens: u.completion_tokens || 0,
      totalTokens: u.total_tokens || 0,
      searches: u.num_search_queries || 0,
    },
    provider: `perplexity/${body.model}`,
    // Reported by /health/providers so the first real call tells us the shape
    // rather than leaving it to a second guess.
    rawKeys: Object.keys(json),
  };
}

/**
 * Google Programmable Search — links and snippets, no synthesis.
 *
 * Domain restriction lives in the search engine's own configuration (the
 * `cx`), not in the query, so it cannot be diluted by a badly worded prompt.
 *
 * @param {object} opts
 * @param {string} opts.query keyword query, not a question
 * @param {'d'|'w'|'m'|'y'} [opts.recency] mapped to Google's dateRestrict
 * @param {number} [opts.limit]
 * @returns {Promise<{ok:boolean, results?:Array<{title:string,uri:string,snippet:string}>,
 *   provider?:string, reason?:string}>}
 */
async function results({ query, recency, limit }) {
  const key = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  if (!key || !cx) return { ok: false, reason: 'GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_CX are not set' };

  const params = new URLSearchParams({ key, cx, q: query, num: String(Math.min(10, limit || 10)) });
  if (recency) params.set('dateRestrict', recency + '1');   // e.g. "y1" = past year

  let res;
  try {
    res = await fetchWithTimeout(`${CUSTOM_SEARCH_URL}?${params}`, {}, REQUEST_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, reason: `Custom Search unreachable: ${e.name === 'AbortError' ? 'timed out' : e.message}` };
  }

  const raw = await res.text();
  if (!res.ok) {
    // The "not enabled" case is worth naming precisely — it is one checkbox
    // in the Cloud console, and an operator reading the log should not have
    // to guess that from a bare 403.
    const enableHint = /has not been used|is disabled/.test(raw)
      ? ' — enable Custom Search API in the Google Cloud console' : '';
    return { ok: false, reason: `Custom Search HTTP ${res.status}${enableHint}` };
  }

  let json;
  try { json = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'Custom Search returned non-JSON' }; }

  const rows = (json.items || []).map(i => ({
    title: i.title || i.link,
    uri: i.link,
    snippet: (i.snippet || '').replace(/\s+/g, ' ').trim(),
  })).filter(r => r.uri);

  if (!rows.length) return { ok: false, reason: 'Custom Search found nothing for this query' };
  return { ok: true, results: rows, provider: 'google-programmable-search' };
}

/**
 * Drop citations that no longer resolve.
 *
 * A dead link in a report handed to a client costs more than the citation was
 * worth. HEAD is cheap, runs in parallel, and anything that errors outright is
 * *kept* rather than dropped — a site refusing HEAD is common, and silently
 * deleting real sources because of it would be its own bug.
 *
 * @param {Array<{title:string,uri:string}>} sources
 * @returns {Promise<Array<{title:string,uri:string}>>}
 */
async function dropDeadLinks(sources) {
  if (!sources || !sources.length) return sources || [];
  const checked = await Promise.all(sources.map(async s => {
    try {
      const res = await fetchWithTimeout(s.uri, { method: 'HEAD', redirect: 'follow' }, 8000);
      return res.status === 404 || res.status === 410 ? null : s;
    } catch (e) {
      return s;                            // unreachable from here ≠ dead
    }
  }));
  return checked.filter(Boolean);
}

module.exports = {
  answer, results, dropDeadLinks, extractCitations,
  perplexityConfigured, customSearchConfigured, webSearchConfigured,
  MAX_DOMAINS,
};
