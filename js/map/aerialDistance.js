/**
 * map/aerialDistance.js — straight-line (aerial) distance tool. Click point A,
 * click point B to drop a measurement showing straight-line distance + compass
 * bearing. Measurements PERSIST after the tool is switched off; both endpoints
 * are draggable so a measurement can be adjusted afterwards, and right-clicking
 * an endpoint removes that measurement. Separate from routing. Purely additive:
 * registers its own map click / keydown listeners alongside the app's existing
 * ones rather than touching toolbar.js or routes.js.
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

/** Format a km distance showing both metric units, e.g. "850 m" or "1.20 km · 1,200 m". @param {number} km @returns {string} */
function fmtAerialDistance(km) {
  const m = km * 1000;
  if (km < 1) return `${Math.round(m)} m`;
  return `${km.toFixed(2)} km · ${Math.round(m).toLocaleString()} m`;
}

const aerialMeasurements = [];
let aerialActive = false;
let aerialPendingA = null;
let aerialPendingMarker = null;

const aerialDot = () => L.divIcon({ className: 'aerial-dot-wrap', html: '<span class="aerial-dot"></span>', iconSize: [14, 14], iconAnchor: [7, 7] });

function aerialTooltipContent(km, brg) {
  return `${fmtAerialDistance(km)}<br>Bearing ${Math.round(brg)}° (${compassLabel(brg)})`;
}

/** Recompute a measurement's line, tooltip and cached distance/bearing from its current endpoints. @param {object} m */
function updateAerialMeasurement(m) {
  m.line.setLatLngs([m.a, m.b]);
  const km = haversineKm(m.a.lat, m.a.lng, m.b.lat, m.b.lng);
  const brg = bearingDeg(m.a.lat, m.a.lng, m.b.lat, m.b.lng);
  const mid = L.latLng((m.a.lat + m.b.lat) / 2, (m.a.lng + m.b.lng) / 2);
  m.tooltip.setLatLng(mid).setContent(aerialTooltipContent(km, brg));
  m.lastKm = km; m.lastBrg = brg;
}

function aerialSummary(m) {
  return `Straight-line distance: ${fmtAerialDistance(m.lastKm)}, bearing ${Math.round(m.lastBrg)}° (${compassLabel(m.lastBrg)}).`;
}

/** Create a persistent, editable A→B measurement. @param {L.LatLng} a @param {L.LatLng} b @returns {object} */
function makeAerialMeasurement(a, b) {
  const m = { a, b };
  m.line = L.polyline([a, b], { color: '#FF7A1A', weight: 2.5, dashArray: '6,6', interactive: false, renderer: vectorRenderer }).addTo(map);
  m.tooltip = L.tooltip({ permanent: true, direction: 'top', className: 'aerial-tooltip', offset: [0, -8] }).setLatLng(a).addTo(map);
  m.markerA = L.marker(a, { icon: aerialDot(), draggable: true, keyboard: false, zIndexOffset: 900 }).addTo(map);
  m.markerB = L.marker(b, { icon: aerialDot(), draggable: true, keyboard: false, zIndexOffset: 900 }).addTo(map);
  m.markerA.on('drag', e => { m.a = e.target.getLatLng(); updateAerialMeasurement(m); });
  m.markerB.on('drag', e => { m.b = e.target.getLatLng(); updateAerialMeasurement(m); });
  m.markerA.on('dragend', () => status(aerialSummary(m)));
  m.markerB.on('dragend', () => status(aerialSummary(m)));
  m.markerA.on('contextmenu', ev => { L.DomEvent.stop(ev); removeAerialMeasurement(m); status('Measurement removed.'); });
  m.markerB.on('contextmenu', ev => { L.DomEvent.stop(ev); removeAerialMeasurement(m); status('Measurement removed.'); });
  updateAerialMeasurement(m);
  aerialMeasurements.push(m);
  updateAerialClearBtn();
  return m;
}

/** Remove a single measurement (its line, tooltip and both endpoints). @param {object} m */
function removeAerialMeasurement(m) {
  [m.markerA, m.markerB, m.line, m.tooltip].forEach(l => { if (l && map.hasLayer(l)) map.removeLayer(l); });
  const i = aerialMeasurements.indexOf(m);
  if (i >= 0) aerialMeasurements.splice(i, 1);
  updateAerialClearBtn();
}

/** Remove every measurement from the map. */
function clearAllAerialMeasurements() {
  aerialMeasurements.slice().forEach(removeAerialMeasurement);
  status('Measurements cleared.');
}

function updateAerialClearBtn() {
  const btn = $('aerialClearBtn');
  if (btn) btn.style.display = aerialMeasurements.length ? '' : 'none';
}

/** Discard only a half-started measurement (single A point), never completed ones. */
function cancelAerialPending() {
  if (aerialPendingMarker) { map.removeLayer(aerialPendingMarker); aerialPendingMarker = null; }
  aerialPendingA = null;
}

/**
 * Toggle aerial-measure mode. Turning it on cancels click-to-add / via-point /
 * draw modes so a map click can't be claimed by two tools at once. Turning it
 * off discards only an in-progress point — finished measurements stay put.
 * @param {boolean} on
 */
function setAerialActive(on) {
  aerialActive = on;
  if (on) {
    if (typeof setAdding === 'function') setAdding(false);
    if (typeof armingViaFor !== 'undefined' && armingViaFor && typeof disarmVia === 'function') disarmVia();
    if (typeof disableAllDrawModes === 'function') disableAllDrawModes();
    if (typeof disableAllEditModes === 'function') disableAllEditModes();
  }
  cancelAerialPending();
  const btn = $('aerialBtn');
  if (btn) {
    btn.classList.toggle('toggled', on);
    btn.textContent = on ? 'Measuring: click two points (Esc)' : '📏 Measure straight-line distance';
  }
  $('mapWrap').classList.toggle('aerial-measuring', on);
}

$('aerialBtn').addEventListener('click', () => setAerialActive(!aerialActive));
$('aerialClearBtn').addEventListener('click', clearAllAerialMeasurements);

// Cancel aerial mode if the user switches to click-to-add (complementary
// listener -- addEventListener supports multiple handlers per element/event,
// so this doesn't touch toolbar.js's own #clickAddBtn listener).
$('clickAddBtn').addEventListener('click', () => { if (aerialActive) setAerialActive(false); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && aerialActive) { setAerialActive(false); status('Distance measurement off.'); }
});

map.on('click', e => {
  if (!aerialActive) return;
  if (!aerialPendingA) {
    aerialPendingA = e.latlng;
    aerialPendingMarker = L.marker(e.latlng, { icon: aerialDot(), interactive: false }).addTo(map);
    status('Point A set — click Point B to measure.', true);
    return;
  }
  const A = aerialPendingA;
  cancelAerialPending();
  const m = makeAerialMeasurement(A, e.latlng);
  status(aerialSummary(m) + ' Drag an endpoint to adjust, right-click it to remove.');
});
