/**
 * map/aerialDistance.js — straight-line (aerial) distance tool. Separate from
 * routing: click point A, click point B, get straight-line distance +
 * compass bearing between them. Purely additive — registers its own map
 * click / keydown listeners alongside the app's existing ones rather than
 * touching toolbar.js or routes.js.
 */

/**
 * Initial great-circle bearing from (lat1,lng1) to (lat2,lng2), in degrees
 * clockwise from north, 0-360.
 * @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2
 * @returns {number}
 */
function bearingDeg(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const phi1 = toRad(lat1), phi2 = toRad(lat2), dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** 16-point compass label for a bearing. @param {number} deg @returns {string} */
function compassLabel(deg) { return COMPASS_16[Math.round(deg / 22.5) % 16]; }

/** Format a km distance showing both metric units, e.g. "850 m (0.85 km)". @param {number} km @returns {string} */
function fmtAerialDistance(km) {
  const m = km * 1000;
  if (km < 1) return `${Math.round(m)} m`;
  return `${km.toFixed(2)} km · ${Math.round(m).toLocaleString()} m`;
}

let aerialActive = false;
let aerialPointA = null;
let aerialMarkerA = null, aerialMarkerB = null, aerialLine = null, aerialTooltip = null;

function clearAerial() {
  [aerialMarkerA, aerialMarkerB, aerialLine].forEach(l => { if (l) map.removeLayer(l); });
  aerialMarkerA = aerialMarkerB = aerialLine = aerialTooltip = null;
  aerialPointA = null;
}

const aerialDot = () => L.divIcon({ className: 'aerial-dot', iconSize: [12, 12] });

/**
 * Toggle aerial-measure mode. Turning it on cancels click-to-add / via-point
 * arming so a map click can't be interpreted by two tools at once.
 * @param {boolean} on
 */
function setAerialActive(on) {
  aerialActive = on;
  if (on) {
    if (typeof setAdding === 'function') setAdding(false);
    if (typeof armingViaFor !== 'undefined' && armingViaFor && typeof disarmVia === 'function') disarmVia();
    if (typeof disableAllDrawModes === 'function') disableAllDrawModes();
    if (typeof disableAllEditModes === 'function') disableAllEditModes();
    clearAerial();
  } else {
    clearAerial();
  }
  const btn = $('aerialBtn');
  if (btn) {
    btn.classList.toggle('toggled', on);
    btn.textContent = on ? 'Measure distance: ON (Esc)' : '📏 Measure straight-line distance';
  }
  $('mapWrap').classList.toggle('aerial-measuring', on);
}

$('aerialBtn').addEventListener('click', () => setAerialActive(!aerialActive));

// Cancel aerial mode if the user switches to click-to-add (complementary
// listener -- addEventListener supports multiple handlers per element/event,
// so this doesn't touch toolbar.js's own #clickAddBtn listener).
$('clickAddBtn').addEventListener('click', () => { if (aerialActive) setAerialActive(false); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && aerialActive) { setAerialActive(false); status('Distance measurement cancelled.'); }
});

map.on('click', e => {
  if (!aerialActive) return;
  if (!aerialPointA) {
    aerialPointA = e.latlng;
    aerialMarkerA = L.marker(e.latlng, { icon: aerialDot(), interactive: false }).addTo(map);
    status('Point A set — click Point B to measure.', true);
    return;
  }
  const B = e.latlng;
  aerialMarkerB = L.marker(B, { icon: aerialDot(), interactive: false }).addTo(map);
  aerialLine = L.polyline([aerialPointA, B], {
    color: '#FF7A1A', weight: 2.5, dashArray: '6,6', interactive: false, renderer: vectorRenderer,
  }).addTo(map);
  const km = haversineKm(aerialPointA.lat, aerialPointA.lng, B.lat, B.lng);
  const brg = bearingDeg(aerialPointA.lat, aerialPointA.lng, B.lat, B.lng);
  const mid = L.latLng((aerialPointA.lat + B.lat) / 2, (aerialPointA.lng + B.lng) / 2);
  aerialTooltip = L.tooltip({ permanent: true, direction: 'top', className: 'aerial-tooltip', offset: [0, -6] })
    .setLatLng(mid)
    .setContent(`${fmtAerialDistance(km)}<br>Bearing ${Math.round(brg)}° (${compassLabel(brg)})`)
    .addTo(map);
  status(`Straight-line distance: ${fmtAerialDistance(km)}, bearing ${Math.round(brg)}° (${compassLabel(brg)}).`);
  aerialPointA = null; // ready for a fresh A/B pair on the next two clicks
});
