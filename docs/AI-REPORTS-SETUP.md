# AI Reports — backend setup

The AI Reports tab (`js/ui/aiTab.js`) is a thin client for a separate backend
in `server/` — a plain Node/Express app that owns the Gemini key, runs the
research pipeline (`server/src/agents/`), renders the PDF/DOCX, and stores
them for 48 hours.

None of this is part of the static site's GitHub Pages deploy. It's a second,
manual deploy you do once.

**Everything below is free and needs no credit card.**

## What you need

| Service | For | Free tier |
|---|---|---|
| [Supabase](https://supabase.com) | Postgres — reports, Evidence Store, usage ledger | 500 MB database, no card |
| [Render](https://render.com) | Runs the Node server | 750 hrs/month, no card |
| [Google AI Studio](https://aistudio.google.com) | Gemini API key | Free tier, no card |

Two things worth knowing before you start:

- **Render's free tier sleeps** after 15 minutes with no traffic. The next
  request wakes it, which takes ~50 seconds. See "Keeping it awake" below.
- **Supabase pauses a free project** after 7 days with no activity; you
  restore it with one click in their dashboard. Regular use avoids this.

Neither is a blocker, but both are better known up front than discovered
later.

## 1. Supabase — the database

You've already created the project. Now:

**Get the connection string.** Project Settings → Database → Connection
string → **URI**, and pick the **Session pooler** (not "Direct connection").

This matters: Supabase's direct connection is IPv6-only unless you pay for
the IPv4 add-on, and Render's free tier doesn't reach IPv6 — so a direct
connection string will fail with a confusing network error. The session
pooler is IPv4 and works.

It looks like:

```
postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
```

Replace `[YOUR-PASSWORD]` with your database password. If you don't have it,
reset it on that same settings page.

**If you get a certificate error on first connect**, append `?sslmode=no-verify`
to the string. `server/src/lib/db.js` reads that flag and relaxes certificate
verification while keeping the connection encrypted. Try without it first.

**Apply the schema.** Easiest path is Supabase's own SQL editor — open
**SQL Editor** in the sidebar, paste the entire contents of
`server/sql/schema.sql`, and run it. You should see five tables under
**Table Editor** afterwards: `projects`, `sites`, `reports`, `agent_runs`,
`usage_ledger`.

Or from a terminal, if you have `psql`:

```sh
psql "YOUR_CONNECTION_STRING" -f server/sql/schema.sql
```

The script is idempotent — running it twice is safe.

## 2. Gemini API key

Create one at [aistudio.google.com](https://aistudio.google.com/apikey).

Two things to check, because both have bitten this project already:

- **Confirm the key has quota.** In AI Studio, the key's Google Cloud project
  must have Gemini API quota available. A key whose project shows a daily
  limit of `0` authenticates fine and then fails every single call with a 429
  — which looks like a code bug and isn't one.
- **Never paste this key into a chat, a commit, or `js/config.js`.** It goes
  in Render's environment variables (step 3) and nowhere else. The browser
  never sees it; there is no code path in this app that would send it there.

## 3. Render — the server

1. Push this repo to GitHub (it already is).
2. In Render: **New → Web Service**, connect the repo.
3. Render reads `render.yaml` at the repo root and fills in the settings.
   Confirm they look right:
   - Root directory: `server`
   - Build: `npm install`
   - Start: `npm start`
   - Plan: **Free**
4. Add the environment variables (Render dashboard → Environment):

**Required:**

| Key | Value |
|---|---|
| `DATABASE_URL` | your Supabase session-pooler string from step 1 |
| `GEMINI_API_KEY` | your key from step 2 |
| `GOOGLE_MAPS_API_KEY` | the same Maps Platform key the site uses (`MAP_PROVIDER_KEYS.google` in `js/config.js`) |
| `ALLOWED_ORIGIN` | the exact origin of your live site, e.g. `https://adityabachal85.github.io` — no trailing slash, no path |

`GOOGLE_MAPS_API_KEY` turns the site's coordinates into place names before any
research runs. It matters more than it looks: no search engine indexes
`19.1547, 72.9986`, but every municipal notice and news story about the area
says "Airoli, Navi Mumbai". Without it the web agents search coordinates and
find nothing.

`ALLOWED_ORIGIN` is what stops other websites' JavaScript from calling your
backend and spending your quota. Get it exactly right: protocol + host,
nothing else.

**For the Government Projects and News sections** — at least one of these, or
those two sections will report that they could not be sourced:

| Key | Value |
|---|---|
| `PERPLEXITY_API_KEY` | a Perplexity key. Searches and writes in one call, and `search_domain_filter` restricts sources to the government and news domains in `server/src/agents/_shared.js` |
| `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX` | the free fallback: enable **Custom Search API** in the Cloud console (100 queries/day, no card) and create a Programmable Search Engine for the `cx` |

Gemini's own web-search grounding is **not** an option here, and this is not a
quota you can wait out. On the free tier its Search-grounding limit is zero —
verified against two separate keys: the identical call returns 200 without the
tool and 429 with it, while the model families that do carry a search
allowance answer 404 "no longer available to new users". Maps grounding is
unaffected and free, which is why Connectivity and Infrastructure work with no
search provider at all.

**Optional:**

| Key | Value |
|---|---|
| `OPENROUTER_API_KEY` | inference fallback. Only used for writing prose when both Gemini models fail — never for research, since a model that cannot search will invent sources |
| `PERPLEXITY_MODEL` | defaults to `sonar-pro` |
| `OPENROUTER_MODEL` | defaults to a free DeepSeek model |

5. Deploy. Render prints a URL like
   `https://map-studio-ai-reports.onrender.com`.

**Verify before going further:**

```sh
curl https://YOUR-SERVICE.onrender.com/health
# {"ok":true,"activeJobs":0}

curl https://YOUR-SERVICE.onrender.com/getUsage
# {"reportsGenerated":0,"reportsCap":20,...}

curl https://YOUR-SERVICE.onrender.com/health/providers
```

`/health` proves the process is up. `/getUsage` proves it reached Postgres —
if that one 500s, `DATABASE_URL` is wrong or the schema wasn't applied.

`/health/providers` is the one to read carefully. It calls every external
service with the keys this deployment actually holds and tells you **which
report sections can be sourced**:

```json
{ "ok": true,
  "sections": { "connectivity": "sourced", "infrastructure": "sourced",
                "government": "sourced", "news": "sourced" } }
```

Anything reading `"unavailable"` will say so in the report rather than being
filled with unsourced prose. Two rows are worth knowing how to read:

- **`gemini.mapsGrounding` ok but `sources: 0`** — the call succeeded and cited
  nothing. The prose will read fine and every claim in it will be unsourced.
- **`perplexity` ok but `citationShape: "none"`** — it answered, but no
  citations were parsed. Compare the `rawKeys` it reports against
  `extractCitations()` in `server/src/lib/webSearch.js`; the API has moved
  citations between fields before.

## 4. Point the site at it

Edit `js/config.js`:

```js
const AI_FUNCTIONS_BASE_URL = 'https://YOUR-SERVICE.onrender.com';
```

Commit and push. GitHub Pages redeploys as normal, and the AI Reports tab is
live. This is the only client-side change in the whole setup.

## Keeping it awake

On the free plan Render sleeps the service after 15 minutes idle, so the
first report after a quiet spell waits ~50 seconds on the cold start. The tab
shows its normal progress status throughout, so it looks slow rather than
broken — but if you'd rather avoid it, point any free uptime pinger
(UptimeRobot, cron-job.org) at `/health` every 10 minutes. That endpoint
touches neither Postgres nor Gemini, so pinging it is genuinely free.

Note this also keeps your Supabase project active, sidestepping the 7-day
pause.

## Tuning the daily caps

`server/src/lib/ledger.js` → `DEFAULT_CAPS` (`maxReportsPerDay: 20`,
`maxTotalTokensPerDay: 1_500_000`) are deliberately conservative placeholders.
Check the current Gemini free-tier limits for the model in
`server/src/lib/aiRouter.js` before raising them — those limits change over
time and this repo can't know today's numbers for you.

## How it works, briefly

Worth knowing when something goes wrong:

- `POST /createReportJob` runs the abuse gates, writes a `reports` row, starts
  the pipeline **in the background**, and returns a `jobId` in under a second.
- The pipeline (`server/src/pipeline/runReport.js`) runs four research agents
  in parallel, each doing its own grounded Google search via Gemini, then a
  writer agent that only synthesizes, then renders PDF + DOCX.
- The client polls `GET /getReportStatus` every ~4s.
- Documents are stored **in Postgres** and served by `GET /downloadReport`.
  There's no object storage to configure, and expiry is enforced at download
  time rather than baked into a URL that can't be revoked.

Because it's one long-lived process rather than serverless functions, there's
no job queue to provision — the server just runs the job. That's the whole
reason this setup is free.

## Troubleshooting

- **`/getUsage` returns 500** — `DATABASE_URL` is wrong, or the schema hasn't
  been applied. Check Render's logs for the actual Postgres error.
- **Postgres connection times out** — you used the direct connection string
  instead of the session pooler (see step 1). Render can't reach IPv6.
- **Certificate / SSL errors** — append `?sslmode=no-verify` to `DATABASE_URL`.
- **CORS errors in the browser console** — `ALLOWED_ORIGIN` doesn't exactly
  match your site's origin. Compare it character by character against what the
  browser address bar shows.
- **Every report fails at "Researching your site…"** — almost always the
  Gemini key: either wrong, or its project has no quota. Render's logs show
  the real error from Google, which usually says which.
- **A report is stuck mid-status forever** — it shouldn't be. The server fails
  orphaned jobs on boot and sweeps hung ones every 15 minutes. If you see one
  persist, check the logs for a crash loop.
- **First request of the day takes ~50s** — that's the free-tier cold start,
  not a bug. See "Keeping it awake".

## Moving off the free tier later

Nothing here locks you in:

- **Any Postgres works** — `DATABASE_URL` is the only knob. Neon, RDS, a VM.
- **Any Node host works** — no Render-specific code exists.
- **Redis is optional and already supported.** `server/src/lib/cache.js` uses
  in-process memory by default, which is correct for one instance. Set
  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` and it switches over
  automatically — do this **before** running more than one instance, since
  in-memory rate-limit counters aren't shared between processes.
- **Object storage**, if reports outgrow Postgres: `server/src/lib/storage.js`
  is the only file that touches the document columns.
