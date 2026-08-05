/**
 * lib/aiRouter.js — every agent's only way to reach a model or a search
 * provider. No agent talks to an API directly.
 *
 * ── WHY THIS WAS REWRITTEN ────────────────────────────────────────────────
 * The router used to take `grounded: true`, which meant one thing: attach
 * Gemini's `google_search` tool. On the Gemini free tier that tool's quota is
 * not small, it is **zero**, so every research agent would have failed on its
 * first call and no report would ever have completed. Measured against two
 * separate keys, August 2026:
 *
 *   gemini-3.5-flash-lite, no tools        -> 200 OK
 *   gemini-3.5-flash-lite + google_search  -> 429, limit 0
 *   gemini-3.5-flash-lite + google_maps    -> 200 OK, real cited places
 *   gemini-2.5-flash (has a search quota)  -> 404 "no longer available to new users"
 *
 * So `grounded` became `evidence`, naming *where the facts come from*:
 *
 *   'maps'  Gemini + the google_maps tool. Free, 500/day, and genuinely good
 *           at place questions — 13 real named schools for an Airoli site.
 *   'web'   lib/webSearch.js: Perplexity (search + write, hard domain filter)
 *           falling back to Google Programmable Search + a synthesis pass.
 *   false   No evidence needed. The writer synthesising sections that were
 *           already researched and cited.
 *
 * Maps grounding is deliberately NOT a fallback for 'web'. Asked about
 * government projects it returns HTTP 200 with citations that are nearby
 * apartment blocks, and prose hedged into meaninglessness. It fails *quietly*,
 * which in a document handed to a client is worse than failing loudly.
 *
 * ── WHY REST RATHER THAN THE SDK ──────────────────────────────────────────
 * @google/genai 0.11.0 (what's installed) types `googleSearch` but has no
 * `googleMaps`, so the SDK cannot express the one tool that works here.
 * Upgrading is a 0.11 -> 2.15 major jump that can't be validated from this
 * environment. The REST call, by contrast, was verified end to end by direct
 * probe — request body, response shape, grounding chunks and usage field
 * names all measured rather than assumed.
 *
 * ── MODEL PINNING ─────────────────────────────────────────────────────────
 * `gemini-flash-latest` used to be the primary. It is a drifting alias, and
 * Google moved it onto a tier where grounding is 0 — silently, with nothing
 * in the app noticing. Research models are pinned to explicit ids now, and
 * the "verify before deploy" note is not decorative: check with a real probe,
 * not the docs, and not `models.list()` either. That listing advertises
 * models this project cannot call.
 */
const ledger = require('./ledger');
const webSearch = require('./webSearch');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 120 * 1000;

/**
 * Pinned per task. Both were probed live: callable, 15 RPM / 500 RPD, and —
 * unlike every non-Lite Gemini 3 model — carrying a Maps-grounding allowance.
 */
const MODEL_BY_TASK = {
  research: 'gemini-3.5-flash-lite',
  write: 'gemini-3.5-flash-lite',
  chat: 'gemini-3.5-flash-lite',
};

/** A different model in a different quota bucket, also probed live. */
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';

/** Free-tier model used when falling back to OpenRouter for plain synthesis. */
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3-0324:free';

/**
 * Worth retrying on the other model.
 *
 * Covers three failures actually observed against the live API: quota
 * exhaustion, a pinned model deprecated out from under us (`gemini-2.5-flash`
 * began 404ing with "no longer available to new users" while still appearing
 * in models.list()), and transient overload — `gemini-3.5-flash-lite`
 * returned 503 "experiencing high demand" twice during testing, which is not
 * a reason to fail a whole report.
 * @param {*} e @returns {boolean}
 */
function isRetryable(e) {
  const msg = String((e && e.message) || e || '').toLowerCase();
  return msg.includes('quota') || msg.includes('rate limit') || msg.includes('resource_exhausted')
    || msg.includes('429') || msg.includes('no longer available')
    || (msg.includes('404') && msg.includes('not found'))
    || msg.includes('503') || msg.includes('high demand') || msg.includes('overloaded');
}

/** @param {string} url @param {object} init */
async function fetchWithTimeout(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** @param {Array<{uri:string}>} list */
function dedupe(list) {
  const seen = new Set();
  return (list || []).filter(s => s && s.uri && !seen.has(s.uri) && seen.add(s.uri));
}

/**
 * One Gemini generateContent call.
 *
 * @param {string} model @param {string} prompt
 * @param {'maps'|null} [tool]
 * @returns {Promise<{text:string, sources:Array, usage:object, model:string, provider:string}>}
 */
async function callGemini(model, prompt, tool) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set — see docs/AI-REPORTS-SETUP.md');

  const body = { contents: [{ parts: [{ text: prompt }] }] };
  if (tool === 'maps') body.tools = [{ google_maps: {} }];

  const res = await fetchWithTimeout(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${raw.slice(0, 220)}`);

  let json;
  try { json = JSON.parse(raw); } catch (e) { throw new Error('Gemini returned non-JSON'); }
  if (json.error) throw new Error(`Gemini ${json.error.code}: ${json.error.message}`);

  const cand = (json.candidates || [])[0] || {};
  const text = ((cand.content && cand.content.parts) || [])
    .map(p => p.text || '').join('').trim();

  // A maps chunk carries `.maps`, a web one `.web`; both expose {uri, title}.
  const chunks = (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
  const sources = chunks
    .map(c => c.maps || c.web)
    .filter(s => s && s.uri)
    .map(s => ({ title: s.title || s.uri, uri: s.uri }));

  const u = json.usageMetadata || {};
  const usage = {
    promptTokens: u.promptTokenCount || 0,
    completionTokens: u.candidatesTokenCount || 0,
    totalTokens: u.totalTokenCount || 0,
    grounded: !!tool,
  };
  await ledger.recordUsage(model, usage).catch(e => console.warn('recordUsage failed (non-fatal):', e.message));
  return { text, sources: dedupe(sources), usage, model, provider: `gemini/${model}` };
}

/**
 * Plain synthesis through OpenRouter — the second leg for ungrounded work.
 *
 * Exists because this whole rewrite was caused by a single provider changing
 * a limit without warning. With one inference provider a repeat of that kills
 * every report; with two it degrades one. Never used for evidence gathering:
 * OpenRouter routes to models, and a model with no search is exactly what
 * produced "the Airoli-Katai Naka Freeway" with zero sources.
 *
 * @param {string} prompt
 * @returns {Promise<{text:string, sources:Array, usage:object, model:string, provider:string}>}
 */
async function callOpenRouter(prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');

  const res = await fetchWithTimeout(OPENROUTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'user', content: prompt }] }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${raw.slice(0, 200)}`);

  let json;
  try { json = JSON.parse(raw); } catch (e) { throw new Error('OpenRouter returned non-JSON'); }
  const text = (((json.choices || [])[0] || {}).message || {}).content;
  if (!text) throw new Error('OpenRouter returned no content');

  const u = json.usage || {};
  const usage = {
    promptTokens: u.prompt_tokens || 0,
    completionTokens: u.completion_tokens || 0,
    totalTokens: u.total_tokens || 0,
    grounded: false,
  };
  await ledger.recordUsage(`openrouter/${OPENROUTER_MODEL}`, usage)
    .catch(e => console.warn('recordUsage failed (non-fatal):', e.message));
  return { text: text.trim(), sources: [], usage, model: OPENROUTER_MODEL, provider: `openrouter/${OPENROUTER_MODEL}` };
}

/**
 * Gemini, retried once on the fallback model, then OpenRouter.
 * @param {string} task @param {string} prompt @param {'maps'|null} tool
 */
async function callModelWithFallback(task, prompt, tool) {
  const primary = MODEL_BY_TASK[task] || MODEL_BY_TASK.research;
  try {
    return await callGemini(primary, prompt, tool);
  } catch (e) {
    if (!isRetryable(e)) throw e;
    console.warn(`AI Router: ${primary} failed for "${task}" (${e.message}) — retrying on ${FALLBACK_MODEL}`);
    try {
      return await callGemini(FALLBACK_MODEL, prompt, tool);
    } catch (e2) {
      // Maps grounding is the point of a 'maps' call; OpenRouter cannot do it,
      // so answering from a model with no places data would be a different
      // question answered confidently. Fail instead.
      if (tool || !process.env.OPENROUTER_API_KEY) throw e2;
      console.warn(`AI Router: ${FALLBACK_MODEL} also failed (${e2.message}) — trying OpenRouter`);
      return await callOpenRouter(prompt);
    }
  }
}

/**
 * Gather web evidence and turn it into a written section.
 *
 * Perplexity answers and cites in one call, so its prose is used directly.
 * Programmable Search only returns links and snippets, so those get handed to
 * a model with an explicit instruction not to go beyond them — the model is
 * summarising a fixed set of pages, not recalling anything, which is what
 * keeps the citations honest.
 *
 * @param {{question:string, query?:string, domains?:string[], recency?:string}} web
 * @param {string} task
 * @returns {Promise<{text:string, sources:Array, usage:object, model:string,
 *   provider:string, unsourced?:string, rawKeys?:string[]}>}
 */
async function researchWeb(web, task) {
  const reasons = [];

  if (webSearch.perplexityConfigured()) {
    const a = await webSearch.answer({
      question: web.question, domains: web.domains, recency: web.recency,
    });
    if (a.ok) {
      return {
        text: a.text, sources: dedupe(a.sources), usage: a.usage,
        model: a.provider, provider: a.provider, rawKeys: a.rawKeys,
      };
    }
    reasons.push(a.reason);
    console.warn(`AI Router: Perplexity unavailable (${a.reason}) — falling back to Programmable Search`);
  } else {
    reasons.push('Perplexity not configured');
  }

  if (webSearch.customSearchConfigured()) {
    const r = await webSearch.results({
      query: web.query || web.question,
      recency: ({ day: 'd', week: 'w', month: 'm', year: 'y' })[web.recency],
    });
    if (r.ok) {
      const numbered = r.results
        .map((x, i) => `[${i + 1}] ${x.title}\n    ${x.uri}\n    ${x.snippet}`).join('\n\n');
      const prompt = `${web.question}

Below are search results. Answer using ONLY what these results actually say. Cite each factual claim with its bracketed number. Where the results do not answer part of the question, say so plainly instead of filling the gap from memory. Write clear prose, not bullet fragments.

${numbered}`;
      const out = await callModelWithFallback(task, prompt, null);
      return {
        text: out.text,
        sources: dedupe(r.results.map(x => ({ title: x.title, uri: x.uri }))),
        usage: out.usage, model: out.model, provider: `${r.provider}+${out.provider}`,
      };
    }
    reasons.push(r.reason);
  } else {
    reasons.push('Programmable Search not configured');
  }

  // Deliberately no third attempt. An ungrounded model asked a research
  // question answers it confidently and wrongly, and a section that says
  // nothing is recoverable where an invented one is not.
  return {
    text: '', sources: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    model: 'none', provider: 'none', unsourced: reasons.join('; '),
  };
}

/**
 * The one call every agent makes.
 *
 * @param {object} opts
 * @param {'research'|'write'|'chat'} opts.task
 * @param {string} opts.prompt
 * @param {'maps'|'web'|false} [opts.evidence] where the facts come from
 * @param {{question:string, query?:string, domains?:string[], recency?:string}} [opts.web]
 *   required when evidence is 'web'
 * @returns {Promise<{text:string, sources:Array<{title:string,uri:string}>,
 *   usage:object, model:string, provider:string, unsourced?:string}>}
 */
async function ask({ task, prompt, evidence, web }) {
  if (evidence === 'web') {
    if (!web || !web.question) throw new Error('evidence:"web" requires a web.question');
    return await researchWeb(web, task);
  }
  return await callModelWithFallback(task, prompt, evidence === 'maps' ? 'maps' : null);
}

module.exports = {
  ask, callGemini, callOpenRouter, isRetryable,
  MODEL_BY_TASK, FALLBACK_MODEL, OPENROUTER_MODEL,
};
