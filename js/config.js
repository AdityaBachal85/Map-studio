/**
 * config.js — external service endpoints.
 */

/** OSRM routing hosts per travel profile; first host is primary, rest are fallbacks. */
const ROUTERS = {
  car: ['https://routing.openstreetmap.de/routed-car', 'https://router.project-osrm.org'],
  bike: ['https://routing.openstreetmap.de/routed-bike'],
  foot: ['https://routing.openstreetmap.de/routed-foot']
};

/**
 * Geoapify API key for search (services/geoapify.js) and nearby-places
 * discovery (services/nearbyPlaces.js). This app has no backend, so this key
 * is visible to anyone who views the deployed page's source -- restrict it to
 * this site's domain in Geoapify's dashboard ("referrer restrictions") if it
 * hasn't been already. Leave empty to disable Geoapify and use only the
 * existing free fallbacks (Nominatim search, no nearby-places).
 */
const GEOAPIFY_API_KEY = '72551776e5ff41cca6cec522fa9062cd';

/**
 * Basemap provider API keys. The catalogue in map/basemapProviders.js hides any
 * basemap whose key is missing, so leaving these empty simply falls back to the
 * keyless Esri/Carto/OSM tiles — nothing breaks.
 *
 * `arcgis` — an ArcGIS Location Platform key (free tier at
 *   developers.arcgis.com). Unlocks the "Imagery Hybrid HD" / "Navigation HD"
 *   basemaps: 512px tiles rendered from Esri's Basemap Styles v2 vector styles,
 *   which is the cartography the ArcGIS attribution in the brief refers to.
 *   This is the single biggest available upgrade to map quality.
 *
 * `mappls` — a Mappls (MapmyIndia) map key. See the Mappls block below: the
 *   credential type matters, and it is probably not the one from the REST API
 *   page.
 */
const MAP_PROVIDER_KEYS = {
  arcgis: '',
  mappls: 'qvbbxilcnllctbsgabklmdpsxnoucoabncre'
};

/* ---------------------------------------------------------------------------
 * Mappls (MapmyIndia)
 * -------------------------------------------------------------------------
 *
 * WHICH KEY. Mappls issues four separate credentials and they are NOT
 * interchangeable: MAP_SDK_KEY, REST_API_KEY, CLIENT_ID and CLIENT_SECRET.
 * Map tiles and `map_load` authenticate with the **Map SDK key**. A key taken
 * from the REST API page (the one that lists Auto Suggest, Nearby, Geocoding,
 * Routing…) will authenticate those REST calls but will be rejected for tiles.
 * If the Mappls basemap loads blank or grey, that mismatch is the first thing
 * to check — the app will say so in the status line, because tile auth
 * failures are counted and reported.
 *
 * TILE URL. Mappls documents its web integration through the `map_load` JS
 * SDK rather than a public XYZ tile template, so the template below could not
 * be confirmed against the live service from the build environment. It is
 * exposed here rather than buried in the catalogue precisely so it can be
 * corrected without touching the provider code. If Mappls support gives you a
 * different pattern, paste it here — `{token}` is replaced with the key above.
 *
 * EXPORT SAFETY is no longer assumed either way. Whether these tiles can be
 * rasterised into a PNG/PPTX depends on a response header we cannot see from
 * here, so the app now *measures* it: the first tile that loads is drawn into a
 * scratch canvas, and if reading it back throws a SecurityError the basemap is
 * marked export-blocked at runtime (see attachExportSafetyProbe in
 * map/mapEngine.js). Turn this on, look at the map, and the app will tell you
 * where it stands rather than relying on a guess baked into the source.
 * ------------------------------------------------------------------------- */
/*
 * OFF — pending an answer from Mappls support.
 *
 * Established by testing against the live service from a whitelisted browser:
 *   - the Static Key is valid. Requests return HTTP 412 (precondition failed),
 *     not 401/403, which is what Mappls answers for a recognised key;
 *   - the domain https://adityabachal85.github.io IS whitelisted in the console;
 *   - the account's Credentials tab offers a Static Key and nothing else — no
 *     separate Map SDK key exists on this plan;
 *   - despite "Raster Tiles SDK" showing Active under Allocations, the SDK
 *     loader script, 44 direct tile URLs and every List Styles request all fail.
 *
 * Since <script> and <img> requests ignore CORS, their failing too means the
 * service is refusing the key for tiles rather than serving a wrong path. No
 * tile URL will work until the account is entitled, so both Mappls basemaps stay
 * hidden rather than offering something known to be broken. Flip this back to
 * true once support confirms tile access; diagnostics/mappls-tiles.html will
 * then find the layer name in one click.
 */
const MAPPLS_ENABLED = false;

/**
 * Mappls ROAD basemap — needs a direct tile URL, which Mappls does not publish.
 *
 * Mappls ships its road basemap through its own Web SDK loader:
 *   https://apis.mappls.com/advancedmaps/api/<key>/map_sdk?v=3.0&layer=raster
 * That script brings its own bundled copy of Leaflet and expects to construct
 * the map itself (`new mappls.Map(...)`). Running it alongside the Leaflet
 * instance this app already owns means two Leaflet globals fighting over the
 * same container, so it is not a drop-in tile layer.
 *
 * There is no publicly documented XYZ template for the road basemap. Guessing
 * layer names does not work — `map_tiles`, `raster_tiles`, `standard` and
 * `tiles` were all tried against the live service and all 404.
 *
 * The URL *shape* is documented, and `bhuvan_imagery` below proves the pattern:
 *   https://apis.mappls.com/advancedmaps/v1/<key>/<layer>/{z}/{x}/{y}.png
 *
 * To enable the road basemap, get the correct <layer> name — from the
 * **List Styles API** (allocated on this account) or from Mappls support — and
 * paste the whole template here. The entry stays hidden from the basemap
 * switcher until this is filled in, so nobody can select a basemap that cannot
 * draw. `{token}` ← MAP_PROVIDER_KEYS.mappls.
 */
const MAPPLS_TILE_URL = '';

/**
 * Optional templates to try automatically, in order, when MAPPLS_TILE_URL is
 * empty. Left deliberately empty: shotgunning guessed layer names produced
 * nothing but 404s and a blank map. Add candidates here only if you have
 * reason to believe they exist.
 */
const MAPPLS_TILE_CANDIDATES = [];

/** Documented Mappls satellite layer (ISRO Bhuvan imagery) — a direct template. */
const MAPPLS_IMAGERY_URL = 'https://apis.mappls.com/advancedmaps/v1/{token}/bhuvan_imagery/{z}/{x}/{y}.png';

/**
 * Search provider endpoints
 */
const SEARCH_PROVIDERS = Object.freeze({
  geoapify: {
    autocomplete: "https://api.geoapify.com/v1/geocode/autocomplete",
    search: "https://api.geoapify.com/v1/geocode/search",
    reverse: "https://api.geoapify.com/v1/geocode/reverse"
  },

  photon: {
    autocomplete: "https://photon.komoot.io/api"
  },

  nominatim: {
    search: "https://nominatim.openstreetmap.org/search",
    reverse: "https://nominatim.openstreetmap.org/reverse"
  }
});

const PLACES_PROVIDERS = Object.freeze({

  geoapify: {
    nearby: "https://api.geoapify.com/v2/places"
  },

  overpass: {
    nearby: "https://overpass-api.de/api/interpreter"
  }

});
