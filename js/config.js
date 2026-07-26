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
const MAPPLS_ENABLED = true;

/** Mappls raster tile template. `{token}` ← MAP_PROVIDER_KEYS.mappls. */
const MAPPLS_TILE_URL = 'https://apis.mappls.com/advancedmaps/v1/{token}/map_tiles/{z}/{x}/{y}.png';

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
