/**
 * core/prefs.js — persistent user preferences (localStorage) + the theme,
 * motion and unit systems that read them. Loaded early so the theme applies
 * before first paint. Everything else reads prefs through getPref(); the
 * Preferences dialog (ui/settingsDialog.js) is the only writer besides code
 * that mirrors an existing control.
 */

const PREFS_KEY = 'dbotMapStudioPrefs.v1';
const PREF_DEFAULTS = {
  theme: 'system',        // 'system' | 'light' | 'dark'
  glass: true,            // frosted-glass effects
  reduceMotion: false,    // minimise animations
  unitDistance: 'auto',   // 'auto' | 'km' | 'm' | 'mi'
  unitArea: 'auto',       // 'auto' | 'm2' | 'sqft' | 'acres' | 'hectares' | 'km2'
  basemap: 'hybrid',      // last-selected basemap key (remembered by the switcher)
};

const _prefs = Object.assign({}, PREF_DEFAULTS);
const _prefSubs = {};

function loadPrefs() {
  // Support escape hatch: ?reset=1 starts from defaults and clears stored
  // preferences. A saved setting that turns out to be unusable — a basemap that
  // stopped working, say — otherwise reapplies itself on every visit, and
  // "clear your site data" is not a reasonable thing to ask an operator for.
  try {
    if (/[?&]reset=1\b/.test(location.search)) {
      localStorage.removeItem(PREFS_KEY);
      return;
    }
  } catch (e) { /* no location (tests) */ }
  try { const raw = localStorage.getItem(PREFS_KEY); if (raw) Object.assign(_prefs, JSON.parse(raw)); } catch (e) { /* private mode / disabled storage */ }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(_prefs)); } catch (e) { /* ignore */ }
}

/** Read a preference (falling back to its default). @param {string} k */
function getPref(k) { return _prefs[k] !== undefined ? _prefs[k] : PREF_DEFAULTS[k]; }
/** Write a preference, persist it, and notify subscribers. @param {string} k @param {*} v */
function setPref(k, v) { _prefs[k] = v; savePrefs(); (_prefSubs[k] || []).forEach(cb => { try { cb(v); } catch (e) { } }); }
/** Subscribe to changes of one preference. @param {string} k @param {(v:*)=>void} cb */
function onPref(k, cb) { (_prefSubs[k] = _prefSubs[k] || []).push(cb); }
/** Reset every preference to its default and re-apply. */
function resetPrefs() { Object.assign(_prefs, PREF_DEFAULTS); savePrefs(); applyTheme(); applyGlass(); applyMotion(); }

// ---------- theme ----------
const _sysThemeMq = window.matchMedia('(prefers-color-scheme: light)');
/** The concrete theme in effect right now ('light' or 'dark'), resolving 'system'. */
function effectiveTheme() { const t = getPref('theme'); return t === 'system' ? (_sysThemeMq.matches ? 'light' : 'dark') : t; }
/** Stamp the resolved theme onto <html> so CSS variable overrides apply. */
function applyTheme() { document.documentElement.dataset.theme = effectiveTheme(); }
_sysThemeMq.addEventListener('change', () => { if (getPref('theme') === 'system') applyTheme(); });

// ---------- glass / motion (mirrored by the existing #glassTgl checkbox too) ----------
function applyGlass() { document.body.classList.toggle('no-glass', !getPref('glass')); }
function applyMotion() { document.body.classList.toggle('reduce-motion', !!getPref('reduceMotion')); }

// ---------- unit formatting (consumed by utils/math.js's fmtLen/fmtArea) ----------
/** Format a length given in km per the distance-unit preference. @param {number} km */
function fmtLenPref(km) {
  const u = getPref('unitDistance');
  if (u === 'km') return `${km.toFixed(km < 10 ? 3 : 2)} km`;
  if (u === 'm') return `${Math.round(km * 1000).toLocaleString()} m`;
  if (u === 'mi') return `${(km * 0.621371).toFixed(2)} mi`;
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`;   // auto
}
/** Format an area given in m² per the area-unit preference. @param {number} m2 */
function fmtAreaPref(m2) {
  const u = getPref('unitArea');
  if (u === 'm2') return `${Math.round(m2).toLocaleString()} m²`;
  if (u === 'sqft') return `${Math.round(m2 * 10.7639).toLocaleString()} sq ft`;
  if (u === 'acres') return `${(m2 / 4046.8564224).toFixed(3)} ac`;
  if (u === 'hectares') return `${(m2 / 10000).toFixed(2)} ha`;
  if (u === 'km2') return `${(m2 / 1e6).toFixed(3)} km²`;
  // auto — pick a sensible unit
  const ha = m2 / 10000;
  if (m2 / 1e6 >= 1) return `${(m2 / 1e6).toFixed(2)} km² (${ha.toFixed(0)} ha)`;
  if (ha >= 1) return `${ha.toFixed(2)} ha (${(m2 / 4046.8564224).toFixed(2)} ac)`;
  if (m2 >= 1000) return `${m2.toFixed(0)} m² (${(m2 / 4046.8564224).toFixed(3)} ac)`;
  return `${m2.toFixed(1)} m² (${Math.round(m2 * 10.7639)} sq ft)`;
}

loadPrefs();
applyTheme();   // before first paint
