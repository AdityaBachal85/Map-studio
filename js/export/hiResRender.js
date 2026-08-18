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

/** How often to check whether tiles have stopped arriving, and for how many consecutive checks. */
const SETTLE_POLL_MS = 250;
const SETTLE_POLLS = 4;   // ~1s of quiet before calling it done

/**
 * Resolve once every tile layer has actually painted its tiles, or when the
 * budget runs out.
 *
 * This polls each layer's tile registry rather than listening for Leaflet's
 * `load` event, because that event was firing early and shipping a
 * half-painted map. Two ways it went wrong:
 *
 *  - `load` fires when the tiles requested *so far* are done. A freshly built
 *    export map requests a coarse batch first and the deep-zoom batch after,
 *    so the first `load` arrives with most of the image still missing.
 *  - The old code also treated `_loading === false` as "settled", which is
 *    true of a layer that has not begun loading at all — resolving instantly
 *    on a map that had rendered nothing.
 *
 * Either one exported the dark `#0d1522` backdrop where tiles should have
 * been, which is the "map is dark in the export" report.
 *
 * @param {L.TileLayer[]} layers
 * @param {number} budgetMs
 * @returns {Promise<boolean>} false when the budget ran out first.
 */
function whenTilesSettled(layers, budgetMs) {
  if (!layers.length) return Promise.resolve(true);

  /** @returns {number} tiles requested but not yet painted, across all layers. */
  const pending = () => layers.reduce((n, l) => {
    const tiles = l._tiles || {};
    let waiting = 0;
    for (const k in tiles) if (!tiles[k].loaded) waiting++;
    // A layer that has not been asked for anything yet is not "settled" — it
    // has simply not started. Counting it as one outstanding tile stops the
    // poll declaring victory before the first request goes out.
    if (!Object.keys(tiles).length && l._loading !== false) waiting++;
    return n + waiting;
  }, 0);

  return new Promise(resolve => {
    const started = Date.now();
    let quietFor = 0;
    const tick = setInterval(() => {
      const outstanding = pending();
      // Require the count to stay at zero across consecutive polls. A single
      // zero reading is not enough: Leaflet requests tiles in waves as the
      // view settles, and the gap between two waves reads as "done".
      quietFor = outstanding === 0 ? quietFor + 1 : 0;
      if (quietFor >= SETTLE_POLLS) { clearInterval(tick); resolve(true); return; }
      if (Date.now() - started > budgetMs) { clearInterval(tick); resolve(false); }
    }, SETTLE_POLL_MS);
  });
}

/**
 * Build the offscreen supersampled map and rasterise it.
 * @param {object} o `{scale, wrapW, wrapH, includeVectors}`
 * @returns {Promise<{canvas:HTMLCanvasElement, complete:boolean}>}
 */
async function renderGroundPass(o) {
  const { scale, wrapW, wrapH } = o;
  const W = Math.round(wrapW * scale), H = Math.round(wrapH * scale);

  // The oblique relief view replaces the flat map rather than sitting over it:
  // Leaflet is hidden, its tiles and vectors are not on screen, and the picture
  // is a GL canvas the operator aimed by hand. Rebuilding that camera from
  // numbers is how an export stops matching what was on the screen, so the
  // buffer is copied straight out instead. Same reasoning as the vector ground,
  // one step further — here there is no Leaflet map left to reproduce at all.
  if (typeof map3dActive === 'function' && map3dActive()) {
    const gl = render3dGroundCanvas({ W, H });
    if (gl) return { canvas: gl, reference: null, vectors: null, contour: null, complete: true };
  }

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
    //
    // Not always literally the same one: a basemap that is licensed for display
    // but not for redistribution (Google), or whose tiles taint the canvas,
    // renders here as its licensed equivalent. Only the ground changes —
    // geometry, labels, framing and scale are computed from the live map, so the
    // export is the same picture on different imagery. See exportBasemapId().
    const exportKey = typeof exportBasemapId === 'function' ? exportBasemapId(activeKey) : activeKey;
    const entry = BASEMAPS[exportKey] || BASEMAPS[activeKey] || BASEMAPS[preferredBasemapId()];

    // A vector ground has no tile layers to build and no scrub to bias — it is
    // rendered separately, below, straight off a GL canvas. Everything else in
    // this function still applies to it: the offscreen Leaflet map is what the
    // routes and shapes are cloned onto, and they need it whichever ground is
    // underneath.
    const vectorGround = typeof isVectorSpec === 'function' && isVectorSpec(entry.spec);

    // The ground is rendered `log2(scale)` levels deeper than the screen for
    // pixel density alone. Tell the scrub, so its "only while zoomed out"
    // threshold is measured against the scale the reader sees rather than the
    // zoom this offscreen map happens to use — otherwise every export keeps the
    // red crosses the screen had just dropped.
    //
    // Raster only. tileScrub.js cleans tile pixels, and a vector ground has
    // none: its equivalent is a style filter, already applied to the export map
    // by renderVectorGroundCanvas(). Setting the bias here anyway would leave it
    // pointing at a scrub that is not running.
    if (!vectorGround && typeof setScrubZoomBias === 'function') setScrubZoomBias(Math.log2(scale));
    const tileLayers = vectorGround ? [] : entry.build($('hdTgl').checked);
    tileLayers.forEach(l => { l.options.maxZoom = 30; l.addTo(exportMap); });
    if ($('hillTgl').checked) {
      const hs = L.tileLayer(HILLSHADE_LAYER.url, {
        maxZoom: 30, crossOrigin: 'anonymous', maxNativeZoom: HILLSHADE_LAYER.maxNative,
        opacity: HILLSHADE_LAYER.opacity, zIndex: HILLSHADE_LAYER.zIndex,
      }).addTo(exportMap);
      tileLayers.push(hs);
    }

    // The contour map, rendered by a second instance of the same layer against
    // this larger map. It reads the shared model, so nothing is refetched and
    // nothing is recomputed — only redrawn, at the export's own resolution, so
    // the lines and their labels stay one pixel wide instead of being magnified.
    let contourExportLayer = null;
    if (typeof ContourLayer === 'function' && typeof contourModel !== 'undefined'
      && contourModel.ready && typeof contourState !== 'undefined' && contourState.on) {
      contourExportLayer = new ContourLayer(contourModel);
      // 1, not the screen's device ratio: this map is already `scale` times the
      // size, so its pixels are the export's pixels.
      contourExportLayer.setRenderScale(1);
      contourExportLayer.addTo(exportMap);
    }

    // A 2x export covers four times the tiles of the screen, a 4x export
    // sixteen. Thirty seconds was a screen-sized budget applied to an
    // export-sized job, so a large or slow render ran out of time and shipped
    // whatever had arrived. Scale the allowance with the work.
    let complete = await whenTilesSettled(tileLayers, 30000 + scale * scale * 15000);
    exportMap.invalidateSize({ animate: false });
    // invalidateSize can pull in a further ring of tiles at the edges; without
    // a second wait those arrive after the capture and are simply missing.
    await whenTilesSettled(tileLayers, 8000);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // The vector ground, rendered off its own GL canvas at the same view and
    // `scale` times the device pixel ratio. Composited under whatever raster
    // layers the Leaflet host did draw — hillshade is the one that can still be
    // on — so the stacking order matches the screen.
    let vectorCanvas = null;
    if (vectorGround) {
      const vg = await renderVectorGroundCanvas(entry.spec, {
        W, H, scale,
        center: map.getCenter(),
        zoom: map.getZoom(),
        budgetMs: 30000 + scale * scale * 15000,
      });
      vectorCanvas = vg.canvas;
      if (!vg.complete) complete = false;
    }

    const shot = extra => html2canvas(host, Object.assign({
      useCORS: true, allowTaint: false, logging: false,
      width: W, height: H, windowWidth: W, windowHeight: H,
      // The DOM is already at target resolution — scaling again would upsample
      // the very tiles we went to the trouble of fetching at depth.
      scale: 1,
    }, extra));

    // Three layer groups, three colour treatments applied at composite time,
    // because html2canvas does not honour CSS filters and grading the whole
    // tile pane at once saturated the road paint along with the ground:
    //   imagery   — graded
    //   reference — desaturated/softened road & label overlay
    //   vectors   — untouched; their colours were chosen, not captured
    //
    // Each is now cut straight out of the DOM rather than re-rendered. See the
    // note above rasteriseTileLayers() for what that was costing.
    const isReference = el => el.classList.contains('basemap-reference');
    // No opaque backdrop when a vector ground is going underneath — filling
    // #0d1522 here would paint over the very thing this pass just rendered.
    const ground = rasteriseTileLayers(host, W, H, el => !isReference(el),
      vectorCanvas ? null : '#0d1522');

    let reference = null;
    const roadOpacity = (typeof roadExportStyle === 'function') ? roadExportStyle().opacity : 1;
    if (roadOpacity > 0 && host.querySelector('.basemap-reference')) {
      const ref = rasteriseTileLayers(host, W, H, isReference, null);
      if (ref.drawn) reference = ref.canvas;
    }

    const isContour = el => el.classList.contains('contour-canvas');
    let contour = null;
    if (contourExportLayer) {
      const cc = rasteriseVectorCanvases(host, W, H, isContour);
      if (cc.drawn) contour = cc.canvas;
    }

    let vectors = null;
    if (o.includeVectors !== false) {
      const clones = [];
      const patternWork = [];
      collectMapPaths(map).forEach(p => {
        const clone = scaledPathClone(p, scale);
        if (!clone) return;
        clone.addTo(exportMap);
        // After addTo, because the renderer's context only exists once the layer
        // is on a map — and awaited below, because rasterising the tile goes
        // through an Image load. The tile is scaled with the export so a hatch
        // keeps its on-screen spacing instead of thinning to hairlines at 3x.
        if (typeof applyCanvasFillPattern === 'function' && clone.options.fillPattern) {
          patternWork.push(applyCanvasFillPattern(clone, clone.options.fillPattern, clone.options.fillColor, scale));
        }
        clones.push(clone);
      });
      if (patternWork.length) await Promise.all(patternWork);
      if (clones.length) {
        // One frame for Leaflet's canvas renderer to actually paint the clones
        // it has only been handed so far.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const vec = rasteriseVectorCanvases(host, W, H, el => !isContour(el));
        if (vec.drawn) vectors = vec.canvas;
      }
    }

    // Falling back rather than shipping a blank ground — but only when the DOM
    // is not the shape this expects. Tiles that simply failed to load are
    // counted as `missing`, and html2canvas cannot draw those either: falling
    // back on a bad connection spent another fifty seconds arriving at the same
    // dark canvas. The distinction is "we found no tile layers at all" versus
    // "we found them and the network did not deliver".
    let tiles = ground.canvas;
    // Vector grounds are exempt: there are no tile layers to find, so "we found
    // no tile layers at all" is the expected state rather than a broken one —
    // and html2canvas cannot photograph a WebGL canvas anyway, so the fallback
    // would trade a correct ground for a blank one.
    const domChanged = !vectorCanvas && !ground.drawn && !ground.missing
      && host.querySelector('img.leaflet-tile');
    if (domChanged) {
      console.warn('Export: tile panes are not the expected shape; falling back to html2canvas.');
      host.classList.add('hires-imagery-only');
      tiles = await shot({ backgroundColor: '#0d1522' });
      host.classList.remove('hires-imagery-only');
    }

    // The GL ground goes down first, then whatever raster survived above it.
    if (vectorCanvas) {
      const composed = document.createElement('canvas');
      composed.width = W; composed.height = H;
      const cx = composed.getContext('2d');
      cx.fillStyle = '#0d1522';
      cx.fillRect(0, 0, W, H);
      // Explicit destination size — the GL canvas is sized in device pixels and
      // need not be exactly W × H. See renderVectorGroundCanvas().
      cx.drawImage(vectorCanvas, 0, 0, W, H);
      if (ground.drawn) cx.drawImage(ground.canvas, 0, 0);
      tiles = composed;
    }

    return { canvas: tiles, reference, vectors, contour, complete };
  } finally {
    // Cleared here, not only after the furniture pass: if the ground pass
    // throws, a leaked bias would follow the *live* map and start scrubbing
    // two zoom levels further in than intended, with nothing to explain it.
    if (typeof setScrubZoomBias === 'function') setScrubZoomBias(0);
    if (exportMap) exportMap.remove();
    host.remove();
  }
}

/* ---------------------------------------------------------------------------
 * Direct rasterisation — why this exists instead of html2canvas
 * ------------------------------------------------------------------------ */

/**
 * WHAT THE GROUND PASS USED TO COST.
 *
 * It called html2canvas three times over the same offscreen map — once for the
 * imagery, once for the road/label overlay, once for the vectors — because
 * html2canvas ignores CSS filters and each of those needs a different colour
 * treatment at composite time. Measured on a 1400x800 map at 3x: 48s, 60s and
 * 62s. One hundred and seventy-one seconds of the export's two hundred and
 * twenty-four, to draw pictures that were already sitting in the DOM as
 * decoded images.
 *
 * That is what html2canvas is: a document cloner and a from-scratch layout
 * renderer. Aimed at a pane of <img> tiles it re-does an enormous amount of
 * work for something the browser has already finished doing.
 *
 * So the tile panes and the vector canvas are drawn straight onto a canvas
 * with drawImage — a few hundred calls, each one a blit the GPU already has
 * the pixels for. The three treatments stop needing three passes, because
 * each layer group gets its own small canvas by construction.
 *
 * html2canvas is still right for the furniture pass: labels, the legend card
 * and the title are real styled DOM, which is the job it is actually for.
 *
 * POSITIONS COME FROM getBoundingClientRect, not from Leaflet's tile
 * arithmetic. The pane carries transforms — the zoom origin, the fractional
 * zoom this export uses — and re-deriving where a tile landed means
 * re-implementing all of that and getting it wrong at the edges. The rect is
 * the browser's own answer to "where did this actually end up".
 */

/** @param {Element} el @returns {number} the element's own opacity, 1 if unset */
function elOpacity(el) {
  const v = parseFloat(getComputedStyle(el).opacity);
  return isFinite(v) ? v : 1;
}

/**
 * Draw a set of tile layers onto a fresh canvas.
 *
 * @param {HTMLElement} host the offscreen map container
 * @param {number} W @param {number} H
 * @param {function(Element):boolean} pick which .leaflet-layer containers to include
 * @param {string|null} background fill first, or null for transparent
 * @returns {{canvas:HTMLCanvasElement, drawn:number, missing:number}}
 */
function rasteriseTileLayers(host, W, H, pick, background) {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, W, H); }

  const hostRect = host.getBoundingClientRect();
  let drawn = 0, missing = 0;

  // z-index order, because a hillshade over imagery and imagery over hillshade
  // are different pictures. Leaflet writes the order into the layer div.
  const layers = Array.from(host.querySelectorAll('.leaflet-tile-pane .leaflet-layer'))
    .filter(pick)
    .sort((a, b) => (+a.style.zIndex || 0) - (+b.style.zIndex || 0));

  layers.forEach(layer => {
    ctx.globalAlpha = elOpacity(layer);
    // Both kinds: a scrubbed basemap's tiles are <canvas> elements, and an
    // img-only selector here exported a blank ground the first time one was on.
    layer.querySelectorAll('img.leaflet-tile, canvas.leaflet-tile').forEach(img => {
      // A tile that errored or has not decoded draws as nothing — and would
      // throw on some browsers rather than being skipped politely.
      const ready = img.tagName === 'CANVAS' ? img.width > 0 : (img.complete && img.naturalWidth);
      if (!ready) { missing++; return; }
      const r = img.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) { missing++; return; }
      try {
        ctx.drawImage(img, r.left - hostRect.left, r.top - hostRect.top, r.width, r.height);
        drawn++;
      } catch (e) {
        missing++;     // tainted canvas, a CORS-less tile that slipped through
      }
    });
  });

  ctx.globalAlpha = 1;
  return { canvas, drawn, missing };
}

/**
 * Draw the vector renderer's own canvases onto a fresh one.
 *
 * The export map runs `preferCanvas`, so every path is already rasterised into
 * a <canvas> in the overlay pane. Copying it is one drawImage.
 *
 * @param {HTMLElement} host @param {number} W @param {number} H
 * @param {function(Element):boolean} [pick] which canvases to include. The
 *   contour map is one of these canvases and is composited separately — it is
 *   ground rather than geometry, so it belongs under the routes, and it has to
 *   survive `includeVectors:false` on the PPTX path where the routes do not.
 * @returns {{canvas:HTMLCanvasElement, drawn:number}}
 */
function rasteriseVectorCanvases(host, W, H, pick) {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const hostRect = host.getBoundingClientRect();
  let drawn = 0;

  host.querySelectorAll('.leaflet-overlay-pane canvas').forEach(src => {
    if (!src.width || !src.height) return;
    if (pick && !pick(src)) return;
    const r = src.getBoundingClientRect();
    try {
      ctx.drawImage(src, r.left - hostRect.left, r.top - hostRect.top, r.width, r.height);
      drawn++;
    } catch (e) { /* leave it out rather than fail the export */ }
  });

  return { canvas, drawn };
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

  // The credit line is captured from the live DOM, so when the ground pass has
  // substituted a different basemap the on-screen credit would be printed over
  // imagery it does not describe. Crediting the wrong provider in a document
  // that leaves the building is the one error here with consequences outside the
  // app, so the exported line names what was actually rendered.
  const creditEl = $('mapCredit');
  const savedCredit = creditEl ? creditEl.textContent : null;
  if (creditEl && typeof exportBasemapId === 'function') {
    const sub = BASEMAP_CATALOGUE[exportBasemapId(activeKey)];
    if (sub && sub.id !== activeKey) creditEl.textContent = sub.credit;
  }

  try {
    return await html2canvas(wrap, {
      useCORS: true, allowTaint: false, logging: false,
      backgroundColor: null,                 // transparent — pass A shows through
      width: wrapW, height: wrapH,
      scale,
    });
  } finally {
    if (creditEl && savedCredit !== null) creditEl.textContent = savedCredit;
    if (typeof restoreBillboardAfterCapture === 'function') restoreBillboardAfterCapture();
    if (typeof setLeaderRenderScale === 'function') setLeaderRenderScale(0);
    if (typeof setScrubZoomBias === 'function') setScrubZoomBias(0);
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
  // Between the ground and the geometry: the contour map describes the land,
  // and the routes and shapes are drawn on top of the land.
  if (ground.contour) ctx.drawImage(ground.contour, 0, 0, out.width, out.height);
  if (ground.vectors) ctx.drawImage(ground.vectors, 0, 0, out.width, out.height);
  ctx.drawImage(furniture, 0, 0, out.width, out.height);

  return { canvas: out, scale, complete: ground.complete };
}
