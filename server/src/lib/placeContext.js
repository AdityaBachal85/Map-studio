/**
 * lib/placeContext.js — turn a site's coordinates into names you can search.
 *
 * This is the single biggest lever on research quality, and it is easy to
 * miss. The client sends `{name, lat, lng}`, where `name` is whatever the
 * operator typed — "Plot 4", "Site A", a project codename. Neither that nor
 * "19.1547, 72.9986" appears in a municipal notification or a news article,
 * so a web search built from them returns nothing about the actual place.
 *
 * What a search engine *has* indexed is "Sector 4, Airoli, Navi Mumbai,
 * Maharashtra 400708" — and Google Places will hand that over from the
 * coordinates alone, on the Essentials tier, for free. Verified live against
 * the project's existing Maps key: one searchNearby call with an
 * addressComponents field mask returns sublocality, locality, district,
 * state and postcode.
 *
 * (The obvious tool for this is the Geocoding API's reverse lookup. It is not
 * used because it returned "You must enable Billing on the Google Cloud
 * Project" on this key, while Places answered the same question free.)
 */

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchNearby';
/** Widened until something is found — a remote plot may have nothing within 300 m. */
const SEARCH_RADII_M = [300, 1500, 6000];

/** Address-component types worth pulling out, mapped to our field names. */
const COMPONENT_FIELDS = [
  ['sublocality_level_1', 'sublocality'],
  ['locality', 'locality'],
  ['administrative_area_level_3', 'taluka'],
  ['administrative_area_level_2', 'district'],
  ['administrative_area_level_1', 'state'],
  ['postal_code', 'postalCode'],
  ['country', 'country'],
];

/** @returns {string|undefined} */
function mapsKey() {
  return process.env.GOOGLE_MAPS_API_KEY || process.env.GEMINI_API_KEY_MAPS || undefined;
}

/**
 * Resolve the administrative names around a coordinate.
 *
 * Never throws. A site whose names cannot be resolved still produces a
 * report — the agents fall back to the raw coordinates, which is what they
 * used before this existed. Losing the research quality is bad; losing the
 * whole report because a lookup failed is worse.
 *
 * @param {{lat:number, lng:number}} site
 * @returns {Promise<{formattedAddress?:string, sublocality?:string, locality?:string,
 *   taluka?:string, district?:string, state?:string, postalCode?:string,
 *   country?:string, resolved:boolean, reason?:string}>}
 */
async function resolvePlace({ lat, lng }) {
  const key = mapsKey();
  if (!key) return { resolved: false, reason: 'GOOGLE_MAPS_API_KEY is not set' };

  for (const radius of SEARCH_RADII_M) {
    try {
      const res = await fetch(PLACES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.formattedAddress,places.addressComponents',
        },
        body: JSON.stringify({
          maxResultCount: 1,
          rankPreference: 'DISTANCE',
          locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { resolved: false, reason: `Places HTTP ${res.status} ${detail.slice(0, 120)}` };
      }
      const json = await res.json();
      const place = (json.places || [])[0];
      if (!place) continue;                    // nothing at this radius, widen

      const out = { resolved: false, formattedAddress: place.formattedAddress };
      for (const c of place.addressComponents || []) {
        const types = c.types || [];
        for (const [type, field] of COMPONENT_FIELDS) {
          if (types.includes(type) && !out[field]) out[field] = c.longText || c.shortText;
        }
      }
      // "Resolved" means we got a name worth searching, not merely that the
      // request succeeded. Two ways it isn't: no locality at all, or a
      // placeholder name. Places answers (0, 0) — open ocean in the Gulf of
      // Guinea — with a locality of literally "......." , and searching for
      // that would return whatever the web happens to hold for seven dots.
      // Requiring a letter is the cheapest test that rejects it.
      const named = n => !!n && /\p{L}/u.test(n);
      out.resolved = named(out.sublocality) || named(out.locality);
      if (!out.resolved) out.reason = 'no usable locality in the address components';
      return out;
    } catch (e) {
      return { resolved: false, reason: e.message };
    }
  }
  return { resolved: false, reason: 'no place found within 6 km' };
}

/**
 * The place, written the way a person would say it — most specific first.
 *
 * Used both in prompts and to build search queries, so the two always agree
 * on what "here" means.
 *
 * @param {object} place a resolvePlace() result
 * @param {{lat:number,lng:number}} site
 * @returns {string} e.g. "Airoli, Navi Mumbai, Thane, Maharashtra"
 */
function placePhrase(place, site) {
  const parts = [place.sublocality, place.locality, place.taluka, place.district, place.state]
    .filter(Boolean)
    // Google fills administrative_area_level_2 in India with the revenue
    // *division* — "Konkan Division", "Pune Division". Nothing a municipal
    // notice or a news story is ever written about, so it only dilutes a
    // query and reads as noise in a report. Measured on three real sites.
    .filter(p => !/\bdivision\b/i.test(p));
  // Duplicates are common in Indian addressing — Navi Mumbai turns up as both
  // locality and taluka — and "Airoli, Navi Mumbai, Navi Mumbai" reads as a
  // typo in a client document.
  const seen = new Set();
  const unique = parts.filter(p => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.length ? unique.join(', ') : `${site.lat}, ${site.lng}`;
}

module.exports = { resolvePlace, placePhrase };
