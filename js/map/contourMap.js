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

/** @type {object} what the operator asked for. */
const contourState = {
  on: false,
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
  mode: '2d',            // '2d' | '3d'
  exaggeration: 1.5,
};

/** @type {object} what the renderer draws. */
const contourModel = {
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
};

let contourLayerRef = null;
let contourBusy = false;
let contourRebuildTimer = null;
/** Bumped on every generate so a slow fetch that has been superseded is dropped. */
let contourRun = 0;

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

/** Set the study area from a ring of points. @param {Array<{lat,lng}>} ring */
function setContourArea(ring, shape) {
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

function contourLayer() {
  if (!contourLayerRef && typeof ContourLayer === 'function') {
    contourLayerRef = new ContourLayer(contourModel);
  }
  return contourLayerRef;
}

/** Put the contour map on the map, or take it off. @param {boolean} on */
function setContourEnabled(on) {
  contourState.on = !!on;
  const layer = contourLayer();
  if (!layer || typeof map === 'undefined') return;
  if (contourState.on) {
    if (!map.hasLayer(layer)) layer.addTo(map);
    // Not while one is already running: switching the layer on during a
    // generate would start a second pass over the same area, and the first
    // would then be discarded halfway through having already fetched its tiles.
    if (!contourModel.ready && contourState.area && !contourBusy) generateContours();
  } else if (map.hasLayer(layer)) {
    map.removeLayer(layer);
  }
  if (typeof renderContourLegend === 'function') renderContourLegend();
}

function contourRefresh() {
  if (contourLayerRef) contourLayerRef.refresh();
  if (typeof renderContourLegend === 'function') renderContourLegend();
  if (typeof contour3dRedrape === 'function') contour3dRedrape();
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
  if (layer && typeof map !== 'undefined' && !map.hasLayer(layer) && contourState.on) layer.addTo(map);
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

/** The settings worth saving — never the lines, which regenerate. */
function contourSettings() {
  return {
    on: contourState.on,
    area: contourState.area,
    areaShape: contourState.areaShape,
    interval: contourState.interval,
    unit: contourState.unit,
    ramp: contourState.ramp,
    boldEvery: contourState.boldEvery,
    labels: contourState.labels,
    smoothing: contourState.smoothing,
    detail: contourState.detail,
    fillOpacity: contourState.fillOpacity,
    shade: contourState.shade,
    roads: contourState.roads,
    showOutline: contourState.showOutline,
    exaggeration: contourState.exaggeration,
  };
}

/**
 * Restore saved settings and, if the map was on, rebuild it.
 *
 * The contours themselves are not in the project file. Half a million
 * coordinates would dwarf everything else in it, and they are derived data —
 * the same area at the same interval gives the same lines, and re-reading the
 * DEM costs a second against a file that stays small enough to email.
 */
function applyContourSettings(s) {
  if (!s || typeof s !== 'object') return;
  Object.keys(contourSettings()).forEach(k => {
    if (s[k] !== undefined) contourState[k] = s[k];
  });
  contourModel.ready = false;
  contourModel.grid = null;
  contourModel.lines = [];
  contourModel.osm = [];
  contourModel.ring = contourState.area;
  contourApplyStyleState();
  if (typeof renderContourPanel === 'function') renderContourPanel();
  if (contourState.on && contourState.area) {
    setContourEnabled(true);
    generateContours({ silent: true });
  } else {
    setContourEnabled(false);
  }
}

/** Forget everything. Used when a project is closed or a new one opened. */
function clearContourMap() {
  contourRun++;
  contourState.on = false;
  contourState.area = null;
  contourModel.ready = false;
  contourModel.grid = null;
  contourModel.lines = [];
  contourModel.osm = [];
  contourModel.ring = null;
  contourModel.fillCanvas = null;
  if (contourLayerRef && typeof map !== 'undefined' && map.hasLayer(contourLayerRef)) {
    map.removeLayer(contourLayerRef);
  }
  if (typeof renderContourLegend === 'function') renderContourLegend();
  if (typeof renderContourPanel === 'function') renderContourPanel();
}

/* ---------------------------------------------------------------------------
 * The drape — the contour picture in the grid's own pixel space
 * ------------------------------------------------------------------------- */

/**
 * Render the contour map into a canvas the exact size of the elevation grid.
 *
 * The 2D layer draws through Leaflet's projection, which the 3D view does not
 * have: MapLibre drapes a flat image over the terrain mesh by its four
 * corners. Drawing in grid space instead makes the corners exactly the grid's
 * corners, so the picture lands on the ground it was computed from with no
 * resampling and no offset.
 *
 * @returns {HTMLCanvasElement|null}
 */
function contourDrapeCanvas() {
  const g = contourModel.grid;
  if (!contourModel.ready || !g) return null;

  const c = document.createElement('canvas');
  c.width = g.w; c.height = g.h;
  const ctx = c.getContext('2d');

  if (contourModel.fillCanvas) {
    ctx.globalAlpha = contourModel.fillOpacity == null ? 1 : contourModel.fillOpacity;
    ctx.drawImage(contourModel.fillCanvas, 0, 0);
    ctx.globalAlpha = 1;
  }

  // Weights are in grid samples here, not screen pixels, so a line stays a
  // sensible thickness however far the 3D camera happens to be.
  const scale = Math.max(1, Math.min(3, g.w / 500));
  const toGrid = p => { const q = latLngToGrid(g, p[0], p[1]); return [q.x, q.y]; };

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
          const q = toGrid(p);
          if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
        });
        if (f.closed || st.fill) ctx.closePath();
        any = true;
      });
      if (!any) return;
      if (st.fill) { ctx.fillStyle = st.fill; ctx.fill('evenodd'); }
      if (st.w > 0) {
        ctx.lineWidth = st.w * scale;
        ctx.strokeStyle = st.color;
        ctx.setLineDash(st.dash || []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
  };

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  paint(contourModel.osm, ['waterbody', 'building']);

  contourModel.lines.forEach(ln => {
    ctx.beginPath();
    ln.pts.forEach((p, i) => {
      const q = toGrid(p);
      if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
    });
    ctx.strokeStyle = ln.bold ? contourModel.boldColor : contourModel.lineColor;
    ctx.lineWidth = (ln.bold ? contourModel.boldWidth : contourModel.lineWidth) * scale;
    ctx.stroke();
  });

  paint(contourModel.osm, ['water', 'motorway', 'trunk', 'primary', 'secondary',
    'tertiary', 'minor', 'rail']);

  return c;
}

/** The drape's four corners, in MapLibre's order: TL, TR, BR, BL. */
function contourDrapeCorners() {
  const g = contourModel.grid;
  if (!g) return null;
  const c = (x, y) => { const p = gridToLatLng(g, x, y); return [p.lng, p.lat]; };
  return [c(0, 0), c(g.w, 0), c(g.w, g.h), c(0, g.h)];
}
