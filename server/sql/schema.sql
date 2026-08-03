-- DBOT Map Studio v6 — AI report backend schema (any Postgres; Supabase is
-- what docs/AI-REPORTS-SETUP.md walks through).
--
-- This data is genuinely relational — a report belongs to a site, a site
-- belongs to a project, an agent run belongs to a report — which is why this
-- lives in Postgres rather than a document store. agent_runs.evidence is the
-- Evidence Store the Report Writer and Chat Agent both read from; normal
-- foreign keys give "every prior report for this site" for free.
--
-- IDs are app-generated (nanoid, see server/src/lib/db.js), stored as TEXT
-- — matches the plain-string job/report ids the client already works with,
-- and avoids depending on pgcrypto/gen_random_uuid() being available.
--
-- Apply once against a fresh database: `psql "$DATABASE_URL" -f sql/schema.sql`
-- (or paste the whole file into Supabase's SQL editor). Safe to run twice.
--
-- Every statement below is IF NOT EXISTS / idempotent, so a re-run is a no-op
-- that would otherwise print a screenful of "already exists, skipping"
-- NOTICEs. Those say nothing went wrong, so they're silenced; real warnings
-- and errors still surface.
SET client_min_messages TO WARNING;

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- This app has no user accounts yet — Map Studio is a single shared public
-- tool, not a multi-tenant one. The `projects` table is kept for when that
-- changes; until then every site belongs to one implicit default project,
-- seeded below, rather than the client having to invent and pass a project id
-- it has no real concept of.
INSERT INTO projects (id, name)
VALUES ('default', 'Default project')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sites (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  name        TEXT NOT NULL,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The client sends {name, lat, lng} on every report request, not a stable
-- site id — createReportJob finds-or-creates a site row by rounded
-- coordinates (see lib/db.js findOrCreateSite), so this index is the query
-- that lookup actually runs.
CREATE INDEX IF NOT EXISTS idx_sites_project_coords ON sites (project_id, lat, lng);

CREATE TABLE IF NOT EXISTS reports (
  id                     TEXT PRIMARY KEY,
  site_id                TEXT NOT NULL REFERENCES sites(id),
  status                 TEXT NOT NULL DEFAULT 'queued',
  -- Free-text note on how this job actually ran (which agents, any reuse from
  -- prior reports) — for debugging, not machine-parsed.
  provider_strategy_note TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The rendered documents themselves. Storing a few hundred KB inline keeps
  -- the whole backend on one free-tier service instead of requiring a blob
  -- store (which, on every major cloud, is the thing that forces a billing
  -- account). At the daily cap in lib/ledger.js and a 48h retention this tops
  -- out around 20-40 MB — comfortably inside a free Postgres tier. If reports
  -- ever grow large or retention lengthens, this is the seam to swap for
  -- object storage: only lib/storage.js reads or writes these columns.
  pdf_bytes              BYTEA,
  docx_bytes             BYTEA,
  -- Set to NULL by the expiry sweep once the files are dropped, so a report
  -- row survives (for the Evidence Store and reuse) after its downloads don't.
  expires_at             TIMESTAMPTZ,
  error                  TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_site ON reports (site_id, created_at DESC);
-- The concurrency gate (Phase E) counts reports in an active status.
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status) WHERE status NOT IN ('done', 'error');

CREATE TABLE IF NOT EXISTS agent_runs (
  id            TEXT PRIMARY KEY,
  report_id     TEXT NOT NULL REFERENCES reports(id),
  agent_name    TEXT NOT NULL, -- 'connectivity' | 'infrastructure' | 'government' | 'news' | 'writer'
  status        TEXT NOT NULL DEFAULT 'running', -- 'running' | 'done' | 'error' | 'reused'
  evidence      JSONB,          -- the agent's structured findings
  sources       JSONB,          -- grounding sources it cited, as [{title, uri}]
  usage         JSONB,          -- {promptTokens, completionTokens, totalTokens, groundingCalls}
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_report ON agent_runs (report_id);
-- The Project Context Agent's "reuse recent evidence for this site" query.
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_name ON agent_runs (agent_name, started_at DESC);

-- Upgrade path for a database created before reports carried their files
-- inline (the original design uploaded to Cloud Storage and kept only URLs).
-- Every statement is a no-op on a fresh database.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS pdf_bytes BYTEA;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS docx_bytes BYTEA;
ALTER TABLE reports DROP COLUMN IF EXISTS pdf_path;
ALTER TABLE reports DROP COLUMN IF EXISTS docx_path;
ALTER TABLE reports DROP COLUMN IF EXISTS pdf_url;
ALTER TABLE reports DROP COLUMN IF EXISTS docx_url;

-- The expiry sweep's query: find reports whose files are past their TTL but
-- haven't been cleared yet.
CREATE INDEX IF NOT EXISTS idx_reports_expiry ON reports (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS usage_ledger (
  date               DATE NOT NULL,
  -- Whichever model lib/aiRouter.js actually called, plus the reserved
  -- '_reports' row that counts reports rather than tokens.
  model              TEXT NOT NULL,
  prompt_tokens      BIGINT NOT NULL DEFAULT 0,
  completion_tokens  BIGINT NOT NULL DEFAULT 0,
  total_tokens       BIGINT NOT NULL DEFAULT 0,
  grounding_calls    BIGINT NOT NULL DEFAULT 0,
  reports_generated  BIGINT NOT NULL DEFAULT 0,
  reports_failed     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (date, model)
);

RESET client_min_messages;
