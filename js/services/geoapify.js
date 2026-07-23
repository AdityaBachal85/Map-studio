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
 * @param {string} cat @param {string} [rt] Geoapify result_type (city/street/postcode/...)
 * @returns {string}
 */
function iconForGeoapifyCategory(cat, rt) {
  const c = String(cat || '');
  const t = String(rt || '');
  if (t === 'postcode' || c.includes('postcode')) return '📮';
  if (c.startsWith('railway') || c.includes('subway') || c.includes('train')) return '🚉';
  if (c.startsWith('airport') || c.startsWith('aeroway')) return '✈️';
  if (c.includes('hospital') || c.startsWith('healthcare')) return '🏥';
  if (c.includes('school') || c.includes('university') || c.includes('college') || c.startsWith('education')) return '🎓';
  if (c.includes('fuel') || c.includes('petrol')) return '⛽';
  if (c.includes('mall') || c.includes('supermarket') || c.startsWith('commercial')) return '🛍️';
  if (c.includes('restaurant') || c.includes('catering') || c.includes('food')) return '🍽️';
  if (c.includes('hotel') || c.startsWith('accommodation')) return '🏨';
  if (c.startsWith('highway') || t === 'street' || c.includes('road')) return '🛣️';
  if (c.includes('bus')) return '🚌';
  if (c.startsWith('leisure') || c.startsWith('natural') || c.includes('park')) return '🌳';
  if (t === 'country' || t === 'state' || t === 'county' || c.startsWith('administrative')) return '🗺️';
  if (t === 'city' || t === 'village' || t === 'town' || t === 'suburb' || c.startsWith('populated_place')) return '🏙️';
  if (c.startsWith('building') || t === 'amenity') return '🏢';
  return '📍';
}

/**
 * Query Geoapify's autocomplete endpoint directly (no cache, no fallback --
 * callers should go through geocodeSearch()). Uses a *proximity* bias toward
 * the current view centre so nearby matches rank first without hard-excluding
 * far-away ones, asks for more candidates (limit 8) and de-duplicates
 * near-identical results Geoapify sometimes returns for the same place.
 * @param {string} q @param {L.LatLngBounds|null} bias
 * @returns {Promise<Array>} mapped results; throws on network/HTTP failure.
 */
async function geoapifySearch(q, bias) {
  if (!GEOAPIFY_API_KEY) return [];
  let url =
    SEARCH_PROVIDERS.geoapify.autocomplete
    + '?text=' + encodeURIComponent(q)
    + '&limit=8&format=json&lang=en'
    + '&apiKey=' + GEOAPIFY_API_KEY;
  if (bias) { const c = bias.getCenter(); url += `&bias=proximity:${c.lng},${c.lat}`; }
  const res = await fetch(url);
  if (!res.ok) throw new Error('Geoapify HTTP ' + res.status);
  const json = await res.json();
  const items = json.results || [];
  const seen = new Set();
  const out = [];
  for (const r of items) {
    const lat = r.lat, lng = r.lon;
    if (lat == null || lng == null) continue;
    const label = r.formatted || r.address_line1 || r.name || '';
    const dedupeKey = label.toLowerCase() + '|' + lat.toFixed(4) + ',' + lng.toFixed(4);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      lat, lng,
      name: r.name || r.address_line1 || (r.formatted || '').split(',')[0],
      label,
      icon: iconForGeoapifyCategory(r.category || (r.categories && r.categories[0]) || '', r.result_type),
    });
  }
  return out;
}

/**
 * Photon autocomplete fallback
 */
async function photonSearch(q, bias) {

  let url =
    SEARCH_PROVIDERS.photon.autocomplete
    + '?q=' + encodeURIComponent(q)
    + '&limit=8';

  if (bias) {
    const c = bias.getCenter();
    url += '&lon=' + c.lng + '&lat=' + c.lat;
  }

  const res = await fetch(url);

  if (!res.ok)
    throw new Error('Photon HTTP ' + res.status);

  const json = await res.json();

  return (json.features || []).map(f => ({

    lat: f.geometry.coordinates[1],

    lng: f.geometry.coordinates[0],

    name:
      f.properties.name ||
      f.properties.city ||
      f.properties.street ||
      'Unknown',

    label: [
      f.properties.name,
      f.properties.city,
      f.properties.county,
      f.properties.state,
      f.properties.country
    ]
      .filter(Boolean)
      .join(', '),

    icon: "📍"

  }));

}

/** The original Nominatim search (unchanged), now the fallback path. */
async function nominatimSearch(q, bias) {
  let url =
    SEARCH_PROVIDERS.nominatim.search
    + '?format=jsonv2&limit=6&q='
    + encodeURIComponent(q);
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
  const c = bias ? bias.getCenter() : null;
  const key = q.trim().toLowerCase() + '|' + (c ? c.lat.toFixed(2) + ',' + c.lng.toFixed(2) : '');
  const cached = cacheGet(key);
  if (cached) return cached;
  let results = [];

  /* ---------- Geoapify ---------- */

  try {

    results = await geoapifySearch(q, bias);

  } catch (e) {

    console.warn("Geoapify failed:", e);

  }

  /* ---------- Photon ---------- */

  if (!results.length) {

    try {

      results = await photonSearch(q, bias);

    } catch (e) {

      console.warn("Photon failed:", e);

    }

  }

  /* ---------- Nominatim ---------- */

  if (!results.length) {

    try {

      results = await nominatimSearch(q, bias);

    } catch (e) {

      console.warn("Nominatim failed:", e);

      results = [];

    }

  }
  cacheSet(key, results);
  return results;
}
