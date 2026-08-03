/**
 * map/basemapProviders.js — the basemap provider registry.
 *
 * This module is **pure data plus pure functions**: it declares *what* every
 * basemap is made of (tile endpoints, native zoom depth, retina policy, credit,
 * export-safety) but never touches Leaflet, the DOM or the network. mapEngine.js
 * turns a descriptor into real `L.tileLayer`s. Keeping the two apart is what
 * makes the provider swappable — adding Mappls, Google, Bing or a self-hosted
 * tile server means adding a descriptor here, not editing the map engine.
 *
 * ---------------------------------------------------------------------------
 * Provider evaluation (2026-07) — why the defaults are what they are
 * ---------------------------------------------------------------------------
 *
 * Esri / ArcGIS Online raster (`server.arcgisonline.com`) — DEFAULT.
 *   + keyless, CORS-enabled (`Access-Control-Allow-Origin: *`) so tiles can be
 *     drawn into a canvas and exported to PNG/PPTX without tainting it;
 *   + World Imagery has genuine z19 coverage almost everywhere and z20–z21 over
 *     Indian metros and most peri-urban corridors;
 *   - the *raster* reference overlays (World_Transportation,
 *     World_Boundaries_and_Places) stop at z19 and their labels are baked into
 *     the tile, which is why road labels read as inconsistent when you zoom in.
 *
 * ArcGIS Static Basemap Tiles v1 (`static-map-tiles-api.arcgis.com`) — BEST.
 *   This is what the attribution block quoted in the brief comes from: the
 *   "Imagery Hybrid" style of the Basemap Styles v2 family (World Imagery for
 *   the picture; the vector Hybrid Reference Layer for roads/labels; Esri Places
 *   for POIs — hence the "Meta, Microsoft, PinMeTo, Krick, Foursquare" clause;
 *   plus 3D scene layers for the "Google Open Buildings / USGS 3DEP" clause).
 *   The static-tiles service renders those vector styles server-side to 512px
 *   PNGs, so we get modern Esri cartography *without* swapping Leaflet for a
 *   vector renderer.
 *   + 512px tiles → 2× the label/road detail per screen pixel vs 256px tiles;
 *   + labels are re-rendered per zoom, so they stay consistent all the way in;
 *   - needs a (free) ArcGIS Location Platform API key. Set it in config.js and
 *     the entries below light up automatically.
 *
 * Esri World Imagery (Clarity) (`clarity.maptiles.arcgis.com`) — deep zoom.
 *   Same archive, selected for clarity rather than recency, published to z22.
 *   Often noticeably sharper past z19; the imagery may be older. Offered as its
 *   own basemap rather than as the default so the trade-off stays explicit.
 *
 * Mappls / MapmyIndia — India-specific, opt-in, EXPORT-UNSAFE.
 *   Best-in-class Indian road network, house numbers and local names. Two
 *   blockers keep it off by default:
 *     1. its raster tiles are not served with an `Access-Control-Allow-Origin`
 *        header, so drawing them into a canvas *taints* it and every PNG/PPTX
 *        export throws a SecurityError — the whole export pipeline dies;
 *     2. the licence for the free developer tier does not cover redistributing
 *        rendered tiles inside exported client deliverables.
 *   The descriptor is therefore declared but gated behind
 *   `MAP_PROVIDER_KEYS.mappls` *and* `MAPPLS_ENABLED`, and marked
 *   `corsSafe: false` so the export pipeline can warn instead of failing.
 */

/* ---------------------------------------------------------------------------
 * Tile endpoints
 * ------------------------------------------------------------------------- */

const ESRI_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const ESRI_CLARITY_TILES = 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/';
const ESRI_STATIC_TILES = 'https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/';
const CARTO_TILES = 'https://{s}.basemaps.cartocdn.com/';

/** ArcGIS Online raster MapServer tile template. */
const esri = (path, host) => (host || ESRI_TILES) + path + '/MapServer/tile/{z}/{y}/{x}';

/**
 * ArcGIS Static Basemap Tiles template. 512px PNGs, so the layer is declared
 * with `tileSize: 512, zoomOffset: -1` — Leaflet then asks for one zoom level
 * *shallower* and paints it over twice the area, which is exactly how you get
 * double-density cartography out of a 256px tile grid.
 * @param {string} style e.g. `arcgis/imagery`, `arcgis/imagery/labels`.
 */
const esriStatic = style => ESRI_STATIC_TILES + style + '/static/tile/{z}/{y}/{x}?token={token}';

/**
 * Candidate style names per HD basemap layer, best guess first.
 *
 * Esri's Basemap Styles v2 enumeration has been renamed at least once —
 * `arcgis/imagery` is the composite hybrid, and the photographic half has been
 * documented both as `.../standard` and as `.../base`. Which one a given
 * deployment answers to cannot be checked from a build environment with no
 * route to `static-map-tiles-api.arcgis.com`, and a wrong guess is invisible
 * until someone with a key sees an empty map.
 *
 * So the app does not depend on the guess. Each layer ships its best candidate
 * as `url` and the alternatives as `urlCandidates`; if the first one returns no
 * tiles, mapEngine tries the rest against the live service and pins whichever
 * works (see resolveLayerAlternates). Discovery costs nothing when the first
 * guess is right, which is the common case.
 */
const ARCGIS_STYLES = Object.freeze({
  imagery: ['arcgis/imagery/standard', 'arcgis/imagery/base', 'arcgis/imagery'],
  imageryLabels: ['arcgis/imagery/labels', 'arcgis/imagery/hybrid'],
  navigation: ['arcgis/navigation', 'arcgis/navigation/night'],
});

/* ---------------------------------------------------------------------------
 * Layer descriptors
 * ------------------------------------------------------------------------- */

/**
 * @typedef {object} LayerSpec
 * @property {string}  url        Tile URL template.
 * @property {number}  zIndex     Paint order inside the basemap stack.
 * @property {number}  maxNative  Deepest zoom with real tiles. Past this Leaflet
 *                                upscales the parent tile rather than requesting
 *                                a level the service does not publish.
 * @property {boolean} [retina]   Request `@2x` / deeper tiles on hi-dpi screens.
 * @property {number}  [tileSize] Tile edge in px (default 256).
 * @property {number}  [zoomOffset] Leaflet zoom offset, paired with tileSize.
 * @property {string}  [subdomains]
 * @property {number}  [opacity]
 * @property {boolean} [adaptive]  Probe returned tiles for the "Map data not yet
 *                                available" placeholder and walk `maxNative`
 *                                back when the service runs out of coverage.
 * @property {string}  [retinaSuffix] Token substituted for `{r}` on hi-dpi.
 * @property {string}  [role]     `imagery` for the photographic base, `reference`
 *                                for a roads/labels overlay drawn on top of it.
 *                                The two are graded and exported separately.
 */

/**
 * @typedef {object} BasemapSpec
 * @property {string}  id
 * @property {string}  label
 * @property {string}  group      Grouping shown in the switcher.
 * @property {string}  provider   Provider id, for the credit line + diagnostics.
 * @property {string}  credit     Attribution rendered on the map and in exports.
 * @property {string}  thumb      CSS background used by the switcher thumbnail.
 * @property {LayerSpec[]} layers
 * @property {boolean} corsSafe   False when tiles taint the export canvas.
 * @property {string}  [needsKey] Provider key that must be present to offer it.
 * @property {boolean} [imagery]  True for photographic basemaps.
 * @property {boolean} [dark]     True when the basemap reads as a dark surface,
 *                                so overlaid text needs light ink. Imagery is
 *                                treated as dark too.
 */

const ESRI_IMAGERY_CREDIT =
  'Imagery © Esri · Vantor · Airbus DS · USGS · NGA · NASA · CGIAR · GEBCO · the GIS User Community';
const ESRI_HYBRID_CREDIT =
  'Imagery © Esri · Vantor · Airbus DS · Maxar · Labels © Esri · TomTom · Garmin · © OpenStreetMap contributors';

/**
 * The catalogue. Order here is the order shown in the switcher.
 * @type {Object<string, BasemapSpec>}
 */
const BASEMAP_CATALOGUE = {

  /* ---- Satellite ------------------------------------------------------- */

  hybrid: {
    id: 'hybrid', label: 'Satellite + labels', group: 'Satellite',
    provider: 'esri', credit: ESRI_HYBRID_CREDIT, imagery: true, corsSafe: true,
    thumb: 'linear-gradient(150deg,#2e4a2a,#6a7f4a 45%,#8a9a63)',
    layers: [
      { url: esri('World_Imagery'), zIndex: 1, maxNative: 21, retina: true, adaptive: true, role: 'imagery' },
      { url: esri('Reference/World_Transportation'), zIndex: 3, maxNative: 19, retina: true, role: 'reference' },
      { url: esri('Reference/World_Boundaries_and_Places'), zIndex: 4, maxNative: 19, retina: true, role: 'reference' },
    ],
  },

  sat: {
    id: 'sat', label: 'Satellite — clean', group: 'Satellite',
    provider: 'esri', credit: ESRI_IMAGERY_CREDIT, imagery: true, corsSafe: true,
    thumb: 'linear-gradient(150deg,#26402a,#4f6b3c 50%,#7d8f5c)',
    layers: [
      { url: esri('World_Imagery'), zIndex: 1, maxNative: 21, retina: true, adaptive: true, role: 'imagery' },
    ],
  },

  clarity: {
    id: 'clarity', label: 'Satellite — deep zoom (Clarity)', group: 'Satellite',
    provider: 'esri-clarity', imagery: true, corsSafe: true,
    credit: 'Imagery © Esri World Imagery (Clarity) · Vantor · Airbus DS · USGS · NGA · NASA',
    thumb: 'linear-gradient(150deg,#22401f,#5c7a3e 45%,#94a468)',
    layers: [
      { url: esri('World_Imagery', ESRI_CLARITY_TILES), zIndex: 1, maxNative: 22, retina: true, adaptive: true, role: 'imagery' },
    ],
  },

  clarityHybrid: {
    id: 'clarityHybrid', label: 'Deep zoom + labels', group: 'Satellite',
    provider: 'esri-clarity', imagery: true, corsSafe: true,
    credit: 'Imagery © Esri World Imagery (Clarity) · Labels © Esri · TomTom · Garmin · © OpenStreetMap contributors',
    thumb: 'linear-gradient(150deg,#22401f,#5c7a3e 45%,#a8b47c)',
    layers: [
      { url: esri('World_Imagery', ESRI_CLARITY_TILES), zIndex: 1, maxNative: 22, retina: true, adaptive: true, role: 'imagery' },
      { url: esri('Reference/World_Transportation'), zIndex: 3, maxNative: 19, retina: true, role: 'reference' },
      { url: esri('Reference/World_Boundaries_and_Places'), zIndex: 4, maxNative: 19, retina: true, role: 'reference' },
    ],
  },

  /* ---- Premium (ArcGIS Location Platform key) --------------------------- */

  imageryHybridHD: {
    id: 'imageryHybridHD', label: 'Imagery Hybrid HD', group: 'Satellite',
    provider: 'arcgis-static', needsKey: 'arcgis', imagery: true, corsSafe: true,
    credit: 'Esri · TomTom · Garmin · METI/NASA · USGS · Vantor · Airbus DS · © OpenStreetMap contributors · Microsoft · Esri Community Maps',
    thumb: 'linear-gradient(150deg,#233f22,#5f7d42 45%,#b3bd86)',
    layers: [
      {
        url: esriStatic(ARCGIS_STYLES.imagery[0]),
        urlCandidates: ARCGIS_STYLES.imagery.map(esriStatic),
        zIndex: 1, maxNative: 21, tileSize: 512, zoomOffset: -1, role: 'imagery',
      },
      {
        url: esriStatic(ARCGIS_STYLES.imageryLabels[0]),
        urlCandidates: ARCGIS_STYLES.imageryLabels.map(esriStatic),
        zIndex: 3, maxNative: 21, tileSize: 512, zoomOffset: -1, role: 'reference',
      },
    ],
  },

  navigationHD: {
    id: 'navigationHD', label: 'Navigation HD', group: 'Streets',
    provider: 'arcgis-static', needsKey: 'arcgis', corsSafe: true,
    credit: 'Esri · TomTom · Garmin · © OpenStreetMap contributors · Microsoft · Esri Community Maps',
    thumb: 'linear-gradient(150deg,#f7f5f0,#e6e1d6 60%,#d6cfbe)',
    layers: [
      {
        url: esriStatic(ARCGIS_STYLES.navigation[0]),
        urlCandidates: ARCGIS_STYLES.navigation.map(esriStatic),
        zIndex: 1, maxNative: 21, tileSize: 512, zoomOffset: -1,
      },
    ],
  },

  /* ---- Streets ---------------------------------------------------------- */

  esristreet: {
    id: 'esristreet', label: 'Streets — Esri', group: 'Streets',
    provider: 'esri', credit: '© Esri · World Street Map', corsSafe: true,
    thumb: 'linear-gradient(150deg,#f4f1ea,#e2ddd0 60%,#cfc8b6)',
    layers: [{ url: esri('World_Street_Map'), zIndex: 1, maxNative: 19, retina: true }],
  },

  osm: {
    id: 'osm', label: 'Streets — OpenStreetMap', group: 'Streets',
    provider: 'osm', credit: '© OpenStreetMap contributors', corsSafe: true,
    thumb: 'linear-gradient(150deg,#f2efe9,#e3ded2 60%,#cfd8c2)',
    layers: [{ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', zIndex: 1, maxNative: 19 }],
  },

  voyager: {
    id: 'voyager', label: 'Streets — Carto Voyager', group: 'Streets',
    provider: 'carto', credit: '© CARTO · © OpenStreetMap contributors', corsSafe: true,
    thumb: 'linear-gradient(150deg,#fbf9f6,#eae5dd 60%,#cfe0ea)',
    layers: [{
      url: CARTO_TILES + 'rastertiles/voyager/{z}/{x}/{y}{r}.png',
      zIndex: 1, maxNative: 20, subdomains: 'abcd', retinaSuffix: '@2x',
    }],
  },

  /* ---- Executive / minimal --------------------------------------------- */

  lightgray: {
    id: 'lightgray', label: 'Light Gray Canvas', group: 'Executive',
    provider: 'esri', credit: '© Esri · Light Gray Canvas', corsSafe: true,
    thumb: 'linear-gradient(150deg,#fafafa,#ededed 60%,#dcdcdc)',
    layers: [
      { url: esri('Canvas/World_Light_Gray_Base'), zIndex: 1, maxNative: 16, retina: true },
      { url: esri('Canvas/World_Light_Gray_Reference'), zIndex: 3, maxNative: 16, retina: true },
    ],
  },

  darkgray: {
    id: 'darkgray', label: 'Dark Gray Canvas', group: 'Executive',
    provider: 'esri', credit: '© Esri · Dark Gray Canvas', corsSafe: true, dark: true,
    thumb: 'linear-gradient(150deg,#3a3f45,#2b2f35 60%,#1e2126)',
    layers: [
      { url: esri('Canvas/World_Dark_Gray_Base'), zIndex: 1, maxNative: 16, retina: true },
      { url: esri('Canvas/World_Dark_Gray_Reference'), zIndex: 3, maxNative: 16, retina: true },
    ],
  },

  positron: {
    id: 'positron', label: 'Minimal light', group: 'Executive',
    provider: 'carto', credit: '© CARTO · © OpenStreetMap contributors', corsSafe: true,
    thumb: 'linear-gradient(150deg,#ffffff,#f2f2f2 60%,#e2e2e2)',
    layers: [{
      url: CARTO_TILES + 'light_all/{z}/{x}/{y}{r}.png',
      zIndex: 1, maxNative: 20, subdomains: 'abcd', retinaSuffix: '@2x',
    }],
  },

  dark: {
    id: 'dark', label: 'Minimal dark', group: 'Executive',
    provider: 'carto', credit: '© CARTO · © OpenStreetMap contributors', corsSafe: true, dark: true,
    thumb: 'linear-gradient(150deg,#2a2e33,#1b1e22 60%,#111316)',
    layers: [{
      url: CARTO_TILES + 'dark_all/{z}/{x}/{y}{r}.png',
      zIndex: 1, maxNative: 20, subdomains: 'abcd', retinaSuffix: '@2x',
    }],
  },

  /* ---- Terrain ---------------------------------------------------------- */

  topo: {
    id: 'topo', label: 'Terrain topo', group: 'Terrain',
    provider: 'esri', credit: '© Esri · World Topo Map', corsSafe: true,
    thumb: 'linear-gradient(150deg,#efeadd,#d9d3bd 60%,#bcc4a4)',
    layers: [{ url: esri('World_Topo_Map'), zIndex: 1, maxNative: 19, retina: true }],
  },

  natgeo: {
    id: 'natgeo', label: 'National Geographic', group: 'Terrain',
    provider: 'esri', credit: '© Esri · National Geographic', corsSafe: true,
    thumb: 'linear-gradient(150deg,#e9e2ce,#cfc7a8 60%,#a8b189)',
    layers: [{ url: esri('NatGeo_World_Map'), zIndex: 1, maxNative: 16, retina: true }],
  },

  opentopo: {
    id: 'opentopo', label: 'OpenTopoMap', group: 'Terrain',
    provider: 'opentopo', credit: '© OpenTopoMap · © OpenStreetMap contributors', corsSafe: true,
    thumb: 'linear-gradient(150deg,#f0ebe0,#d8cfae 60%,#b9c39a)',
    layers: [{ url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', zIndex: 1, maxNative: 17, subdomains: 'abc' }],
  },

  /* ---- Google (on-screen only) ------------------------------------------
   * Best-in-class road network, place names and building footprints for
   * navigating and planning. Marked `displayOnly` because Google's terms
   * restrict copying map content into derivative works — which is what an
   * exported PNG or client deck is — so exports substitute `exportFallback`
   * rather than refusing or quietly shipping something unlicensed.
   *
   * `url` is empty until prepareGoogleBasemap() trades the API key for a
   * session token; see map/googleTiles.js.
   * --------------------------------------------------------------------- */

  googleHybrid: {
    id: 'googleHybrid', label: 'Google — satellite + roads', group: 'Google',
    provider: 'google', needsKey: 'google', imagery: true,
    // Never exported, so the crossOrigin attribute buys nothing and asking for
    // it could only stop tiles displaying.
    corsSafe: false, displayOnly: true, exportFallback: 'hybrid',
    credit: 'Map data © Google',
    thumb: 'linear-gradient(150deg,#2b4029,#5c7a45 45%,#93a76c)',
    google: { mapType: 'satellite', layerTypes: ['layerRoadmap'] },
    prepare: spec => prepareGoogleBasemap(spec),
    layers: [{ url: '', zIndex: 1, maxNative: 20, role: 'imagery' }],
  },

  googleRoadmap: {
    id: 'googleRoadmap', label: 'Google — roads', group: 'Google',
    provider: 'google', needsKey: 'google',
    corsSafe: false, displayOnly: true, exportFallback: 'esristreet',
    credit: 'Map data © Google',
    thumb: 'linear-gradient(150deg,#f6f4ef,#e8e5dd 55%,#cfe3d0)',
    google: { mapType: 'roadmap' },
    prepare: spec => prepareGoogleBasemap(spec),
    layers: [{ url: '', zIndex: 1, maxNative: 20 }],
  },

  googleTerrain: {
    id: 'googleTerrain', label: 'Google — terrain', group: 'Google',
    provider: 'google', needsKey: 'google',
    corsSafe: false, displayOnly: true, exportFallback: 'topo',
    credit: 'Map data © Google',
    thumb: 'linear-gradient(150deg,#eee9dc,#d5cfb6 55%,#b6c39c)',
    google: { mapType: 'terrain', layerTypes: ['layerRoadmap'] },
    prepare: spec => prepareGoogleBasemap(spec),
    layers: [{ url: '', zIndex: 1, maxNative: 20 }],
  },

  /* ---- India (opt-in) --------------------------------------------------- */

  mappls: {
    id: 'mappls', label: 'Mappls — India roads', group: 'India',
    provider: 'mappls', needsKey: 'mappls',
    // Pessimistic until measured: exports are blocked only if the runtime probe
    // actually observes a tainted canvas. See attachExportSafetyProbe().
    corsSafe: false,
    credit: '© Mappls (MapmyIndia)',
    thumb: 'linear-gradient(150deg,#fdf6ec,#f0e2c9 60%,#d9c9a3)',
    layers: [{
      // Empty until discovery resolves it — see resolveTileCandidates().
      url: (typeof MAPPLS_TILE_URL !== 'undefined' && MAPPLS_TILE_URL) || '',
      urlCandidates: typeof MAPPLS_TILE_CANDIDATES !== 'undefined' ? MAPPLS_TILE_CANDIDATES : [],
      zIndex: 1, maxNative: 18,
    }],
  },

  mapplsImagery: {
    id: 'mapplsImagery', label: 'Mappls — Bhuvan imagery', group: 'India',
    provider: 'mappls', needsKey: 'mappls', corsSafe: false, imagery: true,
    credit: '© Mappls (MapmyIndia) · ISRO Bhuvan imagery',
    thumb: 'linear-gradient(150deg,#2c4726,#5d7a41 50%,#8b9a63)',
    layers: [{
      url: typeof MAPPLS_IMAGERY_URL !== 'undefined'
        ? MAPPLS_IMAGERY_URL
        : 'https://apis.mappls.com/advancedmaps/v1/{token}/bhuvan_imagery/{z}/{x}/{y}.png',
      zIndex: 1, maxNative: 18,
    }],
  },
};

/** Hillshade relief overlay — shared by every basemap, toggled independently. */
const HILLSHADE_LAYER = {
  url: esri('Elevation/World_Hillshade'), maxNative: 16, opacity: 0.35, zIndex: 2,
};

/* ---------------------------------------------------------------------------
 * Key gating + catalogue queries
 * ------------------------------------------------------------------------- */

/**
 * The API key configured for a provider, or `''`.
 *
 * A key entered in the app (stored per device in prefs — see map/providerKeys.js)
 * wins over one committed to config.js. That order is deliberate: this app is
 * deployed from a public repository, so the in-app field is the safe way to
 * supply a metered credential, and the config constant remains only as a
 * fallback for private forks and internal deployments.
 *
 * Both sources are read through `typeof` guards so this module stays loadable on
 * its own (tests, diagnostics pages) with neither present.
 * @param {string} provider `arcgis` | `mappls`
 * @returns {string}
 */
function basemapKey(provider) {
  // `usableProviderKey`, not `storedProviderKey`: a key saved against the wrong
  // provider is ignored so it cannot shadow a working one in config.js.
  if (typeof usableProviderKey === 'function') {
    const stored = usableProviderKey(provider);
    if (stored) return stored;
  } else if (typeof storedProviderKey === 'function') {
    const stored = storedProviderKey(provider);
    if (stored) return stored;
  }
  const keys = (typeof MAP_PROVIDER_KEYS !== 'undefined' && MAP_PROVIDER_KEYS) || {};
  return String(keys[provider] || '').trim();
}

/**
 * Is this basemap usable right now? Key-gated entries stay hidden until their
 * key is configured, so the switcher never offers a basemap that would render
 * as a wall of 403s.
 * @param {BasemapSpec} spec
 * @returns {boolean}
 */
function isBasemapAvailable(spec) {
  if (!spec) return false;
  // A basemap with no tile template and nothing to try is unusable. Hiding it
  // is the whole point: a basemap the user can select but that cannot draw
  // leaves them staring at an empty map wondering what broke.
  const first = spec.layers && spec.layers[0];
  // A spec with a `prepare` hook fetches its own template (Google trades the API
  // key for a session token), so an empty url is expected rather than broken.
  if (first && !first.url && !(first.urlCandidates || []).length && typeof spec.prepare !== 'function') return false;
  if (!spec.needsKey) return true;
  if (!basemapKey(spec.needsKey)) return false;
  // Two providers additionally need an explicit opt-in, because holding a key
  // is not the same as the account being entitled to tiles. Google's key here
  // is live for Places and Routes but 403s on Map Tiles; Mappls has never
  // served a tile at all.
  if (spec.provider === 'mappls') return typeof MAPPLS_ENABLED !== 'undefined' && !!MAPPLS_ENABLED;
  if (spec.provider === 'google') return typeof GOOGLE_BASEMAPS_ENABLED !== 'undefined' && !!GOOGLE_BASEMAPS_ENABLED;
  return true;
}

/**
 * Every basemap that can be offered to the user, in catalogue order.
 * @returns {BasemapSpec[]}
 */
function availableBasemaps() {
  return Object.keys(BASEMAP_CATALOGUE)
    .map(k => BASEMAP_CATALOGUE[k])
    .filter(isBasemapAvailable);
}

/**
 * Resolve a basemap id to a usable spec, falling back to the default when the
 * id is unknown or its key has since been removed (e.g. an old saved project
 * that referenced a premium basemap).
 * @param {string} id
 * @returns {BasemapSpec}
 */
function resolveBasemap(id) {
  const spec = BASEMAP_CATALOGUE[id];
  return isBasemapAvailable(spec) ? spec : BASEMAP_CATALOGUE[DEFAULT_BASEMAP_ID];
}

const DEFAULT_BASEMAP_ID = 'hybrid';

/**
 * The best imagery basemap available right now — premium when a key is present,
 * otherwise the keyless hybrid. Used as the first-run default so an operator who
 * adds an ArcGIS key immediately gets the better cartography.
 * @returns {string} basemap id
 */
function preferredBasemapId() {
  return isBasemapAvailable(BASEMAP_CATALOGUE.imageryHybridHD) ? 'imageryHybridHD' : DEFAULT_BASEMAP_ID;
}

/**
 * Substitute provider tokens into a tile template.
 * @param {string} url
 * @param {BasemapSpec} spec
 * @returns {string}
 */
function basemapUrl(url, spec) {
  return spec.needsKey ? url.replace(/\{token\}/g, encodeURIComponent(basemapKey(spec.needsKey))) : url;
}

/**
 * Observed export safety per provider, filled in at runtime by the tile probe
 * in map/mapEngine.js. An entry here always beats the declared `corsSafe`,
 * because it is evidence from the live service rather than an assumption
 * written into the source.
 * @type {Object<string, boolean>}
 */
const EXPORT_SAFETY_OBSERVED = {};

/**
 * Record what a real tile fetch told us about a provider.
 * @param {string} provider Provider id.
 * @param {boolean} safe true when a loaded tile could be read back off a canvas.
 */
function recordExportSafety(provider, safe) {
  EXPORT_SAFETY_OBSERVED[provider] = !!safe;
}

/**
 * Can this basemap be rasterised into an export without tainting the canvas?
 *
 * Measured beats declared: a provider whose tiles turn out to carry the right
 * CORS header is usable for export even if the catalogue was pessimistic about
 * it, and vice versa. Until the probe reports, the declared value stands.
 *
 * @param {string} id
 * @returns {boolean}
 */
function basemapExportSafe(id) {
  const spec = BASEMAP_CATALOGUE[id];
  if (!spec) return true;
  const observed = EXPORT_SAFETY_OBSERVED[spec.provider];
  if (observed !== undefined) return observed;
  return spec.corsSafe !== false;
}

/**
 * Which basemap an export should actually render.
 *
 * Two different reasons a basemap cannot go into a file, with the same answer:
 *
 *   - **licence** — Google's terms restrict copying map content into derivative
 *     works, and a PNG or a client deck is exactly that. Flagged `displayOnly`.
 *   - **technique** — a provider without an `Access-Control-Allow-Origin` header
 *     taints the export canvas, so the read throws. Measured at runtime.
 *
 * Both used to end at the same dead end: the export button refused and told the
 * operator to go and change basemap first. Substituting the equivalent licensed
 * basemap is better in every way — the export still happens, it comes out on
 * imagery that is cleared for it, and the geometry, labels and framing are
 * identical because only the ground layer differs. The caller says so in the
 * status line; a silent swap would be its own kind of wrong.
 *
 * @param {string} id Active basemap id.
 * @returns {string} The basemap id to render into the file.
 */
function exportBasemapId(id) {
  const spec = BASEMAP_CATALOGUE[id];
  if (!spec) return id;
  if (!spec.displayOnly && basemapExportSafe(id)) return id;
  const fallback = spec.exportFallback || DEFAULT_BASEMAP_ID;
  return isBasemapAvailable(BASEMAP_CATALOGUE[fallback]) ? fallback : DEFAULT_BASEMAP_ID;
}

/**
 * Does exporting this basemap swap in a different one?
 * @param {string} id @returns {boolean}
 */
function exportSubstitutes(id) { return exportBasemapId(id) !== id; }

/**
 * Can an export run at all?
 *
 * Only false in the case nothing can rescue: tiles that taint the canvas *and*
 * no licensed stand-in to render instead.
 * @param {string} id @returns {boolean}
 */
function exportReady(id) { return basemapExportSafe(id) || exportSubstitutes(id); }

/**
 * Append the substitution notice to a progress message, when there is one.
 * @param {string} msg @returns {string}
 */
function exportSubstituteNote(msg) {
  if (typeof activeKey === 'undefined' || !exportSubstitutes(activeKey)) return msg;
  const sub = BASEMAP_CATALOGUE[exportBasemapId(activeKey)];
  return msg + ' Using “' + (sub ? sub.label : 'a licensed basemap') + '” imagery — the current basemap is on-screen only.';
}

/* ---------------------------------------------------------------------------
 * Adaptive imagery depth
 * ------------------------------------------------------------------------- */

/**
 * Esri's satellite services answer 200 OK with a flat light-grey
 * "Map data not yet available" placeholder once you zoom past their coverage,
 * so a plain `error` handler never fires and the map fills with grey squares.
 * The previous fix was to cap `maxNativeZoom` globally at 18/19, which threw
 * away the z20–z21 imagery that *does* exist over the areas this tool is
 * actually used on, and was the direct cause of "zoom levels become blurry".
 *
 * Instead we let the layer ask for the deep tiles and *look at what comes back*:
 * the placeholder is a uniform, fully desaturated light grey, which real
 * imagery essentially never is across all four corners at once. On a hit we
 * drop that layer's native depth by one and redraw, so the map settles on the
 * deepest zoom the service genuinely serves for wherever the user is — per
 * session, without a round-trip to a coverage API.
 *
 * A false positive costs nothing beyond one upscaled zoom level (exactly what
 * the old hard cap did everywhere, all the time).
 *
 * @param {number[]} px RGBA samples, four corners + centre: `[r,g,b,a, …]`.
 * @returns {boolean} true when the sample looks like the placeholder tile.
 */
function looksLikeNoDataTile(px) {
  if (!px || px.length < 16) return false;
  const rgb = [];
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 250) return false;                        // translucent → not it
    rgb.push([px[i], px[i + 1], px[i + 2]]);
  }
  let lo = 255, hi = 0;
  for (const [r, g, b] of rgb) {
    // Desaturation is the strongest signal: aerial photography is never
    // neutral grey across a whole tile — vegetation, water, rooftops and
    // tarmac all carry a colour cast.
    if (Math.max(r, g, b) - Math.min(r, g, b) > 10) return false;
    const v = (r + g + b) / 3;
    // Was 224–249, which missed the placeholder outright: Esri's is around
    // 215–225, and averaging its white caption into a downsample drags the
    // reading further about. The band is now wide enough to cover the tile as
    // actually served while still excluding dark ground and white cloud.
    if (v < 185 || v > 252) return false;
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  // Was ≤3, which no sample containing any of the caption could satisfy.
  // Callers sample the corners for that reason, but a little slack costs
  // nothing and this has to survive JPEG noise too.
  return hi - lo <= 10;
}

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BASEMAP_CATALOGUE, HILLSHADE_LAYER, DEFAULT_BASEMAP_ID,
    isBasemapAvailable, availableBasemaps, resolveBasemap, preferredBasemapId,
    basemapUrl, basemapKey, basemapExportSafe, recordExportSafety, looksLikeNoDataTile,
  };
}
