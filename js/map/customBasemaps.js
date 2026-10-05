/**
 * map/customBasemaps.js — user-added XYZ tile servers.
 *
 * The catalogue in basemapProviders.js covers the public providers worth
 * shipping, but an organisation with its own imagery — a drone survey, a
 * council WMTS, a paid provider on a corporate key — cannot be served by
 * anything hard-coded. Because the catalogue is already declarative, a custom
 * basemap is simply another descriptor: it needs no special path through the
 * engine, the switcher, the export pipeline or the grading system.
 *
 * Stored per device in prefs rather than in the project file. A tile URL is
 * infrastructure, not content: it usually carries a key, it is the same across
 * every project, and a project shared with a colleague should not silently
 * carry a credential.
 */

/** Prefs key holding the array of user basemaps. */
const CUSTOM_BASEMAP_PREF = 'customBasemaps';

/**
 * @typedef {object} CustomBasemap
 * @property {string} id        Generated, prefixed `custom:`.
 * @property {string} label
 * @property {string} url       XYZ template containing {z}/{x}/{y}.
 * @property {number} maxNative
 * @property {string} credit
 * @property {boolean} imagery  Photographic — enables colour grading.
 */

/** @returns {CustomBasemap[]} */
function loadCustomBasemaps() {
  if (typeof getPref !== 'function') return [];
  const raw = getPref(CUSTOM_BASEMAP_PREF);
  return Array.isArray(raw) ? raw : [];
}

/** @param {CustomBasemap[]} list */
function saveCustomBasemaps(list) {
  if (typeof setPref === 'function') setPref(CUSTOM_BASEMAP_PREF, list);
}

/**
 * Does this look like a usable XYZ template?
 * Checked before adding so a typo is caught at entry rather than as a silent
 * wall of broken tiles.
 * @param {string} url
 * @returns {string} An empty string when valid, otherwise the reason.
 */
function validateTileUrl(url) {
  const u = String(url || '').trim();
  if (!u) return 'Enter a tile URL.';
  if (!/^https?:\/\//i.test(u)) return 'The URL must start with http:// or https://.';
  if (!/\{z\}/.test(u) || !/\{x\}/.test(u) || !/\{y\}/.test(u)) {
    return 'The URL needs {z}, {x} and {y} placeholders, e.g. …/{z}/{x}/{y}.png';
  }
  if (/^http:\/\//i.test(u) && location.protocol === 'https:') {
    return 'This page is served over HTTPS, so an http:// tile server will be blocked by the browser.';
  }
  return '';
}

/**
 * Turn a stored custom basemap into a catalogue descriptor.
 * `corsSafe` is left undeclared-optimistic: whether an arbitrary server allows
 * canvas reads is exactly the thing the runtime probe in mapEngine measures, so
 * guessing here would only get in its way.
 * @param {CustomBasemap} c
 * @returns {object} BasemapSpec
 */
function customBasemapSpec(c) {
  return {
    id: c.id,
    label: c.label,
    group: 'Custom',
    provider: c.id,                 // its own provider, so export safety is measured per server
    credit: c.credit || c.label,
    imagery: !!c.imagery,
    corsSafe: true,
    custom: true,
    thumb: 'linear-gradient(150deg,#2a3550,#3d4a6b 55%,#55648c)',
    layers: [{ url: c.url, zIndex: 1, maxNative: +c.maxNative || 19, role: c.imagery ? 'imagery' : undefined }],
  };
}

/**
 * Merge every stored custom basemap into the live catalogue.
 * Called before the switcher is built, and again whenever the list changes.
 */
function applyCustomBasemaps() {
  // Drop any previously merged entries first, so an edit or delete takes effect
  // rather than accumulating.
  Object.keys(BASEMAP_CATALOGUE).forEach(k => {
    if (BASEMAP_CATALOGUE[k] && BASEMAP_CATALOGUE[k].custom) delete BASEMAP_CATALOGUE[k];
  });
  loadCustomBasemaps().forEach(c => { BASEMAP_CATALOGUE[c.id] = customBasemapSpec(c); });
}

/**
 * Add a basemap and make it available immediately.
 * @param {{label:string,url:string,maxNative:number,credit:string,imagery:boolean}} data
 * @returns {CustomBasemap}
 */
function addCustomBasemap(data) {
  const list = loadCustomBasemaps();
  const entry = {
    id: 'custom:' + Date.now().toString(36),
    label: String(data.label || '').trim() || 'Custom basemap',
    url: String(data.url).trim(),
    maxNative: Math.max(1, Math.min(24, +data.maxNative || 19)),
    credit: String(data.credit || '').trim(),
    imagery: !!data.imagery,
  };
  list.push(entry);
  saveCustomBasemaps(list);
  applyCustomBasemaps();
  return entry;
}

/**
 * Remove a basemap. If it is the one currently displayed, the caller is
 * responsible for switching away — deleting the active basemap and leaving it
 * on screen would be the "stranded on a basemap that cannot draw" failure again.
 * @param {string} id
 */
function removeCustomBasemap(id) {
  saveCustomBasemaps(loadCustomBasemaps().filter(c => c.id !== id));
  applyCustomBasemaps();
}

/**
 * Substitute a sample tile from a template, for the preview in the manager.
 * Uses a mid-zoom tile over India so a regional provider shows real data rather
 * than empty ocean.
 * @param {string} url @param {number} maxNative
 * @returns {string}
 */
function sampleCustomTile(url, maxNative) {
  const z = Math.max(1, Math.min(+maxNative || 12, 12));
  const n = Math.pow(2, z);
  const lat = 19.076, lng = 72.877;                       // Mumbai
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return String(url)
    .replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y)
    .replace(/\{-y\}/g, n - 1 - y).replace(/\{s\}/g, 'a').replace(/\{r\}/g, '');
}

// Merge stored basemaps into the catalogue at load, before ui/basemapSwitcher.js
// builds the picker from it.
if (typeof BASEMAP_CATALOGUE !== 'undefined') applyCustomBasemaps();

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateTileUrl, sampleCustomTile, CUSTOM_BASEMAP_PREF };
}
