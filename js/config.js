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
 * `mappls` — a Mappls (MapmyIndia) key. See MAPPLS_ENABLED below before using.
 */
const MAP_PROVIDER_KEYS = {
  arcgis: '',
  mappls: 'qvbbxilcnllctbsgabklmdpsxnoucoabncre'
};

/**
 * Mappls basemap opt-in. OFF by default and deliberately so: Mappls raster
 * tiles are served without an `Access-Control-Allow-Origin` header, which
 * taints the export canvas and makes every PNG and PPTX export throw a
 * SecurityError. Mappls *search/geocoding* has no such problem — only the
 * basemap tiles do. Flip this on only for on-screen use, or once tiles are
 * proxied through a same-origin backend that adds the CORS header.
 */
const MAPPLS_ENABLED = false;

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
