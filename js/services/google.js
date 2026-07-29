/**
 * services/google.js — Google Maps Platform: places, search and routing.
 *
 * WHICH APIS, AND WHY IT MATTERS
 *
 * Google ships two generations of these services and only one of them can be
 * called from a browser at all:
 *
 *   Legacy   maps.googleapis.com/maps/api/{place,geocode,directions}
 *            No `Access-Control-Allow-Origin`. Every browser call is blocked.
 *            They exist to be called from a server, or through the Maps JS SDK.
 *
 *   Current  places.googleapis.com/v1/…  and  routes.googleapis.com/…/v2:…
 *            POST + `X-Goog-Api-Key`, CORS-enabled, meant for direct browser
 *            use. This is what the app uses.
 *
 * This app has no backend, so the legacy endpoints were never an option. That
 * is worth writing down because every tutorial and Stack Overflow answer still
 * reaches for them, and the failure looks like a CORS bug rather than a
 * deliberate design of Google's.
 *
 * VERIFIED, NOT ASSUMED
 *
 * Unusually for the providers in this app, every call here was checked against
 * the live service before it was written. Findings that shaped the code:
 *
 *   - `languageCode` is not optional. Without it, route descriptions for an
 *     Indian query came back in Assamese ("Sangamwadi Rd আৰু Airport Rd").
 *   - `BICYCLE` returns an empty result set in India and a real route in
 *     London: Google has no cycling network here. Bike routing therefore falls
 *     through to OSRM rather than reporting "no route".
 *   - Alternatives work: a Pune request returned three distinct routes with
 *     encoded polylines.
 *   - A field mask is mandatory on both services. Omitting it is an error, and
 *     asking for more than is needed is billed for, so each call asks for
 *     exactly what it uses.
 *
 * COST
 *
 * These are metered per request. Search is debounced by the caller, nearby is
 * one request per category per search, and routing is one per route. Nothing
 * here polls.
 */

const GOOGLE_PLACES_HOST = 'https://places.googleapis.com/v1';
const GOOGLE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/** Language and region for every request. See the note on Assamese above. */
const GOOGLE_LANG = 'en-GB';
const GOOGLE_REGION = 'IN';

/** @returns {string} the Google key from prefs, else config, else ''. */
function googleKey() {
  return typeof basemapKey === 'function' ? basemapKey('google') : '';
}

/** @returns {boolean} */
function googleReady() { return !!googleKey(); }

/**
 * POST to a Google endpoint with the key and field mask as headers.
 * @param {string} url @param {object} body @param {string} fieldMask
 * @returns {Promise<object>}
 */
async function googlePost(url, body, fieldMask) {
  const key = googleKey();
  if (!key) throw new Error('No Google key');
  const headers = { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key };
  if (fieldMask) headers['X-Goog-FieldMask'] = fieldMask;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json || {};
}

/* ---------------------------------------------------------------------------
 * Polyline decoding
 * ------------------------------------------------------------------------- */

/**
 * Decode Google's encoded polyline into `[[lat, lng], …]`.
 *
 * The format packs each coordinate as a delta from the previous one, in
 * base-64-ish chunks of five bits. Implemented here rather than pulled in
 * because it is twenty lines and the alternative is another dependency for a
 * single function.
 *
 * The output shape deliberately matches what OSRM produces after conversion,
 * so the rest of the app cannot tell which router drew a line.
 *
 * @param {string} str @returns {Array<[number, number]>}
 */
function decodePolyline(str) {
  const out = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    let shift = 0, result = 0, b;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Search
 * ------------------------------------------------------------------------- */

/** Rough icon for a Google place type, matching the existing result rows. */
function iconForGoogleTypes(types) {
  const t = (types || []).join(' ');
  if (/airport/.test(t)) return '✈️';
  if (/train_station|subway|transit_station|bus_station/.test(t)) return '🚉';
  if (/school|university|college/.test(t)) return '🎓';
  if (/hospital|doctor|clinic/.test(t)) return '🏥';
  if (/shopping_mall|store|supermarket/.test(t)) return '🛍️';
  if (/restaurant|cafe|food/.test(t)) return '🍽️';
  if (/lodging|hotel/.test(t)) return '🏨';
  if (/park/.test(t)) return '🌳';
  if (/locality|political|geocode/.test(t)) return '🏙️';
  return '📍';
}

/**
 * Search places by text.
 *
 * Text Search rather than Autocomplete on purpose. Autocomplete returns
 * predictions without coordinates, so every suggestion would need a second
 * Place Details call before the row could show a distance or fly the map
 * anywhere — two requests per keystroke-batch, and two things to bill. Text
 * Search returns the name, address and location in one.
 *
 * @param {string} q
 * @param {L.LatLngBounds|null} bias Viewport to prefer results near.
 * @returns {Promise<Array<{lat,lng,name,label,icon}>>}
 */
async function googleTextSearch(q, bias) {
  const body = {
    textQuery: q,
    languageCode: GOOGLE_LANG,
    regionCode: GOOGLE_REGION,
    maxResultCount: 8,
  };
  // A bias, not a restriction: a search for somewhere outside the current view
  // should still find it, just ranked below the near things.
  if (bias) {
    const c = bias.getCenter();
    body.locationBias = {
      circle: {
        center: { latitude: c.lat, longitude: c.lng },
        radius: Math.min(50000, Math.max(1000, bias.getNorthEast().distanceTo(bias.getSouthWest()) / 2)),
      },
    };
  }
  const json = await googlePost(GOOGLE_PLACES_HOST + '/places:searchText', body,
    'places.displayName,places.formattedAddress,places.location,places.types');

  return (json.places || []).map(p => {
    const name = (p.displayName && p.displayName.text) || p.formattedAddress || 'Unnamed place';
    return {
      lat: p.location.latitude,
      lng: p.location.longitude,
      name,
      label: p.formattedAddress ? name + ' — ' + p.formattedAddress : name,
      icon: iconForGoogleTypes(p.types),
      source: 'google',
    };
  }).filter(r => r.lat != null && r.lng != null);
}

/* ---------------------------------------------------------------------------
 * Autocomplete — what a search bar should actually do
 * ------------------------------------------------------------------------- */

/**
 * The session token that ties a run of keystrokes to the pick that ends it.
 *
 * Google bills autocomplete-then-details as one session when the same token is
 * passed throughout, and as separate requests when it is not. Beyond cost, it
 * is also what makes the predictions improve as the query grows, since Google
 * treats the keystrokes as one search rather than several unrelated ones.
 */
let _gSessionToken = null;

/** A fresh token. Any opaque unique string; a UUID is what Google suggests. */
function newGoogleSessionToken() {
  _gSessionToken = (crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'st-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  return _gSessionToken;
}

/** Called after a pick, so the next query starts a new billing session. */
function endGoogleSession() { _gSessionToken = null; }

/**
 * Live predictions for a partial query.
 *
 * This is the difference between a search box and a search *bar*. Text Search
 * wants a complete query and answers with places; Autocomplete answers "ferg"
 * with five ranked, disambiguated predictions — Fergusson College, Ferguson
 * College Road, Fergusson College Junior Wing — which is what the operator is
 * actually choosing between.
 *
 * Predictions carry no coordinates, by design: Google charges for the location
 * and expects you to fetch it only for the one that gets picked. So a row here
 * shows the address as its secondary line instead of a distance, and
 * `googlePlaceDetails` resolves the coordinates on selection.
 *
 * @param {string} q @param {L.LatLngBounds|null} bias
 * @returns {Promise<Array<object>>}
 */
async function googleAutocomplete(q, bias) {
  const body = {
    input: q,
    languageCode: GOOGLE_LANG,
    regionCode: GOOGLE_REGION,
    sessionToken: _gSessionToken || newGoogleSessionToken(),
  };
  if (bias) {
    const c = bias.getCenter();
    body.locationBias = {
      circle: {
        center: { latitude: c.lat, longitude: c.lng },
        radius: Math.min(50000, Math.max(2000, bias.getNorthEast().distanceTo(bias.getSouthWest()) / 2)),
      },
    };
  }
  const json = await googlePost(GOOGLE_PLACES_HOST + '/places:autocomplete', body);

  return (json.suggestions || []).map(sg => {
    const p = sg.placePrediction;
    if (!p) return null;
    const sf = p.structuredFormat || {};
    const main = (sf.mainText && sf.mainText.text) || (p.text && p.text.text) || '';
    const secondary = (sf.secondaryText && sf.secondaryText.text) || '';
    return {
      placeId: p.placeId,
      name: main,
      label: secondary ? main + ' — ' + secondary : main,
      secondary,
      icon: iconForGoogleTypes(p.types),
      source: 'google',
      // No lat/lng yet — the caller resolves it if this one is chosen.
      needsDetails: true,
    };
  }).filter(Boolean);
}

/**
 * Resolve a prediction to a real coordinate.
 * @param {string} placeId
 * @returns {Promise<{lat,lng,name,label,icon}|null>}
 */
async function googlePlaceDetails(placeId) {
  const key = googleKey();
  if (!key || !placeId) return null;
  const url = GOOGLE_PLACES_HOST + '/places/' + encodeURIComponent(placeId) +
    '?languageCode=' + GOOGLE_LANG +
    (_gSessionToken ? '&sessionToken=' + encodeURIComponent(_gSessionToken) : '');
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,types',
    },
  });
  if (!res.ok) return null;
  const p = await res.json();
  if (!p || !p.location) return null;
  // The pick closes the billing session.
  endGoogleSession();
  const name = (p.displayName && p.displayName.text) || p.formattedAddress || 'Place';
  return {
    lat: p.location.latitude,
    lng: p.location.longitude,
    name,
    label: p.formattedAddress ? name + ' — ' + p.formattedAddress : name,
    icon: iconForGoogleTypes(p.types),
    source: 'google',
  };
}

/* ---------------------------------------------------------------------------
 * Nearby places
 * ------------------------------------------------------------------------- */

/**
 * Place types that are technically in the category but are not what anyone
 * means by it. Kept as a demotion rather than an exclusion: a preschool IS
 * relevant to a homebuyer, it just should not push the actual secondary school
 * off the end of a twenty-item list, which is what "the college is not showing"
 * turned out to be.
 */
const GOOGLE_DEMOTE_TYPES = new Set([
  'preschool', 'child_care_agency', 'fitness_center', 'makeup_artist',
  'service', 'association_or_organization',
  // A Stations search at Airoli returns thirty-odd bus stops around one railway
  // station. The stops are real and stay in the list; the station goes first.
  'bus_stop',
]);

/** Hard ceiling Google puts on one Nearby Search response. */
const GOOGLE_NEARBY_CAP = 20;

/**
 * Places of one or more Google types within a radius.
 *
 * WHY POPULARITY, AND WHY EXACTLY ONE REQUEST
 *
 * The twenty-result ceiling is the whole problem. Ranked by DISTANCE, a schools
 * search at Airoli spends all twenty slots inside 520 m and comes back as
 * playgroups — Baby Steps, Tender Feet, Dada class, MASOOM NURSERY — while
 * EuroSchool, DAV Public School, VIBGYOR High and St Xavier's, the schools a
 * buyer actually asks about, never appear at all. Ranked by POPULARITY the same
 * request returns those four and drops the playgroups.
 *
 * An earlier version chased the last few percent of coverage with a second
 * DISTANCE pass and a per-type fan-out, three or four requests per chip. That
 * emptied the project's daily `SearchNearbyRequest` quota in an afternoon, and
 * an exhausted quota does not degrade gracefully — every chip goes quiet. One
 * request per chip is the budget; POPULARITY is what makes one request enough.
 *
 * @param {number} lat @param {number} lng @param {number} radiusM
 * @param {string[]} types Google place types.
 * @param {number} [limit]
 * @returns {Promise<Array<{lat,lng,name,address,primaryType,distance}>>}
 */
async function googleNearby(lat, lng, radiusM, types, limit) {
  const json = await googlePost(GOOGLE_PLACES_HOST + '/places:searchNearby', {
    // `includedPrimaryTypes`, not `includedTypes`. A dance studio and a makeup
    // academy both carry `school` somewhere in their type list; filtering on
    // the *primary* type drops them at the server. Verified at Airoli: it
    // removes "FMS Dance & Fitness", "Albatraoz Makeup & Hair Academy" and a
    // day-care from a schools search.
    includedPrimaryTypes: types,
    maxResultCount: GOOGLE_NEARBY_CAP,
    rankPreference: 'POPULARITY',
    languageCode: GOOGLE_LANG,
    regionCode: GOOGLE_REGION,
    locationRestriction: {
      circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(50000, radiusM) },
    },
  }, 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType');

  const out = (json.places || []).map(p => ({
    id: p.id,
    lat: p.location.latitude,
    lng: p.location.longitude,
    name: (p.displayName && p.displayName.text) || 'Unnamed place',
    address: p.formattedAddress || '',
    primaryType: p.primaryType || '',
    distance: haversineKm(lat, lng, p.location.latitude, p.location.longitude) * 1000,
  })).filter(r => r.lat != null && r.lng != null);

  // Nearest-first, but the genuine article ahead of its lookalikes: a preschool
  // stays in the list, just below the schools.
  out.sort((a, b) => {
    const da = GOOGLE_DEMOTE_TYPES.has(a.primaryType) ? 1 : 0;
    const db = GOOGLE_DEMOTE_TYPES.has(b.primaryType) ? 1 : 0;
    return da - db || a.distance - b.distance;
  });

  return limit ? out.slice(0, limit) : out;
}

/* ---------------------------------------------------------------------------
 * Routing
 * ------------------------------------------------------------------------- */

/** App travel mode → Google's. `bike` is absent: see the note below. */
const GOOGLE_TRAVEL_MODE = { car: 'DRIVE', foot: 'WALK' };

/**
 * Compute a route, with alternatives, in the shape the app already uses.
 *
 * Returns `null` rather than throwing when Google cannot serve the request, so
 * the caller falls through to OSRM. That covers the bicycle case: `BICYCLE`
 * returns an empty result set in India — verified against the live API, and
 * against London where it returns a real route — so cycling here is simply not
 * data Google has, and pretending otherwise would show "no route" for a journey
 * OSRM can route perfectly well.
 *
 * @param {{lat,lng}} from @param {{lat,lng}} to
 * @param {string} mode `car` | `bike` | `foot`
 * @param {Array<{lat,lng}>} [vias]
 * @returns {Promise<Array<{d:number,t:number,coords:Array<[number,number]>,desc:string}>|null>}
 */
async function googleRoute(from, to, mode, vias) {
  const travelMode = GOOGLE_TRAVEL_MODE[mode];
  if (!travelMode) return null;                       // bike — OSRM handles it

  const pt = p => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const body = {
    origin: pt(from),
    destination: pt(to),
    travelMode,
    languageCode: GOOGLE_LANG,
    regionCode: GOOGLE_REGION,
    units: 'METRIC',
    polylineEncoding: 'ENCODED_POLYLINE',
  };
  if (vias && vias.length) body.intermediates = vias.map(pt);
  // Alternatives are only offered for a direct A→B, the same restriction OSRM
  // has, so the two routers behave identically from the app's point of view.
  else body.computeAlternativeRoutes = true;
  if (travelMode === 'DRIVE') body.routingPreference = 'TRAFFIC_UNAWARE';

  const json = await googlePost(GOOGLE_ROUTES_URL, body,
    'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.description');

  const routes = json.routes || [];
  if (!routes.length) return null;

  return routes.map(r => ({
    d: r.distanceMeters,
    // Google returns duration as a protobuf string, "1690s".
    t: r.duration ? parseFloat(String(r.duration).replace('s', '')) : null,
    coords: decodePolyline((r.polyline && r.polyline.encodedPolyline) || ''),
    desc: r.description || '',
  })).filter(r => r.coords.length > 1);
}

/* ---------------------------------------------------------------------------
 * Capability probe
 * ------------------------------------------------------------------------- */

/**
 * Ask each service whether this key may use it.
 *
 * A Maps Platform key is a per-API thing: the same string can be live for
 * Places and 403 for Map Tiles because one checkbox in the Cloud console is
 * off. That is invisible from inside the app — the basemap is simply blank, or
 * nearby returns nothing — so the key panel reports each service separately and
 * names the console page to fix it on.
 *
 * @returns {Promise<Array<{label:string, ok:boolean, status:number, message:string}>>}
 */
async function googleCapabilities() {
  const key = googleKey();
  if (!key) return [];
  const probe = async (label, fn) => {
    try { await fn(); return { label, ok: true, status: 200, message: '' }; }
    catch (e) {
      return {
        label, ok: false, status: e.status || 0,
        message: typeof googleErrorText === 'function' ? googleErrorText(e.message, e.status) : e.message,
      };
    }
  };
  // One cheap real call each, over a fixed point — a probe that does not
  // exercise the actual endpoint proves nothing.
  const here = { lat: 18.52, lng: 73.85 };
  return [
    await probe('Search (Places)', () => googleTextSearch('airport', null)),
    await probe('Nearby (Places)', () => googleNearby(here.lat, here.lng, 2000, ['school'], 1)),
    await probe('Routing (Routes)', () => googleRoute(here, { lat: 18.58, lng: 73.91 }, 'car')),
    await probe('Basemaps (Map Tiles)', async () => {
      const r = await createGoogleSession({ mapType: 'roadmap' });
      if (!r.ok) { const e = new Error(r.message); e.status = r.status; throw e; }
    }),
  ];
}

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { decodePolyline, iconForGoogleTypes, GOOGLE_TRAVEL_MODE };
}
