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

/** Full two-unit distance string for the status bar, e.g. "850 m" or "1.20 km · 1,200 m". @param {number} km */
function fmtAerialDistance(km) {
  const m = km * 1000;
  if (km < 1) return `${Math.round(m)} m`;
  return `${km.toFixed(2)} km · ${Math.round(m).toLocaleString()} m`;
}

/** Compact single-unit distance for the on-map pill, e.g. "850 m" or "1.20 km". @param {number} km */
function fmtAerialShort(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`;
}

const aerialMeasurements = [];
let aerialNextId = 1;
let aerialCounter = 0;
let aerialActive = false;
let aerialPendingA = null;
let aerialPendingMarker = null;

const aerialDot = () => L.divIcon({ className: 'aerial-dot-wrap', html: '<span class="aerial-dot"></span>', iconSize: [16, 16], iconAnchor: [8, 8] });

/** dashArray for a measurement line style; null = solid. @param {string} style */
function aerialDashArray(style) {
  if (style === 'solid') return null;
  if (style === 'dotted') return '1,7';
  return '8,8'; // dashed (default)
}

/** Apply a measurement's colour + line style to its line. @param {object} m */
function applyAerialStyle(m) {
  m.line.setStyle({ color: m.color, dashArray: aerialDashArray(m.lineStyle), lineCap: 'round' });
}

/** Compact pill text: distance · compass bearing. @param {object} m */
function aerialLabelText(m) {
  return `${fmtAerialShort(m.lastKm)} · ${compassLabel(m.lastBrg)} ${Math.round(m.lastBrg)}°`;
}

/** Full card readout: both distance units + bearing. @param {object} m */
function aerialReadout(m) {
  return `${fmtAerialDistance(m.lastKm)} · Bearing ${Math.round(m.lastBrg)}° (${compassLabel(m.lastBrg)})`;
}

/** Recompute a measurement's line, label, card readout and cached distance/bearing. @param {object} m */
function updateAerialMeasurement(m) {
  m.line.setLatLngs([m.a, m.b]);
  const km = haversineKm(m.a.lat, m.a.lng, m.b.lat, m.b.lng);
  const brg = bearingDeg(m.a.lat, m.a.lng, m.b.lat, m.b.lng);
  m.lastKm = km; m.lastBrg = brg;
  const mid = L.latLng((m.a.lat + m.b.lat) / 2, (m.a.lng + m.b.lng) / 2);
  m.label.setLatLng(mid);
  const el = m.label.getElement();
  if (el) { const t = el.querySelector('.aerial-txt'); if (t) t.textContent = aerialLabelText(m); }
  if (m.card) { const r = m.card.querySelector('.measure-readout'); if (r) r.textContent = aerialReadout(m); }
}

function aerialSummary(m) {
  return `Straight-line distance: ${fmtAerialDistance(m.lastKm)}, bearing ${Math.round(m.lastBrg)}° (${compassLabel(m.lastBrg)}).`;
}

/** Fit the map to a measurement's two endpoints. @param {object} m */
function zoomToMeasurement(m) { map.fitBounds(L.latLngBounds([m.a, m.b]), { padding: [80, 80] }); }

/** Show/hide a measurement (line, label, endpoints) without deleting it. Used by the Layer Manager. @param {object} m @param {boolean} on */
function setAerialMeasurementVisible(m, on) {
  m._hidden = !on;
  [m.line, m.label, m.markerA, m.markerB].forEach(l => {
    if (!l) return;
    if (on) { if (!map.hasLayer(l)) l.addTo(map); }
    else if (map.hasLayer(l)) map.removeLayer(l);
  });
}

// ---------- sidebar card (Draw tab › Measure) ----------

function syncMeasureEmpty() {
  const empty = $('measureEmpty');
  if (empty) empty.style.display = aerialMeasurements.length ? 'none' : '';
}

/** Build and wire a measurement's card in the Draw tab's Measure list. @param {object} m */
function buildMeasureCard(m) {
  const card = document.createElement('div');
  card.className = 'item-card measure-card';
  card.innerHTML = `
    <div class="r">
      <input type="color" class="mclr" value="${esc(m.color)}" title="Line color">
      <input type="text" class="mnm grow" value="${esc(m.name)}" placeholder="Name">
      <button class="x-btn" title="Delete">&times;</button>
    </div>
    <div class="r">
      <span class="sub" style="width:44px;">Line</span>
      <select class="mls grow">
        <option value="dashed">Dashed</option>
        <option value="solid">Solid</option>
        <option value="dotted">Dotted</option>
      </select>
      <button class="mini-btn mzoom" title="Zoom to measurement">⌖</button>
    </div>
    <div class="r"><textarea class="mnotes grow" rows="2" placeholder="Notes">${esc(m.notes)}</textarea></div>
    <div class="r"><span class="sub measure-readout">${aerialReadout(m)}</span></div>
    <div class="r"><span class="sub" style="font-size:10px;">Created ${new Date(m.createdAt).toLocaleString()}</span></div>`;
  card.querySelector('.mls').value = m.lineStyle;
  card.querySelector('.mclr').addEventListener('input', e => { m.color = e.target.value; applyAerialStyle(m); refreshLayersSafe(); });
  card.querySelector('.mnm').addEventListener('change', e => { m.name = e.target.value || ('Measurement ' + m.n); refreshLayersSafe(); });
  card.querySelector('.mls').addEventListener('change', e => { m.lineStyle = e.target.value; applyAerialStyle(m); });
  card.querySelector('.mnotes').addEventListener('change', e => { m.notes = e.target.value; });
  card.querySelector('.mzoom').addEventListener('click', () => zoomToMeasurement(m));
  card.querySelector('.x-btn').addEventListener('click', () => { removeAerialMeasurement(m); status('Measurement removed.'); });
  m.card = card;
  enhanceColorInputs(card);
  $('measureList').appendChild(card);
}

function refreshLayersSafe() { if (typeof refreshLayers === 'function') refreshLayers(); }

/** Create a persistent, editable A→B measurement (on-map pill + endpoints + sidebar card). @param {L.LatLng} a @param {L.LatLng} b @returns {object} */
function makeAerialMeasurement(a, b) {
  const m = {
    id: aerialNextId++, n: ++aerialCounter,
    a, b, lastKm: 0, lastBrg: 0,
    name: 'Measurement ' + (aerialCounter), color: '#FF7A1A', lineStyle: 'dashed', notes: '',
    createdAt: new Date().toISOString(), card: null,
  };
  m.line = L.polyline([a, b], { color: m.color, weight: 2.5, dashArray: aerialDashArray(m.lineStyle), lineCap: 'round', interactive: false, renderer: vectorRenderer }).addTo(map);
  const labelIcon = L.divIcon({
    className: 'aerial-label-wrap',
    html: '<div class="aerial-label"><span class="aerial-txt"></span><button class="aerial-del" title="Remove this measurement" aria-label="Remove">×</button></div>',
    iconSize: [0, 0],
  });
  m.label = L.marker(L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2), { icon: labelIcon, interactive: true, keyboard: false, zIndexOffset: 1000 }).addTo(map);
  m.markerA = L.marker(a, { icon: aerialDot(), draggable: true, keyboard: false, zIndexOffset: 900 }).addTo(map);
  m.markerB = L.marker(b, { icon: aerialDot(), draggable: true, keyboard: false, zIndexOffset: 900 }).addTo(map);
  m.markerA.on('drag', e => { m.a = e.target.getLatLng(); updateAerialMeasurement(m); });
  m.markerB.on('drag', e => { m.b = e.target.getLatLng(); updateAerialMeasurement(m); });
  m.markerA.on('dragend', () => status(aerialSummary(m)));
  m.markerB.on('dragend', () => status(aerialSummary(m)));
  const el = m.label.getElement();
  if (el) {
    const del = el.querySelector('.aerial-del');
    if (del) L.DomEvent.on(del, 'click', ev => { L.DomEvent.stop(ev); removeAerialMeasurement(m); status('Measurement removed.'); });
  }
  aerialMeasurements.push(m);
  buildMeasureCard(m);
  updateAerialMeasurement(m);
  updateAerialClearBtn();
  syncMeasureEmpty();
  refreshLayersSafe();
  return m;
}

/** Remove a single measurement (line, label, endpoints, card). @param {object} m */
function removeAerialMeasurement(m) {
  [m.markerA, m.markerB, m.line, m.label].forEach(l => { if (l && map.hasLayer(l)) map.removeLayer(l); });
  if (m.card && m.card.parentNode) m.card.parentNode.removeChild(m.card);
  const i = aerialMeasurements.indexOf(m);
  if (i >= 0) aerialMeasurements.splice(i, 1);
  updateAerialClearBtn();
  syncMeasureEmpty();
  refreshLayersSafe();
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
  status(aerialSummary(m) + ' Drag an endpoint to adjust · click × on the label to remove.');
});
