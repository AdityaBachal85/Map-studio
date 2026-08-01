-- DBOT Map Studio v6 — AI report backend schema (Postgres, e.g. Neon).
--
-- This data is genuinely relational — a report belongs to a site, a site
-- belongs to a project, an agent run belongs to a report — which is why this
-- lives in Postgres rather than a document store. agent_runs.evidence is the
-- Evidence Store the Report Writer and Chat Agent both read from; normal
-- foreign keys give "every prior report for this site" for free.
--
-- IDs are app-generated (nanoid, see functions/src/lib/db.js), stored as TEXT
-- — matches the plain-string job/report ids the client already works with,
-- and avoids depending on pgcrypto/gen_random_uuid() being available.
--
-- Apply once against a fresh database: `psql "$DATABASE_URL" -f sql/schema.sql`

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
  pdf_path               TEXT,
  docx_path              TEXT,
  pdf_url                TEXT,
  docx_url               TEXT,
  -- Drives the signed-URL TTL shown to the user. The Storage bucket lifecycle
  -- rule (see docs/AI-REPORTS-SETUP.md) is a coarser, day-granular backstop —
  -- this column is the precise 48h promise the UI actually makes.
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

CREATE TABLE IF NOT EXISTS usage_ledger (
  date               DATE NOT NULL,
  model              TEXT NOT NULL, -- Gemini model tier, e.g. 'gemini-2.5-flash'
  prompt_tokens      BIGINT NOT NULL DEFAULT 0,
  completion_tokens  BIGINT NOT NULL DEFAULT 0,
  total_tokens       BIGINT NOT NULL DEFAULT 0,
  grounding_calls    BIGINT NOT NULL DEFAULT 0,
  reports_generated  BIGINT NOT NULL DEFAULT 0,
  reports_failed     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (date, model)
);
