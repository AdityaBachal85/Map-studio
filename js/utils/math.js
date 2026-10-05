/**
 * utils/math.js — coordinate parsing/formatting and geodesic distance.
 */

/**
 * Parse coordinate text into [lat, lng], or null when invalid/out of range.
 *
 * Two forms, chosen by whether a degree mark is present — not tried one after
 * the other, because that ordering is what would make this unsafe:
 *
 *   "19.37697, 73.16956"                    plain decimal degrees
 *   "19°22'37.1"N 73°10'10.4"E"             degrees-minutes-seconds
 *
 * A DEGREE MARK ROUTES STRAIGHT TO THE DMS PARSER AND NEVER TOUCHES THE
 * DECIMAL PATH. `parseFloat` stops at the first character it cannot read
 * rather than failing, so `parseFloat("19°22'37.1\"N")` silently returns 19 —
 * the whole minutes-and-seconds part just disappears. Splitting a
 * comma-joined DMS pair on that basis would have handed back a coordinate
 * several kilometres from the one pasted in, with no error to say so. So any
 * "\d°" in the text is treated as DMS from the first character, exclusively.
 *
 * The DMS form requires a hemisphere letter on BOTH halves. That is what
 * removes every ambiguity in one move — which half is lat and which is lng
 * (whichever position they are typed in), and the sign of each — so nothing
 * here has to guess. Text with a degree mark but no hemisphere letters is
 * refused rather than guessed at, same as the bulk sheet importer already
 * refuses DMS entirely (see parseLatLngPair in project/importSheet.js) for
 * the identical reason: a wrong guess lands the pin somewhere real-looking
 * and wrong, and that is worse than asking again.
 *
 * @param {string} str @returns {[number, number]|null}
 */
function parseCoord(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (/\d\s*[°º]/.test(s)) return parseDmsCoord(s);
  const p = s.split(',').map(x => parseFloat(x.trim()));
  if (p.length !== 2 || p.some(isNaN) || Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180) return null;
  return p;
}

/**
 * One "D° M' S" H" token — minutes and seconds each optional, hemisphere
 * mandatory. The minute mark accepts a straight or curly apostrophe/prime and
 * the second mark a straight or curly quote/double-prime, because those are
 * what a paste from Google Maps, Google Earth or a GPS app actually carries,
 * not necessarily a plain ' and ".
 */
const DMS_TOKEN = '(\\d{1,3}(?:\\.\\d+)?)\\s*[°º]\\s*'
  + '(?:(\\d{1,2}(?:\\.\\d+)?)\\s*[\'’′]\\s*'
  + '(?:(\\d{1,2}(?:\\.\\d+)?)\\s*["”″])?)?'
  + '\\s*([NSEWnsew])';
/** Two DMS tokens, comma and/or whitespace between them, nothing else in the string. */
const DMS_PAIR_RE = new RegExp('^\\s*' + DMS_TOKEN + '\\s*[, ]?\\s*' + DMS_TOKEN + '\\s*$');

/**
 * Parse a degrees-minutes-seconds coordinate pair. Only called once a degree
 * mark has already been seen — see parseCoord.
 * @param {string} s @returns {[number, number]|null}
 */
function parseDmsCoord(s) {
  const m = DMS_PAIR_RE.exec(s);
  if (!m) return null;
  const toDeg = (deg, min, sec, hemi) => {
    min = min ? parseFloat(min) : 0;
    sec = sec ? parseFloat(sec) : 0;
    if (min >= 60 || sec >= 60) return null;         // malformed, not merely unusual
    const v = parseFloat(deg) + min / 60 + sec / 3600;
    return /[SW]/i.test(hemi) ? -v : v;
  };
  const a = { deg: m[1], min: m[2], sec: m[3], h: m[4] };
  const b = { deg: m[5], min: m[6], sec: m[7], h: m[8] };
  const lat = /[NS]/i.test(a.h) ? a : (/[NS]/i.test(b.h) ? b : null);
  const lng = /[EW]/i.test(a.h) ? a : (/[EW]/i.test(b.h) ? b : null);
  if (!lat || !lng || lat === lng) return null;       // one N/S half and one E/W half, not two of a kind
  const latV = toDeg(lat.deg, lat.min, lat.sec, lat.h);
  const lngV = toDeg(lng.deg, lng.min, lng.sec, lng.h);
  if (latV === null || lngV === null) return null;
  if (Math.abs(latV) > 90 || Math.abs(lngV) > 180) return null;
  return [latV, lngV];
}

const fmtCoord = (lat, lng) => lat.toFixed(5) + ', ' + lng.toFixed(5);
function haversineKm(a, b, c, d) {
  const R = 6371, dLat = (c - a) * Math.PI / 180, dLng = (d - b) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * Math.PI / 180) * Math.cos(c * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** Total length (km) of a polyline given as an array of {lat,lng}. @param {Array<{lat:number,lng:number}>} pts */
function pathLengthKm(pts) {
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += haversineKm(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
  return km;
}

/**
 * Geodesic-ish area (m²) of a lat/lng polygon ring, via an equirectangular
 * projection onto a local tangent plane centered on the ring's own latitude.
 * Accurate enough at property/parcel scale (the polygons this tool draws);
 * not intended for country-scale shapes.
 * @param {Array<{lat:number,lng:number}>} pts @returns {number}
 */
function polygonAreaM2(pts) {
  if (pts.length < 3) return 0;
  const R = 6371000;
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length * Math.PI / 180;
  const xy = pts.map(p => ({
    x: R * (p.lng * Math.PI / 180) * Math.cos(lat0),
    y: R * (p.lat * Math.PI / 180),
  }));
  let a = 0;
  for (let i = 0; i < xy.length; i++) {
    const p1 = xy[i], p2 = xy[(i + 1) % xy.length];
    a += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(a) / 2;
}

/** Perimeter (km) of a closed ring — same as pathLengthKm but wraps last→first. @param {Array<{lat:number,lng:number}>} pts */
function ringPerimeterKm(pts) {
  if (pts.length < 2) return 0;
  return pathLengthKm(pts) + haversineKm(pts[pts.length - 1].lat, pts[pts.length - 1].lng, pts[0].lat, pts[0].lng);
}

/** Convert a square-meters area into all the display units the Draw tab needs. @param {number} m2 */
function areaUnits(m2) {
  return { m2, sqft: m2 * 10.7639, acres: m2 / 4046.8564224, hectares: m2 / 10000, sqkm: m2 / 1e6 };
}

/** Format an area (m²), honouring the user's area-unit preference when available. @param {number} m2 */
function fmtArea(m2) {
  if (typeof fmtAreaPref === 'function') return fmtAreaPref(m2);
  const u = areaUnits(m2);
  if (u.sqkm >= 1) return `${u.sqkm.toFixed(2)} km² (${u.hectares.toFixed(0)} ha)`;
  if (u.hectares >= 1) return `${u.hectares.toFixed(2)} ha (${u.acres.toFixed(2)} ac)`;
  if (m2 >= 1000) return `${(m2).toFixed(0)} m² (${u.acres.toFixed(3)} ac)`;
  return `${m2.toFixed(1)} m² (${u.sqft.toFixed(0)} sq ft)`;
}

/** Format a length (km), honouring the user's distance-unit preference when available. @param {number} km */
function fmtLen(km) {
  if (typeof fmtLenPref === 'function') return fmtLenPref(km);
  const m = km * 1000;
  if (km < 1) return `${Math.round(m)} m`;
  return `${km.toFixed(2)} km`;
}

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseCoord, parseDmsCoord, fmtCoord, haversineKm, pathLengthKm,
    polygonAreaM2, ringPerimeterKm, areaUnits, fmtArea, fmtLen,
  };
}
