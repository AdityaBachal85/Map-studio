/**
 * services/geoapify.js — 3-tier geocoding chain, each hop silent and
 * automatic: Geoapify (primary) -> Photon (fallback) -> Nominatim (final
 * fallback). Exposes geocodeSearch(q, bias), which returns the same
 * {lat,lng,name,label,icon}[] shape geocoder.js's doSearch() already expects,
 * so nothing downstream (rendering, recents, keyboard nav, request
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
 * Photon (komoot) geocoder — the middle fallback. Free, no key, OSM-based, with
 * good POI/address recall. osm_key/osm_value map cleanly onto Nominatim's
 * class/type so we reuse iconFor().
 * @param {string} q @param {L.LatLngBounds|null} bias @returns {Promise<Array>}
 */
async function photonSearch(q, bias) {
  let url = SEARCH_PROVIDERS.photon.autocomplete + '?limit=8&lang=en&q=' + encodeURIComponent(q);
  if (bias) { const c = bias.getCenter(); url += `&lat=${c.lat}&lon=${c.lng}`; }
  const res = await fetch(url);
  if (!res.ok) throw new Error('Photon HTTP ' + res.status);
  const json = await res.json();
  const seen = new Set();
  const out = [];
  for (const f of (json.features || [])) {
    const g = f.geometry, p = f.properties || {};
    if (!g || !g.coordinates) continue;
    const lat = g.coordinates[1], lng = g.coordinates[0];
    const label = [p.name, p.street, p.city || p.county, p.state, p.country].filter(Boolean).join(', ');
    const key = label.toLowerCase() + '|' + lat.toFixed(4) + ',' + lng.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      lat, lng,
      name: p.name || p.street || label.split(',')[0] || 'Place',
      label: label || (p.name || 'Place'),
      icon: iconFor(p.osm_key, p.osm_value),
    });
  }
  return out;
}

/** The original Nominatim search (unchanged), now the final fallback path. */
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
 * Geocode a search query through a 3-tier chain, each step silent and
 * automatic: Geoapify (primary) -> Photon (fallback) -> Nominatim (final
 * fallback). Each tier only runs if the previous one errored or returned zero
 * results, so a normal successful Geoapify search costs exactly one request.
 * Debouncing and duplicate-request supersession stay owned by the caller
 * (geocoder.js's existing searchTimer / token mechanism).
 * @param {string} q @param {L.LatLngBounds|null} bias
 * @returns {Promise<Array<{lat:number,lng:number,name:string,label:string,icon:string}>>}
 */
async function geocodeSearch(q, bias) {
  const c = bias ? bias.getCenter() : null;
  const key = q.trim().toLowerCase() + '|' + (c ? c.lat.toFixed(2) + ',' + c.lng.toFixed(2) : '');
  const cached = cacheGet(key);
  if (cached) return cached;
  let results = [];
  // Google first when a key is present: for Indian addresses, estate names and
  // building-level results it is markedly better than the others, which is the
  // whole reason for having it. The existing chain stays untouched behind it,
  // so removing the key returns the app to exactly its previous behaviour and
  // a Google outage costs a result, not the search box.
  if (typeof googleReady === 'function' && googleReady()) {
    try { results = await googleTextSearch(q, bias); } catch (e) { console.warn('Google search failed:', e.message); results = []; }
  }
  if (!results.length) { try { results = await geoapifySearch(q, bias); } catch (e) { console.warn('Geoapify failed:', e); results = []; } }
  if (!results.length) { try { results = await photonSearch(q, bias); } catch (e) { console.warn('Photon failed:', e); results = []; } }
  if (!results.length) { try { results = await nominatimSearch(q, bias); } catch (e) { console.warn('Nominatim failed:', e); results = []; } }
  cacheSet(key, results);
  return results;
}
