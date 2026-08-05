/**
 * lib/db.js — Postgres access (Neon or any standard Postgres).
 *
 * One pooled client shared across a function instance's lifetime. Serverless
 * Postgres providers generally want a *small* pool per instance (each Cloud
 * Functions instance is its own process) — verify the current recommended
 * `max` for your provider before raising it; the default here is
 * deliberately conservative.
 */
const { Pool } = require('pg');
const { nanoid } = require('nanoid');

let _pool = null;

/**
 * SSL settings, driven by `sslmode` in DATABASE_URL (standard libpq
 * semantics) so this is fixable by editing the connection string rather than
 * this file.
 *
 * Hosted Postgres providers differ on certificates: some present a publicly
 * trusted chain that verifies out of the box, others (Supabase's direct
 * connection among them) present one that won't validate without downloading
 * their CA. `sslmode=no-verify` is the escape hatch for that case — it still
 * encrypts, it just stops checking who's on the other end, so prefer a
 * provider/endpoint that verifies cleanly when you have the choice.
 *
 * @param {string} connectionString
 * @returns {object|false}
 */
function sslConfig(connectionString) {
  const mode = sslModeOf(connectionString);
  if (mode === 'disable') return false;
  if (mode === 'no-verify' || mode === 'allow' || mode === 'prefer') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

/** @param {string} [connectionString] @returns {string|null} the sslmode in the URL, if any. */
function sslModeOf(connectionString) {
  return (String(connectionString || '').match(/[?&]sslmode=([^&]+)/) || [])[1] || null;
}

/**
 * What the connection is actually configured to do, for /health/providers.
 *
 * Reported because "self-signed certificate in certificate chain" and "you
 * did not add ?sslmode=no-verify" look identical from outside the process,
 * and telling them apart otherwise means another round of asking someone to
 * re-check a dashboard field they believe they already set.
 *
 * Never returns any part of the credential — host and port only.
 * @returns {{host:string|null, sslmode:string|null, verifyCertificate:boolean|null}}
 */
function connectionInfo() {
  const cs = process.env.DATABASE_URL || '';
  let host = null;
  try { const u = new URL(cs); host = u.hostname + ':' + (u.port || '5432'); } catch (e) { /* unparseable */ }
  const ssl = cs ? sslConfig(cs) : null;
  return {
    host,
    sslmode: sslModeOf(cs),
    verifyCertificate: ssl === null ? null : (ssl === false ? false : !!ssl.rejectUnauthorized),
  };
}

/** @returns {import('pg').Pool} */
function pool() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set — see docs/AI-REPORTS-SETUP.md');
  _pool = new Pool({
    connectionString,
    max: 3,
    ssl: sslConfig(connectionString),
    // A hosted database behind a pooler can take a moment on a cold start
    // (both Supabase and Neon suspend idle projects); the default 0 means
    // "wait forever", which would hang a request rather than fail it.
    connectionTimeoutMillis: 15000,
  });
  // A pooled client can be dropped by the provider between queries. Without a
  // listener, pg emits this as an unhandled 'error' event, which is fatal to
  // the process — the pool itself recovers by opening a new connection.
  _pool.on('error', (e) => console.warn('postgres idle client error (pool will recover):', e.message));
  return _pool;
}

/**
 * Run a parameterized query.
 * @param {string} text @param {Array<*>} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
function query(text, params) {
  return pool().query(text, params);
}

/** A new id in the same shape used for reports, sites, and agent runs. */
const newId = () => nanoid(16);

/**
 * Find an existing site by (rounded) coordinates, or create one.
 *
 * The client sends {name, lat, lng} on every request rather than a stable
 * site id, so this is how the same physical location resolves to the same
 * `sites` row across separate report requests — which is what lets the
 * Project Context Agent find prior evidence for "this site" at all. Rounded
 * to 5 decimal places (~1m) so float noise from repeated geocoding doesn't
 * mint a new row for a site that hasn't actually moved.
 *
 * @param {{name:string, lat:number, lng:number}} site
 * @returns {Promise<string>} the site's id
 */
async function findOrCreateSite(site) {
  const lat = Math.round(site.lat * 1e5) / 1e5;
  const lng = Math.round(site.lng * 1e5) / 1e5;
  const existing = await query(
    `SELECT id FROM sites WHERE project_id = 'default' AND lat = $1 AND lng = $2 LIMIT 1`,
    [lat, lng]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const id = newId();
  await query(
    `INSERT INTO sites (id, project_id, name, lat, lng) VALUES ($1, 'default', $2, $3, $4)`,
    [id, site.name || 'Untitled site', lat, lng]
  );
  return id;
}

/**
 * Create a new report row in 'queued' status.
 * @param {string} siteId
 * @returns {Promise<string>} the report's id (also the job id)
 */
async function createReportRow(siteId) {
  const id = newId();
  await query(`INSERT INTO reports (id, site_id, status) VALUES ($1, $2, 'queued')`, [id, siteId]);
  return id;
}

/**
 * Update a report's status and any of the columns that accompany a
 * transition (error message, file paths/urls, expiry). Only supplied fields
 * are written — omit a field to leave it as-is.
 * @param {string} reportId @param {string} status
 * @param {object} [fields]
 */
async function updateReportStatus(reportId, status, fields) {
  const f = fields || {};
  const sets = ['status = $2', 'updated_at = now()'];
  const params = [reportId, status];
  let i = 3;
  for (const [col, val] of Object.entries(f)) {
    sets.push(`${col} = $${i}`);
    params.push(val);
    i++;
  }
  await query(`UPDATE reports SET ${sets.join(', ')} WHERE id = $1`, params);
}

/**
 * A report row plus the site it's for (joined, not a separate query) — every
 * caller that needs a report also needs to know what site it's about.
 * @param {string} reportId @returns {Promise<object|null>}
 */
async function getReport(reportId) {
  const res = await query(
    `SELECT r.*, s.name AS site_name, s.lat AS site_lat, s.lng AS site_lng
     FROM reports r JOIN sites s ON s.id = r.site_id
     WHERE r.id = $1`,
    [reportId]
  );
  return res.rows[0] || null;
}

/**
 * Record one research agent's run. Call once when it starts (status:
 * 'running') and again to update it on completion — this is the Evidence
 * Store other agents (Report Writer, Chat Agent) read from.
 * @param {string} reportId @param {string} agentName
 * @returns {Promise<string>} the agent_run id
 */
async function startAgentRun(reportId, agentName) {
  const id = newId();
  await query(
    `INSERT INTO agent_runs (id, report_id, agent_name, status) VALUES ($1, $2, $3, 'running')`,
    [id, reportId, agentName]
  );
  return id;
}

/**
 * @param {string} agentRunId @param {'done'|'error'|'reused'} status
 * @param {{evidence?:object, sources?:object, usage?:object, error?:string}} [fields]
 */
async function completeAgentRun(agentRunId, status, fields) {
  const f = fields || {};
  await query(
    `UPDATE agent_runs SET status = $2, evidence = $3, sources = $4, usage = $5, error = $6, completed_at = now()
     WHERE id = $1`,
    [agentRunId, status, f.evidence ? JSON.stringify(f.evidence) : null,
      f.sources ? JSON.stringify(f.sources) : null, f.usage ? JSON.stringify(f.usage) : null, f.error || null]
  );
}

/** @param {string} reportId @returns {Promise<object[]>} every agent_runs row for a report, oldest first. */
async function getAgentRuns(reportId) {
  const res = await query(`SELECT * FROM agent_runs WHERE report_id = $1 ORDER BY started_at ASC`, [reportId]);
  return res.rows;
}

/**
 * The most recent successful run of one agent for a site, across all of that
 * site's reports — what the Project Context Agent checks before deciding
 * whether to re-research or reuse. Caller applies its own staleness policy
 * against `completed_at` (see the open risk on this in the design doc — a
 * "recent enough" window is a real judgment call per agent, not a fixed
 * global constant).
 * @param {string} siteId @param {string} agentName
 * @returns {Promise<object|null>}
 */
async function mostRecentAgentRun(siteId, agentName) {
  const res = await query(
    `SELECT ar.* FROM agent_runs ar
     JOIN reports r ON r.id = ar.report_id
     WHERE r.site_id = $1 AND ar.agent_name = $2 AND ar.status = 'done'
     ORDER BY ar.completed_at DESC LIMIT 1`,
    [siteId, agentName]
  );
  return res.rows[0] || null;
}

/** @returns {Promise<number>} how many reports are currently in an active (non-terminal) status. */
async function countActiveReports() {
  const res = await query(`SELECT count(*)::int AS n FROM reports WHERE status NOT IN ('done', 'error')`);
  return res.rows[0].n;
}

module.exports = {
  pool, query, newId, connectionInfo, sslModeOf,
  findOrCreateSite, createReportRow, updateReportStatus, getReport,
  startAgentRun, completeAgentRun, getAgentRuns, mostRecentAgentRun,
  countActiveReports,
};
