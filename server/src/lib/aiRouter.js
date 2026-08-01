/**
 * lib/aiRouter.js — every agent's only way to talk to Gemini.
 *
 * No agent touches the Gemini SDK directly. The router picks a model tier by
 * task type, retries once on a different model if the primary one's quota is
 * exhausted (so one saturated model doesn't fail the whole job), and is the
 * single place that logs usage into the ledger — so no agent has to
 * remember to do its own accounting, and the count stays exact.
 *
 * Model names were live-verified against the Gemini API on 2026-08-01 (a
 * direct `models.list()` call plus real `generateContent` probes) —
 * `gemini-2.5-flash`, the prior placeholder, now 404s with "no longer
 * available to new users" even though it's still listed. `-latest` aliases
 * are what Google funnels new callers to and are the more deprecation-
 * resistant choice for a deploy-and-forget app; re-verify with the same
 * approach (list + probe, not just checking the docs) if it's been a while.
 */
const { GoogleGenAI } = require('@google/genai');
const ledger = require('./ledger');

/** Model tier per task — see the file header on verifying these before deploy. */
const MODEL_BY_TASK = {
  research: 'gemini-flash-latest',  // grounded search, moderate reasoning
  write: 'gemini-flash-latest',     // synthesis over already-gathered evidence, no grounding
  chat: 'gemini-flash-latest',      // usually cheap lookups against existing evidence
};

/** Tried once if the primary model for a task reports its quota exhausted. A distinct, explicitly-versioned model (not another `-latest` alias) so it isn't sharing the same quota bucket as the primary. */
const FALLBACK_MODEL = 'gemini-2.0-flash';

let _client = null;
/** @returns {GoogleGenAI} */
function client() {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set — see docs/AI-REPORTS-SETUP.md');
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

/**
 * @param {*} e @returns {boolean} best-effort detection of an error worth
 * retrying on the fallback model — quota/rate-limit, or the primary model
 * having been deprecated out from under a pinned name server-side (a real,
 * live-observed failure mode: `gemini-2.5-flash` started 404ing with "no
 * longer available to new users" while still appearing in `models.list()`).
 */
function isQuotaError(e) {
  const msg = String((e && e.message) || e || '').toLowerCase();
  return msg.includes('quota') || msg.includes('rate limit') || msg.includes('resource_exhausted') || msg.includes('429')
    || msg.includes('no longer available') || (msg.includes('404') && msg.includes('not found'));
}

/**
 * One Gemini call, routed and logged.
 * @param {{task:'research'|'write'|'chat', prompt:string, grounded?:boolean}} opts
 * @returns {Promise<{text:string, sources:Array<{title:string,uri:string}>, usage:object, model:string}>}
 */
async function ask({ task, prompt, grounded }) {
  const primaryModel = MODEL_BY_TASK[task] || MODEL_BY_TASK.research;
  try {
    return await callModel(primaryModel, prompt, grounded);
  } catch (e) {
    if (!isQuotaError(e) || primaryModel === FALLBACK_MODEL) throw e;
    console.warn(`AI Router: ${primaryModel} unavailable for task "${task}" (${e.message}), retrying on ${FALLBACK_MODEL}`);
    return await callModel(FALLBACK_MODEL, prompt, grounded);
  }
}

/**
 * @param {string} model @param {string} prompt @param {boolean} [grounded]
 * @returns {Promise<{text:string, sources:Array<{title:string,uri:string}>, usage:object, model:string}>}
 */
async function callModel(model, prompt, grounded) {
  const config = grounded ? { tools: [{ googleSearch: {} }] } : undefined;
  const response = await client().models.generateContent({ model, contents: prompt, config });

  const text = response.text || '';
  const usageMeta = response.usageMetadata || {};
  const usage = {
    promptTokens: usageMeta.promptTokenCount || 0,
    completionTokens: usageMeta.candidatesTokenCount || 0,
    totalTokens: usageMeta.totalTokenCount || 0,
    grounded: !!grounded,
  };

  const groundingChunks = (response.candidates && response.candidates[0]
    && response.candidates[0].groundingMetadata && response.candidates[0].groundingMetadata.groundingChunks) || [];
  const sources = groundingChunks
    .map(c => c.web && { title: c.web.title || c.web.uri, uri: c.web.uri })
    .filter(Boolean);

  await ledger.recordUsage(model, usage).catch(e => console.warn('recordUsage failed (non-fatal):', e.message));

  return { text, sources, usage, model };
}

module.exports = { ask, MODEL_BY_TASK, FALLBACK_MODEL };
