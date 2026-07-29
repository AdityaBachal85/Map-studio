/**
 * services/nearbyPlaces.js — Geoapify Places API (nearby discovery). Each
 * category is fetched in its OWN request (not batched) so that if one category
 * string is ever wrong/unsupported it fails alone and silently, never taking
 * the other categories down with it.
 *
 * If a chip consistently returns nothing, its `cats` string below is the thing
 * to check against Geoapify's "Supported categories" list
 * (apidocs.geoapify.com/docs/places) — everything else is category-agnostic.
 */

/** Discoverable categories: friendly label + icon + marker colour + Geoapify category id(s). */
const NEARBY_CATEGORIES = [
  { key: 'school', label: 'Schools', icon: '🎓', color: '#4C9AFF', cats: 'education' , gtypes: ['school','primary_school','secondary_school'] },
  { key: 'college', label: 'Colleges', icon: '🏛️', color: '#6554C0', cats: 'education' , gtypes: ['university'] },
  { key: 'hospital', label: 'Hospitals', icon: '🏥', color: '#FF5630', cats: 'healthcare.hospital' , gtypes: ['hospital'] },
  { key: 'pharmacy', label: 'Pharmacies', icon: '💊', color: '#FF7452', cats: 'healthcare.pharmacy' , gtypes: ['pharmacy'] },
  { key: 'transit', label: 'Stations', icon: '🚉', color: '#00B8D9', cats: 'public_transport' , gtypes: ['train_station','subway_station','bus_station','transit_station'] },
  { key: 'airport', label: 'Airports', icon: '✈️', color: '#2684FF', cats: 'airport' , gtypes: ['airport'] },
  { key: 'mall', label: 'Malls / Markets', icon: '🛍️', color: '#FFAB00', cats: 'commercial.shopping_mall,commercial.supermarket,commercial.marketplace' , gtypes: ['shopping_mall','supermarket','department_store'] },
  { key: 'fuel', label: 'Petrol pumps', icon: '⛽', color: '#FF8B00', cats: 'service.vehicle.fuel' , gtypes: ['gas_station'] },
  { key: 'hotel', label: 'Hotels', icon: '🏨', color: '#8777D9', cats: 'accommodation.hotel' , gtypes: ['hotel','lodging'] },
  { key: 'restaurant', label: 'Restaurants', icon: '🍽️', color: '#FF991F', cats: 'catering.restaurant,catering.fast_food' , gtypes: ['restaurant'] },
  { key: 'bank', label: 'Banks / ATMs', icon: '🏦', color: '#36B37E', cats: 'service.financial' , gtypes: ['bank','atm'] },
  { key: 'park', label: 'Parks', icon: '🌳', color: '#57D9A3', cats: 'leisure.park' , gtypes: ['park'] },
];

/** Look up a category descriptor by key. @param {string} key */
const nearbyCatByKey = key => NEARBY_CATEGORIES.find(c => c.key === key);

/**
 * Fetch places of one category within a radius of a point via Geoapify Places.
 * @param {number} lat @param {number} lng @param {number} radiusM
 * @param {string} cats Geoapify category id(s), comma-separated
 * @param {number} [limit]
 * @returns {Promise<Array<{lat:number,lng:number,name:string,address:string,distance:number}>>}
 */
async function fetchNearbyCategory(lat, lng, radiusM, cats, limit, gtypes) {
  // Google first when a key is present. Its Indian POI data is the reason this
  // integration exists — verified against the live API, a Pune search returns
  // Fergusson College, Deenanath Mangeshkar Hospital and Pune Station where the
  // free providers return partial or unnamed results. Geoapify stays behind it
  // untouched, so no key means no change in behaviour.
  if (gtypes && gtypes.length && typeof googleReady === 'function' && googleReady()) {
    try {
      const g = await googleNearby(lat, lng, radiusM, gtypes, limit);
      if (g.length) return g;
    } catch (e) { console.warn('Google nearby failed:', e.message); }
  }
  if (!GEOAPIFY_API_KEY) return [];
  const url = PLACES_PROVIDERS.geoapify.nearby
    + '?categories=' + encodeURIComponent(cats)
    + '&filter=circle:' + lng + ',' + lat + ',' + radiusM
    + '&bias=proximity:' + lng + ',' + lat
    + '&limit=' + (limit || 50)
    + '&apiKey=' + GEOAPIFY_API_KEY;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Geoapify Places HTTP ' + res.status);
  const json = await res.json();
  return (json.features || []).map(f => {
    const p = f.properties || {};
    const coords = (f.geometry && f.geometry.coordinates) || [p.lon, p.lat];
    return {
      lat: coords[1], lng: coords[0],
      name: p.name || p.address_line1 || p.street || p.formatted || 'Unnamed place',
      address: p.formatted || '',
      // Geoapify returns `distance` only alongside a proximity bias. Computing
      // it when absent keeps the marker tooltip from reading "NaN m", which is
      // what a missing field looked like downstream.
      distance: p.distance != null ? p.distance
        : haversineKm(lat, lng, coords[1], coords[0]) * 1000,
    };
  }).filter(r => r.lat != null && r.lng != null);
}
