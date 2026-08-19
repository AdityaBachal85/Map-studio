/**
 * map/contourMap.js — the contour map's state, and the pipeline that builds it.
 *
 * One place holds what the operator asked for (contourState) and one place
 * holds what the renderer draws (contourModel). Everything else — the panel,
 * the legend card, the 3D view, the export — reads those two rather than
 * keeping a copy, so there is never a moment where the legend is describing a
 * map that has already changed underneath it.
 *
 * THE PIPELINE, and why it is split into three:
 *
 *   fetch   elevation tiles -> one grid of metres        (slow: network)
 *   lines   grid -> isolines -> smoothed -> lat/lng      (medium: arithmetic)
 *   fill    grid -> one RGBA image                       (fast)
 *
 * Changing the colour ramp must not re-download a DEM, and changing the
 * contour interval must not either. So each stage caches its output and each
 * control declares the deepest stage it invalidates. That is the difference
 * between a ramp picker that feels instant and one that spends four seconds on
 * the network to repaint the same numbers in different colours.
 */

/** Intervals offered per unit. Metres and feet both land on round numbers. */
const CONTOUR_INTERVALS_M = [1, 2, 5, 10, 20, 25, 50, 100, 250, 500];
const CONTOUR_INTERVALS_FT = [5, 10, 20, 25, 50, 100, 250, 500, 1000, 2000];
const FT_PER_M = 3.280839895;

/** Beyond this many contour lines the map is solid ink and the browser crawls. */
const CONTOUR_MAX_LEVELS = 260;
/** Shortest contour worth drawing, in grid samples — below this it is DEM noise. */
const CONTOUR_MIN_LENGTH = 3;
/** Simplification tolerance, in grid samples. A quarter of a sample is invisible. */
const CONTOUR_SIMPLIFY = 0.25;

const CONTOUR_SMOOTHING = { none: 0, light: 1, medium: 2, heavy: 3 };

/**
 * The settings a new contour map starts with.
 *
 * A template rather than the live object: there are several contour maps on a
 * project now, each with its own area and its own interval, so "the settings"
 * is a property of a map rather than of the app.
 */
const CONTOUR_DEFAULTS = {
  visible: true,
  area: null,            // [{lat,lng}, ...] the selection ring
  areaShape: 'Rectangle',
  interval: 5,           // in `unit`
  unit: 'm',
  ramp: 'rainbow',
  boldEvery: 5,          // 1 = every line bold; 0 = none
  labels: 'bold',        // 'off' | 'bold' | 'all'
  smoothing: 'light',
  detail: 'standard',
  fillOpacity: 0.78,
  shade: true,
  roads: 'off',          // 'off' | 'roads' | 'full'
  showOutline: true,
  // 1, not 1.5. An exaggerated default makes ground that is nearly flat look
  // like it rolls, and the operator has no way to know the view is lying to
  // them by half. Exaggeration is a deliberate choice for a presentation, not
  // something the map should do to you on the way in.
  exaggeration: 1,
};

/** A fresh render model — what the renderer draws for one contour map. */
function newContourModel() {
  return {
    ready: false,
    grid: null,
    ring: null,
    fillCanvas: null,
    lines: [],
    osm: [],
    min: 0, max: 0,
    labels: 'bold',
    fillOpacity: 0.78,
    osmWeight: 1,
    lineColor: 'rgba(28,26,24,.62)',
    boldColor: 'rgba(20,18,16,.92)',
    lineWidth: 0.8,
    boldWidth: 1.5,
    labelHalo: 'rgba(255,255,255,.9)',
    showOutline: true,
    outlineColor: 'rgba(255,122,26,.95)',
    visible: true,
  };
}

/**
 * Every contour map on this project.
 *
 * IT USED TO BE ONE. Drawing a second study area silently replaced the first,
 * which is not a limitation anybody would choose — a site has a plot and its
 * catchment, or two plots being compared, and both want contours. Each entry
 * owns its own settings and its own render model, so they are independent all
 * the way down: different intervals, different ramps, different detail.
 *
 * @type {Array<{id:string, name:string, settings:object, model:object}>}
 */
const contourMaps = [];
let activeContourId = null;
let contourSeq = 0;

/**
 * The ACTIVE map's settings and model.
 *
 * Deliberately `let` and deliberately the same objects the record holds, not
 * copies. Everything downstream — the panel, the renderer, the 3D drape — was
 * written against `contourState` and `contourModel` when there was one of each,
 * and all of it still reads correctly: those names now mean "the one being
 * edited". Selecting a different map repoints them. Copying instead would mean
 * every edit needing a write-back, and one missed write-back is a setting that
 * silently does not stick.
 */
let contourState = Object.assign({}, CONTOUR_DEFAULTS);
let contourModel = newContourModel();

let contourLayerRef = null;
let contourBusy = false;
let contourRebuildTimer = null;
/** Bumped on every generate so a slow fetch that has been superseded is dropped. */
let contourRun = 0;

/* ---------------------------------------------------------------------------
 * The collection
 * ------------------------------------------------------------------------- */

/** @param {string} id @returns {object|null} */
function contourMapById(id) {
  return contourMaps.find(m => m.id === id) || null;
}

/** The record currently being edited, or null before the first one exists. */
function activeContourMap() { return contourMapById(activeContourId); }

/** A name that is not already taken. */
function nextContourName() {
  let n = contourMaps.length + 1;
  const taken = new Set(contourMaps.map(m => m.name));
  while (taken.has('Contour ' + n)) n++;
  return 'Contour ' + n;
}

/**
 * Add a contour map and select it.
 *
 * New maps inherit the settings of the one being edited rather than the
 * factory defaults: somebody drawing a second area almost always wants it at
 * the same interval and in the same colours as the first, and having to set
 * all nine controls again for every area is how a feature stops being used.
 * The area itself is not inherited — that is the one thing that differs.
 *
 * @param {object} [o] `{name, settings}`
 * @returns {object} the new record
 */
function addContourMap(o) {
  const opts = o || {};
  const base = opts.settings
    || (activeContourMap() ? activeContourMap().settings : CONTOUR_DEFAULTS);
  const settings = Object.assign({}, CONTOUR_DEFAULTS, base, { area: null, visible: true });

  const rec = {
    id: 'cm' + (++contourSeq),
    name: opts.name || nextContourName(),
    settings,
    model: newContourModel(),
  };
  contourMaps.push(rec);
  selectContourMap(rec.id);
  return rec;
}

/** Make `contourState` and `contourModel` point at this map. @param {string} id */
function selectContourMap(id) {
  const rec = contourMapById(id);
  if (!rec) return;
  activeContourId = rec.id;
  contourState = rec.settings;
  contourModel = rec.model;
  if (typeof renderContourPanel === 'function') renderContourPanel();
  if (typeof renderContourLegend === 'function') renderContourLegend();
}

/**
 * There is always something to edit.
 *
 * The panel has nine controls and a Draw button, and they have to write
 * somewhere before the first area is chosen. An empty first map is simpler than
 * a draft state that has to be promoted into a real one later.
 */
function ensureContourMap() {
  if (!activeContourMap()) {
    if (contourMaps.length) selectContourMap(contourMaps[0].id);
    else addContourMap();
  }
  return activeContourMap();
}

/** Every map with something drawn and showing. */
function visibleContourModels() {
  return contourMaps.filter(m => m.model.ready && m.settings.visible !== false).map(m => m.model);
}

/** Is anything drawn at all? */
function anyContourReady() { return contourMaps.some(m => m.model.ready); }

/**
 * Delete one contour map.
 *
 * Returns what it removed so the caller can offer an Undo — the house rule is
 * a reversal rather than a confirmation, and a contour map costs a network
 * round trip to rebuild.
 *
 * @param {string} id @returns {object|null} `{rec, index, geoms}`
 */
function deleteContourMap(id) {
  const i = contourMaps.findIndex(m => m.id === id);
  if (i < 0) return null;
  const rec = contourMaps[i];
  const geoms = removeContourGeoms(rec.id);
  contourMaps.splice(i, 1);

  if (activeContourId === rec.id) {
    activeContourId = null;
    if (contourMaps.length) selectContourMap(contourMaps[Math.max(0, i - 1)].id);
    else ensureContourMap();
  }
  contourRefresh();
  if (typeof renderContourPanel === 'function') renderContourPanel();
  return { rec, index: i, geoms };
}

/** Put a deleted contour map back where it was. @param {object} undo */
function restoreContourMap(undo) {
  if (!undo || !undo.rec) return;
  contourMaps.splice(Math.min(undo.index, contourMaps.length), 0, undo.rec);
  (undo.geoms || []).forEach(sn => {
    if (typeof recreateGeomFromSnapshot === 'function') recreateGeomFromSnapshot(sn);
  });
  selectContourMap(undo.rec.id);
  contourRefresh();
}

/* ---------------------------------------------------------------------------
 * Units and labels
 * ------------------------------------------------------------------------- */

/** The chosen interval expressed in metres, which is what the DEM speaks. */
function contourIntervalMetres() {
  const v = contourState.interval;
  return contourState.unit === 'ft' ? v / FT_PER_M : v;
}

/** The intervals to offer for the current unit. */
function contourIntervalChoices() {
  return contourState.unit === 'ft' ? CONTOUR_INTERVALS_FT : CONTOUR_INTERVALS_M;
}

/**
 * A level's label, in the operator's unit.
 * Levels are multiples of the interval, so in feet they land on round feet and
 * this rounding never invents a number that is not on the scale.
 */
function contourLabelFor(metres) {
  return contourState.unit === 'ft'
    ? String(Math.round(metres * FT_PER_M))
    : String(Math.round(metres * 10) / 10).replace(/\.0$/, '');
}

/** A height for display, with its unit. */
function contourHeightText(metres) {
  if (!isFinite(metres)) return '—';
  return contourState.unit === 'ft'
    ? Math.round(metres * FT_PER_M) + ' ft'
    : Math.round(metres) + ' m';
}

/* ---------------------------------------------------------------------------
 * The selected area
 * ------------------------------------------------------------------------- */

/** @returns {{north,south,east,west}|null} */
function contourBounds() {
  const ring = contourState.area;
  if (!ring || ring.length < 3) return null;
  let north = -90, south = 90, east = -180, west = 180;
  ring.forEach(p => {
    if (p.lat > north) north = p.lat;
    if (p.lat < south) south = p.lat;
    if (p.lng > east) east = p.lng;
    if (p.lng < west) west = p.lng;
  });
  return { north, south, east, west };
}

/** Selected area in square metres, via the app's own geodesic helper. */
function contourAreaM2() {
  const ring = contourState.area;
  if (!ring || ring.length < 3 || typeof polygonAreaM2 !== 'function') return 0;
  return polygonAreaM2(ring);
}

/** Set the ACTIVE map's study area. @param {Array<{lat,lng}>} ring */
function setContourArea(ring, shape) {
  ensureContourMap();
  contourState.area = (ring || []).map(p => ({ lat: p.lat, lng: p.lng }));
  if (shape) contourState.areaShape = shape;
  contourModel.ring = contourState.area;
}

/** Take the current viewport as the study area, inset slightly from the edge. */
function contourAreaFromView() {
  if (typeof map === 'undefined') return;
  const b = map.getBounds().pad(-0.06);
  setContourArea([
    { lat: b.getNorth(), lng: b.getWest() },
    { lat: b.getNorth(), lng: b.getEast() },
    { lat: b.getSouth(), lng: b.getEast() },
    { lat: b.getSouth(), lng: b.getWest() },
  ], 'Rectangle');
}

/* ---------------------------------------------------------------------------
 * The layer
 * ------------------------------------------------------------------------- */

/**
 * The single layer that draws every contour map.
 *
 * One layer rather than one per map: they share a canvas, a projection and a
 * repaint, and N Leaflet layers would mean N canvases stacked over the same
 * ground, each clearing and redrawing on every frame of a pan.
 */
function contourLayer() {
  if (!contourLayerRef && typeof ContourLayer === 'function') {
    contourLayerRef = new ContourLayer();
  }
  return contourLayerRef;
}

/** Add or remove the layer according to whether anything wants drawing. */
function syncContourLayer() {
  const layer = contourLayer();
  if (!layer || typeof map === 'undefined') return;
  const wanted = visibleContourModels().length > 0;
  if (wanted && !map.hasLayer(layer)) layer.addTo(map);
  else if (!wanted && map.hasLayer(layer)) map.removeLayer(layer);
}

/** Show or hide one contour map. @param {string} id @param {boolean} on */
function setContourVisible(id, on) {
  const rec = contourMapById(id);
  if (!rec) return;
  rec.settings.visible = !!on;
  rec.model.visible = !!on;
  syncContourLayer();
  contourRefresh();
  if (typeof renderContourPanel === 'function') renderContourPanel();
}

/** Show or hide the map being edited, and build it if it has never been built. */
function setContourEnabled(on) {
  ensureContourMap();
  contourState.visible = !!on;
  contourModel.visible = !!on;
  syncContourLayer();
  // Not while one is already running: switching the layer on during a generate
  // would start a second pass over the same area, and the first would then be
  // discarded halfway through having already fetched its tiles.
  if (on && !contourModel.ready && contourState.area && !contourBusy) generateContours();
  if (typeof renderContourLegend === 'function') renderContourLegend();
}

function contourRefresh() {
  syncContourLayer();
  if (contourLayerRef) contourLayerRef.refresh();
  if (typeof renderContourLegend === 'function') renderContourLegend();
  if (typeof map3dRedrape === 'function') map3dRedrape();
}

/* ---------------------------------------------------------------------------
 * Stage 3 — the fill
 * ------------------------------------------------------------------------- */

/** Rebuild the hypsometric image from the cached grid. Cheap; no network. */
function contourBuildFill() {
  const g = contourModel.grid;
  if (!g) { contourModel.fillCanvas = null; return; }

  const ramp = contourRamp(contourState.ramp);
  const shade = contourState.shade
    ? hillshadeGrid(g, g.metresPerSample, 1.4)
    : null;
  const px = hypsoPixels(g, rampLut(ramp), {
    min: g.min, max: g.max, alpha: 1, shade, shadeStrength: 0.5,
  });

  const c = document.createElement('canvas');
  c.width = px.width; c.height = px.height;
  c.getContext('2d').putImageData(new ImageData(px.data, px.width, px.height), 0, 0);

  contourModel.fillCanvas = c;
  contourModel.fillOpacity = contourState.fillOpacity;
  contourModel.min = g.min;
  contourModel.max = g.max;
}

/* ---------------------------------------------------------------------------
 * Stage 2 — the lines
 * ------------------------------------------------------------------------- */

/**
 * Rebuild the contour lines from the cached grid.
 *
 * Grid coordinates become latitude and longitude here, once, rather than on
 * every frame — the renderer then only has to project, which Leaflet does with
 * a multiply. Latitude is the expensive half (an inverse hyperbolic sine per
 * point), so it is resolved through a per-row table and interpolated between
 * rows: over one sample the Mercator curve is straight to far below a pixel,
 * and a big selection is half a million points.
 */
function contourBuildLines() {
  const g = contourModel.grid;
  contourModel.lines = [];
  if (!g) return { levels: 0, lines: 0, capped: false };

  const step = contourIntervalMetres();
  const wanted = contourLevelCount(g.min, g.max, step);
  const levels = contourLevels(g.min, g.max, step, CONTOUR_MAX_LEVELS);
  const capped = wanted > levels.length;

  const iters = CONTOUR_SMOOTHING[contourState.smoothing] || 0;
  const bold = contourState.boldEvery;

  // Latitude per grid row, interpolated between rows for fractional y.
  const latRow = new Float64Array(g.h + 2);
  for (let y = 0; y <= g.h + 1; y++) latRow[y] = gridToLatLng(g, 0, y).lat;
  const lngAt = gx => gridToLatLng(g, gx, 0).lng;
  const latAt = gy => {
    const y0 = gy < 0 ? 0 : gy > g.h ? g.h : Math.floor(gy);
    const f = gy - y0;
    return latRow[y0] + (latRow[y0 + 1] - latRow[y0]) * f;
  };

  levels.forEach(level => {
    const idx = Math.round(level / step);
    const isBold = bold > 0 && idx % bold === 0;
    const label = contourLabelFor(level);

    isoLines(g, level).forEach(raw => {
      if (lineLength(raw) < CONTOUR_MIN_LENGTH) return;
      const shaped = simplifyLine(smoothLine(raw, iters), CONTOUR_SIMPLIFY);
      if (shaped.length < 2) return;
      const pts = new Array(shaped.length);
      for (let i = 0; i < shaped.length; i++) pts[i] = [latAt(shaped[i][1]), lngAt(shaped[i][0])];
      contourModel.lines.push({ level, bold: isBold, label, pts });
    });
  });

  contourModel.labels = contourState.labels;
  return { levels: levels.length, lines: contourModel.lines.length, capped, wanted };
}

/* ---------------------------------------------------------------------------
 * Stage 1 — the whole pipeline
 * ------------------------------------------------------------------------- */

/**
 * Build the contour map for the selected area.
 * @param {object} [o] `{silent}`
 * @returns {Promise<boolean>} whether anything was drawn
 */
async function generateContours(o) {
  const opts = o || {};
  const bounds = contourBounds();
  if (!bounds) {
    if (!opts.silent) status('Choose an area first — draw one on the map, or use the current view.');
    return false;
  }

  const run = ++contourRun;
  contourBusy = true;
  if (typeof renderContourPanel === 'function') renderContourPanel();
  if (!opts.silent) status('Reading elevation data…', true);

  const res = await fetchElevationGrid(bounds, { detail: contourState.detail });
  if (run !== contourRun) {
    // Superseded while we waited. The progress line above is sticky and this
    // run is the only thing that knows it put it there — the run that replaced
    // it may well be a silent one, which would never clear it.
    if (!opts.silent) status('');
    return false;
  }

  if (!res.ok) {
    contourBusy = false;
    contourModel.ready = false;
    contourRefresh();
    if (typeof renderContourPanel === 'function') renderContourPanel();
    status(elevationMessage(res.reason));
    return false;
  }

  contourModel.grid = res.grid;
  contourModel.ring = contourState.area;
  contourBuildFill();
  const built = contourBuildLines();
  contourApplyStyleState();
  contourModel.ready = true;
  contourBusy = false;

  const layer = contourLayer();
  syncContourLayer();
  contourRefresh();
  if (typeof renderContourPanel === 'function') renderContourPanel();

  if (!opts.silent) status(contourBuiltMessage(res.grid, built));

  // Roads come after the contours are already on screen: they are a second
  // network round trip, to a service that rate-limits, and there is no reason
  // to make the terrain wait for them.
  contourLoadOsm();
  return true;
}

/** The sentence that reports what was actually built. */
function contourBuiltMessage(grid, built) {
  const parts = [];
  parts.push(built.lines + ' contour' + (built.lines === 1 ? '' : 's')
    + ' at ' + contourState.interval + ' ' + contourState.unit);
  parts.push(contourHeightText(grid.min) + ' to ' + contourHeightText(grid.max));
  parts.push('~' + grid.metresPerSample.toFixed(1) + ' m per sample');
  let msg = parts.join(' · ') + '.';
  if (built.capped) {
    msg += ' Stopped at ' + CONTOUR_MAX_LEVELS + ' lines of ' + built.wanted
      + ' — widen the interval to see them all.';
  }
  if (grid.partial) msg += ' Some elevation tiles were unavailable.';
  return msg;
}

/** Plain language for a failed elevation fetch. */
function elevationMessage(reason) {
  if (reason === 'no-area') return 'Choose an area first.';
  if (reason === 'too-small') return 'That area is too small to contour — zoom out a little.';
  if (reason === 'no-tiles' || reason === 'no-data') {
    return 'No elevation data covers that area.';
  }
  return 'Could not read elevation data. Check the connection and try again.';
}

/** Fetch and attach the OpenStreetMap detail for the current area. */
async function contourLoadOsm() {
  const bounds = contourBounds();
  if (!bounds || contourState.roads === 'off') {
    contourModel.osm = [];
    contourRefresh();
    return;
  }
  const run = contourRun;
  const res = await fetchOsmDetail(bounds, contourState.roads);
  if (run !== contourRun) return;

  if (!res.ok) {
    contourModel.osm = [];
    contourRefresh();
    status(osmDetailMessage(res.reason));
    return;
  }
  contourModel.osm = res.features;
  contourRefresh();
  if (res.truncated) status('Roads shown are capped — OpenStreetMap returned more than fits.');
}

/* ---------------------------------------------------------------------------
 * Style + recompute policy
 * ------------------------------------------------------------------------- */

/** Push the purely cosmetic settings into the model. No recompute at all. */
function contourApplyStyleState() {
  contourModel.labels = contourState.labels;
  contourModel.fillOpacity = contourState.fillOpacity;
  contourModel.showOutline = contourState.showOutline;
  // Over a pale ramp a dark line reads; over the dark end of one it would
  // disappear, which is why the halo behind the labels is always light and the
  // lines themselves are ink rather than a ramp colour.
  contourModel.lineColor = 'rgba(28,26,24,.62)';
  contourModel.boldColor = 'rgba(20,18,16,.92)';
}

/**
 * Apply a change, doing only the work it actually invalidates.
 * @param {string} depth 'style' | 'fill' | 'lines' | 'all'
 */
function contourInvalidate(depth) {
  if (!contourModel.grid && depth !== 'all') { contourApplyStyleState(); contourRefresh(); return; }

  clearTimeout(contourRebuildTimer);
  contourRebuildTimer = setTimeout(() => {
    if (depth === 'all') { generateContours(); return; }
    if (depth === 'lines') contourBuildLines();
    if (depth === 'lines' || depth === 'fill') contourBuildFill();
    contourApplyStyleState();
    contourRefresh();
  // Style is instant; anything that recomputes waits for the slider to settle
  // rather than rebuilding on every pixel of the drag.
  }, depth === 'style' ? 0 : 140);
}

/* ---------------------------------------------------------------------------
 * Contours as editable shapes
 * ------------------------------------------------------------------------- */

/** How many shapes a conversion would create, at each scope. */
function contourShapeCounts() {
  const all = contourModel.lines.length;
  const bold = contourModel.lines.filter(l => l.bold).length;
  return { all, bold };
}

/**
 * Turn the drawn contours into real geometries — cards, styling, GeoJSON.
 *
 * Deliberately not the default way to use this feature. The rendered layer
 * draws ten thousand lines without noticing; ten thousand `geometries` entries
 * is ten thousand sidebar cards and a map that will not pan. So a conversion
 * large enough to hurt converts the bold contours only and says so, which is
 * the useful half of the answer anyway — the index contours are the ones worth
 * labelling, restyling and exporting.
 *
 * @param {string} [scope] 'auto' | 'all' | 'bold'
 */
function contoursToShapes(scope) {
  if (!contourModel.ready || !contourModel.lines.length) {
    status('Generate a contour map first.');
    return;
  }
  if (typeof registerGeom !== 'function') return;

  const counts = contourShapeCounts();
  let pick = scope || 'auto';
  let note = '';
  if (pick === 'auto') {
    pick = counts.all > 300 && counts.bold ? 'bold' : 'all';
    if (pick === 'bold') {
      note = ' Converted the ' + counts.bold + ' bold contours of ' + counts.all
        + ' — the rest would have made the sidebar unusable.';
    }
  }

  const lines = pick === 'bold' ? contourModel.lines.filter(l => l.bold) : contourModel.lines;
  if (!lines.length) { status('No contours in that selection.'); return; }

  const ramp = contourRamp(contourState.ramp);
  const span = (contourModel.max - contourModel.min) || 1;
  const made = [];

  lines.forEach(ln => {
    const layer = L.polyline(ln.pts.map(p => L.latLng(p[0], p[1])));
    const g = registerGeom(layer, 'Line', {
      // Tagged, because otherwise a converted contour is indistinguishable from
      // a line somebody drew by hand — and then nothing can clean them up.
      // Clearing the contour map used to leave every converted line behind,
      // one sidebar card each, with no way to tell which were which.
      fromContour: true,
      // Which map made it, so clearing one contour map takes only its own
      // shapes and leaves the other maps' alone.
      contourMapId: activeContourId,
      contourLevel: ln.level,
      name: contourLabelFor(ln.level) + ' ' + contourState.unit,
      // Coloured by its own height, so a converted set still reads as terrain
      // once the rendered layer underneath is switched off.
      borderColor: rampHexAt(ramp, (ln.level - contourModel.min) / span),
      borderWidth: ln.bold ? 2 : 1,
      description: 'Contour at ' + contourHeightText(ln.level),
    });
    made.push(g);
  });

  // One history entry for the whole conversion: it was one click, so it is one
  // press of Ctrl+Z. history.js snapshots the map, so nothing needs listing.
  if (typeof pushUndo === 'function') pushUndo();
  status(made.length + ' contour' + (made.length === 1 ? '' : 's') + ' converted to shapes.' + note);
}

/* ---------------------------------------------------------------------------
 * Persistence
 * ------------------------------------------------------------------------- */

/**
 * The settings worth saving — never the lines, which regenerate.
 *
 * The whole collection, because there are several contour maps on a project
 * now and each carries its own area and its own interval.
 */
function contourSettings() {
  return {
    activeId: activeContourId,
    maps: contourMaps.map(m => ({
      id: m.id,
      name: m.name,
      settings: Object.assign({}, m.settings),
    })),
  };
}

/**
 * Restore saved contour maps and rebuild the visible ones.
 *
 * The contours themselves are not in the project file. Half a million
 * coordinates would dwarf everything else in it, and they are derived data —
 * the same area at the same interval gives the same lines back for the cost of
 * one DEM read on open.
 *
 * Reads the OLD single-map shape too. Projects saved before contour maps could
 * be collected have their settings flat on the object rather than under
 * `maps`, and silently losing a saved contour map on upgrade would be a worse
 * bug than the one collections fixed.
 */
function applyContourSettings(s) {
  if (!s || typeof s !== 'object') return;

  contourMaps.length = 0;
  activeContourId = null;
  contourSeq = 0;

  const list = Array.isArray(s.maps) ? s.maps
    // The single-map shape: settings sat directly on the object.
    : (s.area || s.interval !== undefined) ? [{ name: 'Contour 1', settings: s }] : [];

  list.forEach(entry => {
    const rec = addContourMap({
      name: entry.name,
      settings: Object.assign({}, CONTOUR_DEFAULTS, entry.settings || {}),
    });
    // addContourMap clears the area deliberately — a NEW map should not inherit
    // one — so a restore has to put it back.
    rec.settings.area = (entry.settings && entry.settings.area) || null;
    // `on` was the old field for "is it showing".
    if (entry.settings && entry.settings.on !== undefined && entry.settings.visible === undefined) {
      rec.settings.visible = !!entry.settings.on;
    }
    rec.model.ring = rec.settings.area;
    rec.model.visible = rec.settings.visible !== false;
  });

  ensureContourMap();
  if (s.activeId && contourMapById(s.activeId)) selectContourMap(s.activeId);
  else if (contourMaps.length) selectContourMap(contourMaps[0].id);

  contourApplyStyleState();
  syncContourLayer();
  if (typeof renderContourPanel === 'function') renderContourPanel();

  // Rebuild every map that has an area, one at a time. In parallel they would
  // race each other for contourRun and all but the last would be discarded.
  (async () => {
    for (const rec of contourMaps.slice()) {
      if (!rec.settings.area) continue;
      selectContourMap(rec.id);
      await generateContours({ silent: true });
    }
    if (s.activeId && contourMapById(s.activeId)) selectContourMap(s.activeId);
  })();
}

/** Forget every contour map. Used when a project is closed or a new one opened. */
function clearContourMap() {
  contourRun++;
  contourMaps.length = 0;
  activeContourId = null;
  contourSeq = 0;
  contourState = Object.assign({}, CONTOUR_DEFAULTS);
  contourModel = newContourModel();
  ensureContourMap();
  if (contourLayerRef && typeof map !== 'undefined' && map.hasLayer(contourLayerRef)) {
    map.removeLayer(contourLayerRef);
  }
  if (typeof renderContourLegend === 'function') renderContourLegend();
  if (typeof renderContourPanel === 'function') renderContourPanel();
}

/**
 * Shapes that came from a contour conversion.
 * @param {string} [mapId] only this map's; omit for all of them.
 */
function contourDerivedGeoms(mapId) {
  if (typeof geometries === 'undefined') return [];
  return geometries.filter(g => g && g.fromContour
    && (!mapId || g.contourMapId === mapId
      // Shapes converted before contour maps could be told apart have no id.
      // They belong to whoever is clearing, rather than becoming unremovable.
      || g.contourMapId === undefined));
}

/**
 * Remove the shapes a conversion created.
 *
 * Snapshotted before anything is removed — removeGeomById drops the layer, and
 * a snapshot taken afterwards has no coordinates left to store. Same order, and
 * same reason, as geomGroupDelete().
 *
 * @param {string} [mapId] only this map's; omit for all of them.
 * @returns {Array<object>} snapshots, for the undo
 */
function removeContourGeoms(mapId) {
  const doomed = contourDerivedGeoms(mapId);
  if (!doomed.length) return [];
  const snaps = doomed.map(g => (typeof snapshotGeom === 'function' ? snapshotGeom(g) : null)).filter(Boolean);
  doomed.forEach(g => {
    if (typeof map !== 'undefined' && map.hasLayer(g.layer)) map.removeLayer(g.layer);
    if (typeof removeGeomById === 'function') removeGeomById(g.id);
  });
  if (typeof renderGeomGroups === 'function') renderGeomGroups();
  return snaps;
}


/* ---------------------------------------------------------------------------
 * The drape — the contour picture in the grid's own pixel space
 * ------------------------------------------------------------------------- */

/**
 * The drape's texture size along its longest edge.
 *
 * NOT the grid's own size, which is what this used to be. A 3.8 km selection
 * reads back as an 850-pixel grid; draped over terrain and looked at from a low
 * camera it covers well over two thousand screen pixels, so every contour was
 * magnified two and a half times — soft, fat, stair-stepped lines over a
 * blurred tint. Painting the same picture into a larger texture costs one
 * canvas and fixes all of it.
 */
const CONTOUR_DRAPE_TARGET_PX = 2048;

/** Contour line weights in TEXTURE pixels — see contourDrapeCanvas(). */
const CONTOUR_DRAPE_LINE_PX = 1.4;
const CONTOUR_DRAPE_BOLD_PX = 2.6;

/**
 * Render the contour map into a canvas to be draped over the terrain.
 *
 * The 2D layer draws through Leaflet's projection, which the 3D view does not
 * have: MapLibre drapes a flat image over the terrain mesh by its four corners.
 * Drawing in grid space instead makes the corners exactly the grid's corners,
 * so the picture lands on the ground it was computed from with no offset.
 *
 * SUPERSAMPLED. The grid is the resolution of the DATA, not of the picture, and
 * the two are not the same requirement: the fill is a smooth field that
 * upscales cleanly, but a contour line is a hairline that has to survive being
 * looked at from three metres above the ground. So the canvas is scaled up to
 * CONTOUR_DRAPE_TARGET_PX and the lines are drawn at a fixed width in TEXTURE
 * pixels — which makes them thinner relative to the ground the larger the
 * texture gets, exactly as a finer pen would be.
 *
 * Labels are deliberately absent. Text baked into a texture is stretched by
 * whatever the terrain does underneath it, and a contour label that is legible
 * on the flat and skewed on a slope is worse than no label at all.
 *
 * @returns {HTMLCanvasElement|null}
 */
function contourDrapeCanvas(model) {
  const mdl = model || contourModel;
  const g = mdl.grid;
  if (!mdl.ready || !g) return null;

  const cap = (typeof maxWebglDimension === 'function') ? maxWebglDimension() : 4096;
  const target = Math.min(CONTOUR_DRAPE_TARGET_PX, cap);
  // Never downscale below the data, and never upscale past what the GPU will
  // hold as one texture.
  const ss = Math.max(1, Math.min(4, target / Math.max(g.w, g.h)));
  const W = Math.max(1, Math.round(g.w * ss));
  const H = Math.max(1, Math.round(g.h * ss));

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  if (mdl.fillCanvas) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = mdl.fillOpacity == null ? 1 : mdl.fillOpacity;
    ctx.drawImage(mdl.fillCanvas, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  const toTex = p => {
    const q = latLngToGrid(g, p[0], p[1]);
    return [q.x * ss, q.y * ss];
  };

  const paint = (feats, kinds) => {
    if (!feats || !feats.length) return;
    kinds.forEach(kind => {
      const st = OSM_DETAIL_STYLE[kind];
      if (!st) return;
      let any = false;
      ctx.beginPath();
      feats.forEach(f => {
        if (f.cls !== kind) return;
        f.pts.forEach((p, i) => {
          const q = toTex(p);
          if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
        });
        if (f.closed || st.fill) ctx.closePath();
        any = true;
      });
      if (!any) return;
      if (st.fill) { ctx.fillStyle = st.fill; ctx.fill('evenodd'); }
      if (st.w > 0) {
        ctx.lineWidth = st.w;
        ctx.strokeStyle = st.color;
        ctx.setLineDash(st.dash || []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
  };

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  paint(mdl.osm, ['waterbody', 'building']);

  // Batched into one path per weight rather than one stroke per contour: a fine
  // interval is thousands of lines, and thousands of separate strokes is
  // thousands of state changes for a picture drawn in two colours.
  [false, true].forEach(bold => {
    let any = false;
    ctx.beginPath();
    mdl.lines.forEach(ln => {
      if (!!ln.bold !== bold) return;
      ln.pts.forEach((p, i) => {
        const q = toTex(p);
        if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
      });
      any = true;
    });
    if (!any) return;
    ctx.strokeStyle = bold ? mdl.boldColor : mdl.lineColor;
    ctx.lineWidth = bold ? CONTOUR_DRAPE_BOLD_PX : CONTOUR_DRAPE_LINE_PX;
    ctx.stroke();
  });

  paint(mdl.osm, ['water', 'motorway', 'trunk', 'primary', 'secondary',
    'tertiary', 'minor', 'rail']);

  return c;
}

/** One drape's four corners, in MapLibre's order: TL, TR, BR, BL. */
function contourDrapeCorners(model) {
  const g = (model || contourModel).grid;
  if (!g) return null;
  const c = (x, y) => { const p = gridToLatLng(g, x, y); return [p.lng, p.lat]; };
  return [c(0, 0), c(g.w, 0), c(g.w, g.h), c(0, g.h)];
}
