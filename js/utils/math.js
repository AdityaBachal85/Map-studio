/**
 * utils/math.js — coordinate parsing/formatting and geodesic distance.
 */

/** Parse "lat, lng" text into [lat, lng], or null when invalid/out of range. @param {string} str */
function parseCoord(str) {
  if (!str) return null;
  const p = String(str).split(',').map(s => parseFloat(s.trim()));
  if (p.length !== 2 || p.some(isNaN) || Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180) return null;
  return p;
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

/** Format an area (m²) as a compact human string, picking a sensible unit. @param {number} m2 */
function fmtArea(m2) {
  const u = areaUnits(m2);
  if (u.sqkm >= 1) return `${u.sqkm.toFixed(2)} km² (${u.hectares.toFixed(0)} ha)`;
  if (u.hectares >= 1) return `${u.hectares.toFixed(2)} ha (${u.acres.toFixed(2)} ac)`;
  if (m2 >= 1000) return `${(m2).toFixed(0)} m² (${u.acres.toFixed(3)} ac)`;
  return `${m2.toFixed(1)} m² (${u.sqft.toFixed(0)} sq ft)`;
}

/** Format a length (km) reusing the same "m below 1km" convention as the aerial tool. @param {number} km */
function fmtLen(km) {
  const m = km * 1000;
  if (km < 1) return `${Math.round(m)} m`;
  return `${km.toFixed(2)} km`;
}
