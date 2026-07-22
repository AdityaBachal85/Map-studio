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
