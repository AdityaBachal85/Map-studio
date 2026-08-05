/**
 * lib/travelMatrix.js — how long it actually takes to get anywhere from here.
 *
 * The most quotable table in a property report, and the one most often faked.
 * "20 minutes to the airport" in a brochure is usually a free-flow figure
 * measured at 3am. Google's Routes API will give both numbers on the same
 * call — `duration` at a stated departure time and `staticDuration` with no
 * traffic model — so the report can say "42 minutes off-peak, 68 at 9am",
 * which is the number a buyer actually experiences.
 *
 * Measured on this project's existing Maps key, no billing: Airoli to South
 * Mumbai came back 54 min free-flow against 80 min at a 9am departure.
 *
 * TWO STEPS, BOTH NEEDED. Destinations are found before they are routed to.
 * Hardcoding "the airport" as a coordinate would be wrong for every site
 * outside one city, so Places finds the real nearest airport, station and
 * business district for this particular site, and Routes then measures the
 * journey. That also means the row labels name a real place — "Chhatrapati
 * Shivaji Maharaj International Airport", not "Airport".
 *
 * WHY NOT computeRouteMatrix. Routes' own batch endpoint would do all of
 * these in one request, but it answers 403 "This API method requires billing
 * to be enabled" on this project while computeRoutes is free. So each
 * destination is a separate call — six of them, run in parallel.
 */

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const REQUEST_TIMEOUT_MS = 30 * 1000;

/** Places rejects anything larger, with "Radius must be in [0, 50000]". */
const MAX_PLACES_RADIUS_M = 50000;

/**
 * What a property report is always asked about, with the Places type that
 * finds each one, how far out to look, and — the part that decides whether
 * the table is any use — how to choose between the matches.
 *
 * `DISTANCE` is right only where the nearest one is genuinely the one you
 * would use: your station is the station you walk to. Everywhere else it
 * produces nonsense, because Indian Places data is noisy with mis-typed
 * small businesses. Probed at an Airoli site, nearest-first returned "unicare
 * car tarasport" as the major hospital and a corner shop as the shopping
 * mall; ranking by prominence over the same radius returned Kokilaben
 * Dhirubhai Ambani Hospital and Phoenix Marketcity. This is the same lesson
 * the client-side Nearby search already learned (see js/services/google.js).
 *
 * Radii are per-destination for the same reason: prominence-ranked over too
 * wide a circle finds the city's most famous hospital rather than the one
 * that actually serves this suburb.
 */
const DESTINATIONS = [
  { key: 'airport', label: 'Airport', types: ['international_airport', 'airport'], radius: MAX_PLACES_RADIUS_M, rank: 'POPULARITY' },
  { key: 'railway', label: 'Railway station', types: ['train_station'], radius: 15000, rank: 'DISTANCE' },
  { key: 'metro', label: 'Metro station', types: ['subway_station'], radius: 25000, rank: 'DISTANCE' },
  { key: 'businessDistrict', label: 'Business district / IT park', types: ['corporate_office'], radius: 15000, rank: 'POPULARITY' },
  { key: 'hospital', label: 'Major hospital', types: ['hospital'], radius: 12000, rank: 'POPULARITY' },
  { key: 'mall', label: 'Shopping mall', types: ['shopping_mall'], radius: 15000, rank: 'POPULARITY' },
];

/**
 * 09:00 IST on the next weekday, in UTC.
 *
 * Routes rejects a departureTime in the past, so "peak" has to be a real
 * future instant. Weekends are skipped because a Sunday 9am reading would
 * quietly report the off-peak number twice and look like the traffic model
 * had done nothing.
 * @returns {string} RFC3339
 */
function nextWeekdayPeak() {
  const d = new Date();
  d.setUTCHours(3, 30, 0, 0);                 // 09:00 IST == 03:30 UTC
  if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** @param {string} url @param {object} init */
async function fetchWithTimeout(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {string|undefined} */
function mapsKey() { return process.env.GOOGLE_MAPS_API_KEY; }

/**
 * The nearest real place of a given type.
 * @param {{lat:number,lng:number}} from @param {object} dest
 * @returns {Promise<{name:string, lat:number, lng:number}|null>}
 */
async function findDestination(from, dest) {
  const res = await fetchWithTimeout(PLACES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': mapsKey(),
      'X-Goog-FieldMask': 'places.displayName,places.location',
    },
    body: JSON.stringify({
      includedPrimaryTypes: dest.types,
      maxResultCount: 1,
      rankPreference: dest.rank || 'POPULARITY',
      locationRestriction: {
        circle: {
          center: { latitude: from.lat, longitude: from.lng },
          radius: Math.min(dest.radius, MAX_PLACES_RADIUS_M),
        },
      },
    }),
  });
  if (!res.ok) {
    // Silence here is how the airport row vanished without explanation: an
    // over-large radius is rejected outright, and a null return looks exactly
    // like "there is no airport near this site".
    console.warn(`travel matrix: Places rejected the ${dest.key} lookup — HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
    return null;
  }
  const json = await res.json();
  const p = (json.places || [])[0];
  if (!p || !p.location) return null;
  return {
    name: (p.displayName && p.displayName.text) || dest.label,
    lat: p.location.latitude,
    lng: p.location.longitude,
  };
}

/**
 * Drive time between two points, with and without traffic.
 * @param {{lat:number,lng:number}} from @param {{lat:number,lng:number}} to
 * @returns {Promise<{distanceKm:number, offPeakMin:number, peakMin:number|null}|null>}
 */
async function driveTime(from, to) {
  const pt = p => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const res = await fetchWithTimeout(ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': mapsKey(),
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.staticDuration',
    },
    body: JSON.stringify({
      origin: pt(from), destination: pt(to),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      departureTime: nextWeekdayPeak(),
      units: 'METRIC',
      languageCode: 'en-GB',
      regionCode: 'IN',
    }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  const r = (json.routes || [])[0];
  if (!r) return null;
  const secs = s => (s ? Math.round(parseFloat(String(s).replace('s', '')) / 60) : null);
  const peak = secs(r.duration);
  const off = secs(r.staticDuration);
  return {
    distanceKm: Math.round((r.distanceMeters || 0) / 100) / 10,
    // staticDuration is the free-flow figure. If the API omits it there is
    // only one number to report, and it is the traffic-aware one — reporting
    // it in the off-peak column would be the exact overstatement this exists
    // to avoid.
    offPeakMin: off != null ? off : null,
    peakMin: peak,
  };
}

/**
 * Build the matrix.
 *
 * Never throws and never partially fails the report: a destination that
 * cannot be found or routed to is simply absent from the table, because a
 * site genuinely may not have a metro station within 25 km and inventing a
 * row for one would be worse than a shorter table.
 *
 * @param {{lat:number,lng:number}} site
 * @returns {Promise<{rows:Array, departureNote:string, ok:boolean, reason?:string}>}
 */
async function buildTravelMatrix(site) {
  if (!mapsKey()) return { rows: [], ok: false, reason: 'GOOGLE_MAPS_API_KEY is not set', departureNote: '' };

  const rows = (await Promise.all(DESTINATIONS.map(async dest => {
    try {
      const place = await findDestination(site, dest);
      if (!place) return null;
      const t = await driveTime(site, place);
      if (!t) return null;
      return { key: dest.key, label: dest.label, name: place.name, ...t };
    } catch (e) {
      console.warn(`travel matrix: ${dest.key} failed — ${e.message}`);
      return null;
    }
  }))).filter(Boolean);

  return {
    ok: rows.length > 0,
    rows,
    reason: rows.length ? undefined : 'no destinations could be found or routed to',
    departureNote: 'Peak times are modelled for a 09:00 IST weekday departure; off-peak is free-flow.',
  };
}

module.exports = { buildTravelMatrix, DESTINATIONS, nextWeekdayPeak };
