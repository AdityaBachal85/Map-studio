/**
 * project/history.js — one undo stack for everything on the map.
 *
 * Undo used to mean "undo a drawing operation". It knew about creating,
 * deleting and reshaping a geometry, and about nothing else — so dragging a
 * pin, renaming a location, restyling a route, moving a label, changing a
 * colour, adding a waypoint were all one-way doors. That is the wrong shape for
 * a tool people arrange things in: most of the work here *is* moving things
 * around, and the moves were the part you could not take back.
 *
 * WHY SNAPSHOTS AND NOT COMMANDS. The alternative is instrumenting every edit
 * with a before/after pair, which means touching several dozen call sites and
 * then remembering to touch the next one somebody adds. Every one that gets
 * forgotten is an action that silently cannot be undone, and you only find out
 * when you need it. serialiseProject() already produces a complete, tested
 * description of the whole map — it is what Save and autosave write — so
 * comparing it against itself catches every change by construction, including
 * ones written after this file.
 *
 * WHY POLLING. There is no central "something changed" signal to hook, and
 * inventing one has the same forget-a-call-site problem. So the state is
 * fingerprinted on a timer, and a snapshot is committed only once the map has
 * stopped changing for one interval. That trailing edge is what makes a
 * two-second drag one undo step instead of five: the intermediate positions
 * never settle, so they are never committed.
 *
 * WHAT IT COSTS. One serialise per tick while the map is being edited, which is
 * the same work autosave already does on its own timer, and nothing at all once
 * the map is idle (the fingerprint matches and no string is kept). Memory is
 * bounded twice over — by entry count and by total bytes — because a project
 * with a few thousand route vertices is not small and thirty of them would be
 * worse than no undo at all.
 */

/** How often the map is fingerprinted, ms. */
const HISTORY_TICK_MS = 450;

/** Most steps kept. Deep enough to get out of trouble, shallow enough to hold. */
const HISTORY_MAX_ENTRIES = 15;

/** Total budget for the stacks, bytes. Oldest entries drop first. */
const HISTORY_MAX_BYTES = 12 * 1024 * 1024;

const historyUndo = [];
const historyRedo = [];

/** The state as of the last committed step — what an undo goes back to. */
let historyCommitted = null;

/** The last thing the poller saw, used to detect that changes have settled. */
let historySeen = null;

let historyTimer = null;

/** True while an undo or redo is being applied, so it is not itself recorded. */
let historyApplying = false;

/**
 * The current map state as a comparable string.
 *
 * Two fields are stripped, and both matter:
 *
 * `savedAt` is a fresh timestamp on every call. Left in, no two snapshots are
 * ever equal, the state never "settles", and the watcher below never commits a
 * single step — the whole feature silently does nothing while looking like it
 * is running.
 *
 * `view` is the map's centre and zoom. Panning and zooming are not edits, and
 * with them in, scrolling the map would fill the undo stack with steps that
 * change nothing you can see — and undoing a real edit would drag the map back
 * to wherever it happened to be.
 *
 * @returns {string|null} the state, or null if it cannot be read
 */
function historySnapshot() {
  try {
    const proj = serialiseProject();
    delete proj.savedAt;
    delete proj.view;
    return JSON.stringify(proj);
  } catch (e) {
    return null;
  }
}

/** @param {Array<string>} stack @returns {number} total bytes held */
function historyBytes(stack) {
  return stack.reduce((n, s) => n + s.length, 0);
}

/** Drop the oldest entries until both caps are satisfied. */
function historyTrim() {
  while (historyUndo.length > HISTORY_MAX_ENTRIES) historyUndo.shift();
  while (historyUndo.length > 1
    && historyBytes(historyUndo) + historyBytes(historyRedo) > HISTORY_MAX_BYTES) {
    historyUndo.shift();
  }
}

/** Enable/disable both pairs of buttons to match the stacks. */
function historyUpdateButtons() {
  const set = (id, on) => { const b = document.getElementById(id); if (b) b.disabled = !on; };
  set('drawUndoBtn', historyUndo.length);
  set('drawRedoBtn', historyRedo.length);
  set('mapUndoBtn', historyUndo.length);
  set('mapRedoBtn', historyRedo.length);
}

/**
 * Record the current state as a step, if it differs from the last one.
 *
 * Called by the poller once changes settle, and directly by anything that
 * knows it has just finished a discrete action and would rather not wait —
 * creating or deleting a shape, say, where the tick would be a visible lag
 * between doing the thing and being able to take it back.
 */
function historyCommit() {
  if (historyApplying) return;
  const now = historySnapshot();
  if (now === null || now === historyCommitted) return;

  if (historyCommitted !== null) {
    historyUndo.push(historyCommitted);
    // A new action after an undo ends that branch — the same rule every editor
    // uses, and the only one that keeps the stack a stack.
    historyRedo.length = 0;
    historyTrim();
  }
  historyCommitted = now;
  historySeen = now;
  historyUpdateButtons();
}

/**
 * Put a snapshot back on the map, without moving the map.
 *
 * The snapshot has no `view` — see historySnapshot() — and applyProject()
 * reads a missing view as "no framing was saved" and calls fitAll(), which
 * zooms to everything on the map. So an undo of a colour change would have
 * re-framed the whole plan. Handing it the view we are already looking at
 * makes that branch a no-op instead.
 *
 * @param {string} json
 */
function historyApply(json) {
  historyApplying = true;
  try {
    const proj = JSON.parse(json);
    const c = map.getCenter();
    proj.view = { c: [c.lat, c.lng], z: map.getZoom() };
    applyProject(proj, { silent: true });
  } catch (e) {
    console.warn('History: could not apply a step —', e && e.message);
  } finally {
    // Resync after the rebuild rather than trusting the string: applyProject
    // normalises some fields, and a mismatch here would make the very next tick
    // record a phantom step for a change nobody made.
    historyApplying = false;
    historyCommitted = historySnapshot();
    historySeen = historyCommitted;
    historyUpdateButtons();
  }
}

/** Step back one action. */
function doUndo() {
  // Anything typed but not yet settled is part of what is being undone.
  historyCommit();
  if (!historyUndo.length) { status('Nothing left to undo.'); return; }
  const prev = historyUndo.pop();
  if (historyCommitted !== null) historyRedo.push(historyCommitted);
  historyApply(prev);
  status('Undone. Ctrl+Shift+Z to redo.');
}

/** Step forward one action. */
function doRedo() {
  if (!historyRedo.length) { status('Nothing to redo.'); return; }
  const next = historyRedo.pop();
  if (historyCommitted !== null) historyUndo.push(historyCommitted);
  historyApply(next);
  status('Redone.');
}

/** Forget everything — used when a different project is opened. */
function historyReset() {
  historyUndo.length = 0;
  historyRedo.length = 0;
  historyCommitted = historySnapshot();
  historySeen = historyCommitted;
  historyUpdateButtons();
}

/**
 * Start watching. Called once the project has finished loading, so the state
 * it opens with becomes the baseline rather than an undoable step.
 */
function historyStart() {
  if (historyTimer) return;
  historyCommitted = historySnapshot();
  historySeen = historyCommitted;
  historyUpdateButtons();

  historyTimer = setInterval(() => {
    if (historyApplying) return;
    const now = historySnapshot();
    if (now === null) return;

    // Settled: what we saw last tick is still what is there, and it differs
    // from the committed step. One drag, one entry.
    if (now === historySeen && now !== historyCommitted) {
      historyUndo.push(historyCommitted);
      historyRedo.length = 0;
      historyTrim();
      historyCommitted = now;
      historyUpdateButtons();
      return;
    }
    historySeen = now;
  }, HISTORY_TICK_MS);
}

/* Wiring for the map-corner pair. The Draw tab's buttons are wired in
   map/drawing.js, which owns them; these are the same two functions, put
   somewhere reachable from every tab because undo is no longer a drawing
   feature. */
(function wireMapHistoryButtons() {
  const u = document.getElementById('mapUndoBtn');
  const r = document.getElementById('mapRedoBtn');
  if (u) u.addEventListener('click', doUndo);
  if (r) r.addEventListener('click', doRedo);
  historyUpdateButtons();
})();
