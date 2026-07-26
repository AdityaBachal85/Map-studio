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
