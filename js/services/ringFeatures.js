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

  /* ---- power: a constraint on the land, not a service to it ---- */
  { id: 'powerLine', label: 'HT / transmission lines', cls: 'powerLine', max: 25,
    q: ['way["power"="line"]'] },
  { id: 'powerMinor', label: 'LT / distribution lines', cls: 'powerMinor', max: 3,
    q: ['way["power"="minor_line"]'] },
  { id: 'powerTower', label: 'Transmission towers', cls: 'powerTower', max: 8,
    q: ['node["power"="tower"]'] },
  { id: 'substation', label: 'Substations', cls: 'substation', max: 15,
    q: ['way["power"="substation"]', 'node["power"="substation"]'] },

  /* ---- ground cover: what the land around the site actually is ---- */
  { id: 'builtUp', label: 'Built-up / residential land', cls: 'builtUp', max: 8,
    q: ['way["landuse"="residential"]', 'relation["landuse"="residential"]'] },
  { id: 'industrial', label: 'Industrial land', cls: 'industrial', max: 12,
    q: ['way["landuse"="industrial"]', 'relation["landuse"="industrial"]'] },
  { id: 'commercial', label: 'Commercial / retail land', cls: 'commercial', max: 8,
    q: ['way["landuse"~"^(commercial|retail)$"]'] },
  { id: 'green', label: 'Parks, forest & green cover', cls: 'green', max: 10,
    q: ['way["leisure"="park"]', 'way["landuse"="forest"]', 'way["natural"="wood"]',
      'relation["landuse"="forest"]', 'relation["natural"="wood"]'] },
  { id: 'waterBody', label: 'Lakes & reservoirs', cls: 'water', max: 15,
    q: ['way["natural"="water"]', 'relation["natural"="water"]'] },
  { id: 'farmland', label: 'Farmland & open land', cls: 'farmland', max: 5,
    q: ['way["landuse"~"^(farmland|meadow|orchard)$"]'] },
  // 1 km, and merged into one shape. A single km² of a city holds thousands of
  // footprints; as separate shapes that is thousands of cards in the Draw list
  // and thousands of objects the undo system re-serialises twice a second.
  { id: 'building', label: 'Building footprints', cls: 'building', max: 1, merge: true,
    q: ['way["building"]'] },

  { id: 'settlement', label: 'Towns & villages (names)', cls: 'hub', max: 25,
    q: ['node["place"~"^(city|town|village|suburb)$"]'] },
];

/** What a fresh install looks for. */
const RING_FEATURE_DEFAULTS = ['expressway', 'highway', 'metro', 'rail', 'station',
  'airport', 'river', 'powerLine'];

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

  if (t.power === 'line' && has('powerLine')) return 'powerLine';
  if (t.power === 'minor_line' && has('powerMinor')) return 'powerMinor';
  if (t.power === 'tower' && has('powerTower')) return 'powerTower';
  if (t.power === 'substation' && has('substation')) return 'substation';

  if (t.landuse === 'residential' && has('builtUp')) return 'builtUp';
  if (t.landuse === 'industrial' && has('industrial')) return 'industrial';
  if (/^(commercial|retail)$/.test(t.landuse || '') && has('commercial')) return 'commercial';
  if ((t.leisure === 'park' || t.landuse === 'forest' || t.natural === 'wood') && has('green')) return 'green';
  if (t.natural === 'water' && has('waterBody')) return 'waterBody';
  if (/^(farmland|meadow|orchard)$/.test(t.landuse || '') && has('farmland')) return 'farmland';
  if (t.place && has('settlement')) return 'settlement';
  // Last, and only if nothing above claimed it: almost every building also
  // carries other tags, and a school building must not outrank the school.
  if (t.building && has('building')) return 'building';
  return null;
}

/**
 * What to call a power line.
 *
 * Voltage is the whole point. "HT line" tells you a corridor exists; "220 kV"
 * tells you roughly how wide it is and what it is worth arguing about, and it
 * is the number a plot's buildable area actually turns on. OSM stores it in
 * volts, often as "220000" or "220000;110000" for a shared tower.
 *
 * The corridor width itself is deliberately NOT computed here. It is set by
 * statute and varies by jurisdiction, and a number invented by this app and
 * pasted into a client report would be worse than no number at all.
 *
 * @param {object} t tags @returns {string|null}
 */
function powerLineName(t) {
  const kv = String(t.voltage || '').split(';')
    .map(v => parseInt(v, 10)).filter(v => v > 0)
    .map(v => (v >= 1000 ? Math.round(v / 1000) + ' kV' : v + ' V'));
  const bits = [];
  if (t.name) bits.push(t.name);
  if (kv.length) bits.push(kv.join(' / '));
  if (t.ref && !t.name) bits.push(t.ref);
  if (t.operator && !t.name) bits.push(t.operator);
  return bits.length ? bits.join(' — ') : null;
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

/* ---------------------------------------------------------------------------
 * Joining the pieces back together
 *
 * OSM does not store "Swami Vivekanand Road" as one line. It stores it as a
 * dozen `way`s, split at every point where a tag changes — a bridge, a change
 * in lane count, a different surface, a speed-limit sign. That is correct for a
 * database and useless on a map: a scan comes back with the same road listed
 * nine times at 0.2 km each, and ticking it draws nine stubs instead of one
 * road.
 *
 * So the pieces are chained back into continuous lines before anyone sees them.
 * This is what turns a list of 146 fragments into a list of the twenty roads
 * that are actually there.
 * ------------------------------------------------------------------------ */

/** ~1 m. Contiguous ways share an exact node; this only absorbs float drift. */
const JOIN_TOL_DEG = 0.00001;

/**
 * Can these two pieces be the same road?
 *
 * Equal names obviously. But an unnamed piece is joinable with a named one,
 * and that case matters more than it sounds: a flyover is usually tagged
 * without a name, so a road reads as "Santa Cruz Flyover / Unnamed section /
 * Santa Cruz Flyover" — three rows for one continuous stretch. Refusing to join
 * across a missing name is what produces that.
 *
 * @param {string} a @param {string} b @returns {boolean}
 */
function joinableNames(a, b) { return !a || !b || a === b; }

/**
 * Chain touching pieces of the same class into continuous lines.
 *
 * Grouped by class rather than by name, because the unnamed connector between
 * two named stretches has to be able to join either of them.
 *
 * @param {object[]} features @returns {object[]}
 */
function joinRingFeatures(features) {
  const out = [];
  const byClass = new Map();
  features.forEach(f => {
    if (f.kind !== 'line') { out.push(f); return; }   // points and areas pass through
    if (!byClass.has(f.classId)) byClass.set(f.classId, []);
    byClass.get(f.classId).push(f);
  });

  const near = (a, b) =>
    Math.abs(a[0] - b[0]) <= JOIN_TOL_DEG && Math.abs(a[1] - b[1]) <= JOIN_TOL_DEG;

  byClass.forEach(group => {
    const segs = group.map(f => ({ f, pts: f.pts, used: false }));
    const chains = [];

    for (let i = 0; i < segs.length; i++) {
      if (segs[i].used) continue;
      segs[i].used = true;
      let pts = segs[i].pts.slice();
      let name = segs[i].f.name || '';
      let ref = segs[i].f.ref || '';
      let parts = 1;

      // Re-scan after every join: absorbing a piece gives the chain two new
      // ends, and a piece that did not fit a moment ago may fit one of them.
      let grew = true;
      while (grew) {
        grew = false;
        for (let j = 0; j < segs.length; j++) {
          if (segs[j].used) continue;
          const o = segs[j].pts, on = segs[j].f.name || '';
          if (!joinableNames(name, on)) continue;

          const head = pts[0], tail = pts[pts.length - 1];
          if (near(tail, o[0])) pts = pts.concat(o.slice(1));
          else if (near(tail, o[o.length - 1])) pts = pts.concat(o.slice(0, -1).reverse());
          else if (near(head, o[o.length - 1])) pts = o.slice(0, -1).concat(pts);
          else if (near(head, o[0])) pts = o.slice(1).reverse().concat(pts);
          else continue;

          segs[j].used = true;
          grew = true;
          parts++;
          if (!name && on) name = on;                       // the chain inherits a name
          if (!ref && segs[j].f.ref) ref = segs[j].f.ref;
        }
      }
      chains.push(Object.assign({}, segs[i].f, {
        pts, parts, name: name || null, ref: ref || null, km: ringPathKm(pts),
      }));
    }

    // A dual carriageway is two ways that never touch, so one road can still
    // end up as two chains. Numbering them says "these are halves of one thing"
    // rather than leaving two identical rows looking like a duplicate bug.
    const byName = new Map();
    chains.forEach(c => {
      const k = c.name || '';
      if (!k) return;
      byName.set(k, (byName.get(k) || 0) + 1);
    });
    const seen = new Map();
    chains.forEach(c => {
      const k = c.name || '';
      if (k && byName.get(k) > 1) {
        const n = (seen.get(k) || 0) + 1;
        seen.set(k, n);
        c.part = n;
        c.ofParts = byName.get(k);
      }
      out.push(c);
    });
  });

  // Longest first. The 12 km expressway is what somebody scanned for; a 90 m
  // slip road is not, and it should not be what they see at the top of a list.
  out.sort((a, b) => (b.km || 0) - (a.km || 0));
  return out;
}

/**
 * Turn one Overpass element into something registerGeom can take.
 * @param {object} el @param {string} classId @returns {object|null}
 */
function overpassToFeature(el, classId) {
  const t = el.tags || {};
  const name = (classId === 'powerLine' || classId === 'powerMinor')
    ? powerLineName(t)
    : (t.name || t['name:en'] || null);
  const ref = t.ref || null;

  if (el.type === 'node') {
    if (!isFinite(el.lat) || !isFinite(el.lon)) return null;
    return { kind: 'point', classId, name: name || ref, ref, lat: el.lat, lng: el.lon, km: 0 };
  }

  /* ---- relations: real multipolygons, with holes ----
   * A forest with a lake in it is one relation whose `inner` members are the
   * lake. The old code concatenated every member's coordinates into a single
   * list, which drew one nonsense line zig-zagging between unrelated rings —
   * fine while only airports were fetched as relations and each had one ring,
   * and wrong the moment forests and water arrived. */
  if (el.type === 'relation') {
    const outerWays = [], innerWays = [];
    (el.members || []).forEach(m => {
      if (!m.geometry || m.geometry.length < 2) return;
      const pts = m.geometry.filter(g => g && isFinite(g.lat) && isFinite(g.lon)).map(g => [g.lat, g.lon]);
      if (pts.length < 2) return;
      (m.role === 'inner' ? innerWays : outerWays).push(pts);
    });
    const outers = chainRings(outerWays).filter(r => r.length >= 4);
    const inners = chainRings(innerWays).filter(r => r.length >= 4);
    if (!outers.length) return null;

    const polys = outers.map(o => [simplifyLatLngs(o, OVERPASS_SIMPLIFY_DEG)]);
    inners.forEach(h => {
      // Which outer contains this hole. With a single outer the test is
      // skipped: that is the overwhelmingly common case and the test is the
      // only part of this that can get it wrong.
      let idx = 0;
      if (outers.length > 1) {
        idx = outers.findIndex(o => pointInRing(h[0], o));
        if (idx < 0) return;                       // an orphan inner: not a hole
      }
      polys[idx].push(simplifyLatLngs(h, OVERPASS_SIMPLIFY_DEG));
    });
    return { kind: 'area', classId, name, ref, polys, km: 0, areaKm2: polysAreaKm2(polys) };
  }

  const geom = el.geometry || [];
  let pts = geom.filter(g => g && isFinite(g.lat) && isFinite(g.lon)).map(g => [g.lat, g.lon]);
  if (pts.length < 2) return null;
  pts = simplifyLatLngs(pts, OVERPASS_SIMPLIFY_DEG);

  const first = pts[0], last = pts[pts.length - 1];
  const closed = pts.length >= 4
    && Math.abs(first[0] - last[0]) < 1e-7 && Math.abs(first[1] - last[1]) < 1e-7;
  if (closed && isAreaTagged(t)) {
    return { kind: 'area', classId, name, ref, polys: [[pts]], km: 0, areaKm2: polysAreaKm2([[pts]]) };
  }

  return { kind: 'line', classId, name, ref, pts, km: ringPathKm(pts) };
}

/**
 * Is this closed way an area rather than a loop of road?
 *
 * A closed way is not automatically an area — a ring road and a roundabout are
 * closed lines, and filling them would paint a solid disc over the middle of
 * the map. OSM's rule is that the *tags* decide, so this asks the tags.
 *
 * @param {object} t tags @returns {boolean}
 */
function isAreaTagged(t) {
  return !!(t.landuse || t.building || t.leisure || t.aeroway === 'aerodrome'
    || t.natural === 'water' || t.natural === 'wood' || t.amenity === 'bus_station'
    || t.power === 'substation' || t.area === 'yes');
}

/**
 * Chain open ways into closed rings.
 *
 * A relation's outer boundary arrives as a bag of unordered, arbitrarily
 * directed ways that have to be walked end to end. Same algorithm the road
 * joiner uses, kept separate because this one must *close* its output — a ring
 * that does not meet itself is not a ring, and Leaflet will silently close it
 * across whatever gap is left, cutting the corner off a forest.
 *
 * @param {Array<Array<[number,number]>>} ways @returns {Array<Array<[number,number]>>}
 */
function chainRings(ways) {
  const segs = ways.map(w => ({ pts: w, used: false }));
  const near = (a, b) =>
    Math.abs(a[0] - b[0]) <= JOIN_TOL_DEG && Math.abs(a[1] - b[1]) <= JOIN_TOL_DEG;
  const rings = [];

  for (let i = 0; i < segs.length; i++) {
    if (segs[i].used) continue;
    segs[i].used = true;
    let pts = segs[i].pts.slice();
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < segs.length; j++) {
        if (segs[j].used) continue;
        const o = segs[j].pts;
        const head = pts[0], tail = pts[pts.length - 1];
        if (near(tail, o[0])) pts = pts.concat(o.slice(1));
        else if (near(tail, o[o.length - 1])) pts = pts.concat(o.slice(0, -1).reverse());
        else if (near(head, o[o.length - 1])) pts = o.slice(0, -1).concat(pts);
        else if (near(head, o[0])) pts = o.slice(1).reverse().concat(pts);
        else continue;
        segs[j].used = true; grew = true;
      }
    }
    if (pts.length >= 4) rings.push(pts);
  }
  return rings;
}

/**
 * Is a point inside a ring? Ray casting.
 * @param {[number,number]} pt @param {Array<[number,number]>} ring @returns {boolean}
 */
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
    if ((xi > pt[1]) !== (xj > pt[1])
      && pt[0] < (yj - yi) * (pt[1] - xi) / (xj - xi) + yi) inside = !inside;
  }
  return inside;
}

/**
 * Area of a multipolygon in km², holes subtracted.
 *
 * Shoelace on an equirectangular projection about the shape's own latitude.
 * Not the geodesic answer, but the error is well under a percent at the sizes
 * this reports, and it is only ever shown as "1.4 km²" next to a tick box.
 *
 * @param {Array<Array<Array<[number,number]>>>} polys @returns {number}
 */
function polysAreaKm2(polys) {
  const ringArea = ring => {
    if (!ring || ring.length < 3) return 0;
    const lat0 = ring.reduce((a, p) => a + p[0], 0) / ring.length;
    const k = Math.cos(lat0 * Math.PI / 180);
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += (ring[j][1] * k * 111.32) * (ring[i][0] * 111.32)
         - (ring[i][1] * k * 111.32) * (ring[j][0] * 111.32);
    }
    return Math.abs(a / 2);
  };
  return (polys || []).reduce((sum, poly) =>
    sum + poly.reduce((s, ring, i) => s + (i === 0 ? ringArea(ring) : -ringArea(ring)), 0), 0);
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

      const joined = joinRingFeatures(features);
      const truncated = els.length >= OVERPASS_CAP;
      const out = { ok: true, features: joined, skipped, truncated };
      // Cache a definite answer, including an empty one — "nothing is mapped
      // here" is still true tomorrow. Never cache a transport failure: one
      // blip must not look permanent for a week.
      all[key] = { at: Date.now(), f: joined, tr: truncated };
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
