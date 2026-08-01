/**
 * lib/jobs.js — the in-process replacement for Cloud Tasks.
 *
 * The original design queued the report pipeline as a Cloud Task because a
 * serverless function cannot keep running after it returns a response. This
 * backend is a long-lived process, so it simply doesn't have that problem:
 * `start()` kicks the pipeline off and returns immediately, the HTTP handler
 * responds with a job id, and the work continues on the same process while
 * the client polls. Postgres remains the source of truth for job state, so a
 * poll is answered from the database, not from anything held in memory here.
 *
 * That removes the single dependency (Cloud Tasks) that forced a billing
 * account onto the whole stack.
 *
 * What a queue gave us for free and we now have to do deliberately:
 *  - concurrency limiting (below — an unbounded fan-out would blow through
 *    Gemini's per-minute quota and the process's memory at the same time)
 *  - surviving a restart. We can't: an in-flight job dies with the process.
 *    `sweepInterrupted()` is the answer — on boot, any report still sitting in
 *    a non-terminal status is one no process is working on any more, so it's
 *    marked failed rather than left to poll forever.
 */

/** Hard ceiling on pipelines running at once in this process. Distinct from the request-level gate in http/createReportJob.js: that one rejects the user politely, this one is the last line of defense. */
const MAX_CONCURRENT_JOBS = 3;

/** A job stuck this long is treated as hung and failed by the watchdog. */
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

/** reportId -> {startedAt} for everything currently running in this process. */
const running = new Map();

/** @returns {number} how many pipelines are running right now. */
function activeCount() {
  return running.size;
}

/**
 * Start a report pipeline in the background.
 *
 * Deliberately NOT awaited by the caller — the HTTP handler returns a job id
 * immediately and the client polls. `onDone`/`onError` therefore have to
 * handle their own failures: there is nobody left to catch a rejection here,
 * and an unhandled one would take the whole process down.
 *
 * @param {string} reportId
 * @param {() => Promise<void>} work
 * @param {(reportId:string, error:Error) => Promise<void>} onError
 * @returns {boolean} false if the concurrency ceiling was already reached
 */
function start(reportId, work, onError) {
  if (running.size >= MAX_CONCURRENT_JOBS) return false;

  running.set(reportId, { startedAt: Date.now() });

  work()
    .catch(async (e) => {
      console.error(`job ${reportId} failed:`, e);
      try { await onError(reportId, e); }
      catch (inner) { console.error(`job ${reportId}: failed to record its own failure:`, inner); }
    })
    .finally(() => { running.delete(reportId); });

  return true;
}

/**
 * Fail any report left in a non-terminal status, and free its slot.
 *
 * Called on boot (where every such report is a casualty of the previous
 * process exiting) and periodically (where it catches a pipeline that hung
 * past JOB_TIMEOUT_MS without throwing — a Gemini call that never settles,
 * say). Without this a killed job polls as 'researching' forever and the
 * concurrency gate leaks a slot permanently.
 *
 * @param {object} db @param {string} reason
 * @param {boolean} onlyStale when true, spare reports still legitimately running in this process
 * @returns {Promise<number>} how many reports were failed
 */
async function sweepInterrupted(db, reason, onlyStale) {
  const cutoff = new Date(Date.now() - JOB_TIMEOUT_MS).toISOString();
  const res = onlyStale
    ? await db.query(
        `UPDATE reports SET status = 'error', error = $1, updated_at = now()
         WHERE status NOT IN ('done', 'error') AND updated_at < $2
         RETURNING id`,
        [reason, cutoff]
      )
    : await db.query(
        `UPDATE reports SET status = 'error', error = $1, updated_at = now()
         WHERE status NOT IN ('done', 'error')
         RETURNING id`,
        [reason]
      );

  for (const row of res.rows) running.delete(row.id);
  return res.rowCount || 0;
}

module.exports = { start, activeCount, sweepInterrupted, MAX_CONCURRENT_JOBS, JOB_TIMEOUT_MS };
