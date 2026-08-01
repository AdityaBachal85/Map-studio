# AI Reports — backend setup

The AI Reports tab (`js/ui/aiTab.js`) is a thin client for a separate backend
in `functions/` — a Firebase Cloud Functions app that owns the Gemini key,
runs the research pipeline (`functions/src/agents/`), renders the PDF/DOCX,
and stores them for 48 hours. None of this is part of the static site's
GitHub Pages deploy; it's a second, manual deploy path you set up once.

Everything below is a one-time setup. After it's done, redeploying the
backend after a code change is just `firebase deploy --only functions`.

## What you need

Four accounts, all with usable free tiers for this workload:

| Service | For | Where |
|---|---|---|
| Firebase project (**Blaze plan**) | Cloud Functions, Cloud Tasks, Cloud Storage | [console.firebase.google.com](https://console.firebase.google.com) |
| Gemini API key | The actual research/writing calls | [aistudio.google.com](https://aistudio.google.com) |
| Neon (or any Postgres) | Reports, sites, the Evidence Store, the usage ledger | [neon.tech](https://neon.tech) |
| Upstash (or any Redis) | Job-status polling cache, per-IP rate limiting | [upstash.com](https://upstash.com) |

**Blaze plan note:** the async job pattern (`tasks/reportWorker.js`) needs
Cloud Functions 2nd-gen + Cloud Tasks, which requires a billing account on
the Firebase project — even though actual spend should stay near $0 given
the daily caps below. This is a Google requirement, not something this app
chose; a card on file is unavoidable, being charged for it in practice
shouldn't happen if the caps are respected.

## 1. Firebase project

```sh
npm install -g firebase-tools
firebase login
firebase projects:create your-project-id   # or use an existing one
```

Enable Blaze billing for the project in the [Firebase console](https://console.firebase.google.com)
(Settings → Usage and billing).

Edit `.firebaserc` at the repo root and replace the placeholder with your
real project id:

```json
{ "projects": { "default": "your-project-id" } }
```

## 2. Postgres (Neon)

Create a project at [neon.tech](https://neon.tech), then apply the schema:

```sh
psql "$YOUR_NEON_CONNECTION_STRING" -f functions/sql/schema.sql
```

Keep the connection string — it's `DATABASE_URL` below. Neon's pooled
connection string (the one with `-pooler` in the hostname) is the one to use
here; Cloud Functions instances are short-lived and don't benefit from a
direct, unpooled connection the way a long-running server would.

## 3. Redis (Upstash)

Create a database at [upstash.com](https://upstash.com) (the free tier is
plenty for this). From its dashboard, copy the **REST URL** and **REST
token** — not the Redis protocol connection string, the REST ones
(`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` below). The REST API
is what `@upstash/redis` uses, and it's what avoids Cloud Functions having to
hold a persistent TCP connection open between invocations.

## 4. Gemini API key

Create a key at [aistudio.google.com](https://aistudio.google.com). This key
lives **only** in the backend (a Cloud Functions secret, step 5) — it never
ships to the browser, and the app has no code path that would put it there.

## 5. Configure secrets

From the `functions/` directory:

```sh
cd functions
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set DATABASE_URL
firebase functions:secrets:set UPSTASH_REDIS_REST_URL
firebase functions:secrets:set UPSTASH_REDIS_REST_TOKEN
```

```sh
firebase functions:secrets:set ALLOWED_ORIGIN
```

Each prompts for the value and stores it in Secret Manager — nothing is
written to a file that could accidentally get committed. `ALLOWED_ORIGIN` is
the exact origin your GitHub Pages site is served from (e.g.
`https://your-org.github.io`, no trailing slash) — it isn't sensitive, but
it's kept in Secret Manager alongside the real secrets for one consistent
config mechanism rather than mixing two.

Firebase Functions v2 only populates `process.env.SECRET_NAME` for a
function that explicitly lists that secret in its own options — every
function in `functions/src/http/` and `functions/src/tasks/` already
declares exactly what it needs via `secrets: secrets.DB` /
`secrets.DB_CACHE` / `secrets.ALL` (see `functions/src/lib/secrets.js`), so
this is handled for you; it only matters if you add a new function later.

For **local emulator testing**, create `functions/.env` (already gitignored)
instead:

```
GEMINI_API_KEY=...
DATABASE_URL=...
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
ALLOWED_ORIGIN=http://localhost:8080
```

## 6. Storage bucket lifecycle (the 48-hour report expiry)

This isn't part of `firebase deploy` — it's a one-time bucket setting:

```sh
cat > /tmp/lifecycle.json <<'EOF'
{ "rule": [ { "action": {"type": "Delete"}, "condition": {"age": 2} } ] }
EOF
gcloud storage buckets update gs://your-project-id.appspot.com --lifecycle-file=/tmp/lifecycle.json
```

Note this deletes objects somewhere between ~48-72 hours after creation (the
rule is day-granular, swept once a day) — the *precise* "expires in 48
hours" the UI promises is actually enforced by the signed URL's own
expiry (`functions/src/lib/storage.js`), which is exact. The lifecycle rule
is the backstop that guarantees the bucket doesn't accumulate files forever
even if a signed URL is never followed.

## 7. Install, verify locally, deploy

```sh
cd functions
npm install
firebase emulators:start --only functions   # needs functions/.env from step 5
# in another terminal:
curl http://127.0.0.1:5001/your-project-id/asia-south1/getUsage
```

That should return a zeroed usage ledger for today. If it does, the whole
chain (Postgres, Redis, CORS, deploy config) is wired correctly and it's
safe to deploy for real:

```sh
firebase deploy --only functions
```

Note the deployed base URL Firebase prints (something like
`https://asia-south1-your-project-id.cloudfunctions.net`).

## 8. Point the client at it

Edit `js/config.js`:

```js
const AI_FUNCTIONS_BASE_URL = 'https://asia-south1-your-project-id.cloudfunctions.net';
```

That's the only client-side change. Redeploy the static site (GitHub Pages,
as normal) and the AI Reports tab is live.

## Tuning the daily caps

`functions/src/lib/ledger.js`'s `DEFAULT_CAPS` (`maxReportsPerDay`,
`maxTotalTokensPerDay`) ship with conservative placeholders. Check the
current Gemini free-tier limits for whichever model
`functions/src/lib/aiRouter.js` is configured to use before raising them —
those limits change over time and this repo can't know the current numbers
for you.

## Troubleshooting

- **`getUsage` 500s locally**: almost always a missing/wrong `DATABASE_URL`
  or the schema not having been applied yet (step 2).
- **`createReportJob` succeeds but the report never leaves `queued`**: check
  `firebase functions:log` for `reportWorker` — a Cloud Tasks misconfiguration
  (wrong region, queue not provisioned yet on first deploy) is the usual
  cause. Redeploying once queues exist typically resolves it.
- **CORS errors in the browser console**: `ALLOWED_ORIGIN` doesn't match the
  page's actual origin exactly (protocol + host, no trailing slash).
