/**
 * lib/ledger.js — the usage ledger: a real, self-counted record of what
 * this deployment has spent with Gemini today, since our Cloud Functions are
 * the only caller of the key. This is what the "credits used today" widget
 * shows and what the daily caps (Phase E) enforce against — an exact ledger,
 * not an estimate, because nothing else is spending against this key.
 *
 * One row per (date, model) in Postgres. Day boundary is Asia/Kolkata, not
 * UTC — this is an India-focused tool, and "resets at midnight IST" is the
 * framing that actually matches the UI.
 */
const db = require('./db');

/** Reasonable v1 placeholders — finalize against real Gemini free-tier numbers before launch (Phase E). */
const DEFAULT_CAPS = {
  maxReportsPerDay: 20,
  maxTotalTokensPerDay: 1_500_000,
};

/** @returns {string} today's date in Asia/Kolkata, as YYYY-MM-DD. */
function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

/** @returns {string} ISO timestamp for the next Asia/Kolkata midnight. */
function nextResetISO() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const istMidnight = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate() + 1, 0, 0, 0);
  const offsetMs = now.getTime() - istNow.getTime();
  return new Date(istMidnight.getTime() + offsetMs).toISOString();
}

/**
 * Read (creating if absent) today's ledger row for one model.
 * @param {string} model
 * @returns {Promise<object>}
 */
async function getOrCreateToday(model) {
  const date = todayIST();
  const existing = await db.query(`SELECT * FROM usage_ledger WHERE date = $1 AND model = $2`, [date, model]);
  if (existing.rows[0]) return existing.rows[0];
  await db.query(
    `INSERT INTO usage_ledger (date, model) VALUES ($1, $2) ON CONFLICT (date, model) DO NOTHING`,
    [date, model]
  );
  const created = await db.query(`SELECT * FROM usage_ledger WHERE date = $1 AND model = $2`, [date, model]);
  return created.rows[0];
}

/**
 * Record one Gemini call's usage. Called by the AI Router right after each
 * call returns successfully — not after any later rendering/upload step —
 * since the spend already happened at that point and a later failure must
 * not let it go unlogged.
 * @param {string} model
 * @param {{promptTokens?:number, completionTokens?:number, totalTokens?:number, grounded?:boolean}} usage
 */
async function recordUsage(model, usage) {
  const date = todayIST();
  await getOrCreateToday(model);
  await db.query(
    `UPDATE usage_ledger SET
       prompt_tokens = prompt_tokens + $3,
       completion_tokens = completion_tokens + $4,
       total_tokens = total_tokens + $5,
       grounding_calls = grounding_calls + $6
     WHERE date = $1 AND model = $2`,
    [date, model, usage.promptTokens || 0, usage.completionTokens || 0, usage.totalTokens || 0, usage.grounded ? 1 : 0]
  );
}

/** Bump today's report counter. @param {boolean} succeeded */
async function recordReportOutcome(succeeded) {
  const date = todayIST();
  await db.query(
    `INSERT INTO usage_ledger (date, model, reports_generated, reports_failed)
     VALUES ($1, '_reports', $2, $3)
     ON CONFLICT (date, model) DO UPDATE SET
       reports_generated = usage_ledger.reports_generated + $2,
       reports_failed = usage_ledger.reports_failed + $3`,
    [date, succeeded ? 1 : 0, succeeded ? 0 : 1]
  );
}

/**
 * Everything the daily caps (Phase E) and the client's usage widget need, in
 * one call: today's report count and per-model token totals.
 * @returns {Promise<{reportsGenerated:number, reportsCap:number, totalTokens:number, tokenBudget:number, resetsAt:string, byModel:object}>}
 */
async function getTodaySummary() {
  const date = todayIST();
  const res = await db.query(`SELECT * FROM usage_ledger WHERE date = $1`, [date]);
  const byModel = {};
  let reportsGenerated = 0;
  let totalTokens = 0;
  for (const row of res.rows) {
    if (row.model === '_reports') { reportsGenerated = Number(row.reports_generated); continue; }
    byModel[row.model] = {
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      totalTokens: Number(row.total_tokens),
      groundingCalls: Number(row.grounding_calls),
    };
    totalTokens += Number(row.total_tokens);
  }
  return {
    reportsGenerated,
    reportsCap: DEFAULT_CAPS.maxReportsPerDay,
    totalTokens,
    tokenBudget: DEFAULT_CAPS.maxTotalTokensPerDay,
    resetsAt: nextResetISO(),
    byModel,
  };
}

module.exports = { DEFAULT_CAPS, todayIST, nextResetISO, getOrCreateToday, recordUsage, recordReportOutcome, getTodaySummary };
