/**
 * project/autosave.js — never lose work to a refresh.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Every location, route, ring and shape lived in plain JavaScript variables and
 * nowhere else. A refresh, a crashed tab or a stray Ctrl-R threw the lot away
 * with no warning and no recovery. Saving was entirely manual, so the cost of
 * forgetting was total.
 *
 * WHY INDEXEDDB AND NOT LOCALSTORAGE
 *
 * localStorage is capped near 5 MB, stores only strings, and is *synchronous* —
 * every write blocks the main thread. Projects here embed base64 logos, custom
 * icon images and location photos, so one project can run to hundreds of KB and
 * a handful of them would breach the cap. IndexedDB is asynchronous, holds
 * orders of magnitude more, and stores the object directly through structured
 * clone, so there is no stringify on the hot path.
 *
 * WHY A TICK AND NOT `markDirty()` EVERYWHERE
 *
 * The obvious design is to call a dirty-flag from each mutation site. There are
 * upwards of twenty — every marker drag, ring edit, colour picker, route
 * re-route, shape vertex. Miss one and changes silently fail to save, which is
 * worse than having no autosave at all, because by then the user trusts it. A
 * periodic snapshot cannot miss anything. To keep it cheap it hashes the
 * serialised state and writes only when the hash moves, so an idle map costs one
 * serialise every few seconds and no I/O.
 *
 * WHY SNAPSHOTS
 *
 * Autosave faithfully records mistakes too. A short ring of previous states
 * means a bad edit — or a bad autosave — is recoverable rather than the new
 * truth.
 */

const AUTOSAVE_DB = 'dbotMapStudio';
const AUTOSAVE_DB_VERSION = 1;
const AUTOSAVE_STORE = 'sessions';
/** Key of the live session record. Snapshots live under `snap:<n>`. */
const AUTOSAVE_KEY = 'current';
/** How often to look for changes. Long enough to be invisible, short enough that
 *  a crash costs a few seconds of work rather than a few minutes. */
const AUTOSAVE_TICK_MS = 5000;
/** How many previous states to keep. */
const AUTOSAVE_SNAPSHOTS = 5;

let _asDb = null;
let _asLastHash = '';
let _asTimer = null;
let _asSuspended = false;
let _asLastEstimateAt = 0;

/* ---------------------------------------------------------------------------
 * IndexedDB, wrapped just enough
 * ------------------------------------------------------------------------- */

/** @returns {Promise<IDBDatabase|null>} null when IndexedDB is unavailable. */
function autosaveDb() {
  if (_asDb) return Promise.resolve(_asDb);
  if (!('indexedDB' in window)) return Promise.resolve(null);
  return new Promise(resolve => {
    let req;
    // Private-browsing modes in some browsers throw on open rather than
    // returning an error event, so this has to be guarded rather than trusted.
    try { req = indexedDB.open(AUTOSAVE_DB, AUTOSAVE_DB_VERSION); }
    catch (e) { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUTOSAVE_STORE)) db.createObjectStore(AUTOSAVE_STORE);
    };
    req.onsuccess = () => { _asDb = req.result; resolve(_asDb); };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/** @param {string} key @param {*} value @returns {Promise<boolean>} */
async function autosavePut(key, value) {
  const db = await autosaveDb();
  if (!db) return false;
  return new Promise(resolve => {
    let tx;
    try { tx = db.transaction(AUTOSAVE_STORE, 'readwrite'); }
    catch (e) { return resolve(false); }
    tx.objectStore(AUTOSAVE_STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    // QuotaExceededError lands here. Reported rather than swallowed, because a
    // silent failure to save is the exact thing this file exists to prevent.
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/** @param {string} key @returns {Promise<*>} */
async function autosaveGet(key) {
  const db = await autosaveDb();
  if (!db) return null;
  return new Promise(resolve => {
    let tx;
    try { tx = db.transaction(AUTOSAVE_STORE, 'readonly'); }
    catch (e) { return resolve(null); }
    const rq = tx.objectStore(AUTOSAVE_STORE).get(key);
    rq.onsuccess = () => resolve(rq.result || null);
    rq.onerror = () => resolve(null);
  });
}

/** @param {string} key @returns {Promise<boolean>} */
async function autosaveDelete(key) {
  const db = await autosaveDb();
  if (!db) return false;
  return new Promise(resolve => {
    let tx;
    try { tx = db.transaction(AUTOSAVE_STORE, 'readwrite'); }
    catch (e) { return resolve(false); }
    tx.objectStore(AUTOSAVE_STORE).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

/* ---------------------------------------------------------------------------
 * Change detection
 * ------------------------------------------------------------------------- */

/**
 * A cheap 32-bit hash (FNV-1a) of the serialised state.
 *
 * Only ever compared with itself, so collision resistance is irrelevant; speed
 * over a few hundred KB is what matters. Returned with the length appended,
 * which makes an accidental collision between two different-sized projects
 * impossible in practice.
 * @param {string} str @returns {string}
 */
function autosaveHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(36) + ':' + str.length;
}

/**
 * Serialise, and write if anything moved.
 * @param {{force?:boolean, reason?:string}} [opts]
 * @returns {Promise<boolean>} whether a write happened
 */
async function autosaveNow(opts) {
  if (_asSuspended) return false;
  const force = opts && opts.force;
  let proj;
  try { proj = serialiseProject(); }
  catch (e) { console.warn('Autosave: could not serialise —', e.message); return false; }

  // An empty map must still be recorded, or clearing everything and reloading
  // would resurrect the old work.
  const json = JSON.stringify(proj);
  const hash = autosaveHash(json);
  if (!force && hash === _asLastHash) return false;

  // Roll the previous state into the snapshot ring before overwriting it, so the
  // ring holds the last N *distinct* states rather than N copies of this one.
  const previous = _asLastHash ? await autosaveGet(AUTOSAVE_KEY) : null;
  const ok = await autosavePut(AUTOSAVE_KEY, { project: proj, at: Date.now(), reason: (opts && opts.reason) || 'tick' });
  if (!ok) {
    // Stop hammering a store that is refusing writes, and say so once.
    _asSuspended = true;
    autosaveSetIndicator('bad', 'Autosave failed — storage is full or blocked. Save to a file.');
    status('Autosave failed — browser storage is full or blocked. Save the project to a file.', true);
    return false;
  }
  _asLastHash = hash;
  if (previous && previous.project) await autosavePushSnapshot(previous);
  autosaveSetIndicator('ok', 'Saved ' + new Date().toLocaleTimeString() + ' — your work survives a refresh.');
  // The storage figure was only measured at boot, before anything had been
  // written, so it always read 0 B. Refreshed after a write but throttled —
  // estimate() is not free and the number moves slowly.
  if (Date.now() - _asLastEstimateAt > 30000) {
    _asLastEstimateAt = Date.now();
    autosaveRefreshStorageLine();
  }
  return true;
}

/**
 * Push one state onto the snapshot ring.
 * @param {{project:object, at:number}} record
 */
async function autosavePushSnapshot(record) {
  const meta = (await autosaveGet('snapshots')) || { seq: 0, ids: [] };
  const id = 'snap:' + (meta.seq + 1);
  const okWrite = await autosavePut(id, record);
  if (!okWrite) return;
  meta.seq += 1;
  meta.ids.push({ id, at: record.at,
    counts: {
      locations: (record.project.locations || []).length,
      routes: (record.project.routes || []).length,
      shapes: (record.project.geometries || []).length,
    } });
  while (meta.ids.length > AUTOSAVE_SNAPSHOTS) {
    const drop = meta.ids.shift();
    await autosaveDelete(drop.id);
  }
  await autosavePut('snapshots', meta);
}

/** @returns {Promise<Array<{id:string,at:number,counts:object}>>} newest first. */
async function autosaveSnapshots() {
  const meta = (await autosaveGet('snapshots')) || { ids: [] };
  return meta.ids.slice().reverse();
}

/**
 * Restore one snapshot by id. The state being replaced is itself pushed onto the
 * ring first, so stepping back is undoable.
 * @param {string} id @returns {Promise<boolean>}
 */
async function autosaveRestoreSnapshot(id) {
  const rec = await autosaveGet(id);
  if (!rec || !rec.project) { status('That snapshot is no longer available.'); return false; }
  await autosaveNow({ force: true, reason: 'before-snapshot-restore' });
  applyProject(rec.project, { silent: true });
  _asLastHash = '';                       // the restored state is new; let the tick record it
  const when = new Date(rec.at).toLocaleTimeString();
  status(`Restored the snapshot from ${when}.`);
  return true;
}

/* ---------------------------------------------------------------------------
 * Lifecycle
 * ------------------------------------------------------------------------- */

/**
 * Ask the browser to keep this data.
 *
 * Without it IndexedDB is "best-effort" and may be evicted under storage
 * pressure — which for a tool holding unsaved client work is a data-loss bug
 * waiting to happen. Browsers grant this silently when the site looks like it
 * matters to the user (installed, bookmarked, engaged) and decline otherwise;
 * either way it costs one call and no prompt.
 */
async function autosaveRequestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (!(await navigator.storage.persisted())) await navigator.storage.persist();
    }
  } catch (e) { /* not fatal — autosave still works, it is just evictable */ }
}

/** @returns {Promise<{usage:number,quota:number}|null>} */
async function autosaveStorageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    }
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Offer the restored session back to the user.
 *
 * Restored silently rather than behind a prompt — the point is that a refresh
 * costs nothing, and a dialog on every load defeats that. The line that says so
 * carries the escape hatch, because silent restore without a visible way out is
 * a trap when you wanted a blank map.
 * @param {object} rec
 */
function autosaveAnnounceRestore(rec) {
  const when = rec.at ? new Date(rec.at) : null;
  const ago = when ? Math.max(0, Math.round((Date.now() - when.getTime()) / 1000)) : null;
  const when_s = ago == null ? ''
    : ago < 90 ? ` from ${ago}s ago`
    : ago < 5400 ? ` from ${Math.round(ago / 60)} min ago`
    : ` from ${when.toLocaleString()}`;
  const p = rec.project || {};
  const bits = [
    (p.locations || []).length + ' location' + ((p.locations || []).length === 1 ? '' : 's'),
    (p.routes || []).length ? (p.routes || []).length + ' route' + ((p.routes || []).length === 1 ? '' : 's') : null,
    (p.geometries || []).length ? (p.geometries || []).length + ' shape' + ((p.geometries || []).length === 1 ? '' : 's') : null,
  ].filter(Boolean).join(', ');
  status(`Restored your last session${when_s} — ${bits}. Settings › Project › Start fresh to clear it.`, true);
}

/** Wipe the live session and the snapshot ring. */
async function autosaveDiscard() {
  const meta = (await autosaveGet('snapshots')) || { ids: [] };
  for (const s of meta.ids) await autosaveDelete(s.id);
  await autosaveDelete('snapshots');
  await autosaveDelete(AUTOSAVE_KEY);
  _asLastHash = '';
}

/**
 * Clear the map and forget the saved session.
 * @returns {Promise<void>}
 */
async function startFreshProject() {
  clearProject();
  await autosaveDiscard();
  // Record the now-empty state so a reload does not bring the old work back.
  await autosaveNow({ force: true, reason: 'start-fresh' });
  status('Started a fresh map — the previous session has been discarded.');
}

/**
 * Boot: restore, then start watching.
 *
 * `?reset=all` and `?reset=1` skip the restore, so there is always a way back to
 * a clean map from the URL even if the stored state is what is breaking.
 */
async function initAutosave() {
  const reset = new URLSearchParams(location.search).get('reset');
  autosaveRequestPersistence();

  if (!reset) {
    const rec = await autosaveGet(AUTOSAVE_KEY);
    if (rec && rec.project && projectHasContent(rec.project)) {
      try {
        applyProject(rec.project, { silent: true });
        autosaveAnnounceRestore(rec);
        // Seed the hash from what was just applied, so the first tick does not
        // rewrite an identical record.
        _asLastHash = autosaveHash(JSON.stringify(serialiseProject()));
      } catch (e) {
        console.warn('Autosave: restore failed —', e.message);
        status('Your last session could not be restored. Starting with a blank map.', true);
      }
    }
  } else if (reset === 'all') {
    await autosaveDiscard();
  }

  _asTimer = setInterval(() => { autosaveNow(); }, AUTOSAVE_TICK_MS);

  // `pagehide` and `visibilitychange` rather than `beforeunload`: beforeunload is
  // unreliable on mobile, where a tab is often frozen or killed without it ever
  // firing. These two are the pair that actually run.
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosaveNow({ reason: 'hidden' }); });
  addEventListener('pagehide', () => { autosaveNow({ reason: 'pagehide' }); });
}

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { autosaveHash };
}

/* ---------------------------------------------------------------------------
 * The Settings › This session panel
 * ------------------------------------------------------------------------- */

/** Paint the "saved / saving / failed" dot and its line. @param {string} state */
function autosaveSetIndicator(state, text) {
  const dot = $('asDot'), line = $('asState');
  if (dot) dot.className = 'as-dot ' + state;
  if (line && text) line.textContent = text;
}

/** Human file size. @param {number} n */
function autosaveBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

async function autosaveRefreshStorageLine() {
  const el = $('asStorage');
  if (!el) return;
  const est = await autosaveStorageEstimate();
  let persisted = false;
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; }
  catch (e) { /* ignore */ }
  const bits = [];
  if (est && est.quota) bits.push(`${autosaveBytes(est.usage)} of ${autosaveBytes(est.quota)} browser storage used`);
  // Worth stating plainly: without persistence granted the browser is allowed to
  // evict this data, so it is not a substitute for saving a file.
  bits.push(persisted
    ? 'Storage is marked persistent — the browser will not evict it.'
    : 'Storage is best-effort: the browser may clear it if space runs low. Save a file for anything you must keep.');
  el.textContent = bits.join(' · ');
}

/** List the snapshot ring in a dialog-free way: a status line plus buttons. */
async function autosaveShowSnapshots() {
  const snaps = await autosaveSnapshots();
  const host = $('asSnapList');
  if (!host) return;
  host.innerHTML = '';
  if (!snaps.length) {
    host.innerHTML = '<div class="sub">No earlier versions yet — one is kept each time the map changes.</div>';
    return;
  }
  snaps.forEach(s => {
    const row = document.createElement('div');
    row.className = 'as-snap';
    const when = new Date(s.at);
    const c = s.counts || {};
    row.innerHTML = `<span class="as-snap-when">${esc(when.toLocaleTimeString())}</span>`
      + `<span class="as-snap-meta">${c.locations || 0} loc · ${c.routes || 0} routes · ${c.shapes || 0} shapes</span>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = 'Restore';
    btn.addEventListener('click', async () => {
      await autosaveRestoreSnapshot(s.id);
      autosaveShowSnapshots();
    });
    row.appendChild(btn);
    host.appendChild(row);
  });
}

function initAutosaveUI() {
  const fresh = $('asFreshBtn');
  if (fresh) fresh.addEventListener('click', async () => {
    if (projectHasContent() && !confirm('Clear this map and discard the saved session?\n\nAnything you have not exported to a file will be gone.')) return;
    await startFreshProject();
    autosaveRefreshStorageLine();
    autosaveShowSnapshots();
  });

  const snapsBtn = $('asSnapsBtn');
  if (snapsBtn) {
    const list = document.createElement('div');
    list.id = 'asSnapList';
    list.className = 'as-snaps';
    list.hidden = true;
    snapsBtn.parentElement.parentElement.appendChild(list);
    snapsBtn.addEventListener('click', () => {
      list.hidden = !list.hidden;
      snapsBtn.textContent = list.hidden ? 'Earlier versions…' : 'Hide earlier versions';
      if (!list.hidden) autosaveShowSnapshots();
    });
  }

  autosaveRefreshStorageLine();
}
