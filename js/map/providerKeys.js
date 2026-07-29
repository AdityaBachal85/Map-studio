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
    blurb: 'Unlocks <b>Imagery Hybrid HD</b> and <b>Navigation HD</b> — Esri’s current cartography rendered to ' +
      '512&nbsp;px tiles, so roads and labels carry twice the detail per screen pixel and stay legible at every zoom. ' +
      'Licensed for exports. Free tier at {signup}.',
    signup: 'https://location.arcgis.com/sign-up/',
    signupLabel: 'location.arcgis.com',
    unlocks: ['imageryHybridHD', 'navigationHD'],
    /** Offered as a one-click switch once the key works. */
    primary: 'imageryHybridHD',
    primaryLabel: 'Imagery Hybrid HD',
    verify: k => verifyArcgisKey(k),
    diagnostic: './diagnostics/arcgis-tiles.html',
  },
  google: {
    label: 'Google Maps Platform',
    blurb: 'Puts Google first for <b>search</b>, <b>nearby places</b> and <b>routing</b> — its Indian addresses, ' +
      'POIs and road network are the best available — with the existing providers kept behind it as fallback. ' +
      'Also adds Google basemaps, which are <b>on-screen only</b>: Google’s terms do not cover copying map content ' +
      'into files, so exports render the equivalent Esri imagery instead. Needs <b>Places API (New)</b>, ' +
      '<b>Routes API</b> and <b>Map Tiles API</b> enabled, with billing on, at {signup}.',
    signup: 'https://console.cloud.google.com/google/maps-apis/api-list',
    signupLabel: 'the Google Cloud console',
    unlocks: ['googleHybrid', 'googleRoadmap', 'googleTerrain'],
    primary: 'googleHybrid',
    primaryLabel: 'Google satellite + roads',
    verify: k => verifyGoogleKey(k),
    /** Each service is enabled separately in the console, so each is reported. */
    perService: true,
    /** Tiles are metered per request, so the cost warning is part of the UI. */
    caution: 'Google bills per tile request. Restrict the key by HTTP referrer and set a quota cap before using it.',
    onChange: () => {
      if (typeof clearGoogleSessions === 'function') clearGoogleSessions();
      // Saving the key has to change the next search, not the one after a
      // reload — the cache is keyed by query alone and would otherwise keep
      // serving the pre-Google answer.
      if (typeof clearSearchCache === 'function') clearSearchCache();
    },
  },
});

/** Provider ids with a key panel, in the order they are shown. */
const PROVIDER_KEY_ORDER = ['arcgis', 'google'];

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

/** The static-tiles endpoint shape, used when the catalogue is not loaded. */
const ARCGIS_STATIC_TPL =
  'https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/' +
  '{style}/static/tile/{z}/{y}/{x}?token={token}';

/** The style segment of a tile template, e.g. `arcgis/imagery/standard`. */
const arcgisStyleOf = url => (String(url).match(/v1\/(.+?)\/static\/tile/) || [])[1] || '';

/**
 * A real tile URL from a template, used to verify a key.
 *
 * Built from the catalogue's own templates, so the probe tests the exact
 * endpoints the basemaps will use rather than a copy of them that can drift.
 * @param {string} key @param {string} [tpl] Tile template; defaults to Navigation HD.
 * @returns {string}
 */
function arcgisProbeUrl(key, tpl) {
  const spec = typeof BASEMAP_CATALOGUE !== 'undefined' && BASEMAP_CATALOGUE.navigationHD;
  const t = tpl || (spec && spec.layers[0].url) || ARCGIS_STATIC_TPL.replace('{style}', 'arcgis/navigation');
  // z8 over the western Indian coast: land and sea, so a blank ocean tile is
  // not mistaken for a broken one.
  return String(t)
    .replace('{z}', 8).replace('{x}', 180).replace('{y}', 116)
    .replace(/\{token\}/g, encodeURIComponent(String(key).trim()));
}

/**
 * What a key has to serve before the HD basemaps can draw — one entry per
 * layer, each carrying that layer's full candidate list.
 *
 * Read from the catalogue rather than restated here, so the check cannot drift
 * from what the app actually requests, and so verification tries exactly the
 * same alternatives the map would.
 * @returns {{label:string, specId:string, layerIndex:number, urls:string[]}[]}
 */
function arcgisRequiredStyles() {
  const cat = typeof BASEMAP_CATALOGUE !== 'undefined' ? BASEMAP_CATALOGUE : {};
  const entry = (label, specId, i) => {
    const spec = cat[specId];
    if (!spec || !spec.layers[i]) return null;
    const lyr = spec.layers[i];
    const urls = (lyr.urlCandidates || []).length ? lyr.urlCandidates.slice() : [lyr.url];
    // The layer's current url leads, since that is what the map will ask for first.
    if (lyr.url && urls[0] !== lyr.url) urls.unshift(lyr.url);
    return { label, specId, layerIndex: i, urls: urls.filter(Boolean) };
  };
  const out = [
    entry('Navigation HD', 'navigationHD', 0),
    entry('Imagery Hybrid HD — imagery', 'imageryHybridHD', 0),
    entry('Imagery Hybrid HD — labels', 'imageryHybridHD', 1),
  ].filter(Boolean);
  return out.length ? out : [{
    label: 'Navigation HD', specId: '', layerIndex: 0,
    urls: [ARCGIS_STATIC_TPL.replace('{style}', 'arcgis/navigation')],
  }];
}

/**
 * Turn an Esri error body into something an operator can act on.
 *
 * The distinctions matter because they have different fixes: a rejected key is
 * the wrong credential, a referrer error is the right credential from an
 * un-allowed origin, and a privilege error is the right credential without the
 * basemap entitlement ticked — the last being the easiest to miss, because the
 * key is genuinely valid and everything else about it looks fine.
 * @param {string} body @param {number} [status]
 * @returns {string}
 */
function arcgisErrorText(body, status) {
  const txt = String(body || '');
  if (/referer|referrer|origin not allowed/i.test(txt)) {
    return 'Esri rejected the request because of the key’s referrer restrictions. Add this site’s address to the key’s allowed referrers in the Location Platform dashboard.';
  }
  if (/privilege|not licensed|not authorized|unauthorized access|insufficient/i.test(txt)) {
    return 'The key is valid but is not entitled to basemap tiles. In the Location Platform dashboard, edit the API key and tick the **Basemaps** (Location services → Basemap styles) privilege.';
  }
  if (/invalid token|token required|invalid.*api key/i.test(txt) || status === 498 || status === 499) {
    return 'Esri rejected that key. Check it is an API key from the Location Platform dashboard, not a client ID or an OAuth secret.';
  }
  if (/invalid or missing input|unable to find|not found/i.test(txt) || status === 400 || status === 404) {
    return 'Esri does not recognise that basemap style — the key is being read, but the style name is wrong for this account.';
  }
  return 'Esri answered' + (status ? ' HTTP ' + status : '') + ', but not with a tile. ' + txt.slice(0, 160);
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
 * Ask Esri for one real tile from one template.
 *
 * `fetch` first, because the status code and body distinguish "wrong key" from
 * "right key, wrong referrer" from "right key, no basemap privilege" from "Esri
 * is down" — four problems with four different fixes. An `<img>` load can only
 * ever say yes or no, so it is the fallback for when fetch itself is blocked
 * (offline, a corporate proxy, an extension), where a plain yes is still worth
 * having.
 *
 * @param {string} key @param {string} tpl Tile template.
 * @returns {Promise<{ok:boolean, status:number, message:string, reachable:boolean}>}
 */
async function probeArcgisTemplate(key, tpl) {
  const url = arcgisProbeUrl(key, tpl);
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const type = res.headers.get('content-type') || '';
    if (res.ok && /image\//i.test(type)) {
      return { ok: true, status: res.status, message: 'tile returned', reachable: true };
    }
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, message: arcgisErrorText(body, res.status), reachable: true };
  } catch (e) {
    const ok = await imageLoads(url);
    return ok
      ? { ok: true, status: 0, message: 'tile returned', reachable: true }
      : { ok: false, status: 0, message: 'could not reach Esri', reachable: false };
  }
}

/**
 * Verify a key against every style the HD basemaps need.
 *
 * Checking one style was not enough: a key can be perfectly valid, pass a
 * navigation probe, and still leave Imagery Hybrid HD blank because that style
 * resolves differently — which presents as "I pasted the key and the map did
 * not load", with nothing on screen to say which half failed. Probing each
 * style the app will actually request turns that into a named cause.
 *
 * @param {string} key
 * @returns {Promise<{ok:boolean, message:string, results:object[]}>}
 */
async function verifyArcgisKey(key) {
  const problem = looksLikeArcgisKey(key);
  if (problem) return { ok: false, message: problem, results: [] };

  const styles = arcgisRequiredStyles();
  const results = [];

  for (const s of styles) {
    // Try the layer's own candidates in the same order the map would, so
    // verification reports what the map will *actually* do rather than failing a
    // style the app would have recovered from a moment later.
    let first = null, winner = null, winning = null;
    for (const tpl of s.urls) {
      const r = await probeArcgisTemplate(key, tpl);
      if (!first) first = r;
      if (r.ok) { winner = tpl; winning = r; break; }
    }
    const ok = !!winner;
    results.push({
      label: s.label, specId: s.specId, layerIndex: s.layerIndex,
      ok,
      status: ok ? winning.status : first.status,
      message: ok ? '' : first.message,
      reachable: ok ? true : first.reachable,
      style: arcgisStyleOf(winner || s.urls[0]),
      url: winner || '',
      // True when the default guess failed and an alternative carried it.
      switched: ok && winner !== s.urls[0],
    });
  }

  // Pin anything that resolved to an alternative, so the map does not have to
  // rediscover it by failing a screenful of tiles first.
  results.forEach(r => {
    if (r.switched && r.specId && typeof pinResolvedTemplate === 'function') {
      pinResolvedTemplate(r.specId, r.layerIndex, r.url);
    }
  });

  const good = results.filter(r => r.ok);
  const bad = results.filter(r => !r.ok);

  if (!bad.length) {
    const switched = results.filter(r => r.switched);
    return {
      ok: true, results,
      message: 'Key accepted — Esri returned a tile for every basemap style.' +
        (switched.length
          ? ' ' + switched.map(r => r.label + ' resolved to “' + r.style + '”').join('; ') + '.'
          : ''),
    };
  }

  // Nothing came back at all: one cause, one message.
  if (!results.some(r => r.reachable)) {
    return {
      ok: false, results,
      message: 'Could not reach Esri to check the key. Check the connection, then try again — the key can still be saved and will simply show blank tiles if it is wrong.',
    };
  }

  // Every style failed the same way: report the cause once rather than three times.
  if (!good.length && bad.every(r => r.message === bad[0].message)) {
    return { ok: false, message: bad[0].message, results };
  }

  // A partial failure is the interesting case — the key works, one style does not.
  return {
    ok: false, results,
    message: 'The key works (' + good.map(r => r.label).join(', ') + ') but Esri would not serve ' +
      bad.map(r => r.label).join(' or ') + '. ' + bad[0].message,
  };
}

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PROVIDER_KEY_PREF, PROVIDER_KEY_INFO, looksLikeArcgisKey, arcgisProbeUrl, arcgisErrorText,
    arcgisRequiredStyles, arcgisStyleOf, ARCGIS_STATIC_TPL,
  };
}
