/**
 * server.js — the backend's entry point.
 *
 * A plain, long-lived Express process. That single fact is what removes the
 * managed job queue, the object store, and the Redis instance that the
 * original Cloud Functions design needed — and with them the billing account
 * that made the whole feature cost money to run. See docs/AI-REPORTS-SETUP.md.
 *
 * Deployable to anything that runs Node and gives you a $PORT: Render, Koyeb,
 * Fly, a VM. Nothing here is host-specific.
 */
const express = require('express');
const db = require('./lib/db');
const jobs = require('./lib/jobs');
const storage = require('./lib/storage');
const { getUsage } = require('./http/getUsage');
const { createReportJob } = require('./http/createReportJob');
const { getReportStatus } = require('./http/getReportStatus');
const { downloadReport } = require('./http/downloadReport');
const { chat } = require('./http/chat');

const PORT = process.env.PORT || 8080;
/** How often to look for jobs that hung, and files that outlived their 48h. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

const app = express();

// Every free host puts a reverse proxy in front of this process. Without
// this, req.ip is the proxy's address — meaning every visitor shares one
// rate-limit bucket — and req.protocol reads 'http', which would produce
// broken http:// download links from an https:// site.
app.set('trust proxy', true);

app.use(express.json({ limit: '1mb' }));

// Cheap and dependency-free, so an uptime pinger can hold a sleepy free-tier
// instance awake without touching Postgres or Gemini.
app.get('/health', (req, res) => res.status(200).json({ ok: true, activeJobs: jobs.activeCount() }));

app.get('/getUsage', getUsage);
app.post('/createReportJob', createReportJob);
app.get('/getReportStatus', getReportStatus);
app.get('/downloadReport', downloadReport);
app.post('/chat', chat);

// Catch-all preflight. Written as middleware rather than app.options('*')
// because the wildcard path syntax differs between Express 4 and 5 and
// silently 404s on the wrong one — this matches on the method instead, which
// behaves the same on both.
app.use((req, res, next) => {
  if (req.method !== 'OPTIONS') { next(); return; }
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  if (allowedOrigin) res.set('Access-Control-Allow-Origin', allowedOrigin);
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '86400');
  res.status(204).send('');
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

/**
 * Periodic maintenance: fail jobs that hung, and free expired report files.
 *
 * Both were somebody else's problem in the original design — Cloud Tasks
 * timed a task out, and a bucket lifecycle rule deleted old objects. Running
 * our own process means owning both.
 * @param {boolean} onlyStale see lib/jobs.js — false only on boot
 */
async function sweep(onlyStale) {
  try {
    const failed = await jobs.sweepInterrupted(
      db,
      onlyStale
        ? 'This report stopped responding and was cancelled — please try again.'
        : 'The server restarted while this report was being generated — please try again.',
      onlyStale
    );
    if (failed) console.log(`sweep: failed ${failed} interrupted report(s)`);

    const cleared = await storage.sweepExpiredFiles();
    if (cleared) console.log(`sweep: cleared ${cleared} expired report file(s)`);
  } catch (e) {
    console.error('sweep failed (will retry next interval):', e.message);
  }
}

const server = app.listen(PORT, () => {
  console.log(`AI reports backend listening on :${PORT}`);

  // On boot, anything still mid-flight belongs to a process that no longer
  // exists — nothing is going to finish it, so fail it now rather than leave
  // the client polling a status that can never change.
  sweep(false);
  const timer = setInterval(() => sweep(true), SWEEP_INTERVAL_MS);
  if (timer.unref) timer.unref();
});

/**
 * Stop taking new work, let in-flight requests finish, then exit. Hosts send
 * SIGTERM before replacing an instance; without this, a deploy would cut off
 * responses mid-flight. In-flight *report jobs* still die here — that's what
 * the boot sweep above exists to clean up.
 */
function shutdown(signal) {
  console.log(`${signal} received — shutting down`);
  server.close(() => {
    db.pool().end().catch(() => {}).finally(() => process.exit(0));
  });
  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app };
