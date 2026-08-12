/**
 * services/ringFeatures.js — what is actually inside a catchment ring.
 *
 * WHY OVERPASS AND NOT THE NEARBY SERVICE. `services/nearbyPlaces.js` already
 * finds hospitals and schools, and it is the right tool for those: they are
 * points, and Google and Geoapify know about them. But a metro line, a railway,
 * a river and an airport perimeter are *lines and areas*, and neither provider
 * will hand over that geometry — Places APIs return a coordinate and a name.
 * Overpass returns OpenStreetMap's own ways, which is the only free source that
 * can draw the line you actually want on the map.
 *
 * `js/config.js` has declared `PLACES_PROVIDERS.overpass` since before I got
 * here, referenced by nothing. This makes it real.
 *
 * BUILT ON boundaries.js's SHAPE, deliberately. That file is the working
 * template for this exact problem — a donated third-party service that is
 * frequently unreachable, needs caching, needs an in-flight guard, and must
 * fail in a way that tells you which of half a dozen things went wrong. Its
 * header documents the failure mode that matters most here: a browser that
 * cannot reach the host because of corporate DNS, an ad blocker, or the
 * service's own rate limiter. Overpass is the same class of service, so it gets
 * the same treatment: four independent hosts, a rate gate, and messages that
 * name the actual problem instead of "something went wrong".
 *
 * NOTHING IS ADDED TO THE MAP BY ITSELF. This module fetches and returns; the
 * user ticks what to keep. A 5 km ring over a city can hold six hundred ways,
 * and dropping those onto the map unasked would bury the drawing they were
 * meant to support — and, because every shape is re-serialised by the undo
 * system twice a second, would make the whole app crawl.
 */

/** Independent hosts. One donated service is not a feature. */
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/** Overpass's own timeout, in seconds, and ours, in ms. */
const OVERPASS_TIMEOUT_S = 25;
const OVERPASS_FETCH_MS = 30000;

/** Overpass's usage policy is a condition of use, not a suggestion. */
const OVERPASS_MIN_GAP_MS = 1200;

/** How many elements the server is allowed to return. */
const OVERPASS_CAP = 600;

/** ~8 m. Finer than anyone can see at the zooms this is drawn at. */
const OVERPASS_SIMPLIFY_DEG = 0.00007;

const OVERPASS_CACHE_KEY = 'dbot.overpassCache.v1';
const OVERPASS_CACHE_TTL_MS = 7 * 24 * 3600e3;
/** By bytes, not entries: one entry here is 50-200× a cached boundary. */
const OVERPASS_CACHE_MAX_BYTES = 1.5e6;

/**
 * What a ring can look for.
 *
 * `max` is a per-class radius ceiling in km. A 10 km ring over a city holds
 * thousands of secondary roads and streams; asking for them produces either a
 * refusal from Overpass or a wall of lines nobody wants. The class is skipped
 * with a note rather than silently, so the answer is "I did not ask for that
 * and here is why", not an empty result that reads as "there are none".
 */
const RING_FEATURE_CLASSES = [
  { id: 'expressway', label: 'Expressways & motorways', cls: 'expressway', max: 25,
    q: ['way["highway"="motorway"]'] },
  { id: 'highway', label: 'National & state highways', cls: 'expressway', max: 25,
    q: ['way["highway"~"^(trunk|primary)$"]'] },
  { id: 'arterial', label: 'Major roads', cls: 'major', max: 6,
    q: ['way["highway"="secondary"]'] },
  { id: 'metro', label: 'Metro & light rail', cls: 'metro', max: 25,
    q: ['way["railway"~"^(subway|light_rail|monorail)$"]'] },
  { id: 'rail', label: 'Railway lines', cls: 'railway', max: 25,
    // Sidings, yards and spurs are the majority of railway=rail in a city and
    // are all noise on a connectivity map.
    q: ['way["railway"~"^(rail|narrow_gauge)$"]["service"!~"."]'] },
  { id: 'station', label: 'Railway stations', cls: 'station', max: 25,
    q: ['node["railway"="station"]'] },
  { id: 'metroStation', label: 'Metro stations', cls: 'metroStation', max: 25,
    q: ['node["railway"="station"]["station"="subway"]', 'node["station"="subway"]'] },
  { id: 'airport', label: 'Airports', cls: 'airport', max: 40,
    q: ['way["aeroway"="aerodrome"]', 'relation["aeroway"="aerodrome"]'] },
  { id: 'river', label: 'Rivers', cls: 'water', max: 15,
    q: ['way["waterway"="river"]'] },
  { id: 'stream', label: 'Streams & canals', cls: 'water', max: 5,
    // waterway=drain is excluded: municipal drains are dense and are not a
    // feature of a location.
    q: ['way["waterway"~"^(stream|canal)$"]'] },
  { id: 'busTerminal', label: 'Bus terminals', cls: 'hub', max: 20,
    q: ['node["amenity"="bus_station"]', 'way["amenity"="bus_station"]'] },
  { id: 'port', label: 'Ports & ferry terminals', cls: 'hub', max: 40,
    q: ['node["amenity"="ferry_terminal"]', 'way["landuse"="port"]'] },
];

/** What a fresh install looks for. */
const RING_FEATURE_DEFAULTS = ['expressway', 'highway', 'metro', 'rail', 'station', 'airport', 'river'];

/** @param {string} id @returns {object|null} */
function ringFeatureClass(id) { return RING_FEATURE_CLASSES.find(c => c.id === id) || null; }

/* ---------------------------------------------------------------------------
 * The query
 * ------------------------------------------------------------------------ */

/**
 * Build the Overpass QL for a ring.
 *
 * `out geom` is the single most important choice here: it returns each way's
 * coordinates inline, so converting the answer is one map(). The alternative
 * (`out body; >; out skel qt;`) returns every node as its own top-level element
 * — three to four times the bytes — and makes the client reassemble ways from
 * node-id arrays.
 *
 * @param {string[]} ids class ids
 * @param {number} lat @param {number} lng @param {number} radiusM
 * @returns {{ql:string, used:string[], skipped:object[]}}
 */
function overpassQL(ids, lat, lng, radiusM) {
  const km = radiusM / 1000;
  const used = [], skipped = [], parts = [];
  const around = '(around:' + Math.round(radiusM) + ',' + lat.toFixed(6) + ',' + lng.toFixed(6) + ')';

  ids.forEach(id => {
    const c = ringFeatureClass(id);
    if (!c) return;
    if (km > c.max) { skipped.push({ id, label: c.label, max: c.max }); return; }
    used.push(id);
    c.q.forEach(frag => parts.push('  ' + frag + around + ';'));
  });

  const ql = '[out:json][timeout:' + OVERPASS_TIMEOUT_S + '];\n(\n'
    + parts.join('\n') + '\n);\nout geom ' + OVERPASS_CAP + ';';
  return { ql, used, skipped };
}

/**
 * Which class an element belongs to.
 *
 * Matched from the tags rather than tracked through the query, because
 * Overpass returns one flat list and does not say which statement produced
 * each element.
 *
 * @param {object} el @param {string[]} ids the classes that were asked for
 * @returns {string|null}
 */
function overpassClassOf(el, ids) {
  const t = el.tags || {};
  const has = id => ids.indexOf(id) >= 0;

  if (t.aeroway === 'aerodrome' && has('airport')) return 'airport';
  if (t.railway === 'station' || t.station === 'subway') {
    if ((t.station === 'subway' || t.subway === 'yes') && has('metroStation')) return 'metroStation';
    if (has('station')) return 'station';
  }
  if (/^(subway|light_rail|monorail)$/.test(t.railway || '') && has('metro')) return 'metro';
  // The `service` exclusion is repeated from the query on purpose. The query
  // asks the server not to send sidings, yards and spurs; this makes sure none
  // is *accepted* if a mirror sends one anyway — a fixture caught exactly that,
  // and in a city sidings outnumber the running lines.
  if (/^(rail|narrow_gauge)$/.test(t.railway || '') && !t.service && has('rail')) return 'rail';
  if (t.waterway === 'river' && has('river')) return 'river';
  if (/^(stream|canal)$/.test(t.waterway || '') && has('stream')) return 'stream';
  if (t.highway === 'motorway' && has('expressway')) return 'expressway';
  if (/^(trunk|primary)$/.test(t.highway || '') && has('highway')) return 'highway';
  if (t.highway === 'secondary' && has('arterial')) return 'arterial';
  if (t.amenity === 'bus_station' && has('busTerminal')) return 'busTerminal';
  if ((t.amenity === 'ferry_terminal' || t.landuse === 'port') && has('port')) return 'port';
  return null;
}

/* ---------------------------------------------------------------------------
 * Geometry
 * ------------------------------------------------------------------------ */

/**
 * Douglas-Peucker, in degrees.
 *
 * A motorway comes back with ~900 points and looks identical at 80. Run before
 * caching, so the cache stores the small version and every later read is cheap.
 *
 * @param {Array<[number,number]>} pts @param {number} tol
 * @returns {Array<[number,number]>}
 */
function simplifyLatLngs(pts, tol) {
  if (!pts || pts.length < 3) return pts || [];
  const sqTol = tol * tol;

  const sqSegDist = (p, a, b) => {
    let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y;
    return dx * dx + dy * dy;
  };

  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let far = 0, idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = sqSegDist(pts[i], pts[lo], pts[hi]);
      if (d > far) { far = d; idx = i; }
    }
    if (idx > 0 && far > sqTol) { keep[idx] = true; stack.push([lo, idx], [idx, hi]); }
  }
  return pts.filter((p, i) => keep[i]);
}

/** @param {Array<[number,number]>} pts @returns {number} length in km */
function ringPathKm(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    const [aLat, aLng] = pts[i - 1], [bLat, bLng] = pts[i];
    const dLat = (bLat - aLat) * 111.32;
    const dLng = (bLng - aLng) * 111.32 * Math.cos((aLat + bLat) / 2 * Math.PI / 180);
    m += Math.sqrt(dLat * dLat + dLng * dLng);
  }
  return m;
}

/**
 * Turn one Overpass element into something registerGeom can take.
 * @param {object} el @param {string} classId @returns {object|null}
 */
function overpassToFeature(el, classId) {
  const t = el.tags || {};
  const name = t.name || t['name:en'] || t.ref || null;

  if (el.type === 'node') {
    if (!isFinite(el.lat) || !isFinite(el.lon)) return null;
    return { kind: 'point', classId, name, lat: el.lat, lng: el.lon, km: 0 };
  }

  const geom = el.geometry || (el.members || []).reduce((a, m) => a.concat(m.geometry || []), []);
  if (!geom.length) return null;
  let pts = geom.filter(g => g && isFinite(g.lat) && isFinite(g.lon)).map(g => [g.lat, g.lon]);
  if (pts.length < 2) return null;
  pts = simplifyLatLngs(pts, OVERPASS_SIMPLIFY_DEG);

  // A way whose ends meet is an area — an airport perimeter, a lake, a port.
  const first = pts[0], last = pts[pts.length - 1];
  const closed = Math.abs(first[0] - last[0]) < 1e-7 && Math.abs(first[1] - last[1]) < 1e-7;
  const area = closed && (t.aeroway === 'aerodrome' || t.natural === 'water' || t.landuse === 'port'
    || t.amenity === 'bus_station');

  return {
    kind: area ? 'area' : 'line',
    classId, name,
    pts,
    km: area ? 0 : ringPathKm(pts),
  };
}

/* ---------------------------------------------------------------------------
 * Cache and rate gate
 * ------------------------------------------------------------------------ */

/** @returns {object} the whole cache */
function overpassCacheRead() {
  try { return JSON.parse(localStorage.getItem(OVERPASS_CACHE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}

/** @param {object} all */
function overpassCacheWrite(all) {
  try {
    let s = JSON.stringify(all);
    if (s.length > OVERPASS_CACHE_MAX_BYTES) {
      // Oldest first, by bytes rather than by entry count: entries here differ
      // in size by two orders of magnitude, so counting them evicts the wrong
      // ones.
      const keys = Object.keys(all).sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
      while (keys.length && s.length > OVERPASS_CACHE_MAX_BYTES) {
        delete all[keys.shift()];
        s = JSON.stringify(all);
      }
    }
    localStorage.setItem(OVERPASS_CACHE_KEY, s);
  } catch (e) { /* quota, or private mode — the cache is an optimisation */ }
}

/** @returns {string} */
function overpassCacheKey(ids, lat, lng, radiusM) {
  // Three decimals ≈ 110 m. Two, as boundaries.js uses, would serve a ring a
  // kilometre away — and a ring's *contents* genuinely change over a kilometre,
  // where a city's outline does not.
  return ids.slice().sort().join('+') + '|' + lat.toFixed(3) + ',' + lng.toFixed(3)
    + '|' + Math.round(radiusM / 100) * 100;
}

/** In-flight requests, so a double-click is one request. */
const _overpassPending = new Map();

/** Serialises outbound requests with a minimum gap. */
let _overpassGate = Promise.resolve();
function overpassGate() {
  const wait = _overpassGate.then(() => new Promise(r => setTimeout(r, OVERPASS_MIN_GAP_MS)));
  _overpassGate = wait;
  return wait;
}

/* ---------------------------------------------------------------------------
 * The fetch
 * ------------------------------------------------------------------------ */

/**
 * Ask Overpass what is inside a ring.
 *
 * @param {number} lat @param {number} lng @param {number} radiusM
 * @param {string[]} ids class ids to look for
 * @returns {Promise<{ok:boolean, reason?:string, features?:object[], skipped?:object[], truncated?:boolean, cached?:boolean}>}
 */
async function fetchRingFeatures(lat, lng, radiusM, ids) {
  if (!ids || !ids.length) return { ok: false, reason: 'no-classes' };
  if (!isFinite(lat) || !isFinite(lng) || !(radiusM > 0)) return { ok: false, reason: 'no-centre' };

  const { ql, used, skipped } = overpassQL(ids, lat, lng, radiusM);
  if (!used.length) return { ok: false, reason: 'too-big', skipped };

  const key = overpassCacheKey(used, lat, lng, radiusM);
  const all = overpassCacheRead();
  const hit = all[key];
  if (hit && Date.now() - hit.at < OVERPASS_CACHE_TTL_MS) {
    return { ok: true, features: hit.f || [], skipped, truncated: !!hit.tr, cached: true };
  }
  if (_overpassPending.has(key)) return _overpassPending.get(key);

  const run = (async () => {
    const reasons = [];
    for (const host of OVERPASS_MIRRORS) {
      await overpassGate();
      let res;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), OVERPASS_FETCH_MS);
        res = await fetch(host, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(ql),
          signal: ctl.signal,
        });
        clearTimeout(timer);
      } catch (e) { reasons.push('network'); continue; }

      // A syntax error fails identically everywhere — cycling four mirrors on
      // it wastes five seconds and four slots of rate-limit budget.
      if (res.status === 400) { reasons.push('http-400'); break; }
      if (!res.ok) { reasons.push(res.status === 429 ? 'http-429' : 'http-' + res.status); continue; }

      let json;
      try { json = await res.json(); } catch (e) { reasons.push('network'); continue; }

      const els = (json && json.elements) || [];
      const features = [];
      els.forEach(el => {
        const cid = overpassClassOf(el, used);
        if (!cid) return;
        const f = overpassToFeature(el, cid);
        if (f) features.push(f);
      });

      const truncated = els.length >= OVERPASS_CAP;
      const out = { ok: true, features, skipped, truncated };
      // Cache a definite answer, including an empty one — "nothing is mapped
      // here" is still true tomorrow. Never cache a transport failure: one
      // blip must not look permanent for a week.
      all[key] = { at: Date.now(), f: features, tr: truncated };
      overpassCacheWrite(all);
      return out;
    }
    return { ok: false, reason: overpassWorstReason(reasons), skipped };
  })();

  _overpassPending.set(key, run);
  try { return await run; } finally { _overpassPending.delete(key); }
}

/**
 * The most informative failure across the mirrors.
 *
 * A definite refusal outranks a transport failure, for the reason
 * boundaries.js's equivalent gives: "could not reach it" from three hosts and
 * "it answered and said no" from one means the answer is no.
 *
 * @param {string[]} reasons @returns {string}
 */
function overpassWorstReason(reasons) {
  const rank = r => (r === 'http-400' ? 4 : r === 'http-429' ? 3 : /^http-5/.test(r) ? 2 : 1);
  return reasons.slice().sort((a, b) => rank(b) - rank(a))[0] || 'network';
}

/**
 * What to tell someone when it did not work.
 * @param {string} reason @param {object} [ctx]
 * @returns {string}
 */
function ringFeatureMessage(reason, ctx) {
  ctx = ctx || {};
  switch (reason) {
    case 'no-classes':
      return 'Tick at least one kind of feature to look for.';
    case 'no-centre':
      return 'Give the ring a radius first.';
    case 'too-big': {
      const names = (ctx.skipped || []).map(s => s.label.toLowerCase()).join(', ');
      return 'This ring is too wide for ' + (names || 'the selected types')
        + '. A city-scale search returns thousands of them. Reduce the ring, or untick those.';
    }
    case 'http-400':
      return 'Overpass rejected the query. That is a bug in Map Studio, not in your ring —'
        + ' please report which types you had ticked.';
    case 'http-429':
      return 'Overpass is rate-limiting. It is a donated service shared by everyone —'
        + ' wait half a minute and try again.';
    case 'network':
    default:
      return 'Could not reach any Overpass server (tried ' + OVERPASS_MIRRORS.length + ').'
        + ' An office firewall or a DNS filter blocks these specifically, and that is as common'
        + ' as being offline. You can still trace a line by hand with Draw a road.';
  }
}

/** Whether a failure is worth offering a retry for. */
function ringFeatureRetryable(reason) {
  return reason === 'network' || reason === 'http-429' || /^http-5/.test(reason || '');
}
