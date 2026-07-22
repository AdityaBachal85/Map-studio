/**
 * map/drawing.js — professional drawing tools built on Leaflet-Geoman
 * (vendor/leaflet-geoman.js): Marker / Line / Polygon / Rectangle / Circle /
 * Circle-marker creation, global Edit / Drag / Rotate / Delete modes, live
 * distance-perimeter-area measurement while drawing or editing, and an
 * app-level undo/redo history (Geoman itself has no cross-shape undo/redo).
 * Purely additive: registers its own map/document listeners and its own
 * "Draw" sidebar tab rather than touching toolbar.js/routes.js/markers.js.
 */

const geometries = [];
let nextGeomId = 1;
const shapeCounters = {};
const editSnapshots = new Map(); // geom id -> snapshot taken at the start of the current edit gesture
const undoStack = [], redoStack = [];
const HISTORY_MAX = 50;

const GEOM_SHAPES = ['Marker', 'Line', 'Polygon', 'Rectangle', 'Circle', 'CircleMarker'];
const SHAPE_BTN_ID = { Marker: 'drawMarkerBtn', Line: 'drawLineBtn', Polygon: 'drawPolygonBtn', Rectangle: 'drawRectBtn', Circle: 'drawCircleBtn', CircleMarker: 'drawCircleMarkerBtn' };
const SHAPE_LABEL = { Marker: 'Marker', Line: 'Line', Polygon: 'Polygon', Rectangle: 'Rectangle', Circle: 'Circle', CircleMarker: 'Circle marker' };
const MODE_BTN_ID = { edit: 'drawEditBtn', drag: 'drawDragBtn', rotate: 'drawRotateBtn', remove: 'drawRemoveBtn' };

let activeShape = null;
let activeEditMode = null;

/** Default per-shape style, matching the app's orange/navy brand palette. */
function defaultGeomStyle() { return { fillColor: '#FF7A1A', borderColor: '#0A1E3C', borderWidth: 3, fillOpacity: 0.25, lineStyle: 'solid', corner: 'round', showLabel: false, glow: false }; }

/** dashArray for a line style + width; null = solid. @param {string} style @param {number} w */
function dashArrayFor(style, w) {
  if (style === 'dashed') return `${Math.max(8, w * 3)},${Math.max(7, w * 2.5)}`;
  if (style === 'dotted') return `1,${Math.max(6, w * 2.4)}`; // round caps render these as dots
  return null;
}

/** corner name -> [lineCap, lineJoin]. @param {string} corner */
const GEOM_CAP = { round: ['round', 'round'], sharp: ['butt', 'miter'], square: ['square', 'bevel'] };

// Brand Geoman's in-progress drawing + editing chrome so it matches the app
// (its defaults are a generic blue). Runs once at load; map/map.pm exist by now.
map.pm.setGlobalOptions({
  templineStyle: { color: '#FF7A1A', weight: 2.5 },
  hintlineStyle: { color: '#FF7A1A', weight: 2, dashArray: '6,6' },
  pathOptions: { color: '#0A1E3C', weight: 3, fillColor: '#FF7A1A', fillOpacity: 0.25 },
  snappable: true, snapDistance: 20,
});

/** Next auto-generated name for a newly created/imported shape, e.g. "Polygon 2". @param {string} shape */
function nextGeomName(shape) {
  shapeCounters[shape] = (shapeCounters[shape] || 0) + 1;
  return `${SHAPE_LABEL[shape] || shape} ${shapeCounters[shape]}`;
}

const geomById = id => geometries.find(g => g.id === id);
const geomByLayer = layer => geometries.find(g => g.layer === layer);

/** Point-shaped divIcon used for Marker/CircleMarker so Fill/Border properties stay meaningful for point shapes too. @param {object} g */
function geomMarkerIcon(g) {
  return L.divIcon({
    className: 'geom-marker-dot',
    html: `<span style="display:block;width:100%;height:100%;border-radius:50%;background:${g.fillColor};opacity:${g.fillOpacity};border:${g.borderWidth}px solid ${g.borderColor};box-shadow:0 1px 4px rgba(0,0,0,.4);"></span>`,
    iconSize: [22, 22], iconAnchor: [11, 11],
  });
}

/** Re-apply a geometry's current style fields onto its live Leaflet layer, plus its optional glow halo and on-map label. @param {object} g */
function applyGeomStyle(g) {
  if (g.shape === 'Marker') {
    g.layer.setIcon(geomMarkerIcon(g));
  } else {
    const [cap, join] = GEOM_CAP[g.corner] || GEOM_CAP.round;
    g.layer.setStyle({
      color: g.borderColor, weight: g.borderWidth, fillColor: g.fillColor, fillOpacity: g.fillOpacity,
      dashArray: dashArrayFor(g.lineStyle, g.borderWidth), lineCap: cap, lineJoin: join,
    });
  }
  ensureGlow(g);
  ensureGeomLabel(g);
}

// ---------- glow halo (a wider, translucent under-layer that tracks the shape) ----------

function glowStyleFor(g) {
  return {
    color: g.fillColor, weight: (g.borderWidth || 3) + 8, opacity: 0.3,
    fillColor: g.fillColor, fillOpacity: 0.2, interactive: false, renderer: vectorRenderer,
    dashArray: null, lineCap: 'round', lineJoin: 'round',
  };
}

function makeGlowLayer(g) {
  const s = glowStyleFor(g);
  if (g.shape === 'Marker') return L.circleMarker(g.layer.getLatLng(), Object.assign({ radius: 15, fill: true }, s));
  if (g.shape === 'CircleMarker') return L.circleMarker(g.layer.getLatLng(), Object.assign({ radius: (g.layer.getRadius() || 8) + 7, fill: true }, s));
  if (g.shape === 'Circle') return L.circle(g.layer.getLatLng(), Object.assign({ radius: g.layer.getRadius(), fill: false }, s));
  if (g.shape === 'Rectangle') return L.rectangle(g.layer.getBounds(), Object.assign({ fill: false }, s));
  if (g.shape === 'Line') return L.polyline(g.layer.getLatLngs(), Object.assign({ fill: false }, s));
  return L.polygon(g.layer.getLatLngs(), Object.assign({ fill: false }, s));
}

/** Keep a glow layer's geometry + style in sync with its shape. @param {object} g */
function syncGlowGeometry(g) {
  if (!g.glowLayer) return;
  if (g.shape === 'Marker' || g.shape === 'CircleMarker') g.glowLayer.setLatLng(g.layer.getLatLng());
  else if (g.shape === 'Circle') { g.glowLayer.setLatLng(g.layer.getLatLng()); g.glowLayer.setRadius(g.layer.getRadius()); }
  else if (g.shape === 'Rectangle') g.glowLayer.setBounds(g.layer.getBounds());
  else g.glowLayer.setLatLngs(g.layer.getLatLngs());
  g.glowLayer.setStyle(glowStyleFor(g));
  if (g.glowLayer.bringToBack) g.glowLayer.bringToBack();
}

/** Create/refresh or remove a shape's glow halo to match g.glow. @param {object} g */
function ensureGlow(g) {
  if (g._hidden) { if (g.glowLayer) { map.removeLayer(g.glowLayer); g.glowLayer = null; } return; }
  if (g.glow) {
    if (!g.glowLayer) { g.glowLayer = makeGlowLayer(g); g.glowLayer.addTo(map); if (g.glowLayer.bringToBack) g.glowLayer.bringToBack(); }
    else syncGlowGeometry(g);
  } else if (g.glowLayer) {
    map.removeLayer(g.glowLayer); g.glowLayer = null;
  }
}

// ---------- on-map name label (a small frosted chip centered on the shape) ----------

function geomLabelLatLng(g) {
  try { return g.layer.getBounds ? g.layer.getBounds().getCenter() : g.layer.getLatLng(); }
  catch (e) { return g.layer.getLatLng ? g.layer.getLatLng() : map.getCenter(); }
}

function geomLabelIcon(g) {
  return L.divIcon({
    className: 'geom-label-wrap',
    html: `<span class="geom-label" style="border-color:${g.borderColor}">${esc(g.name)}</span>`,
    iconSize: [0, 0],
  });
}

/** Create/refresh or remove a shape's on-map name label to match g.showLabel. @param {object} g */
function ensureGeomLabel(g) {
  if (g._hidden) { if (g.labelMarker) { map.removeLayer(g.labelMarker); g.labelMarker = null; } return; }
  if (g.showLabel) {
    if (!g.labelMarker) {
      g.labelMarker = L.marker(geomLabelLatLng(g), { icon: geomLabelIcon(g), interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(map);
    } else {
      g.labelMarker.setLatLng(geomLabelLatLng(g));
      g.labelMarker.setIcon(geomLabelIcon(g));
    }
  } else if (g.labelMarker) {
    map.removeLayer(g.labelMarker); g.labelMarker = null;
  }
}

/**
 * Live distance/perimeter/area text for a shape's current geometry.
 * @param {string} shape @param {L.Layer} layer @returns {{text:string}}
 */
function measureForLayer(shape, layer) {
  try {
    if (shape === 'Marker' || shape === 'CircleMarker') {
      const ll = layer.getLatLng();
      return { text: `Point: ${fmtCoord(ll.lat, ll.lng)}` };
    }
    if (shape === 'Line') {
      const pts = layer.getLatLngs();
      return { text: `Length: ${fmtLen(pathLengthKm(pts))}` };
    }
    if (shape === 'Polygon' || shape === 'Rectangle') {
      let ring = layer.getLatLngs();
      if (Array.isArray(ring[0])) ring = ring[0];
      return { text: `Perimeter: ${fmtLen(ringPerimeterKm(ring))} · Area: ${fmtArea(polygonAreaM2(ring))}` };
    }
    if (shape === 'Circle') {
      const r = layer.getRadius();
      return { text: `Radius: ${fmtLen(r / 1000)} · Area: ${fmtArea(Math.PI * r * r)}` };
    }
  } catch (e) { /* mid-edit transient states can briefly yield too-few vertices */ }
  return { text: '' };
}

/** Push the live measurement into a geometry's card and, if `live`, the floating readout. Also keeps the glow halo and on-map label tracking the shape as it moves. @param {object} g @param {boolean} [live] */
function updateGeomMeasurement(g, live) {
  const m = measureForLayer(g.shape, g.layer);
  g.measureText = m.text;
  if (g.card) { const el = g.card.querySelector('.geom-measure'); if (el) el.textContent = m.text; }
  if (g.glowLayer) syncGlowGeometry(g);
  if (g.labelMarker) g.labelMarker.setLatLng(geomLabelLatLng(g));
  if (live) {
    const box = $('drawLiveStats');
    box.textContent = `${g.name} — ${m.text}`;
    box.style.display = 'block';
  }
}

function refreshGeomCardMeta(g) {
  if (!g.card) return;
  const mod = g.card.querySelector('.geom-modified');
  if (mod) mod.textContent = 'Modified ' + new Date(g.modifiedAt).toLocaleString();
}

/** Mark a geometry as modified now and refresh its card's timestamp. @param {object} g */
function touchGeom(g) { g.modifiedAt = new Date().toISOString(); refreshGeomCardMeta(g); }

function syncGeomEmpty() { $('geomEmpty').style.display = geometries.length ? 'none' : ''; }

/** Briefly highlight a geometry's sidebar card (used when its shape is clicked on the map). @param {object} g */
function selectGeom(g) {
  if (!g.card) return;
  g.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  g.card.classList.add('flash');
  setTimeout(() => g.card && g.card.classList.remove('flash'), 600);
}

// ---------- GeoJSON-shaped coordinate extraction (shared by undo/redo + import/export) ----------

/** Extract this geometry's raw coordinates in a plain, serialisable form. @param {string} shape @param {L.Layer} layer */
function extractGeomCoords(shape, layer) {
  if (shape === 'Marker' || shape === 'CircleMarker') { const ll = layer.getLatLng(); return { lat: ll.lat, lng: ll.lng }; }
  if (shape === 'Circle') { const ll = layer.getLatLng(); return { lat: ll.lat, lng: ll.lng, radius: layer.getRadius() }; }
  if (shape === 'Rectangle') { const b = layer.getBounds(); return { bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]] }; }
  let ring = layer.getLatLngs();
  if (Array.isArray(ring[0])) ring = ring[0];
  return { latlngs: ring.map(p => [p.lat, p.lng]) };
}

/** Build a fresh, unattached Leaflet layer from extractGeomCoords() output. @param {string} shape @param {object} geom */
function layerFromGeom(shape, geom) {
  if (shape === 'Marker') return L.marker([geom.lat, geom.lng]);
  if (shape === 'CircleMarker') return L.circleMarker([geom.lat, geom.lng], { radius: 8 });
  if (shape === 'Circle') return L.circle([geom.lat, geom.lng], { radius: geom.radius });
  if (shape === 'Rectangle') return L.rectangle(geom.bounds);
  if (shape === 'Line') return L.polyline(geom.latlngs);
  return L.polygon(geom.latlngs);
}

/** Reposition a geometry's existing layer in place to match a snapshot's coordinates (keeps the same layer instance/listeners). @param {object} g @param {object} geom */
function applyGeomCoords(g, geom) {
  if (g.shape === 'Marker' || g.shape === 'CircleMarker') g.layer.setLatLng([geom.lat, geom.lng]);
  else if (g.shape === 'Circle') { g.layer.setLatLng([geom.lat, geom.lng]); g.layer.setRadius(geom.radius); }
  else if (g.shape === 'Rectangle') g.layer.setBounds(geom.bounds);
  else g.layer.setLatLngs(geom.latlngs);
}

/** Full undo/redo-able snapshot of a geometry: style + metadata + coordinates. @param {object} g */
function snapshotGeom(g) {
  return {
    id: g.id, shape: g.shape, name: g.name, description: g.description, notes: g.notes,
    fillColor: g.fillColor, borderColor: g.borderColor, borderWidth: g.borderWidth, fillOpacity: g.fillOpacity,
    lineStyle: g.lineStyle, corner: g.corner, showLabel: g.showLabel, glow: g.glow,
    createdAt: g.createdAt, geom: extractGeomCoords(g.shape, g.layer),
  };
}

// ---------- create / delete / history ----------

function updateUndoRedoButtons() {
  $('drawUndoBtn').disabled = !undoStack.length;
  $('drawRedoBtn').disabled = !redoStack.length;
}

function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
  updateUndoRedoButtons();
}

/** Attach the live/edit/select listeners every geometry (drawn or imported) needs. @param {object} g */
function attachGeomLayerEvents(g) {
  const layer = g.layer;
  layer.on('pm:markerdragstart pm:dragstart pm:rotatestart', () => {
    if (!editSnapshots.has(g.id)) editSnapshots.set(g.id, snapshotGeom(g));
  });
  layer.on('pm:markerdrag pm:change pm:rotate pm:drag', () => {
    if (!editSnapshots.has(g.id)) editSnapshots.set(g.id, snapshotGeom(g));
    updateGeomMeasurement(g, true);
  });
  layer.on('pm:edit pm:markerdragend pm:dragend pm:rotateend', () => {
    const before = editSnapshots.get(g.id);
    editSnapshots.delete(g.id);
    touchGeom(g);
    updateGeomMeasurement(g);
    if (before) pushUndo({ type: 'edit', id: g.id, before, after: snapshotGeom(g) });
  });
  layer.on('click', () => selectGeom(g));
  // Double-click a shape to edit just that shape's vertices in place (stop the
  // event so the map doesn't also zoom).
  layer.on('dblclick', ev => { L.DomEvent.stop(ev); enableSingleShapeEdit(g); });
}

/**
 * Enable direct vertex/shape editing on a single geometry (and turn it off
 * everywhere else), independent of the global Edit mode. Toggles: a second
 * call on the same shape turns its editing off.
 * @param {object} g
 */
function enableSingleShapeEdit(g) {
  disableAllDrawModes();
  disableAllEditModes();
  const wasEditing = g.layer.pm && g.layer.pm.enabled && g.layer.pm.enabled();
  geometries.forEach(x => { if (x.layer.pm && x.layer.pm.enabled && x.layer.pm.enabled()) x.layer.pm.disable(); });
  geometries.forEach(x => { if (x.card) x.card.classList.toggle('editing', false); });
  if (wasEditing) { status(`${g.name}: editing off.`); return; }
  g.layer.pm.enable({ allowSelfIntersection: false });
  if (g.card) g.card.classList.add('editing');
  selectGeom(g);
  status(`${g.name}: drag vertices to reshape · drag the middle handles to add points · click a vertex to remove it.`);
}

/** Remove a geometry from the map/array/DOM without touching undo history (used by the history machinery itself). @param {number} id */
function removeGeomById(id) {
  const idx = geometries.findIndex(x => x.id === id);
  if (idx < 0) return;
  const g = geometries[idx];
  if (map.hasLayer(g.layer)) map.removeLayer(g.layer);
  if (g.glowLayer && map.hasLayer(g.glowLayer)) map.removeLayer(g.glowLayer);
  if (g.labelMarker && map.hasLayer(g.labelMarker)) map.removeLayer(g.labelMarker);
  if (g.card && g.card.parentNode) g.card.parentNode.removeChild(g.card);
  geometries.splice(idx, 1);
  syncGeomEmpty();
  if (typeof refreshLayers === 'function') refreshLayers();
}

/** Build a full geometry entry around an already-positioned, already-styled layer and add it to the app. */
function registerGeom(layer, shape, meta) {
  const now = new Date().toISOString();
  const clean = {};
  Object.keys(meta || {}).forEach(k => { if (meta[k] !== undefined) clean[k] = meta[k]; });
  const g = Object.assign({
    id: nextGeomId++, shape, layer,
    name: nextGeomName(shape), description: '', notes: '',
    createdAt: now, modifiedAt: now, card: null,
  }, defaultGeomStyle(), clean);
  applyGeomStyle(g);
  if (!map.hasLayer(layer)) layer.addTo(map);
  attachGeomLayerEvents(g);
  geometries.push(g);
  buildGeomCard(g);
  updateGeomMeasurement(g);
  syncGeomEmpty();
  if (typeof refreshLayers === 'function') refreshLayers();
  return g;
}

/** Show/hide a shape (fill/stroke, glow, label) without deleting it. Used by the Layer Manager. @param {object} g @param {boolean} on */
function setGeomVisible(g, on) {
  g._hidden = !on;
  if (on) {
    if (!map.hasLayer(g.layer)) g.layer.addTo(map);
    ensureGlow(g); ensureGeomLabel(g);
  } else {
    if (map.hasLayer(g.layer)) map.removeLayer(g.layer);
    if (g.glowLayer && map.hasLayer(g.glowLayer)) map.removeLayer(g.glowLayer);
    if (g.labelMarker && map.hasLayer(g.labelMarker)) map.removeLayer(g.labelMarker);
  }
}

/** User-facing delete (card button or global removal-mode click) — undo-able. @param {object} g */
function deleteGeom(g) {
  if (map.hasLayer(g.layer)) map.removeLayer(g.layer);
  pushUndo({ type: 'delete', snap: snapshotGeom(g) });
  removeGeomById(g.id);
  status(`${g.name} deleted.`);
}

function finalizeNewGeom(layer, shape) {
  const g = registerGeom(layer, shape, {});
  pushUndo({ type: 'create', snap: snapshotGeom(g) });
  status(`${g.name} added.`);
  return g;
}

function recreateGeomFromSnapshot(snap) {
  const layer = layerFromGeom(snap.shape, snap.geom);
  return registerGeom(layer, snap.shape, {
    id: snap.id, name: snap.name, description: snap.description, notes: snap.notes,
    fillColor: snap.fillColor, borderColor: snap.borderColor, borderWidth: snap.borderWidth, fillOpacity: snap.fillOpacity,
    lineStyle: snap.lineStyle, corner: snap.corner, showLabel: snap.showLabel, glow: snap.glow,
    createdAt: snap.createdAt,
  });
}

function applyHistoryEntry(entry, isUndo) {
  if (entry.type === 'create') { if (isUndo) removeGeomById(entry.snap.id); else recreateGeomFromSnapshot(entry.snap); }
  else if (entry.type === 'delete') { if (isUndo) recreateGeomFromSnapshot(entry.snap); else removeGeomById(entry.snap.id); }
  else if (entry.type === 'edit') {
    const g = geomById(entry.id);
    if (!g) return;
    const snap = isUndo ? entry.before : entry.after;
    applyGeomCoords(g, snap.geom);
    g.fillColor = snap.fillColor; g.borderColor = snap.borderColor; g.borderWidth = snap.borderWidth; g.fillOpacity = snap.fillOpacity;
    g.lineStyle = snap.lineStyle; g.corner = snap.corner; g.showLabel = snap.showLabel; g.glow = snap.glow;
    if (g.card) syncGeomCardStyleControls(g);
    applyGeomStyle(g);
    touchGeom(g);
    updateGeomMeasurement(g);
  }
}

function doUndo() {
  const entry = undoStack.pop();
  if (!entry) return;
  applyHistoryEntry(entry, true);
  redoStack.push(entry);
  updateUndoRedoButtons();
  status('Undid last drawing change.');
}
function doRedo() {
  const entry = redoStack.pop();
  if (!entry) return;
  applyHistoryEntry(entry, false);
  undoStack.push(entry);
  updateUndoRedoButtons();
  status('Redid drawing change.');
}

/** Remove every drawn/imported shape and reset history (used by "Open project"). */
function clearAllGeometries() {
  geometries.slice().forEach(g => {
    if (map.hasLayer(g.layer)) map.removeLayer(g.layer);
    if (g.glowLayer && map.hasLayer(g.glowLayer)) map.removeLayer(g.glowLayer);
    if (g.labelMarker && map.hasLayer(g.labelMarker)) map.removeLayer(g.labelMarker);
    if (g.card && g.card.parentNode) g.card.parentNode.removeChild(g.card);
  });
  geometries.length = 0;
  undoStack.length = 0; redoStack.length = 0;
  updateUndoRedoButtons();
  syncGeomEmpty();
}

// ---------- shape drawing / edit-mode toolbar ----------

function disableAllDrawModes() {
  if (activeShape) map.pm.disableDraw();
  activeShape = null;
  GEOM_SHAPES.forEach(s => { const b = $(SHAPE_BTN_ID[s]); if (b) b.classList.remove('toggled'); });
  $('drawLiveStats').style.display = 'none';
}

function disableAllEditModes() {
  if (map.pm.globalEditModeEnabled()) map.pm.disableGlobalEditMode();
  if (map.pm.globalDragModeEnabled()) map.pm.disableGlobalDragMode();
  if (map.pm.globalRotateModeEnabled()) map.pm.disableGlobalRotateMode();
  if (map.pm.globalRemovalModeEnabled()) map.pm.disableGlobalRemovalMode();
  activeEditMode = null;
  Object.values(MODE_BTN_ID).forEach(id => { const b = $(id); if (b) b.classList.remove('toggled'); });
}

function startDrawShape(shape) {
  disableAllEditModes();
  if (typeof setAdding === 'function') setAdding(false);
  if (typeof armingViaFor !== 'undefined' && armingViaFor && typeof disarmVia === 'function') disarmVia();
  if (typeof aerialActive !== 'undefined' && aerialActive && typeof setAerialActive === 'function') setAerialActive(false);
  const wasActive = activeShape === shape;
  if (activeShape) map.pm.disableDraw();
  if (wasActive) { activeShape = null; GEOM_SHAPES.forEach(s => { const b = $(SHAPE_BTN_ID[s]); if (b) b.classList.remove('toggled'); }); return; }
  activeShape = shape;
  GEOM_SHAPES.forEach(s => { const b = $(SHAPE_BTN_ID[s]); if (b) b.classList.toggle('toggled', s === shape); });
  map.pm.enableDraw(shape, { continueDrawing: false });
}

function toggleEditMode(mode) {
  disableAllDrawModes();
  const wasActive = activeEditMode === mode;
  disableAllEditModes();
  if (wasActive) return;
  activeEditMode = mode;
  const b = $(MODE_BTN_ID[mode]); if (b) b.classList.add('toggled');
  if (mode === 'edit') map.pm.enableGlobalEditMode();
  else if (mode === 'drag') map.pm.enableGlobalDragMode();
  else if (mode === 'rotate') map.pm.enableGlobalRotateMode();
  else if (mode === 'remove') map.pm.enableGlobalRemovalMode();
}

/** Explicitly finish the shape currently being drawn (Geoman's internal per-handler finish, same as clicking the first vertex again). */
function finishActiveDraw() {
  if (!activeShape) return;
  const handler = map.pm.Draw[activeShape];
  if (handler && typeof handler._finishShape === 'function') handler._finishShape();
}

GEOM_SHAPES.forEach(shape => { const b = $(SHAPE_BTN_ID[shape]); if (b) b.addEventListener('click', () => startDrawShape(shape)); });
$('drawFinishBtn').addEventListener('click', finishActiveDraw);
$('drawCancelBtn').addEventListener('click', () => { if (activeShape) { disableAllDrawModes(); status('Drawing cancelled.'); } });
Object.keys(MODE_BTN_ID).forEach(mode => { const b = $(MODE_BTN_ID[mode]); if (b) b.addEventListener('click', () => toggleEditMode(mode)); });
$('drawUndoBtn').addEventListener('click', doUndo);
$('drawRedoBtn').addEventListener('click', doRedo);
updateUndoRedoButtons();

// Live measurement while actively drawing (Geoman exposes the in-progress
// shape at map.pm.Draw[shape]._layer while a draw is in progress).
map.on('mousemove', () => {
  if (!activeShape) return;
  const handler = map.pm.Draw[activeShape];
  const layer = handler && handler._layer;
  if (!layer) { $('drawLiveStats').style.display = 'none'; return; }
  let pts;
  if (activeShape === 'Line' || activeShape === 'Polygon') {
    pts = layer.getLatLngs();
    if (Array.isArray(pts[0])) pts = pts[0];
    if (handler._hintMarker) pts = pts.concat([handler._hintMarker.getLatLng()]);
    if (pts.length < 2) { $('drawLiveStats').style.display = 'none'; return; }
  }
  const box = $('drawLiveStats');
  if (activeShape === 'Line') box.textContent = `Length: ${fmtLen(pathLengthKm(pts))}`;
  else if (activeShape === 'Polygon') box.textContent = `Perimeter: ${fmtLen(ringPerimeterKm(pts))} · Area: ${fmtArea(polygonAreaM2(pts))}`;
  else if (activeShape === 'Rectangle') {
    const b2 = layer.getBounds();
    const ring = [b2.getNorthWest(), b2.getNorthEast(), b2.getSouthEast(), b2.getSouthWest()];
    box.textContent = `Perimeter: ${fmtLen(ringPerimeterKm(ring))} · Area: ${fmtArea(polygonAreaM2(ring))}`;
  } else if (activeShape === 'Circle') {
    const r = layer.getRadius();
    box.textContent = `Radius: ${fmtLen(r / 1000)} · Area: ${fmtArea(Math.PI * r * r)}`;
  } else { box.style.display = 'none'; return; }
  box.style.display = 'block';
});

map.on('pm:create', e => { finalizeNewGeom(e.layer, e.shape); disableAllDrawModes(); });
map.on('pm:remove', e => {
  const g = geomByLayer(e.layer);
  if (!g) return;
  pushUndo({ type: 'delete', snap: snapshotGeom(g) });
  removeGeomById(g.id);
  status(`${g.name} deleted.`);
});

document.addEventListener('keydown', e => {
  const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;
  if (e.key === 'Escape') {
    if (activeShape) { disableAllDrawModes(); status('Drawing cancelled.'); }
    else if (activeEditMode) { disableAllEditModes(); status('Shape editing off.'); }
  }
  if (typing) return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
  else if ((e.ctrlKey || e.metaKey) && key === 'y') { e.preventDefault(); doRedo(); }
});
