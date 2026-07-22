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
  { key: 'school', label: 'Schools', icon: '🎓', color: '#4C9AFF', cats: 'education.school' },
  { key: 'college', label: 'Colleges', icon: '🏛️', color: '#6554C0', cats: 'education.college,education.university' },
  { key: 'hospital', label: 'Hospitals', icon: '🏥', color: '#FF5630', cats: 'healthcare.hospital' },
  { key: 'pharmacy', label: 'Pharmacies', icon: '💊', color: '#FF7452', cats: 'healthcare.pharmacy' },
  { key: 'transit', label: 'Stations', icon: '🚉', color: '#00B8D9', cats: 'public_transport' },
  { key: 'airport', label: 'Airports', icon: '✈️', color: '#2684FF', cats: 'airport' },
  { key: 'mall', label: 'Malls / Markets', icon: '🛍️', color: '#FFAB00', cats: 'commercial.shopping_mall,commercial.supermarket,commercial.marketplace' },
  { key: 'fuel', label: 'Petrol pumps', icon: '⛽', color: '#FF8B00', cats: 'service.vehicle.fuel' },
  { key: 'hotel', label: 'Hotels', icon: '🏨', color: '#8777D9', cats: 'accommodation.hotel' },
  { key: 'restaurant', label: 'Restaurants', icon: '🍽️', color: '#FF991F', cats: 'catering.restaurant,catering.fast_food' },
  { key: 'bank', label: 'Banks / ATMs', icon: '🏦', color: '#36B37E', cats: 'service.financial' },
  { key: 'park', label: 'Parks', icon: '🌳', color: '#57D9A3', cats: 'leisure.park' },
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
async function fetchNearbyCategory(lat, lng, radiusM, cats, limit) {
  if (!GEOAPIFY_API_KEY) return [];
  const url = 'https://api.geoapify.com/v2/places'
    + '?categories=' + encodeURIComponent(cats)
    + '&filter=circle:' + lng + ',' + lat + ',' + radiusM
    + '&bias=proximity:' + lng + ',' + lat
    + '&limit=' + (limit || 20)
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
      distance: p.distance,
    };
  }).filter(r => r.lat != null && r.lng != null);
}
