/**
 * projects/projectStore.js — many named projects, in this browser.
 *
 * WHAT CHANGED. Until now the app held exactly one project: autosave.js keeps
 * a single 'current' slot plus a ring of five snapshots, and "Save" produced a
 * .json download. That is a fine model for one map at a time and a poor one
 * for someone running twenty sites, which is what the projects page is for.
 *
 * WHY A SEPARATE DATABASE. autosave.js opens 'dbotMapStudio' at version 1.
 * Adding a store to it would mean opening at version 2, and then autosave's
 * own open — still asking for version 1 — fails with a VersionError. That
 * path is what protects unsaved work in a live editing session, so it is the
 * last thing to put at risk for a filing cabinet. A second database costs
 * nothing and cannot break the first.
 *
 * WHY TWO STORES INSIDE IT. Listing projects must stay fast when a project is
 * megabytes of geometry, so the row data ('meta': name, counts, timestamps,
 * size) lives apart from the document itself ('payload'). Rendering the page
 * reads only meta — a few hundred bytes per project — and the payload is
 * fetched only when something is actually opened.
 *
 * Every function resolves rather than throws: a browser in private mode may
 * refuse IndexedDB entirely, and the page has to stay usable and say so
 * instead of dying on load.
 */

const PROJECTS_DB = 'dbotMapStudioProjects';
const PROJECTS_DB_VERSION = 1;
const PROJECTS_META = 'meta';
const PROJECTS_PAYLOAD = 'payload';

let _pDb = null;

/** @returns {Promise<IDBDatabase|null>} null when IndexedDB is unavailable. */
function projectsDb() {
  if (_pDb) return Promise.resolve(_pDb);
  if (!('indexedDB' in window)) return Promise.resolve(null);
  return new Promise(resolve => {
    let req;
    try { req = indexedDB.open(PROJECTS_DB, PROJECTS_DB_VERSION); }
    catch (e) { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PROJECTS_META)) {
        const s = db.createObjectStore(PROJECTS_META, { keyPath: 'id' });
        // The page's default sort, so the common read needs no in-memory sort.
        s.createIndex('modified', 'modified');
        s.createIndex('owner', 'ownerId');
      }
      if (!db.objectStoreNames.contains(PROJECTS_PAYLOAD)) {
        db.createObjectStore(PROJECTS_PAYLOAD);
      }
    };
    req.onsuccess = () => { _pDb = req.result; resolve(_pDb); };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/**
 * @param {string|string[]} stores @param {IDBTransactionMode} mode
 * @param {function(IDBTransaction): void} body
 * @returns {Promise<boolean>} whether it committed
 */
function projectsTx(stores, mode, body) {
  return projectsDb().then(db => {
    if (!db) return false;
    return new Promise(resolve => {
      let tx;
      try { tx = db.transaction(stores, mode); }
      catch (e) { return resolve(false); }
      try { body(tx); } catch (e) { return resolve(false); }
      tx.oncomplete = () => resolve(true);
      // QuotaExceededError lands here. Reported, never swallowed — a silent
      // failure to save is the worst outcome this file can produce.
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  });
}

/** @param {IDBRequest} rq @returns {Promise<*>} */
function projectsReq(rq) {
  return new Promise(resolve => {
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => resolve(null);
  });
}

/** @returns {string} a short, sortable, collision-resistant id */
function projectsNewId() {
  return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Summarise a serialised project for the list, so the page never has to parse
 * a payload to draw a row.
 * @param {object} project @returns {{locations:number,routes:number,shapes:number,sites:number}}
 */
function projectsCounts(project) {
  const locs = (project && project.locations) || [];
  return {
    locations: locs.length,
    routes: ((project && project.routes) || []).length,
    shapes: ((project && project.geometries) || []).length,
    sites: locs.filter(l => l && l.type === 'site').length,
  };
}

/**
 * Every project belonging to one person, newest change first.
 * @param {string} ownerId @returns {Promise<object[]>} meta records only
 */
async function projectsList(ownerId) {
  const db = await projectsDb();
  if (!db) return [];
  const tx = db.transaction(PROJECTS_META, 'readonly');
  const all = await projectsReq(tx.objectStore(PROJECTS_META).getAll());
  return (all || [])
    .filter(p => !ownerId || p.ownerId === ownerId)
    .sort((a, b) => (b.modified || 0) - (a.modified || 0));
}

/** @param {string} id @returns {Promise<object|null>} the meta record */
async function projectsMeta(id) {
  const db = await projectsDb();
  if (!db) return null;
  const tx = db.transaction(PROJECTS_META, 'readonly');
  return await projectsReq(tx.objectStore(PROJECTS_META).get(id));
}

/** @param {string} id @returns {Promise<object|null>} the serialised project */
async function projectsLoad(id) {
  const db = await projectsDb();
  if (!db) return null;
  const tx = db.transaction(PROJECTS_PAYLOAD, 'readonly');
  return await projectsReq(tx.objectStore(PROJECTS_PAYLOAD).get(id));
}

/**
 * Create or overwrite a project. Both stores are written in one transaction,
 * so a failure can't leave a row pointing at a payload that isn't there.
 *
 * @param {{id?:string, name:string, ownerId:string, ownerName?:string, project:object}} rec
 * @returns {Promise<object|null>} the stored meta record, or null if it failed
 */
async function projectsSave(rec) {
  const id = rec.id || projectsNewId();
  const project = rec.project || {};
  const now = Date.now();
  const prev = rec.id ? await projectsMeta(rec.id) : null;

  const meta = {
    id,
    name: String(rec.name || 'Untitled project').trim() || 'Untitled project',
    ownerId: rec.ownerId,
    ownerName: rec.ownerName || '',
    created: prev ? prev.created : now,
    modified: now,
    counts: projectsCounts(project),
    // Measured on the string actually stored, so the storage meter reflects
    // real occupancy rather than an estimate that drifts from it.
    bytes: JSON.stringify(project).length,
  };

  const ok = await projectsTx([PROJECTS_META, PROJECTS_PAYLOAD], 'readwrite', tx => {
    tx.objectStore(PROJECTS_META).put(meta);
    tx.objectStore(PROJECTS_PAYLOAD).put(project, id);
  });
  return ok ? meta : null;
}

/** @param {string} id @param {string} name @returns {Promise<boolean>} */
async function projectsRename(id, name) {
  const meta = await projectsMeta(id);
  if (!meta) return false;
  meta.name = String(name || '').trim() || meta.name;
  meta.modified = Date.now();
  return await projectsTx(PROJECTS_META, 'readwrite', tx => tx.objectStore(PROJECTS_META).put(meta));
}

/** @param {string} id @returns {Promise<boolean>} */
async function projectsDelete(id) {
  return await projectsTx([PROJECTS_META, PROJECTS_PAYLOAD], 'readwrite', tx => {
    tx.objectStore(PROJECTS_META).delete(id);
    tx.objectStore(PROJECTS_PAYLOAD).delete(id);
  });
}

/**
 * @param {string} id @param {string} ownerId
 * @returns {Promise<object|null>} the new project's meta
 */
async function projectsDuplicate(id, ownerId) {
  const meta = await projectsMeta(id);
  const payload = await projectsLoad(id);
  if (!meta || !payload) return null;
  return await projectsSave({
    name: meta.name + ' (copy)',
    ownerId: ownerId || meta.ownerId,
    ownerName: meta.ownerName,
    project: payload,
  });
}

/**
 * Total bytes held, for the storage meter.
 * @param {string} ownerId @returns {Promise<{bytes:number, count:number, quota:number|null}>}
 */
async function projectsStorage(ownerId) {
  const list = await projectsList(ownerId);
  const bytes = list.reduce((n, p) => n + (p.bytes || 0), 0);
  let quota = null;
  // The browser's own figure, when it will give one — a fixed "1 GB" would be
  // a number we made up, and the real ceiling varies by browser and disk.
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      quota = est && est.quota ? est.quota : null;
    }
  } catch (e) { /* not available; the meter falls back to a bare total */ }
  return { bytes, count: list.length, quota };
}

/** @returns {Promise<boolean>} whether persistence could be secured. */
async function projectsRequestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (e) { /* fall through */ }
  return false;
}
