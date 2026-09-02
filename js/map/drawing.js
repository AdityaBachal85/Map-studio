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

// 'Label' is a real shape here — see map/textLabels.js for why free-standing
// text is a geometry rather than a collection of its own. It is the one entry
// Geoman knows nothing about, so startDrawShape() hands it to our own
// click-to-place mode instead of map.pm.enableDraw().
const GEOM_SHAPES = ['Marker', 'Line', 'Polygon', 'Rectangle', 'Circle', 'CircleMarker', 'Label'];
const SHAPE_BTN_ID = { Marker: 'drawMarkerBtn', Line: 'drawLineBtn', Polygon: 'drawPolygonBtn', Rectangle: 'drawRectBtn', Circle: 'drawCircleBtn', CircleMarker: 'drawCircleMarkerBtn', Label: 'drawLabelBtn' };
const SHAPE_LABEL = { Marker: 'Marker', Line: 'Line', Polygon: 'Polygon', Rectangle: 'Rectangle', Circle: 'Circle', CircleMarker: 'Circle marker', Label: 'Text' };
const MODE_BTN_ID = { edit: 'drawEditBtn', drag: 'drawDragBtn', rotate: 'drawRotateBtn', remove: 'drawRemoveBtn' };

let activeShape = null;
let activeEditMode = null;

/** Default per-shape style, matching the app's orange/navy brand palette. */
function defaultGeomStyle() { return { fillColor: '#FF7A1A', borderColor: '#0A1E3C', borderWidth: 3, fillOpacity: 0.25, lineStyle: 'solid', corner: 'round', fillPattern: 'none', labelSize: 15, labelBold: true, showLabel: false, glow: false, markerStyle: 'dot', captionSize: 11 }; }

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
  const style = geomMarkerStyle(g);
  if (style === 'pin') return geomPinIcon(g);
  if (style === 'square') return geomSquareIcon(g);
  return L.divIcon({
    className: 'geom-marker-dot',
    html: `<span style="display:block;width:100%;height:100%;border-radius:50%;background:${g.fillColor};opacity:${g.fillOpacity};border:${g.borderWidth}px solid ${g.borderColor};box-shadow:0 1px 4px rgba(0,0,0,.4);"></span>`,
    iconSize: [22, 22], iconAnchor: [11, 11],
  });
}

/**
 * How a point shape is drawn: 'dot', 'pin' or 'square'.
 *
 * `pin` was a boolean for about an hour before towers proved three kinds were
 * needed. Read here rather than at each call site so the old field keeps
 * working in anything already saved with it.
 *
 * @param {object} g @returns {string}
 */
function geomMarkerStyle(g) {
  if (g.markerStyle) return g.markerStyle;
  return g.pin ? 'pin' : 'dot';
}

/**
 * A small square, for a structure that repeats along a line.
 *
 * A ring scan over a transmission corridor returns a tower every few hundred
 * metres — hundreds of them — and a teardrop pin each, captioned "Transmission
 * towers" each, buries the map completely: the thing the reader needs to see is
 * the CORRIDOR, and the pins hide the very line they are strung along.
 *
 * A square says "a structure is here" without claiming to be a destination, and
 * at 9px it reads as a row of beads following the line rather than as a wall of
 * markers. This is the conventional treatment on a utility plan for the same
 * reason. Centred on its coordinate rather than anchored at a tip, because a
 * square marks a footprint and does not point at anything.
 *
 * @param {object} g @returns {L.DivIcon}
 */
function geomSquareIcon(g) {
  const w = Math.max(1, Math.min(3, g.borderWidth == null ? 1.5 : g.borderWidth * 0.5));
  return L.divIcon({
    className: 'geom-marker-square',
    html: '<span style="display:block;width:100%;height:100%;border-radius:2px;'
      + 'background:' + g.fillColor + ';border:' + w + 'px solid ' + g.borderColor + ';'
      + 'box-shadow:0 1px 3px rgba(0,0,0,.45)"></span>',
    iconSize: [9, 9], iconAnchor: [4.5, 4.5],
  });
}

/**
 * A teardrop pin, for a point that marks a *place* rather than a measurement.
 *
 * A dot says "this coordinate"; a pin says "this thing is here", which is what
 * a scanned metro station or a nearby hospital actually is. The ring scan used
 * to drop plain circles for them, and on a busy ground they read as part of the
 * cartography rather than as something somebody put on the map.
 *
 * Deliberately the same silhouette as a location's own marker
 * (map/billboard.js drives those, and `pinTeardropSvg` is shared with it), so a
 * map does not have two unrelated visual languages for "a place". The
 * difference is only what they are for: locations are the sites the map is
 * about and carry routes and distances; these are context, and live in Draw
 * where they can be restyled, renamed or deleted like anything else drawn.
 *
 * Anchored at the tip — a pin points at its coordinate, it does not sit
 * centred on it, and getting that wrong puts every station half a block north.
 *
 * @param {object} g @returns {L.DivIcon}
 */
function geomPinIcon(g) {
  const svg = (typeof pinTeardropSvg === 'function')
    ? pinTeardropSvg({ color: g.fillColor, iconBg: g.fillColor, iconBorderColor: g.borderColor, iconBorder: g.borderWidth })
    : '';

  // The symbol inside the head — a train for a railway station, a metro glyph
  // for a metro station. A ring scan knows exactly what it found, so a pin that
  // says only "something is here" is throwing that away: on a map with a
  // station, a bus terminal and a substation on it, identical teardrops make
  // the reader consult the legend for every one of them.
  //
  // White, and only white. `svgForKey`'s second argument is the fill and its
  // THIRD is an outline — passing a colour there gives a wireframe glyph, which
  // is the trap this codebase has already fallen into once. White on the class
  // colour is also what a location's pin does (billboard.js), so the two read
  // as one family.
  let glyph = '';
  if (g.iconKey && typeof svgForKey === 'function') {
    const box = (typeof PIN_HEAD_BOX !== 'undefined') ? PIN_HEAD_BOX
      : 'position:absolute;left:22.5%;top:13.75%;width:55%;height:41.25%;';
    glyph = '<span style="' + box + '">' + svgForKey(g.iconKey, '#FFFFFF') + '</span>';
  }

  return L.divIcon({
    className: 'geom-marker-pin',
    html: '<span style="position:relative;display:block;width:100%;height:100%;'
      + 'filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))">' + svg + glyph + '</span>',
    iconSize: [24, 32], iconAnchor: [12, 31],
  });
}

/** Re-apply a geometry's current style fields onto its live Leaflet layer, plus its optional glow halo and on-map label. @param {object} g */
function applyGeomStyle(g) {
  if (g.shape === 'Label') {
    g.layer.setIcon(geomTextIcon(g));
    // No glow, no name label: the shape *is* its name, and a second copy of it
    // floating beside the first is not a feature anyone asked for.
    return;
  }
  if (g.shape === 'Marker') {
    g.layer.setIcon(geomMarkerIcon(g));
  } else {
    const [cap, join] = GEOM_CAP[g.corner] || GEOM_CAP.round;
    g.layer.setStyle({
      color: g.borderColor, weight: g.borderWidth, fillColor: g.fillColor, fillOpacity: g.fillOpacity,
      dashArray: dashArrayFor(g.lineStyle, g.borderWidth), lineCap: cap, lineJoin: join,
    });
    // After setStyle, never before: Leaflet rewrites `fill` from fillColor on
    // every call, so a pattern applied first would be wiped by the next change
    // to anything at all.
    applyFillPatternTo(g.layer, g.fillPattern, g.fillColor);
  }
  ensureGeomShift(g);
  ensureGlow(g);
  ensureGeomLabel(g);
}

// ---------- sideways shift (two lines that share one alignment) ----------

/*
 * WHY THIS EXISTS. An elevated metro is mapped where it physically is: over
 * the road it flies over. Drawn, two lines a few metres apart are one line at
 * any zoom a connectivity sheet uses, so one covered the other completely and
 * only one of the two features was on the map.
 *
 * WHY PIXELS AND NOT METRES. A separation that reads has to be a separation
 * the reader can see, and that is a screen distance, not a ground distance.
 * Sixty metres is four pixels at 1:100000 and sixty pixels at 1:5000 — the
 * first is invisible, the second puts the metro in the next street. So the
 * shift is held in pixels and the coordinates are recomputed whenever the zoom
 * changes, which is what `offsetPx` on a route has always done (map/routes.js)
 * and is the same idea applied to a drawn shape.
 *
 * The shape keeps its real coordinates in `_baseLatLngs` and draws the shifted
 * ones. Everything that persists a shape — the saved file, the undo snapshot,
 * the measurement — reads the base, so what is stored is where the metro
 * actually is and the shift stays a property of the drawing.
 */

/** One step of separation, in screen pixels. Two 4px lines 7px apart leave 3px of air. */
const GEOM_SHIFT_STEP = 7;

/** A shape's real coordinates, whatever it is currently drawn at. @param {object} g */
function geomTrueLatLngs(g) {
  return g._baseLatLngs || latLngsToArrays(g.layer.getLatLngs());
}

/**
 * A polyline moved sideways by `px` screen pixels, perpendicular to itself.
 *
 * The normal at each point is averaged from the segments either side of it, so
 * the offset line turns corners with the original instead of tearing open at
 * them. A zero-length segment (two identical points, which OSM does contain)
 * reuses the last good normal rather than producing NaN and erasing the line.
 *
 * @param {Array<[number,number]>} coords @param {number} px
 * @returns {Array<[number,number]>}
 */
function geomOffsetLatLngs(coords, px) {
  if (!px || !coords || coords.length < 2) return coords;
  const pts = coords.map(c => map.latLngToLayerPoint(L.latLng(c[0], c[1])));
  const out = [];
  let lastNx = 0, lastNy = -1;
  for (let i = 0; i < pts.length; i++) {
    let dx = 0, dy = 0;
    if (i > 0) { dx += pts[i].x - pts[i - 1].x; dy += pts[i].y - pts[i - 1].y; }
    if (i < pts.length - 1) { dx += pts[i + 1].x - pts[i].x; dy += pts[i + 1].y - pts[i].y; }
    const len = Math.hypot(dx, dy);
    let nx, ny;
    if (len < 0.001) { nx = lastNx; ny = lastNy; }
    else { nx = -dy / len; ny = dx / len; lastNx = nx; lastNy = ny; }
    const ll = map.layerPointToLatLng(L.point(pts[i].x + nx * px, pts[i].y + ny * px));
    out.push([ll.lat, ll.lng]);
  }
  return out;
}

/**
 * Draw a line at its shift, or put it back if the shift has been turned off.
 * Called from applyGeomStyle, so nothing has to remember to call it.
 * @param {object} g
 */
function ensureGeomShift(g) {
  if (g.shape !== 'Line') return;
  if (!g.shiftPx) {
    if (g._baseLatLngs) { g.layer.setLatLngs(g._baseLatLngs); g._baseLatLngs = null; }
    return;
  }
  if (!g._baseLatLngs) g._baseLatLngs = latLngsToArrays(g.layer.getLatLngs());
  g.layer.setLatLngs(geomOffsetLatLngs(g._baseLatLngs, g.shiftPx));
}

/**
 * Recompute every shifted line for the zoom now on screen.
 *
 * A pixel separation is only a pixel separation at one zoom; without this the
 * shift is baked in at whatever zoom the shape was added at, and zooming in
 * walks the metro off the road it is meant to run beside.
 */
function refreshGeomShifts() {
  if (typeof geometries === 'undefined') return;
  geometries.forEach(g => {
    if (!g.shiftPx || g.shape !== 'Line' || !g._baseLatLngs) return;
    g.layer.setLatLngs(geomOffsetLatLngs(g._baseLatLngs, g.shiftPx));
    if (g.glowLayer) syncGlowGeometry(g);
    if (g._labelEl) g.anchor = geomLabelLatLng(g);
  });
}

// `viewreset` as well as `zoomend`: a basemap change or a container resize
// rebuilds the layer points without ever firing a zoom event.
map.on('zoomend viewreset', refreshGeomShifts);

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
  // A LINE IS TIED SOMEWHERE ALONG ITSELF, not to the middle of its bounding
  // box. For anything but a straight line those are different points, and for
  // a road that bends round a hill the box centre is off the road entirely —
  // so the leader line pointed at open ground beside the thing it named.
  if (g.shape === 'Line') {
    try {
      let lls = g.layer.getLatLngs();
      if (Array.isArray(lls[0])) lls = lls[0];
      const at = routeAnchorAt(lls.map(ll => [ll.lat, ll.lng]),
        g.labelPos == null ? 0.5 : g.labelPos);
      if (at) return at;
    } catch (e) { /* fall through to the bounds centre */ }
  }
  // An area is tied inside itself for the same reason a scanned parcel is
  // pinned inside itself: the centre of an L-shaped zone's bounding box is in
  // the notch, which is a different piece of land.
  if ((g.shape === 'Polygon' || g.shape === 'Rectangle')
    && typeof ringInteriorPoint === 'function') {
    try {
      let lls = g.layer.getLatLngs();
      while (Array.isArray(lls[0]) && Array.isArray(lls[0][0])) lls = lls[0];
      if (Array.isArray(lls) && lls.length > 2 && lls[0] && lls[0].lat != null) {
        const at = ringInteriorPoint(lls.map(ll => [ll.lat, ll.lng]));
        if (at) return L.latLng(at.lat, at.lng);
      }
    } catch (e) { /* fall through */ }
  }
  try { return g.layer.getBounds ? g.layer.getBounds().getCenter() : g.layer.getLatLng(); }
  catch (e) { return g.layer.getLatLng ? g.layer.getLatLng() : map.getCenter(); }
}

/**
 * Where a shape's label sits before anybody moves it.
 *
 * A pin is anchored at its tip and stands 32px above it, so a box centred on
 * the same coordinate lands across the pin's head and hides the thing it is
 * naming. Everything else is offset up and to the right, the way a route's is,
 * so the leader line has somewhere to go.
 */
function defaultGeomLabelOffset(g) {
  return (g.shape === 'Marker' && geomMarkerStyle(g) === 'pin')
    ? { x: 0, y: -52 }
    : { x: 16, y: -30 };
}

/**
 * A shape's name, on the map, as a label you can pick up and move.
 *
 * IT USED TO BE A LEAFLET divIcon PINNED TO THE SHAPE'S CENTRE, and
 * `interactive: false` — so a road's name sat wherever the geometry put it,
 * on top of the road itself or over the next label along, and there was no
 * way at all to move it. On a sheet with a dozen scanned roads that is a dozen
 * names nobody can arrange.
 *
 * It is the same label a location and a route already use now: dragged, tied
 * back to its shape by a leader line, and for a line re-tied to the nearest
 * point on the line as it moves, so the tie-point slides along the road while
 * the box stays where it was dropped. None of that is new code — it is the one
 * implementation in map/billboard.js, which is why a second copy of it was
 * never worth writing.
 *
 * @param {object} g
 */
function ensureGeomLabel(g) {
  const gone = () => { if (g._labelEl) { removeBB(g._labelEl); g._labelEl = null; g._el = null; } };
  if (g._hidden || !g.showLabel || !g.name) { gone(); return; }
  if (typeof makeLabelEl !== 'function') return;   // billboard not wired yet

  if (!g.labelOffset) g.labelOffset = defaultGeomLabelOffset(g);
  // `captionSize` is an ABSOLUTE size in px and stays one. The billboard sizes
  // its labels by percentage, and routing the number through that would have
  // turned "17px" into "155% of whatever the chip font is" — a control that
  // says px and no longer means px. The percentage drives the padding, so the
  // box still grows with the type, and the type itself is set in px below.
  const cap = +g.captionSize > 0 ? +g.captionSize : 11;
  g.labelScale = Math.round(cap / 11 * 100);
  g.anchor = geomLabelLatLng(g);

  gone();
  const el = makeLabelEl(g, 'geom', {
    klass: 'geom', bg: '#FFFFFF', color: textOn('#FFFFFF'), text: g.name,
  });
  g._labelEl = el;
  g._el = el.firstChild;
  if (g._el) g._el.style.fontSize = cap + 'px';
  g._leaderColor = g.borderColor;
  if (g.shape === 'Line') {
    g.onLabelDragStart = () => cacheRouteLabelDrag(g);
    g.onLabelDrag = () => reanchorRouteLabel(g);
    g.onLabelDragEnd = () => endRouteLabelDrag(g);
  } else {
    g.onLabelDragStart = null; g.onLabelDrag = null; g.onLabelDragEnd = null;
  }
  g.onLabelDblclick = () => {
    const v = prompt('Label for this shape:', g.name || '');
    if (v !== null && v.trim()) { g.name = v.trim(); renameGeomCard(g); applyGeomStyle(g); }
  };
  if (typeof scheduleRepaint === 'function') scheduleRepaint();
}

/** Keep the sidebar card's title in step when a label is renamed on the map. @param {object} g */
function renameGeomCard(g) {
  if (!g.card) return;
  const t = g.card.querySelector('.gnm');
  if (t) { if ('value' in t) t.value = g.name; else t.textContent = g.name; }
}

/**
 * Live distance/perimeter/area text for a shape's current geometry.
 * @param {string} shape @param {L.Layer} layer @returns {{text:string}}
 */
function measureForLayer(shape, layer) {
  try {
    if (shape === 'Marker' || shape === 'CircleMarker' || shape === 'Label') {
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
  // Measured on the real line. A parallel curve is longer than the curve it
  // was offset from, so measuring the drawn one reports a road that is a few
  // per cent longer than it is — a number somebody puts in front of a client.
  const m = (g._baseLatLngs && g.shape === 'Line')
    ? measureForLayer('Line', L.polyline(g._baseLatLngs))
    : measureForLayer(g.shape, g.layer);
  g.measureText = m.text;
  if (g.card) { const el = g.card.querySelector('.geom-measure'); if (el) el.textContent = m.text; }
  if (g.glowLayer) syncGlowGeometry(g);
  // Re-tied as the shape is reshaped, so a label does not stay pointing at
  // where a vertex used to be. `labelPos` is a fraction of the line's length,
  // so it survives the line getting longer or shorter.
  if (g._labelEl) { g.anchor = geomLabelLatLng(g); if (typeof scheduleRepaint === 'function') scheduleRepaint(); }
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
function touchGeom(g) {
  g.modifiedAt = new Date().toISOString();
  refreshGeomCardMeta(g);
  // Recolouring one shape from its own card can create, empty or move a colour
  // group. Deferred so a batch edit repaints once at the end rather than once
  // per shape in it.
  if (typeof scheduleGeomGroups === 'function') scheduleGeomGroups();
}

let _geomGroupsTimer = null;
/** Coalesce swatch rebuilds to one per frame-ish. */
function scheduleGeomGroups() {
  if (_geomGroupsTimer) return;
  _geomGroupsTimer = setTimeout(() => {
    _geomGroupsTimer = null;
    if (typeof renderGeomGroups === 'function') renderGeomGroups();
    // The legend describes the colours on the map, so recolouring a shape
    // changes it. Rebuilt here rather than at every call site because this is
    // already the one deferred point every restyle funnels through — and
    // because a legend that still shows the colour a shape USED to be is worse
    // than no legend: the reader trusts it and is told the wrong thing.
    if (typeof rebuildLegend === 'function') rebuildLegend();
  }, 60);
}

function syncGeomEmpty() {
  $('geomEmpty').style.display = geometries.length ? 'none' : '';
  // The one place every add and remove already funnels through, so the colour
  // swatches cannot drift out of step with the shapes they describe.
  if (typeof renderGeomGroups === 'function') renderGeomGroups();
}

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
  if (shape === 'Marker' || shape === 'CircleMarker' || shape === 'Label') { const ll = layer.getLatLng(); return { lat: ll.lat, lng: ll.lng }; }
  if (shape === 'Circle') { const ll = layer.getLatLng(); return { lat: ll.lat, lng: ll.lng, radius: layer.getRadius() }; }
  if (shape === 'Rectangle') { const b = layer.getBounds(); return { bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]] }; }
  // Nesting is preserved rather than flattened to the first ring. Leaflet's
  // getLatLngs is [pt..] for a line, [[ring]] for a polygon, [[outer],[hole]]
  // with holes, and [[[outer]],[[outer2]]] for a multipolygon — and
  // `ring = ring[0]` threw away every hole and every part but the first, so
  // one undo turned a forest with a lake into a forest, and 24 merged
  // buildings into 1. L.polygon accepts all four depths, so round-tripping the
  // real structure needs nothing else.
  return { latlngs: latLngsToArrays(layer.getLatLngs()) };
}

/**
 * LatLng objects to plain [lat,lng] arrays, at whatever nesting depth.
 * @param {*} v @returns {*}
 */
function latLngsToArrays(v) {
  return Array.isArray(v) ? v.map(latLngsToArrays) : [v.lat, v.lng];
}

/** Build a fresh, unattached Leaflet layer from extractGeomCoords() output. @param {string} shape @param {object} geom */
function layerFromGeom(shape, geom) {
  // The icon is left blank here and written by applyGeomStyle(), which every
  // caller runs immediately after — the text and its styling live on the
  // geometry record, not in the coordinates this rebuilds from.
  if (shape === 'Label') return L.marker([geom.lat, geom.lng], { icon: L.divIcon({ className: 'map-text-wrap', html: '', iconSize: [0, 0] }) });
  if (shape === 'Marker') return L.marker([geom.lat, geom.lng]);
  if (shape === 'CircleMarker') return L.circleMarker([geom.lat, geom.lng], { radius: 8 });
  if (shape === 'Circle') return L.circle([geom.lat, geom.lng], { radius: geom.radius });
  if (shape === 'Rectangle') return L.rectangle(geom.bounds);
  if (shape === 'Line') return L.polyline(geom.latlngs);
  return L.polygon(geom.latlngs);
}

/** Reposition a geometry's existing layer in place to match a snapshot's coordinates (keeps the same layer instance/listeners). @param {object} g @param {object} geom */
function applyGeomCoords(g, geom) {
  if (g.shape === 'Marker' || g.shape === 'CircleMarker' || g.shape === 'Label') g.layer.setLatLng([geom.lat, geom.lng]);
  else if (g.shape === 'Circle') { g.layer.setLatLng([geom.lat, geom.lng]); g.layer.setRadius(geom.radius); }
  else if (g.shape === 'Rectangle') g.layer.setBounds(geom.bounds);
  // A snapshot holds where the line really is. For a shifted line that is the
  // base, and the drawn position is derived from it — writing the snapshot
  // straight onto the layer would make the shifted position the new truth.
  else if (g.shiftPx && g.shape === 'Line') { g._baseLatLngs = geom.latlngs; ensureGeomShift(g); }
  else g.layer.setLatLngs(geom.latlngs);
}

/** Full undo/redo-able snapshot of a geometry: style + metadata + coordinates. @param {object} g */
function snapshotGeom(g) {
  return {
    id: g.id, shape: g.shape, name: g.name, description: g.description, notes: g.notes,
    fillColor: g.fillColor, borderColor: g.borderColor, borderWidth: g.borderWidth, fillOpacity: g.fillOpacity,
    lineStyle: g.lineStyle, corner: g.corner, fillPattern: g.fillPattern,
    labelSize: g.labelSize, labelBold: g.labelBold, labelStyle: g.labelStyle, labelAngle: g.labelAngle,
    showLabel: g.showLabel, glow: g.glow, markerStyle: g.markerStyle, iconKey: g.iconKey, captionSize: g.captionSize,
    labelOffset: g.labelOffset && { x: g.labelOffset.x, y: g.labelOffset.y },
    labelPinned: g.labelPinned, labelPos: g.labelPos,
    // Same reason as the GeoJSON properties: restore the look without the
    // class and an undone shape is unclassed, so it drops out of the colour key
    // and the standard stops owning it.
    cls: g.cls, proposed: g.proposed, fromRing: g.fromRing, overRoad: g.overRoad,
    // Where a converted contour came from, so an undone delete is still one.
    fromContour: g.fromContour, contourLevel: g.contourLevel, contourMapId: g.contourMapId,
    // Sideways shift included, and the coordinates taken from the base rather
    // than the drawn line — restoring a shifted line from its drawn position
    // and then shifting it again walks it one step further off every undo.
    shiftPx: g.shiftPx,
    createdAt: g.createdAt,
    geom: g._baseLatLngs ? { latlngs: g._baseLatLngs } : extractGeomCoords(g.shape, g.layer),
  };
}

// ---------- create / delete / history ----------

/* Undo moved out of this file and up a level — see project/history.js.
   It used to be a drawing feature that knew about creating, deleting and
   reshaping a geometry and nothing else, so dragging a pin or restyling a route
   was a one-way door. It is now one stack over the whole map, and these two
   names stay as shims because a dozen call sites here and in ui/geomGroups.js
   already say them, and because each of those sites marks a real "this action
   is finished" moment that is worth recording immediately rather than waiting
   for the watcher's next tick. */

function updateUndoRedoButtons() {
  if (typeof historyUpdateButtons === 'function') historyUpdateButtons();
}

/** @param {object} [entry] ignored — kept so existing call sites read the same */
function pushUndo(entry) {
  if (typeof historyCommit === 'function') historyCommit();
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
    // DRAGGING A SHIFTED LINE BAKES ITS SHIFT IN. What somebody drags is what
    // they meant to place, and a line that sprang 7px sideways the moment they
    // let go of it would be a shape fighting its own editor. The separation is
    // theirs to keep or remove from here.
    if (g.shiftPx && g._baseLatLngs) {
      g._baseLatLngs = null;
      g.shiftPx = 0;
      g.overRoad = false;
    }
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
  // A label has no vertices to drag. Double-clicking one should do the thing
  // it obviously means: put the caret in the text.
  if (g.shape === 'Label') {
    if (typeof focusTextLabelField === 'function') focusTextLabelField(g);
    return;
  }
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
  if (g._labelEl) { removeBB(g._labelEl); g._labelEl = null; g._el = null; }
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
    if (g._labelEl) { removeBB(g._labelEl); g._labelEl = null; g._el = null; }
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
    lineStyle: snap.lineStyle, corner: snap.corner, fillPattern: snap.fillPattern,
    labelSize: snap.labelSize, labelBold: snap.labelBold,
    labelStyle: snap.labelStyle, labelAngle: snap.labelAngle,
    showLabel: snap.showLabel, glow: snap.glow, markerStyle: snap.markerStyle, iconKey: snap.iconKey, captionSize: snap.captionSize,
    // Provenance, not styling — and it was being dropped. snapshotGeom has
    // stored `cls` since the colour key was built, with a comment saying why:
    // a shape restored without its class still LOOKS right, because the colours
    // are saved separately, but belongs to no class, so it falls out of the
    // colour key and the connectivity standard stops owning it. The snapshot
    // carried it and this function quietly did not pass it on, so every undone
    // delete unclassed the shape it brought back. `fromRing` and `fromContour`
    // are the same kind of fact and were lost the same way.
    cls: snap.cls, proposed: snap.proposed, fromRing: snap.fromRing,
    fromContour: snap.fromContour, contourLevel: snap.contourLevel, contourMapId: snap.contourMapId,
    createdAt: snap.createdAt,
  });
}

/** Put one geometry back to a snapshot. @param {number} id @param {object} snap */
function restoreGeomSnapshot(id, snap) {
  const g = geomById(id);
  if (!g) return;
  applyGeomCoords(g, snap.geom);
  g.fillColor = snap.fillColor; g.borderColor = snap.borderColor; g.borderWidth = snap.borderWidth; g.fillOpacity = snap.fillOpacity;
  g.lineStyle = snap.lineStyle; g.corner = snap.corner; g.fillPattern = snap.fillPattern;
  g.labelSize = snap.labelSize; g.labelBold = snap.labelBold;
  g.labelStyle = snap.labelStyle; g.labelAngle = snap.labelAngle;
  g.showLabel = snap.showLabel; g.glow = snap.glow; g.markerStyle = snap.markerStyle;
  g.iconKey = snap.iconKey; g.captionSize = snap.captionSize;
  if (g.card) syncGeomCardStyleControls(g);
  applyGeomStyle(g);
  touchGeom(g);
  updateGeomMeasurement(g);
}

function applyHistoryEntry(entry, isUndo) {
  if (entry.type === 'create') { if (isUndo) removeGeomById(entry.snap.id); else recreateGeomFromSnapshot(entry.snap); }
  else if (entry.type === 'delete') { if (isUndo) recreateGeomFromSnapshot(entry.snap); else removeGeomById(entry.snap.id); }
  else if (entry.type === 'edit') {
    restoreGeomSnapshot(entry.id, isUndo ? entry.before : entry.after);
  } else if (entry.type === 'batch') {
    // Restyling a whole colour group is one action to the person who did it,
    // so it is one entry here. Undoing it shape by shape would mean pressing
    // Undo forty times and watching the map change forty times to get back to
    // where they were one click ago.
    entry.edits.forEach(e => restoreGeomSnapshot(e.id, isUndo ? e.before : e.after));
    if (typeof renderGeomGroups === 'function') renderGeomGroups();
  } else if (entry.type === 'deleteMany') {
    // Deleting a whole colour group is one action for the same reason
    // restyling one is: somebody clicked once. Forty separate `delete` entries
    // would mean forty presses of Undo to get back, each one repainting the
    // map, and no way to tell where the group deletion started.
    if (isUndo) entry.snaps.forEach(s => recreateGeomFromSnapshot(s));
    else entry.snaps.forEach(s => removeGeomById(s.id));
    if (typeof renderGeomGroups === 'function') renderGeomGroups();
    if (typeof rebuildLegend === 'function') rebuildLegend();
  }
}

/* doUndo() and doRedo() now live in project/history.js and cover the whole map.
   applyHistoryEntry() and the per-geometry snapshot helpers above are kept:
   snapshotGeom() is still how geomGroups.js describes a batch, and
   recreateGeomFromSnapshot() is still how a shape is rebuilt. */

/** Remove every drawn/imported shape and reset history (used by "Open project"). */
function clearAllGeometries() {
  geometries.slice().forEach(g => {
    if (map.hasLayer(g.layer)) map.removeLayer(g.layer);
    if (g.glowLayer && map.hasLayer(g.glowLayer)) map.removeLayer(g.glowLayer);
    if (g._labelEl) { removeBB(g._labelEl); g._labelEl = null; g._el = null; }
    if (g.card && g.card.parentNode) g.card.parentNode.removeChild(g.card);
  });
  geometries.length = 0;
  undoStack.length = 0; redoStack.length = 0;
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
  // Geoman has no text tool, so this one is ours. Handed over before any of
  // Geoman's state is touched, since there is nothing of Geoman's to set up.
  if (shape === 'Label') {
    if (activeShape) { map.pm.disableDraw(); activeShape = null; }
    GEOM_SHAPES.forEach(s2 => { const b2 = $(SHAPE_BTN_ID[s2]); if (b2 && s2 !== 'Label') b2.classList.remove('toggled'); });
    if (typeof setTextLabelPlacing === 'function') setTextLabelPlacing(!textLabelPlacing);
    return;
  }
  if (typeof setTextLabelPlacing === 'function' && typeof textLabelPlacing !== 'undefined' && textLabelPlacing) {
    setTextLabelPlacing(false);
  }
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
// Wrapped rather than passed by reference: doUndo/doRedo moved to
// project/history.js, which loads after this file, so naming them here at load
// time threw a ReferenceError — and that abandoned the rest of this file's
// top-level wiring with it. An arrow resolves them at click time instead.
$('drawUndoBtn').addEventListener('click', () => doUndo());
$('drawRedoBtn').addEventListener('click', () => doRedo());
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
  // Undo is deliberately NOT gated on `typing`. Everywhere else that guard is
  // right — single-key shortcuts must not fire mid-word — but Ctrl+Z inside a
  // text field is the browser's own undo for that field, and a name typed into
  // a card is exactly the kind of change people expect Ctrl+Z to take back.
  // The browser still handles it first while a field has an edit of its own to
  // undo; this catches it once that runs out.
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
  else if ((e.ctrlKey || e.metaKey) && key === 'y') { e.preventDefault(); doRedo(); }
  if (typing) return;
});
