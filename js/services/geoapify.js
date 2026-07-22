/**
 * services/geoapify.js — Geoapify-first geocoding with an automatic, silent
 * fallback to Nominatim. Exposes geocodeSearch(q, bias), which returns the
 * same {lat,lng,name,label,icon}[] shape geocoder.js's doSearch() already
 * expects, so nothing downstream (rendering, recents, keyboard nav, request
 * de-duplication) needs to change -- only the fetch itself is swapped.
 */

const GEOAPIFY_CACHE_MAX = 50;
const geoapifyCache = new Map(); // "query|bbox" -> results[], simple bounded LRU

function cacheGet(key) {
  if (!geoapifyCache.has(key)) return null;
  const v = geoapifyCache.get(key);
  geoapifyCache.delete(key); geoapifyCache.set(key, v); // move to most-recently-used
  return v;
}
function cacheSet(key, val) {
  geoapifyCache.delete(key);
  geoapifyCache.set(key, val);
  if (geoapifyCache.size > GEOAPIFY_CACHE_MAX) geoapifyCache.delete(geoapifyCache.keys().next().value);
}

/**
 * Map a Geoapify result category (e.g. "education.school") to an emoji,
 * mirroring services/places.js's iconFor() for Nominatim's class/type.
 * @param {string} cat @returns {string}
 */
function iconForGeoapifyCategory(cat) {
  const c = String(cat || '');
  if (c.startsWith('railway')) return '🚉';
  if (c.startsWith('airport') || c.startsWith('aeroway')) return '✈️';
  if (c.startsWith('healthcare')) return '🏥';
  if (c.startsWith('education')) return '🎓';
  if (c.startsWith('highway')) return '🛣️';
  if (c.includes('bus')) return '🚌';
  if (c.startsWith('commercial')) return '🛍️';
  if (c.startsWith('leisure') || c.startsWith('natural') || c.includes('park')) return '🌳';
  if (c.startsWith('populated_place') || c.startsWith('administrative')) return '🏙️';
  if (c.includes('hotel')) return '🏨';
  if (c.startsWith('building') || c.startsWith('accommodation')) return '🏢';
  return '📍';
}

/**
 * Query Geoapify's autocomplete endpoint directly (no cache, no fallback --
 * callers should go through geocodeSearch()).
 * @param {string} q @param {L.LatLngBounds|null} bias
 * @returns {Promise<Array>} mapped results; throws on network/HTTP failure.
 */
async function geoapifySearch(q, bias) {
  if (!GEOAPIFY_API_KEY) return [];
  let url = 'https://api.geoapify.com/v1/geocode/autocomplete?limit=6&format=json&text=' + encodeURIComponent(q) + '&apiKey=' + GEOAPIFY_API_KEY;
  if (bias) url += `&bias=rect:${bias.getWest()},${bias.getSouth()},${bias.getEast()},${bias.getNorth()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Geoapify HTTP ' + res.status);
  const json = await res.json();
  const items = json.results || [];
  return items.map(r => ({
    lat: r.lat, lng: r.lon,
    name: r.name || r.address_line1 || (r.formatted || '').split(',')[0],
    label: r.formatted || r.address_line1 || r.name,
    icon: iconForGeoapifyCategory(r.category || (r.categories && r.categories[0]) || ''),
  }));
}

/** The original Nominatim search (unchanged), now the fallback path. */
async function nominatimSearch(q, bias) {
  let url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=' + encodeURIComponent(q);
  if (bias) url += `&viewbox=${bias.getWest()},${bias.getNorth()},${bias.getEast()},${bias.getSouth()}&bounded=0`;
  const res = await fetch(url);
  const data = await res.json();
  return data.map(r => ({ lat: +r.lat, lng: +r.lon, name: (r.name || r.display_name.split(',')[0]), label: r.display_name, icon: iconFor(r.class, r.type) }));
}

/**
 * Geocode a search query: Geoapify first (cached), falling back to Nominatim
 * automatically and silently if Geoapify has no key, fails, or returns
 * nothing. Debouncing and duplicate-request supersession stay owned by the
 * caller (geocoder.js's existing searchTimer / token mechanism).
 * @param {string} q @param {L.LatLngBounds|null} bias
 * @returns {Promise<Array<{lat:number,lng:number,name:string,label:string,icon:string}>>}
 */
async function geocodeSearch(q, bias) {
  const key = q.trim().toLowerCase() + '|' + (bias ? bias.toBBoxString() : '');
  const cached = cacheGet(key);
  if (cached) return cached;
  let results = [];
  try { results = await geoapifySearch(q, bias); } catch (e) { results = []; }
  if (!results.length) results = await nominatimSearch(q, bias);
  cacheSet(key, results);
  return results;
}
