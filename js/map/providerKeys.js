/**
 * map/providerKeys.js — per-device storage and verification of provider API keys.
 *
 * The premium basemaps (Imagery Hybrid HD, Navigation HD) need an ArcGIS
 * Location Platform key. The obvious place to put one is `MAP_PROVIDER_KEYS` in
 * config.js — and that is exactly the wrong place, because this app is deployed
 * from a public repository. A key committed there is readable by anyone who
 * opens the source or clones the repo, and an ArcGIS key is metered: someone
 * else's traffic lands on your credit allowance.
 *
 * So keys live where the custom tile servers already live — in prefs, on the
 * operator's own device. Same reasoning as customBasemaps.js: a credential is
 * infrastructure, not content. It is never written into a project file, never
 * travels with a map shared with a colleague, and never reaches the repository.
 * The config.js constants stay supported as a fallback for a private fork or an
 * internal deployment where committing a key is genuinely fine.
 *
 * Resolution order, highest first:
 *   1. the key stored in prefs on this device;
 *   2. `MAP_PROVIDER_KEYS[provider]` from config.js.
 *
 * basemapProviders.js reads through `basemapKey()`, which consults this module,
 * so nothing else in the app has to know where a key came from.
 */

/** Prefs key holding `{ arcgis: '…', mappls: '…' }`. */
const PROVIDER_KEY_PREF = 'providerKeys';

/**
 * What each provider key buys, for the copy shown in the Basemap Manager.
 * Kept beside the storage code so the explanation and the behaviour cannot
 * drift apart.
 */
const PROVIDER_KEY_INFO = Object.freeze({
  arcgis: {
    label: 'ArcGIS Location Platform',
    unlocks: ['imageryHybridHD', 'navigationHD'],
    signup: 'https://location.arcgis.com/sign-up/',
  },
});

/** @returns {Object<string,string>} the stored keys, always an object. */
function loadProviderKeys() {
  if (typeof getPref !== 'function') return {};
  const raw = getPref(PROVIDER_KEY_PREF);
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

/**
 * The key stored on this device for a provider.
 * @param {string} provider @returns {string}
 */
function storedProviderKey(provider) {
  return String(loadProviderKeys()[provider] || '').trim();
}

/**
 * Store (or, with an empty value, clear) a provider key.
 * @param {string} provider @param {string} key
 */
function setProviderKey(provider, key) {
  const keys = loadProviderKeys();
  const val = String(key || '').trim();
  if (val) keys[provider] = val; else delete keys[provider];
  if (typeof setPref === 'function') setPref(PROVIDER_KEY_PREF, keys);
}

/** @param {string} provider */
function clearProviderKey(provider) { setProviderKey(provider, ''); }

/**
 * Is a key configured for this provider, from either source?
 * @param {string} provider @returns {boolean}
 */
function hasProviderKey(provider) {
  const cfg = (typeof MAP_PROVIDER_KEYS !== 'undefined' && MAP_PROVIDER_KEYS) || {};
  return !!(storedProviderKey(provider) || String(cfg[provider] || '').trim());
}

/**
 * Catch the mistakes that are obvious without asking Esri: an empty field, a
 * pasted URL, a truncated copy. Deliberately *not* a prefix whitelist — Esri has
 * used `AAPK` and `AAPT` and may use something else tomorrow, and refusing a
 * valid key because its prefix is unfamiliar is worse than letting the live
 * check answer it.
 * @param {string} key
 * @returns {string} '' when plausible, otherwise the reason.
 */
function looksLikeArcgisKey(key) {
  const k = String(key || '').trim();
  if (!k) return 'Paste your ArcGIS Location Platform API key.';
  if (/^https?:\/\//i.test(k)) return 'That is a URL — paste the API key itself.';
  if (/\s/.test(k)) return 'The key contains a space, so part of the copy is probably missing.';
  if (k.length < 40) return 'That looks too short for an ArcGIS API key — check the whole value was copied.';
  return '';
}

/**
 * A real tile URL for the given key, used to verify it.
 *
 * Built from the catalogue entry rather than a literal, so the probe always
 * tests the exact endpoint the basemap will use. If the template ever changes,
 * the check changes with it instead of quietly validating a dead URL.
 * @param {string} key
 * @returns {string}
 */
function arcgisProbeUrl(key) {
  const spec = typeof BASEMAP_CATALOGUE !== 'undefined' && BASEMAP_CATALOGUE.navigationHD;
  const tpl = (spec && spec.layers[0].url) ||
    'https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/' +
    'arcgis/navigation/static/tile/{z}/{y}/{x}?token={token}';
  // z8 over the western Indian coast: land and sea, so a blank ocean tile does
  // not get mistaken for a broken one.
  return tpl
    .replace('{z}', 8).replace('{x}', 180).replace('{y}', 116)
    .replace(/\{token\}/g, encodeURIComponent(String(key).trim()));
}

/**
 * Turn an Esri error body into something an operator can act on.
 * @param {string} body @returns {string}
 */
function arcgisErrorText(body) {
  const txt = String(body || '');
  if (/invalid token|token required|498|499/i.test(txt)) {
    return 'Esri rejected that key. Check it is an API key from the Location Platform dashboard, not a client ID or an OAuth secret.';
  }
  if (/referer|referrer|origin/i.test(txt)) {
    return 'Esri rejected the request because of the key’s referrer restrictions. Add this site’s address to the key’s allowed referrers.';
  }
  return 'Esri answered, but not with a tile. ' + txt.slice(0, 160);
}

/** Resolve true when a URL loads as an image. Not subject to CORS. */
function imageLoads(url) {
  return new Promise(res => {
    const img = new Image();
    const done = ok => { img.onload = img.onerror = null; res(ok); };
    img.onload = () => done(img.naturalWidth > 0);
    img.onerror = () => done(false);
    setTimeout(() => done(false), 12000);
    img.src = url;
  });
}

/**
 * Ask Esri whether a key works, by fetching one real tile with it.
 *
 * `fetch` first, because the status code and body distinguish "wrong key" from
 * "right key, wrong referrer" from "Esri is down" — three problems with three
 * different fixes. An `<img>` load can only ever say yes or no, so it is the
 * fallback for when fetch itself is blocked (offline, a corporate proxy, an
 * extension), where a plain yes is still worth having.
 *
 * @param {string} key
 * @returns {Promise<{ok:boolean, message:string}>}
 */
async function verifyArcgisKey(key) {
  const problem = looksLikeArcgisKey(key);
  if (problem) return { ok: false, message: problem };

  const url = arcgisProbeUrl(key);
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const type = res.headers.get('content-type') || '';
    if (res.ok && /image\//i.test(type)) {
      return { ok: true, message: 'Key accepted — Esri returned a tile.' };
    }
    if (res.ok) return { ok: false, message: arcgisErrorText(await res.text()) };
    if (res.status === 498 || res.status === 499 || res.status === 401 || res.status === 403) {
      return { ok: false, message: arcgisErrorText(await res.text().catch(() => '')) };
    }
    return { ok: false, message: `Esri answered HTTP ${res.status}. That is a service-side problem, not the key — try again shortly.` };
  } catch (e) {
    const ok = await imageLoads(url);
    return ok
      ? { ok: true, message: 'Key accepted — Esri returned a tile.' }
      : { ok: false, message: 'Could not reach Esri to check the key. Check the connection, then try again — the key can still be saved and will simply show blank tiles if it is wrong.' };
  }
}

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PROVIDER_KEY_PREF, PROVIDER_KEY_INFO, looksLikeArcgisKey, arcgisProbeUrl, arcgisErrorText,
  };
}
