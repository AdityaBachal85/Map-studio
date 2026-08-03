/**
 * services/placeCache.js — a bounded, expiring cache that survives a reload.
 *
 * The in-memory caches in geoapify.js and nearbyPlaces.js already stop the
 * app asking Google the same question twice — a chip toggled off and on, a
 * radius narrowed, a query retyped all cost nothing. What they cannot do is
 * survive an F5. Reopening yesterday's project, or refreshing after an edit,
 * re-buys every answer at full price, and the answers have not changed: the
 * schools around a site are the same schools they were this morning.
 *
 * So the same entries are mirrored to localStorage and read back on boot.
 *
 * TERMS. Google's Maps Platform terms allow Places content to be cached for up
 * to 30 days (Place IDs indefinitely). MAX_AGE_MS is set well inside that at
 * 7 days, which is also about as long as "the hospitals near this plot" stays
 * true enough to hand a client.
 *
 * ARRAYS WITH PROPERTIES. Both callers hang metadata off the results array —
 * `capped`, `radiusM`, `source`, `note`, `outside` — and JSON.stringify drops
 * every non-index property of an array. Losing `capped` in particular would be
 * silently wrong: a truncated twenty-item answer would look complete, and
 * nearbyNarrowable() would happily shrink it to a smaller radius, dropping
 * places that really are inside the smaller circle. So entries are stored as
 * {rows, meta} and rebuilt, never as a bare array.
 */

const PLACE_CACHE_KEY = 'dbot.placeCache.v1';
const PLACE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Rough ceiling on what we are willing to spend of a ~5 MB localStorage budget. */
const PLACE_CACHE_MAX_BYTES = 600 * 1024;
/** Properties the callers hang off a results array. Order is irrelevant. */
const PLACE_CACHE_META = ['capped', 'radiusM', 'source', 'note', 'outside'];

/** ns -> { key -> {t:number, rows:Array, meta:object} }, most-recent-last. */
let _placeStore = null;

function placeCacheLoad() {
  if (_placeStore) return _placeStore;
  _placeStore = {};
  try {
    const raw = localStorage.getItem(PLACE_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const now = Date.now();
      // Drop anything already stale on the way in, so an app left closed for a
      // fortnight does not start by serving fortnight-old answers.
      Object.keys(parsed || {}).forEach(ns => {
        const live = {};
        Object.keys(parsed[ns] || {}).forEach(k => {
          const e = parsed[ns][k];
          if (e && Array.isArray(e.rows) && now - e.t < PLACE_CACHE_MAX_AGE_MS) live[k] = e;
        });
        if (Object.keys(live).length) _placeStore[ns] = live;
      });
    }
  } catch (e) { _placeStore = {}; }   // private mode, quota, or corrupt JSON
  return _placeStore;
}

let _placeSaveTimer = null;
/**
 * Write the store back, coalesced.
 *
 * A radius drag can touch the cache a dozen times in a second, and serialising
 * the whole store on each one is exactly the main-thread stall that makes a
 * slider feel broken.
 */
function placeCacheSave() {
  clearTimeout(_placeSaveTimer);
  _placeSaveTimer = setTimeout(() => {
    try {
      let json = JSON.stringify(_placeStore);
      // Over budget: drop the oldest entries across every namespace until it
      // fits. Insertion order is oldest-first, which is what we want.
      while (json.length > PLACE_CACHE_MAX_BYTES) {
        let oldestNs = null, oldestKey = null, oldestT = Infinity;
        Object.keys(_placeStore).forEach(ns => Object.keys(_placeStore[ns]).forEach(k => {
          if (_placeStore[ns][k].t < oldestT) { oldestT = _placeStore[ns][k].t; oldestNs = ns; oldestKey = k; }
        }));
        if (!oldestNs) break;
        delete _placeStore[oldestNs][oldestKey];
        json = JSON.stringify(_placeStore);
      }
      localStorage.setItem(PLACE_CACHE_KEY, json);
    } catch (e) { /* storage full or disabled — the in-memory cache still works */ }
  }, 400);
}

/**
 * Read a persisted answer.
 * @param {string} ns @param {string} key
 * @returns {Array|null} the rows, with their metadata put back
 */
function placeCacheGet(ns, key) {
  const store = placeCacheLoad();
  const e = store[ns] && store[ns][key];
  if (!e) return null;
  if (Date.now() - e.t >= PLACE_CACHE_MAX_AGE_MS) { delete store[ns][key]; return null; }
  const rows = e.rows.slice();
  PLACE_CACHE_META.forEach(m => { if (e.meta && e.meta[m] !== undefined) rows[m] = e.meta[m]; });
  return rows;
}

/**
 * Persist an answer.
 * @param {string} ns @param {string} key @param {Array} rows
 */
function placeCacheSet(ns, key, rows) {
  if (!Array.isArray(rows)) return;
  const store = placeCacheLoad();
  if (!store[ns]) store[ns] = {};
  const meta = {};
  PLACE_CACHE_META.forEach(m => { if (rows[m] !== undefined) meta[m] = rows[m]; });
  // Re-inserting moves the key to the end, keeping insertion order = age order.
  delete store[ns][key];
  store[ns][key] = { t: Date.now(), rows: rows.slice(), meta };
  placeCacheSave();
}

/**
 * Forget everything, or one namespace.
 *
 * Called when a provider key changes: an answer from before the key was added
 * came from a different provider, and serving it afterwards is how a new key
 * looks like it did nothing.
 * @param {string} [ns]
 */
function placeCacheClear(ns) {
  const store = placeCacheLoad();
  if (ns) delete store[ns]; else _placeStore = {};
  placeCacheSave();
}

/**
 * Every key held in a namespace, oldest first.
 * @param {string} ns @returns {string[]}
 */
function placeCacheKeys(ns) {
  const store = placeCacheLoad();
  return store[ns] ? Object.keys(store[ns]) : [];
}

/** How much is held, for the key panel. @returns {{entries:number, bytes:number}} */
function placeCacheStats() {
  const store = placeCacheLoad();
  let entries = 0;
  Object.keys(store).forEach(ns => { entries += Object.keys(store[ns]).length; });
  let bytes = 0;
  try { bytes = JSON.stringify(store).length; } catch (e) { /* ignore */ }
  return { entries, bytes };
}
