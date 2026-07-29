/**
 * export/hiResRender.js — the high-resolution map rasteriser.
 *
 * ---------------------------------------------------------------------------
 * Why the old pipeline could not produce a sharp export
 * ---------------------------------------------------------------------------
 * The previous exporter was a single `html2canvas(mapWrap, { scale: 2 })` call.
 * html2canvas's `scale` enlarges the *output canvas*; it does not give the page
 * any more source detail. Text and CSS borders genuinely re-rasterise at the
 * larger size, but a map tile is a bitmap: a 256×256 tile drawn into a 512×512
 * slot is a 2× upscale. Every export was therefore a blown-up screenshot — the
 * imagery could never be sharper than what was already on screen, which is
 * exactly the "PNG export is not producing true high-resolution images"
 * symptom. Printing that into PowerPoint then softened it a second time.
 *
 * ---------------------------------------------------------------------------
 * What this does instead
 * ---------------------------------------------------------------------------
 * Ground truth comes from *deeper tiles*, not from a bigger canvas. For a
 * supersample factor `s` we build a throwaway Leaflet map in an offscreen
 * container that is `s`× larger in both axes and sits at `zoom + log2(s)`.
 * Because a zoom level doubles the pixels-per-metre, that pair of changes
 * cancels out geographically: the offscreen map frames the *identical* extent
 * as the on-screen map, but composed of `s`× as many real tile pixels. The
 * basemap is then genuinely `s`× sharper rather than interpolated.
 *
 * The export is composited from two passes so each half is rendered by whatever
 * draws it best:
 *
 *   Pass A — ground.    Offscreen hi-res map: basemap tiles, hillshade, and
 *                       every vector path (routes, rings, drawn shapes,
 *                       measurements) re-drawn by Leaflet's own canvas renderer
 *                       at the larger size with stroke weights scaled to match.
 *   Pass B — furniture. The real #mapWrap with its tile and vector panes hidden,
 *                       rasterised by html2canvas at `scale: s`. Labels, pins,
 *                       divIcon markers, title, legend, north arrow, scale bar
 *                       and logo are DOM, so html2canvas re-rasterises their
 *                       text and borders at full resolution — no upscaling.
 *
 * The two canvases are the same size and share an origin, so compositing is a
 * single `drawImage`.
 *
 * Two supporting details make pass B reliable:
 *   - Billboard elements are positioned with CSS transforms, and html2canvas
 *     1.4.1 silently drops text inside transformed elements. The old code
 *     worked around that with `foreignObjectRendering`, which in turn refuses
 *     to draw cross-origin tiles. We instead flatten the transforms to plain
 *     left/top for the duration of the capture, so the standard renderer works
 *     and neither workaround is needed.
 *   - The leader-line <canvas> has a fixed device-pixel backing store, so
 *     html2canvas would upscale it. We re-render it at `s`× first.
 */

/** Hard ceiling on export canvas area (~60 MP) so a huge window can't OOM the tab. */
const MAX_EXPORT_PIXELS = 60e6;

/** Supersample presets offered in the UI. */
const EXPORT_SCALES = Object.freeze({
  screen: 1,
  standard: 2,
  print: 3,
  max: 4,
});

/**
 * Clamp a requested supersample factor to what this window can actually hold.
 * @param {number} scale Requested factor.
 * @param {number} w CSS width of the map.
 * @param {number} h CSS height of the map.
 * @returns {number} A safe factor, never below 1.
 */
function safeExportScale(scale, w, h) {
  const wanted = Math.max(1, Math.min(6, scale || 2));
  const max = Math.sqrt(MAX_EXPORT_PIXELS / Math.max(1, w * h));
  return Math.max(1, Math.min(wanted, max));
}

/* ---------------------------------------------------------------------------
 * Vector path collection — shared by the hi-res renderer and the PPTX exporter
 * ------------------------------------------------------------------------- */

/**
 * Every vector path currently on the map, in paint order.
 *
 * Walking the live map rather than the app's own route/shape arrays means one
 * implementation covers routes, radius rings, drawn geometry, GeoJSON imports
 * and aerial measurements, and keeps working when a new kind of shape is added.
 * Leaflet-geoman's editing handles are `L.Marker`s, not paths, so they are
 * excluded automatically.
 *
 * @param {L.Map} m
 * @returns {L.Path[]}
 */
function collectMapPaths(m) {
  const out = [];
  m.eachLayer(l => { if (l instanceof L.Path) out.push(l); });
  return out;
}

/**
 * Re-create one path with its stroke geometry multiplied by `scale`.
 * Order of the instanceof tests matters — Circle extends CircleMarker, and
 * Rectangle/Polygon extend Polyline.
 * @param {L.Path} layer
 * @param {number} scale
 * @returns {L.Path|null}
 */
function scaledPathClone(layer, scale) {
  const o = Object.assign({}, layer.options);
  delete o.renderer;
  o.interactive = false;
  o.weight = (o.weight == null ? 3 : o.weight) * scale;
  if (o.dashArray) {
    o.dashArray = String(o.dashArray).split(/[\s,]+/).filter(Boolean)
      .map(n => (parseFloat(n) || 0) * scale).join(',');
  }
  if (layer instanceof L.Circle) return L.circle(layer.getLatLng(), Object.assign(o, { radius: layer.getRadius() }));
  if (layer instanceof L.CircleMarker) return L.circleMarker(layer.getLatLng(), Object.assign(o, { radius: (layer.getRadius() || 8) * scale }));
  if (layer instanceof L.Polygon) return L.polygon(layer.getLatLngs(), o);
  if (layer instanceof L.Polyline) return L.polyline(layer.getLatLngs(), o);
  return null;
}

/**
 * Convert every vector path on the map into flat, renderer-agnostic geometry in
 * map-container pixels, ready to be re-emitted as native PowerPoint shapes.
 *
 * This is the other half of the fix for "the exported PPT contains the lines
 * printed on the image": the map picture is captured with its vector pane
 * switched off, and these descriptors become real editable objects instead.
 *
 * Polylines are simplified with Douglas–Peucker before export. An OSRM route
 * arrives with a vertex every few metres — upwards of a thousand points for a
 * city-scale route — which PowerPoint will accept but chokes on when you try to
 * drag it. At a 0.7px tolerance the simplified line is visually identical at
 * export resolution and typically an order of magnitude smaller.
 *
 * @param {L.Map} m
 * @returns {Array<object>} Path descriptors consumed by addVectorPath().
 */
function mapPathsForExport(m) {
  const SIMPLIFY_TOLERANCE = 0.7;
  const toPx = ll => {
    const p = m.latLngToContainerPoint(ll);
    return { x: p.x, y: p.y };
  };
  const ringToPx = ring => {
    const pts = ring.map(ll => m.latLngToContainerPoint(ll));
    const simple = pts.length > 4 ? L.LineUtil.simplify(pts, SIMPLIFY_TOLERANCE) : pts;
    return simple.map(p => ({ x: p.x, y: p.y }));
  };
  /** Leaflet allows nested rings (polygons with holes / multi-parts). */
  const normaliseRings = latlngs => {
    if (!latlngs.length) return [];
    return Array.isArray(latlngs[0]) ? latlngs.map(normaliseRings).reduce((a, b) => a.concat(b), []) : [latlngs];
  };

  const out = [];
  collectMapPaths(m).forEach(layer => {
    const o = layer.options || {};
    const stroke = {
      color: o.color || '#3388ff',
      weight: o.weight == null ? 3 : o.weight,
      opacity: o.opacity == null ? 1 : o.opacity,
      dash: o.dashArray ? 'dash' : undefined,
      fill: (o.fill && (o.fillOpacity == null || o.fillOpacity > 0))
        ? { color: o.fillColor || o.color || '#3388ff', opacity: o.fillOpacity == null ? 0.2 : o.fillOpacity }
        : null,
    };

    if (layer instanceof L.Circle || layer instanceof L.CircleMarker) {
      let box;
      if (layer instanceof L.Circle) {
        const b = layer.getBounds();
        const nw = toPx(b.getNorthWest()), se = toPx(b.getSouthEast());
        box = { x: nw.x, y: nw.y, w: se.x - nw.x, h: se.y - nw.y };
      } else {
        const c = toPx(layer.getLatLng()), r = layer.getRadius() || 8;
        box = { x: c.x - r, y: c.y - r, w: r * 2, h: r * 2 };
      }
      if (box.w > 0.5 && box.h > 0.5) out.push(Object.assign({ kind: 'ellipse', box }, stroke));
      return;
    }

    const rings = normaliseRings(layer.getLatLngs()).map(ringToPx).filter(r => r.length >= 2);
    if (!rings.length) return;
    if (layer instanceof L.Polygon) out.push(Object.assign({ kind: 'polygon', rings }, stroke));
    else out.push(Object.assign({ kind: 'polyline', points: rings[0] }, stroke));
  });
  return out;
}

/* ---------------------------------------------------------------------------
 * Pass A — the offscreen high-resolution ground
 * ------------------------------------------------------------------------- */

/**
 * Resolve once every tile layer on a map has finished loading, or when the
 * budget runs out. Leaflet fires `load` per tile layer when its visible tiles
 * are in; layers that had nothing to fetch never fire, hence the timeout.
 * @param {L.TileLayer[]} layers
 * @param {number} budgetMs
 * @returns {Promise<boolean>} false when the timeout won the race.
 */
function whenTilesSettled(layers, budgetMs) {
  if (!layers.length) return Promise.resolve(true);
  const all = Promise.all(layers.map(l => new Promise(res => {
    let done = false;
    const finish = () => { if (!done) { done = true; res(); } };
    l.once('load', finish);
    // A layer whose tiles were all cache hits may have completed before we
    // subscribed; `_loading === false` is Leaflet's own settled flag.
    if (l._loading === false) finish();
  })));
  return Promise.race([
    all.then(() => true),
    new Promise(res => setTimeout(() => res(false), budgetMs)),
  ]);
}

/**
 * Build the offscreen supersampled map and rasterise it.
 * @param {object} o `{scale, wrapW, wrapH, includeVectors}`
 * @returns {Promise<{canvas:HTMLCanvasElement, complete:boolean}>}
 */
async function renderGroundPass(o) {
  const { scale, wrapW, wrapH } = o;
  const W = Math.round(wrapW * scale), H = Math.round(wrapH * scale);

  const host = document.createElement('div');
  // Parked far off-screen rather than hidden: Leaflet needs a laid-out box with
  // real dimensions, and `display:none` would give it a 0×0 viewport.
  host.style.cssText =
    `position:fixed;left:-${W + 400}px;top:0;width:${W}px;height:${H}px;` +
    'overflow:hidden;pointer-events:none;z-index:-1;background:#0d1522;';
  document.body.appendChild(host);

  let exportMap = null;
  try {
    exportMap = L.map(host, {
      zoomControl: false, attributionControl: false,
      // Fractional zoom is required for non-power-of-two factors (s = 3 lands on
      // zoom + 1.585). zoomSnap 0 lets Leaflet sit exactly there.
      zoomSnap: 0, zoomDelta: 0,
      fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false,
      inertia: false, keyboard: false, dragging: false, scrollWheelZoom: false,
      maxZoom: 30, minZoom: 0,
      preferCanvas: true,
      renderer: L.canvas({ padding: 0.5 }),
    });
    exportMap.setView(map.getCenter(), map.getZoom() + Math.log2(scale), { animate: false });

    // Same basemap, but uncapped `maxZoom` so Leaflet never clamps the view
    // itself — each layer still stops at its own maxNativeZoom.
    const entry = BASEMAPS[activeKey] || BASEMAPS[preferredBasemapId()];
    const tileLayers = entry.build($('hdTgl').checked);
    tileLayers.forEach(l => { l.options.maxZoom = 30; l.addTo(exportMap); });
    if ($('hillTgl').checked) {
      const hs = L.tileLayer(HILLSHADE_LAYER.url, {
        maxZoom: 30, crossOrigin: 'anonymous', maxNativeZoom: HILLSHADE_LAYER.maxNative,
        opacity: HILLSHADE_LAYER.opacity, zIndex: HILLSHADE_LAYER.zIndex,
      }).addTo(exportMap);
      tileLayers.push(hs);
    }

    const complete = await whenTilesSettled(tileLayers, 30000);
    exportMap.invalidateSize({ animate: false });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const shot = extra => html2canvas(host, Object.assign({
      useCORS: true, allowTaint: false, logging: false,
      width: W, height: H, windowWidth: W, windowHeight: H,
      // The DOM is already at target resolution — scaling again would upsample
      // the very tiles we went to the trouble of fetching at depth.
      scale: 1,
    }, extra));

    // Three separate captures, because three different colour treatments apply.
    // html2canvas does not honour CSS filters, so anything that needs one has
    // to be isolated and filtered at composite time instead:
    //   imagery   — graded
    //   reference — desaturated/softened road & label overlay
    //   vectors   — untouched; their colours were chosen, not captured
    // Splitting also fixes a subtler error: grading the whole tile pane at once
    // saturated the road paint along with the ground.
    host.classList.add('hires-imagery-only');
    const tiles = await shot({ backgroundColor: '#0d1522' });
    host.classList.remove('hires-imagery-only');

    let reference = null;
    const roadOpacity = (typeof roadExportStyle === 'function') ? roadExportStyle().opacity : 1;
    if (roadOpacity > 0 && host.querySelector('.basemap-reference')) {
      host.classList.add('hires-reference-only');
      await new Promise(r => requestAnimationFrame(r));
      reference = await shot({ backgroundColor: null });
      host.classList.remove('hires-reference-only');
    }

    let vectors = null;
    if (o.includeVectors !== false) {
      const clones = [];
      collectMapPaths(map).forEach(p => {
        const clone = scaledPathClone(p, scale);
        if (clone) { clone.addTo(exportMap); clones.push(clone); }
      });
      if (clones.length) {
        host.classList.add('hires-vectors-only');   // hides the tile pane
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        vectors = await shot({ backgroundColor: null });
        host.classList.remove('hires-vectors-only');
      }
    }
    return { canvas: tiles, reference, vectors, complete };
  } finally {
    if (exportMap) exportMap.remove();
    host.remove();
  }
}

/* ---------------------------------------------------------------------------
 * Pass B — the furniture (labels, pins, cards, chrome)
 * ------------------------------------------------------------------------- */

/**
 * Rasterise everything on the real map that is not a tile or a vector path.
 * @param {object} o `{scale, wrapW, wrapH, extraClass}`
 * @returns {Promise<HTMLCanvasElement>}
 */
async function renderFurniturePass(o) {
  const { scale, wrapW, wrapH } = o;
  const wrap = $('mapWrap');
  const stage = $('tiltStage');
  const savedTransform = stage.style.transform;
  const wasTilted = wrap.classList.contains('tilted');

  stage.style.transform = '';
  wrap.classList.remove('tilted');
  wrap.classList.add('capturing', 'hires-overlay-pass');
  if (o.extraClass) wrap.classList.add(o.extraClass);
  if (typeof setLeaderRenderScale === 'function') setLeaderRenderScale(scale);
  if (typeof flattenBillboardForCapture === 'function') flattenBillboardForCapture();

  try {
    return await html2canvas(wrap, {
      useCORS: true, allowTaint: false, logging: false,
      backgroundColor: null,                 // transparent — pass A shows through
      width: wrapW, height: wrapH,
      scale,
    });
  } finally {
    if (typeof restoreBillboardAfterCapture === 'function') restoreBillboardAfterCapture();
    if (typeof setLeaderRenderScale === 'function') setLeaderRenderScale(0);
    wrap.classList.remove('capturing', 'hires-overlay-pass');
    if (o.extraClass) wrap.classList.remove(o.extraClass);
    stage.style.transform = savedTransform;
    if (wasTilted) wrap.classList.add('tilted');
  }
}

/* ---------------------------------------------------------------------------
 * Public entry point
 * ------------------------------------------------------------------------- */

/**
 * Rasterise the map and its overlays at `scale`× the on-screen resolution.
 *
 * @param {object} [opts]
 * @param {number}  [opts.scale=3]        Supersample factor; clamped by
 *                                        {@link safeExportScale}.
 * @param {string}  [opts.extraClass]     Class applied to #mapWrap during the
 *                                        furniture pass (`pptx-capture` hides
 *                                        the chips that become native shapes).
 * @param {boolean} [opts.includeVectors] false to leave routes/shapes out of the
 *                                        image because the caller re-emits them
 *                                        as native objects (the PPTX path).
 * @param {Function} [opts.onProgress]    Called with a short status string.
 * @returns {Promise<{canvas:HTMLCanvasElement, scale:number, complete:boolean}>}
 */
async function captureMapHiRes(opts) {
  opts = opts || {};
  const wrap = $('mapWrap');
  const wrapW = wrap.clientWidth, wrapH = wrap.clientHeight;
  const scale = safeExportScale(opts.scale == null ? EXPORT_SCALES.print : opts.scale, wrapW, wrapH);
  const say = opts.onProgress || (() => {});

  say('Fetching high-resolution imagery…');
  const ground = await renderGroundPass({
    scale, wrapW, wrapH, includeVectors: opts.includeVectors !== false,
  });

  say('Rendering labels and overlays…');
  const furniture = await renderFurniturePass({ scale, wrapW, wrapH, extraClass: opts.extraClass });

  say('Compositing…');
  const out = document.createElement('canvas');
  out.width = ground.canvas.width;
  out.height = ground.canvas.height;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Grade the imagery exactly as the screen does, so an export is not a
  // different-looking picture from the one the operator composed. Canvas
  // `filter` takes the same syntax as CSS `filter`, so one string drives both.
  const spec = (typeof BASEMAP_CATALOGUE !== 'undefined') ? BASEMAP_CATALOGUE[activeKey] : null;
  const grade = (typeof imageryExportFilter === 'function')
    ? imageryExportFilter(!!(spec && spec.imagery)) : 'none';
  if (grade && grade !== 'none' && 'filter' in ctx) ctx.filter = grade;
  ctx.drawImage(ground.canvas, 0, 0);
  ctx.filter = 'none';

  // Roads and labels next, carrying their own treatment so the export matches
  // what the operator toned on screen.
  if (ground.reference) {
    const road = (typeof roadExportStyle === 'function') ? roadExportStyle() : { filter: 'none', opacity: 1 };
    if (road.opacity > 0) {
      if (road.filter && road.filter !== 'none' && 'filter' in ctx) ctx.filter = road.filter;
      ctx.globalAlpha = road.opacity;
      ctx.drawImage(ground.reference, 0, 0, out.width, out.height);
      ctx.globalAlpha = 1;
      ctx.filter = 'none';
    }
  }

  // Vectors and furniture go on ungraded — their colours were chosen, not captured.
  if (ground.vectors) ctx.drawImage(ground.vectors, 0, 0, out.width, out.height);
  ctx.drawImage(furniture, 0, 0, out.width, out.height);

  return { canvas: out, scale, complete: ground.complete };
}
