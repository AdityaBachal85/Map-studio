/**
 * map/googleTiles.js — Google Maps Platform basemaps, on screen only.
 *
 * WHY THIS SHAPE
 *
 * Google's map cannot simply be pointed at as an XYZ template. The tile URLs
 * people pass around (`mt0.google.com/vt/lyrs=s&…`) are undocumented endpoints
 * whose use breaks Google's terms, and a property tool that produces client
 * deliverables is the last place to put a licence violation. The supported
 * route is the **Map Tiles API**, which needs a session token first:
 *
 *   POST /v1/createSession   { mapType, layerTypes, language, region, … }
 *     → { session, expiry, tileWidth, tileHeight, imageFormat }
 *   GET  /v1/2dtiles/{z}/{x}/{y}?session=…&key=…
 *
 * That one asynchronous step is the whole reason this file exists: every other
 * basemap in the catalogue is a static template, so the engine could build its
 * layers synchronously. Google needs a round-trip before the first tile, which
 * is handled by the `prepare()` hook on the spec rather than by special-casing
 * the engine.
 *
 * DISPLAY ONLY, DELIBERATELY
 *
 * These basemaps are marked `displayOnly`. Google's terms restrict copying map
 * content and creating derivative works from it, which is exactly what
 * rasterising imagery into a PNG or a PowerPoint deck for a client is. So the
 * export pipeline substitutes the Esri imagery underneath (see exportBasemapId
 * in basemapProviders.js) instead of either refusing or quietly shipping
 * something unlicensed. The operator gets Google's roads and place names to
 * navigate and plan with; the deliverable goes out on imagery that is licensed
 * for it.
 *
 * ATTRIBUTION
 *
 * Google requires their copyright line to be shown, and the correct string for
 * a given viewport comes from their own endpoint rather than being a constant.
 * It is fetched per view and cached; a static fallback covers the case where
 * the call fails, because showing a slightly stale attribution is much better
 * than showing none.
 */

/** Map Tiles API host. */
const GOOGLE_TILE_HOST = 'https://tile.googleapis.com';

/** Prefs key holding `{ <cacheKey>: {session, expiry, tileWidth} }`. */
const GOOGLE_SESSION_PREF = 'googleSessions';

/**
 * Viewport-info endpoint candidates.
 *
 * Google has published this path in two forms. Attribution is required, so
 * rather than bet on one spelling and risk showing nothing, both are tried and
 * the one that answers is remembered — the same lesson as the ArcGIS style
 * names, applied before it costs anyone a day.
 */
const GOOGLE_VIEWPORT_PATHS = ['/tile/v1/viewport', '/v1/viewport'];

/** Static fallback, used only when the viewport call cannot be reached. */
const GOOGLE_CREDIT_FALLBACK = 'Map data © Google';

/** In-memory session cache, keyed the same way as the prefs cache. */
const _gSessions = {};

/** @param {object} cfg @returns {string} */
function googleSessionCacheKey(cfg) {
  return [cfg.mapType, (cfg.layerTypes || []).join('+'), cfg.scale || '', cfg.highDpi ? 'hd' : ''].join(':');
}

/**
 * A cached session that has not expired, or null.
 *
 * Google's `expiry` is unix seconds and sessions last on the order of a
 * fortnight. Re-using one costs nothing and avoids a round-trip on every page
 * load; a minute of margin keeps a session that is about to lapse from being
 * handed out for a map the operator will still be looking at.
 * @param {string} cacheKey
 */
function cachedGoogleSession(cacheKey) {
  const live = _gSessions[cacheKey];
  const stored = (typeof getPref === 'function' && (getPref(GOOGLE_SESSION_PREF) || {})[cacheKey]) || null;
  const s = live || stored;
  if (!s || !s.session) return null;
  const expiry = Number(s.expiry) || 0;
  if (expiry && expiry * 1000 < Date.now() + 60000) return null;
  _gSessions[cacheKey] = s;
  return s;
}

/** @param {string} cacheKey @param {object} session */
function storeGoogleSession(cacheKey, session) {
  _gSessions[cacheKey] = session;
  if (typeof setPref !== 'function') return;
  const all = getPref(GOOGLE_SESSION_PREF) || {};
  all[cacheKey] = session;
  setPref(GOOGLE_SESSION_PREF, all);
}

/** Drop every stored session — used when the key changes or is removed. */
function clearGoogleSessions() {
  Object.keys(_gSessions).forEach(k => delete _gSessions[k]);
  if (typeof setPref === 'function') setPref(GOOGLE_SESSION_PREF, {});
}

/**
 * Obtain a session token for one map configuration.
 *
 * @param {{mapType:string, layerTypes?:string[], scale?:string, highDpi?:boolean}} cfg
 * @returns {Promise<{ok:boolean, session?:object, status?:number, message?:string}>}
 */
async function createGoogleSession(cfg) {
  const key = basemapKey('google');
  if (!key) return { ok: false, message: 'No Google Maps Platform key is set.' };

  const cacheKey = googleSessionCacheKey(cfg);
  const cached = cachedGoogleSession(cacheKey);
  if (cached) return { ok: true, session: cached };

  const body = {
    mapType: cfg.mapType,
    language: 'en-GB',
    region: 'IN',
  };
  if (cfg.layerTypes) body.layerTypes = cfg.layerTypes;
  if (cfg.scale) body.scale = cfg.scale;
  if (cfg.highDpi) body.highDpi = true;

  try {
    const res = await fetch(GOOGLE_TILE_HOST + '/v1/createSession?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, status: res.status, message: googleErrorText(txt, res.status) };
    let json = null;
    try { json = JSON.parse(txt); } catch (e) { /* fall through */ }
    if (!json || !json.session) {
      return { ok: false, status: res.status, message: 'Google answered without a session token.' };
    }
    storeGoogleSession(cacheKey, json);
    return { ok: true, session: json };
  } catch (e) {
    // Unlike a tile, this is a POST — there is no <img> fallback that can stand
    // in for it, so a blocked fetch is simply a blocked fetch.
    return { ok: false, status: 0, message: 'Could not reach Google (' + e.message + ').' };
  }
}

/**
 * Turn a Google error body into the one thing to change.
 * @param {string} body @param {number} [status] @returns {string}
 */
function googleErrorText(body, status) {
  const txt = String(body || '');
  if (/API key not valid|API_KEY_INVALID|keyInvalid/i.test(txt)) {
    return 'Google rejected that key. Check it is a Maps Platform API key and that it was copied whole.';
  }
  if (/referer|referrer|API_KEY_HTTP_REFERRER|not authorized to use this API/i.test(txt)) {
    return 'Google rejected the request from this address. Add this site to the key’s HTTP-referrer restrictions, ' +
      'and make sure the restriction list includes the Map Tiles API.';
  }
  if (/has not been used|is disabled|SERVICE_DISABLED|PERMISSION_DENIED/i.test(txt)) {
    return 'The Map Tiles API is not enabled on that key’s project. Enable “Map Tiles API” in the Google Cloud console, ' +
      'then try again — it can take a minute to take effect.';
  }
  if (/billing/i.test(txt)) {
    return 'Google requires billing to be enabled on the project before it will serve tiles.';
  }
  if (status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(txt)) {
    return 'Google is rate-limiting or the project is out of quota.';
  }
  return 'Google answered' + (status ? ' HTTP ' + status : '') + ': ' + txt.slice(0, 180);
}

/**
 * The tile template for a live session.
 * @param {object} session @returns {string}
 */
function googleTileUrl(session) {
  return GOOGLE_TILE_HOST + '/v1/2dtiles/{z}/{x}/{y}?session=' +
    encodeURIComponent(session.session) + '&key=' + encodeURIComponent(basemapKey('google'));
}

/**
 * Resolve a Google basemap spec's layer template, creating a session if needed.
 *
 * Used as the spec's `prepare()` hook: the engine calls it, shows nothing while
 * it runs, and rebuilds once it resolves.
 * @param {object} spec BasemapSpec carrying `google` config.
 * @returns {Promise<boolean>}
 */
async function prepareGoogleBasemap(spec) {
  const res = await createGoogleSession(spec.google);
  if (!res.ok) {
    if (typeof revertBasemap === 'function') {
      revertBasemap(spec.id, '“' + spec.label + '” could not start. ' + res.message);
    }
    return false;
  }
  spec.layers[0].url = googleTileUrl(res.session);
  spec.layers[0].tileSize = res.session.tileWidth || 256;
  spec._session = res.session;
  return true;
}

/**
 * Fetch the attribution Google requires for the current viewport.
 *
 * Best-effort by design: attribution must be shown, so a failed lookup falls
 * back to the static credit rather than leaving the line blank.
 * @param {object} spec @param {L.LatLngBounds} bounds @param {number} zoom
 * @returns {Promise<string>}
 */
async function googleViewportCredit(spec, bounds, zoom) {
  const session = spec._session;
  const key = basemapKey('google');
  if (!session || !key) return GOOGLE_CREDIT_FALLBACK;

  const qs = '?session=' + encodeURIComponent(session.session) +
    '&key=' + encodeURIComponent(key) +
    '&zoom=' + Math.round(zoom) +
    '&north=' + bounds.getNorth() + '&south=' + bounds.getSouth() +
    '&east=' + bounds.getEast() + '&west=' + bounds.getWest();

  // Try the known path spellings, remembering whichever answers.
  const paths = spec._viewportPath ? [spec._viewportPath] : GOOGLE_VIEWPORT_PATHS;
  for (const p of paths) {
    try {
      const res = await fetch(GOOGLE_TILE_HOST + p + qs);
      if (!res.ok) continue;
      const j = await res.json();
      if (j && j.copyright) { spec._viewportPath = p; return j.copyright; }
    } catch (e) { /* try the next spelling */ }
  }
  return GOOGLE_CREDIT_FALLBACK;
}

/**
 * Check a Google key by doing the one thing the basemaps need it to do.
 *
 * Creating a session *is* the verification — there is no cheaper call that
 * proves more, and if it succeeds the tiles will load.
 * @param {string} key
 * @returns {Promise<{ok:boolean, message:string, results:object[]}>}
 */
async function verifyGoogleKey(key) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, message: 'Paste your Google Maps Platform API key.', results: [] };
  if (/^https?:\/\//i.test(k)) return { ok: false, message: 'That is a URL — paste the API key itself.', results: [] };
  if (/\s/.test(k)) return { ok: false, message: 'The key contains a space, so part of the copy is probably missing.', results: [] };

  // Verification has to use the key being tested, not the stored one.
  const prev = (typeof MAP_PROVIDER_KEYS !== 'undefined') ? MAP_PROVIDER_KEYS.google : undefined;
  const hadStored = typeof storedProviderKey === 'function' && storedProviderKey('google');
  if (hadStored) return verifyGoogleKeyWith(k);
  if (typeof MAP_PROVIDER_KEYS !== 'undefined') MAP_PROVIDER_KEYS.google = k;
  try { return await verifyGoogleKeyWith(k); }
  finally { if (typeof MAP_PROVIDER_KEYS !== 'undefined') MAP_PROVIDER_KEYS.google = prev; }
}

/**
 * The actual probe, with the key passed explicitly so nothing has to be stored
 * before it is known to work.
 * @param {string} key
 */
async function verifyGoogleKeyWith(key) {
  const results = [];
  const cfgs = [
    { label: 'Google Hybrid', cfg: { mapType: 'satellite', layerTypes: ['layerRoadmap'] } },
    { label: 'Google Roadmap', cfg: { mapType: 'roadmap' } },
  ];

  for (const c of cfgs) {
    const body = Object.assign({ language: 'en-GB', region: 'IN' }, c.cfg);
    let r;
    try {
      const res = await fetch(GOOGLE_TILE_HOST + '/v1/createSession?key=' + encodeURIComponent(key), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const txt = await res.text().catch(() => '');
      let ok = false;
      if (res.ok) { try { ok = !!JSON.parse(txt).session; } catch (e) { ok = false; } }
      r = { ok, status: res.status, message: ok ? '' : googleErrorText(txt, res.status), reachable: true };
    } catch (e) {
      r = { ok: false, status: 0, message: 'Could not reach Google (' + e.message + ').', reachable: false };
    }
    results.push(Object.assign({ label: c.label }, r));
  }

  const bad = results.filter(r => !r.ok);
  if (!bad.length) {
    return { ok: true, results, message: 'Key accepted — Google issued a tile session. These basemaps are on-screen only; exports use the Esri imagery underneath.' };
  }
  if (!results.some(r => r.reachable)) {
    return { ok: false, results, message: bad[0].message + ' The key can still be saved and will simply show blank tiles if it is wrong.' };
  }
  return { ok: false, results, message: bad[0].message };
}

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GOOGLE_TILE_HOST, GOOGLE_SESSION_PREF, GOOGLE_CREDIT_FALLBACK,
    googleSessionCacheKey, googleErrorText,
  };
}
