/**
 * services/osmDetail.js — roads, water and buildings over the contour map.
 *
 * The "Roads & Structures" control. A contour map with nothing on it is a
 * beautiful abstraction that nobody can locate: the whole point of putting one
 * in front of a client is to say "your plot is HERE, on this shoulder, above
 * that river", and that needs the road they drove in on.
 *
 * WHY OPENSTREETMAP VECTORS AND NOT A RASTER TILE OVERLAY. The app already has
 * raster road overlays (map/mapOverlays.js), and they were the obvious answer
 * until you stack one over a hypsometric tint: the tiles carry their own
 * background, they sit in the tile pane UNDER the contour canvas, and they blur
 * the moment the map is exported at 4x. Real geometry draws over the tint, at
 * whatever weight suits it, and stays sharp at any scale.
 *
 * THE PLUMBING IS ALREADY HERE. services/ringFeatures.js runs Overpass properly
 * — four independent mirrors, a serialised gate honouring the usage policy, an
 * expiring cache, an abortable fetch and honest failure reasons. That took real
 * care to get right and none of it is specific to ring scans, so this file
 * calls into it rather than starting a second, worse Overpass client beside it.
 * It must therefore load AFTER ringFeatures.js.
 */

/** Kept well under Overpass's patience; a dense city bbox will hit it. */
const OSM_DETAIL_CAP = 6000;
/** Above this the query is refused outright rather than left to time out. */
const OSM_DETAIL_MAX_KM2 = 400;

/**
 * What each control setting asks for. Buildings are separated because a square
 * kilometre of Mumbai is tens of thousands of them, and most contour maps want
 * the roads and the river without the noise.
 */
const OSM_DETAIL_LEVELS = {
  off: [],
  roads: ['road', 'rail', 'water'],
  full: ['road', 'rail', 'water', 'building'],
};

/** Drawing weight and colour per class. Read by map/contourLayer.js. */
const OSM_DETAIL_STYLE = {
  motorway:   { w: 3.4, color: '#3D2A12', kind: 'road' },
  trunk:      { w: 3.0, color: '#3D2A12', kind: 'road' },
  primary:    { w: 2.6, color: '#42301A', kind: 'road' },
  secondary:  { w: 2.0, color: '#4A4034', kind: 'road' },
  tertiary:   { w: 1.5, color: '#4A4034', kind: 'road' },
  minor:      { w: 1.0, color: '#54504A', kind: 'road' },
  rail:       { w: 1.6, color: '#2B2B2B', kind: 'rail', dash: [6, 4] },
  water:      { w: 1.8, color: '#2E6E9E', kind: 'water' },
  waterbody:  { w: 0, color: '#2E6E9E', kind: 'water', fill: 'rgba(46,110,158,.55)' },
  building:   { w: 0.5, color: 'rgba(30,26,22,.85)', kind: 'building', fill: 'rgba(40,34,28,.55)' },
};

const OSM_ROAD_MAJOR = 'motorway|trunk|primary|secondary|tertiary';
const OSM_ROAD_MINOR = 'unclassified|residential|living_street|service|track|pedestrian';

/** Which style bucket an element falls into, or null to drop it. */
function osmDetailClass(tags) {
  const t = tags || {};
  if (t.building || t['building:part']) return 'building';
  if (t.railway) return 'rail';
  if (t.waterway) return 'water';
  if (t.natural === 'water' || t.landuse === 'reservoir') return 'waterbody';
  const h = t.highway;
  if (!h) return null;
  if (new RegExp('^(' + OSM_ROAD_MAJOR + ')(_link)?$').test(h)) return h.replace('_link', '');
  if (new RegExp('^(' + OSM_ROAD_MINOR + ')$').test(h)) return 'minor';
  return null;
}

/**
 * The Overpass query for a bounding box.
 *
 * `out geom` rather than `out ids` plus a recursion: it returns each way's
 * coordinates inline, which is one round trip instead of two and is what the
 * ring scan already does.
 */
function osmDetailQL(b, want) {
  const box = [b.south, b.west, b.north, b.east].map(v => v.toFixed(6)).join(',');
  const parts = [];
  if (want.indexOf('road') >= 0) {
    parts.push(`way["highway"~"^(${OSM_ROAD_MAJOR})(_link)?$"](${box});`);
    parts.push(`way["highway"~"^(${OSM_ROAD_MINOR})$"](${box});`);
  }
  if (want.indexOf('rail') >= 0) {
    parts.push(`way["railway"~"^(rail|light_rail|subway|narrow_gauge|monorail)$"](${box});`);
  }
  if (want.indexOf('water') >= 0) {
    parts.push(`way["waterway"~"^(river|stream|canal|drain)$"](${box});`);
    parts.push(`way["natural"="water"](${box});`);
  }
  if (want.indexOf('building') >= 0) parts.push(`way["building"](${box});`);

  const timeout = (typeof OVERPASS_TIMEOUT_S !== 'undefined') ? OVERPASS_TIMEOUT_S : 25;
  return `[out:json][timeout:${timeout}];(${parts.join('')});out geom ${OSM_DETAIL_CAP};`;
}

const _osmDetailPending = new Map();

/**
 * Roads, rail, water and optionally buildings inside a bounding box.
 *
 * @param {{north:number,south:number,east:number,west:number}} b
 * @param {string} level key of OSM_DETAIL_LEVELS
 * @returns {Promise<{ok:boolean, features?:Array, reason?:string, truncated?:boolean, cached?:boolean}>}
 */
async function fetchOsmDetail(b, level) {
  const want = OSM_DETAIL_LEVELS[level] || [];
  if (!want.length) return { ok: true, features: [] };
  if (!b || !(b.north > b.south) || !(b.east > b.west)) return { ok: false, reason: 'no-area' };

  // Rough, and rough is enough — this only has to catch "you selected a
  // province" before Overpass has to.
  const km2 = Math.abs(b.north - b.south) * 111 * Math.abs(b.east - b.west) * 111
    * Math.cos((b.north + b.south) / 2 * Math.PI / 180);
  if (km2 > OSM_DETAIL_MAX_KM2) return { ok: false, reason: 'too-big' };

  const key = 'osmd:' + level + ':' + [b.south, b.west, b.north, b.east].map(v => v.toFixed(4)).join(',');
  const cache = (typeof overpassCacheRead === 'function') ? overpassCacheRead() : {};
  const hit = cache[key];
  const ttl = (typeof OVERPASS_CACHE_TTL_MS !== 'undefined') ? OVERPASS_CACHE_TTL_MS : 6048e5;
  if (hit && Date.now() - hit.at < ttl) {
    return { ok: true, features: hit.f || [], truncated: !!hit.tr, cached: true };
  }
  if (_osmDetailPending.has(key)) return _osmDetailPending.get(key);

  const ql = osmDetailQL(b, want);
  const run = (async () => {
    const reasons = [];
    const mirrors = (typeof OVERPASS_MIRRORS !== 'undefined') ? OVERPASS_MIRRORS : [];
    for (const host of mirrors) {
      if (typeof overpassGate === 'function') await overpassGate();
      let res;
      try {
        const ctl = new AbortController();
        const ms = (typeof OVERPASS_FETCH_MS !== 'undefined') ? OVERPASS_FETCH_MS : 30000;
        const timer = setTimeout(() => ctl.abort(), ms);
        res = await fetch(host, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(ql),
          signal: ctl.signal,
        });
        clearTimeout(timer);
      } catch (e) { reasons.push('network'); continue; }

      // A 400 is this query being wrong, and it will be just as wrong at the
      // next mirror. Anything else is worth another host.
      if (res.status === 400) { reasons.push('http-400'); break; }
      if (!res.ok) { reasons.push(res.status === 429 ? 'http-429' : 'http-' + res.status); continue; }

      let json;
      try { json = await res.json(); } catch (e) { reasons.push('network'); continue; }

      const els = (json && json.elements) || [];
      const tol = (typeof OVERPASS_SIMPLIFY_DEG !== 'undefined') ? OVERPASS_SIMPLIFY_DEG : 0.00007;
      const features = [];
      els.forEach(el => {
        if (!el.geometry || el.geometry.length < 2) return;
        const cls = osmDetailClass(el.tags);
        if (!cls) return;
        let pts = el.geometry.map(p => ({ lat: p.lat, lng: p.lon }));
        // Buildings are already small; simplifying them turns a rectangle into
        // a triangle. Everything else benefits.
        if (cls !== 'building' && typeof simplifyLatLngs === 'function') pts = simplifyLatLngs(pts, tol);
        const first = pts[0], last = pts[pts.length - 1];
        features.push({
          cls,
          closed: pts.length > 3 && Math.abs(first.lat - last.lat) < 1e-9 && Math.abs(first.lng - last.lng) < 1e-9,
          pts: pts.map(p => [p.lat, p.lng]),
        });
      });

      const truncated = els.length >= OSM_DETAIL_CAP;
      cache[key] = { at: Date.now(), f: features, tr: truncated };
      // Only ever cached on a definite answer. A mirror having a bad minute
      // must not look like "there are no roads here" for the next week.
      if (typeof overpassCacheWrite === 'function') overpassCacheWrite(cache);
      return { ok: true, features, truncated };
    }
    const worst = (typeof overpassWorstReason === 'function') ? overpassWorstReason(reasons) : 'network';
    return { ok: false, reason: worst };
  })();

  _osmDetailPending.set(key, run);
  try { return await run; } finally { _osmDetailPending.delete(key); }
}

/** A plain-language explanation for a failed detail fetch. */
function osmDetailMessage(reason) {
  if (reason === 'too-big') return 'That area is too large for road data — draw a smaller one.';
  if (reason === 'http-429') return 'OpenStreetMap is rate-limiting right now. The contours are drawn; try roads again shortly.';
  if (reason === 'http-400') return 'Could not ask OpenStreetMap for roads here.';
  return 'Could not reach OpenStreetMap for roads. The contours are drawn without them.';
}
