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

/* ---------------------------------------------------------------------------
 * Telling a school from a college, when Google cannot
 *
 * Google's taxonomy has no `college` type at all, and Indian listings do not
 * respect the types it does have. Verified live at Airoli (19.1557, 72.9986,
 * radius 3 km):
 *
 *   Shreeram Vidyalya & Junior College of Science  →  school
 *   EuroSchool Airoli - ICSE School                →  educational_institution
 *   Datta Meghe College Of Engineering             →  university
 *   ROYAL INFOTECH / "Airoli" / Dhadkan 3415       →  university  (they are not)
 *
 * So a type filter on its own drops the junior college the user went looking
 * for and keeps a computer shop. The fix is to ask Google for the broad parent
 * type — `educational_institution` covers schools, colleges and preschools
 * alike — and then let the *name* decide which chip a place belongs on. These
 * four patterns are that vote, and every example above lands correctly.
 * ------------------------------------------------------------------------- */

/** Names that mean "this is a college", whatever Google typed it as. */
const EDU_COLLEGE_RE = /(college|mahavidyalaya|vidyapeeth|polytechnic|university|institute|\biti\b|\bb\.?ed\b)/i;
/**
 * Names that mean "this is a school". `vid[h]?yal` rather than the full word:
 * the transliteration is not standardised and all of Vidyalaya, Vidyalya and
 * Vidhyalay are in use within three kilometres of Airoli — spelling out one of
 * them is how "Shreeram Vidyalya & Junior College" got missed.
 */
const EDU_SCHOOL_RE = /(school|vid[h]?yal|vidya\s?mandir|shala|gurukul|convent|academy|\bhigh\b)/i;
/** Coaching classes, driving schools and shops that list themselves as either. */
const EDU_COACHING_RE = /(classes|tuitions?|tutorials?|coaching|abacus|driving|motor training|(spoken|speaking)\s+english|english\s+speaking|share market|infotech|distance learning|placement)/i;
/** Real, but not what "schools nearby" means — kept, ranked below the rest. */
const EDU_TINY_RE = /(play\s?group|pre-?school|pre-?primary|nursery|day\s?care|kindergarten|cr[eè]che|toddler)/i;

/** Schools chip: everything educational except the colleges and the coaching. */
function refineSchools(rows) {
  return rows
    .filter(r => {
      if (EDU_COACHING_RE.test(r.name)) return false;
      // A pure college — no school word anywhere in the name — belongs on the
      // other chip. "Shreeram Vidyalya & Junior College" matches both and stays
      // on both, which is right: it is both.
      if (EDU_COLLEGE_RE.test(r.name) && !EDU_SCHOOL_RE.test(r.name)) return false;
      // Catches the listings typed `university` that are not educational at all
      // ("Airoli", "Dhadkan 3415") — they carry no school word either.
      if (r.primaryType === 'university' && !EDU_SCHOOL_RE.test(r.name)) return false;
      return true;
    })
    .sort((a, b) => {
      const ta = EDU_TINY_RE.test(a.name) || a.primaryType === 'preschool' ? 1 : 0;
      const tb = EDU_TINY_RE.test(b.name) || b.primaryType === 'preschool' ? 1 : 0;
      return ta - tb || a.distance - b.distance;
    });
}

/** Colleges chip: name has to say so. Type is not evidence here. */
function refineColleges(rows) {
  return rows.filter(r => EDU_COLLEGE_RE.test(r.name) && !EDU_COACHING_RE.test(r.name));
}

/** Discoverable categories: friendly label + icon + marker colour + Geoapify category id(s). */
const NEARBY_CATEGORIES = [
  { key: 'school', label: 'Schools', icon: '🎓', color: '#4C9AFF', cats: 'education' , gtypes: ['school','educational_institution'], grefine: refineSchools },
  { key: 'college', label: 'Colleges', icon: '🏛️', color: '#6554C0', cats: 'education' , gtypes: ['university','educational_institution'], grefine: refineColleges },
  { key: 'hospital', label: 'Hospitals', icon: '🏥', color: '#FF5630', cats: 'healthcare.hospital' , gtypes: ['hospital'] },
  { key: 'pharmacy', label: 'Pharmacies', icon: '💊', color: '#FF7452', cats: 'healthcare.pharmacy' , gtypes: ['pharmacy'] },
  // `transit_station` is the parent of train / subway / bus, so one type covers
  // them all — verified at Airoli, where it returns Airoli railway station, the
  // bus depot and the stops in a single request.
  { key: 'transit', label: 'Stations', icon: '🚉', color: '#00B8D9', cats: 'public_transport' , gtypes: ['transit_station'] },
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
 * Answers already paid for, keyed by category + centre + radius. Toggling a
 * chip off and back on, or re-opening the panel without moving, is a common
 * gesture and used to cost a fresh request every time — which is how a daily
 * quota disappears. Centre is rounded to ~1 m so an imperceptible drag does not
 * count as a new place.
 */
const nearbyCache = new Map();
const NEARBY_CACHE_MAX = 60;

/** @returns {string} identity of a category at a place, radius aside. */
function nearbyFamilyKey(lat, lng, cats, gtypes) {
  return [cats, (gtypes || []).join('+'), lat.toFixed(5), lng.toFixed(5)].join('|');
}

/** @returns {string} cache key for one category at one place and radius. */
function nearbyCacheKey(lat, lng, radiusM, cats, gtypes) {
  return nearbyFamilyKey(lat, lng, cats, gtypes) + '|' + Math.round(radiusM);
}

/**
 * A wider answer already held that can be narrowed to `radiusM` for free.
 *
 * Shrinking the radius slider used to cost one request per active chip, which
 * is how a whole day's quota goes in a few seconds of fiddling. A smaller
 * circle is a strict subset of a larger one, so the answer is already in hand —
 * *provided* the wider fetch was not truncated. A capped response is only the
 * top twenty of the wider circle and may be missing places that fall inside the
 * smaller one, so those are refetched rather than narrowed.
 *
 * @param {string} fam @param {number} radiusM
 */
function nearbyNarrowable(fam, radiusM) {
  for (const [k, rows] of nearbyCache) {
    if (!k.startsWith(fam + '|')) continue;
    if (rows.capped || !(rows.radiusM >= radiusM)) continue;
    return rows;
  }
  return null;
}

/** Drop every cached answer. Called when the Google key changes. */
function clearNearbyCache() { nearbyCache.clear(); }

/**
 * Turn a provider error into something a person can act on. A spent daily quota
 * is the one failure that looks exactly like "the feature broke": every chip
 * goes quiet at once, with nothing on screen to say why.
 * @param {string} msg
 */
function nearbyErrorNote(msg) {
  if (/quota/i.test(msg)) return 'Google daily quota reached — results are from Geoapify';
  if (/api key|permission|denied|forbidden/i.test(msg)) return 'Google rejected the key — results are from Geoapify';
  return 'Google unavailable — results are from Geoapify';
}

/**
 * Fetch places of one category within a radius of a point via Geoapify Places.
 * @param {number} lat @param {number} lng @param {number} radiusM
 * @param {string} cats Geoapify category id(s), comma-separated
 * @param {number} [limit]
 * @returns {Promise<Array<{lat:number,lng:number,name:string,address:string,distance:number}>>}
 */
async function fetchNearbyCategory(lat, lng, radiusM, cats, limit, gtypes, grefine) {
  const fam = nearbyFamilyKey(lat, lng, cats, gtypes);
  const ck = fam + '|' + Math.round(radiusM);
  if (nearbyCache.has(ck)) return nearbyCache.get(ck);

  const keep = rows => {
    rows.radiusM = radiusM;
    if (rows.capped == null) rows.capped = false;
    if (nearbyCache.size >= NEARBY_CACHE_MAX) nearbyCache.delete(nearbyCache.keys().next().value);
    nearbyCache.set(ck, rows);
    return rows;
  };

  const wider = nearbyNarrowable(fam, radiusM);
  if (wider) {
    const inside = wider.filter(r => r.distance <= radiusM);
    inside.source = wider.source;
    if (wider.note) inside.note = wider.note;
    return keep(inside);
  }

  let note = '';

  // Google first when a key is present. Its Indian POI data is the reason this
  // integration exists — verified against the live API, a Pune search returns
  // Fergusson College, Deenanath Mangeshkar Hospital and Pune Station where the
  // free providers return partial or unnamed results. Geoapify stays behind it
  // untouched, so no key means no change in behaviour.
  if (gtypes && gtypes.length && typeof googleReady === 'function' && googleReady()) {
    try {
      // Refine before the limit is applied — the filter drops rows, and taking
      // the top 50 first would hand the refiner an already-truncated list.
      let g = await googleNearby(lat, lng, radiusM, gtypes);
      // `grefine` and `slice` both return fresh arrays, so carry the flag over
      // by hand. Losing it would let a truncated list be narrowed to a smaller
      // radius, silently dropping places that belong in the smaller circle.
      const capped = g.capped;
      if (grefine) g = grefine(g);
      if (limit) g = g.slice(0, limit);
      g.capped = capped;
      if (g.length) { g.source = 'google'; return keep(g); }
    } catch (e) {
      note = nearbyErrorNote(e.message || '');
      console.warn('Google nearby failed:', e.message);
    }
  }
  if (!GEOAPIFY_API_KEY) {
    if (note) throw new Error(note);
    return keep([]);
  }
  const url = PLACES_PROVIDERS.geoapify.nearby
    + '?categories=' + encodeURIComponent(cats)
    + '&filter=circle:' + lng + ',' + lat + ',' + radiusM
    + '&bias=proximity:' + lng + ',' + lat
    + '&limit=' + (limit || 50)
    + '&apiKey=' + GEOAPIFY_API_KEY;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Geoapify Places HTTP ' + res.status);
  const json = await res.json();
  const out = (json.features || []).map(f => {
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
  out.source = 'geoapify';
  out.capped = out.length >= (limit || 50);
  if (note) out.note = note;
  return keep(out);
}
