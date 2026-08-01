/**
 * lib/aiRouter.js — every agent's only way to talk to Gemini.
 *
 * No agent touches the Gemini SDK directly. The router picks a model tier by
 * task type, retries once on a different model if the primary one's quota is
 * exhausted (so one saturated model doesn't fail the whole job), and is the
 * single place that logs usage into the ledger — so no agent has to
 * remember to do its own accounting, and the count stays exact.
 *
 * MODEL NAMES AND FALLBACK CHOICE ARE PLACEHOLDERS — verify the current
 * Gemini model lineup, names, and free-tier ceilings before deploying; these
 * change over time and this file is the one place to update them.
 */
const { GoogleGenAI } = require('@google/genai');
const ledger = require('./ledger');

/** Model tier per task — see the file header on verifying these before deploy. */
const MODEL_BY_TASK = {
  research: 'gemini-2.5-flash',  // grounded search, moderate reasoning
  write: 'gemini-2.5-flash',     // synthesis over already-gathered evidence, no grounding
  chat: 'gemini-2.5-flash',      // usually cheap lookups against existing evidence
};

/** Tried once if the primary model for a task reports its quota exhausted. */
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

/** @param {*} e @returns {boolean} best-effort detection of a quota/rate-limit error. */
function isQuotaError(e) {
  const msg = String((e && e.message) || e || '').toLowerCase();
  return msg.includes('quota') || msg.includes('rate limit') || msg.includes('resource_exhausted') || msg.includes('429');
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
    console.warn(`AI Router: ${primaryModel} quota exhausted for task "${task}", retrying on ${FALLBACK_MODEL}`);
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
