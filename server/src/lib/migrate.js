/**
 * lib/migrate.js — apply sql/schema.sql on boot.
 *
 * WHY THIS EXISTS. The schema used to be a manual step: open your provider's
 * SQL console, paste a file, run it. That instruction is easy to write and
 * easy to get wrong, and it fails *quietly* — the service starts, /health
 * says ok, and every request that touches Postgres returns a generic 500. The
 * one symptom points at the server; the actual cause is a step that happened
 * somewhere else entirely, or didn't.
 *
 * It is also unnecessary. This process already holds DATABASE_URL and can
 * reach the database — it is better placed to run the schema than a human
 * with a browser tab, and it can do it on every deploy rather than once,
 * which is what makes adding a column later a code change instead of another
 * out-of-band ritual.
 *
 * SAFE TO RUN EVERY TIME. Every statement in schema.sql is IF NOT EXISTS or
 * otherwise idempotent — that was already true, and documented in the file
 * itself, because it was always meant to be re-runnable.
 *
 * NEVER FATAL. A failure here logs loudly and lets the process start anyway,
 * so /health and /health/providers still answer and can be used to diagnose
 * it. Exiting instead would take away the tools you need to find out why.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'sql', 'schema.sql');

/**
 * @returns {Promise<{ok:boolean, tables?:string[], created?:boolean, error?:string}>}
 */
async function applySchema() {
  let sql;
  try {
    sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  } catch (e) {
    return { ok: false, error: `could not read ${SCHEMA_PATH}: ${e.message}` };
  }

  // What was there before, so the log can say whether this did anything.
  let before = [];
  try {
    const r = await db.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
    before = r.rows.map(x => x.tablename);
  } catch (e) {
    // Reaching the database at all is the first thing that can fail, and its
    // error ("password authentication failed", "timeout", a TLS complaint) is
    // far more useful than whatever the schema would have said afterwards.
    return { ok: false, error: `cannot reach the database: ${e.message}` };
  }

  try {
    // One call, not split on semicolons: node-postgres sends the whole string
    // as a simple query, and naive splitting breaks on any semicolon inside a
    // string literal or function body.
    await db.query(sql);
  } catch (e) {
    return { ok: false, error: `schema failed: ${e.message}` };
  }

  const after = (await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`))
    .rows.map(x => x.tablename);

  return { ok: true, tables: after, created: after.length > before.length };
}

/**
 * Run it, and say plainly in the log what happened.
 * @returns {Promise<object>} the same result, for /health/providers to report
 */
async function migrateOnBoot() {
  const result = await applySchema();
  if (!result.ok) {
    console.error('SCHEMA NOT APPLIED — every request that touches Postgres will fail.');
    console.error('  ' + result.error);
    console.error('  Check DATABASE_URL. It must be the Session pooler string '
      + '(host ends .pooler.supabase.com), not the direct connection, which is IPv6-only.');
    return result;
  }
  console.log(result.created
    ? `Schema applied — ${result.tables.length} tables: ${result.tables.join(', ')}`
    : `Schema already current — ${result.tables.length} tables`);
  return result;
}

module.exports = { applySchema, migrateOnBoot, SCHEMA_PATH };
