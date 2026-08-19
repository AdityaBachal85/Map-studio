/**
 * map/contourLayer.js — drawing the contour map onto the Leaflet map.
 *
 * One canvas, in the overlay pane, under the app's own shapes and pins. That
 * position is not cosmetic: js/export/hiResRender.js composites an export by
 * copying every canvas it finds in `.leaflet-overlay-pane`, so a contour map
 * that lives there is exported by machinery that already exists and already
 * works, instead of by a second rendering path that would have to be kept in
 * step with the first.
 *
 * WHY NOT A TILE LAYER. A tile layer would ride Leaflet's grid for free, but a
 * contour is a whole line: it needs smoothing along its length, a label rotated
 * to its own tangent, and a gap burned into it under that label. Cut into 256
 * pixel squares, each square would relabel the same contour and smooth its
 * fragment to a slightly different shape, and the seams would show. So the
 * lines are held whole, in latitude and longitude, and projected on each draw.
 *
 * WHY THE FILL IS RASTER AND THE LINES ARE NOT. The hypsometric fill is one
 * colour per elevation sample — a smooth field, which scales without artefacts,
 * so it is built once at the grid's own resolution and stretched. The lines are
 * redrawn from coordinates at every zoom, so they stay one pixel wide however
 * far in the operator goes. Rasterising them too would blur them the moment the
 * map moved.
 *
 * The roads, water and buildings come from OpenStreetMap as real geometry
 * rather than as a raster overlay — see services/osmDetail.js for why — so they
 * are drawn here, into the same canvas, at whatever weight the scale wants.
 *
 * The layer owns no data. It renders a MODEL — see map/contourMap.js — which
 * means a second instance on the offscreen export map draws exactly the same
 * picture at four times the size without refetching or recomputing anything.
 */

/** Roughly how far apart labels sit along one contour, in screen pixels. */
const CONTOUR_LABEL_SPACING = 230;
/** Shortest run of line, in pixels, still worth interrupting for a label. */
const CONTOUR_LABEL_MIN_RUN = 90;
const CONTOUR_LABEL_FONT = '700 10px Geist, ui-sans-serif, system-ui, sans-serif';

const ContourLayer = L.Layer.extend({
  options: {
    // The same padding Leaflet's own canvas renderer uses: the canvas is drawn
    // a little larger than the viewport so a pan reveals already-drawn ground
    // rather than a white edge waiting for the next redraw.
    padding: 0.1,
  },

  /**
   * No arguments. The layer draws EVERY visible contour map, asking
   * map/contourMap.js for the current list on each frame rather than holding a
   * reference to one — a project can have several, and they can be added,
   * hidden and deleted while the layer is on the map.
   */
  initialize: function () {},

  onAdd: function () {
    const c = this._canvas = document.createElement('canvas');
    c.className = 'contour-canvas leaflet-zoom-animated';
    c.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
    this._ctx = c.getContext('2d');

    // First child, so the app's routes, rings and drawn shapes render over the
    // contour map rather than under it. They are the subject; this is ground.
    const pane = this.getPane('overlayPane');
    pane.insertBefore(c, pane.firstChild);

    this._reset();
  },

  onRemove: function () {
    if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    this._canvas = this._ctx = null;
  },

  getEvents: function () {
    const ev = { viewreset: this._reset, zoom: this._onZoom, moveend: this._update, resize: this._reset };
    if (this._zoomAnimated) ev.zoomanim = this._onAnimZoom;
    return ev;
  },

  /** Redraw from the model — call after anything in it changes. */
  refresh: function () { if (this._map) this._update(); },

  /* -- placement ----------------------------------------------------------
   * Lifted from Leaflet's own L.Renderer, because a canvas in the overlay pane
   * has to survive a zoom animation the same way its path canvases do: the pane
   * is transformed under it mid-animation, and without matching that transform
   * the contour map slides away from the ground and snaps back at the end.
   * ---------------------------------------------------------------------- */

  _onAnimZoom: function (e) { this._updateTransform(e.center, e.zoom); },
  _onZoom: function () { this._updateTransform(this._map.getCenter(), this._map.getZoom()); },

  _updateTransform: function (center, zoom) {
    const scale = this._map.getZoomScale(zoom, this._zoom);
    const viewHalf = this._map.getSize().multiplyBy(0.5 + this.options.padding);
    const currentCentre = this._map.project(this._center, zoom);
    const topLeft = viewHalf.multiplyBy(-scale).add(currentCentre)
      .subtract(this._map._getNewPixelOrigin(center, zoom));

    if (L.Browser.any3d) L.DomUtil.setTransform(this._canvas, topLeft, scale);
    else L.DomUtil.setPosition(this._canvas, topLeft);
  },

  _reset: function () {
    this._update();
    this._updateTransform(this._center, this._zoom);
  },

  _update: function () {
    if (!this._map || this._map._animatingZoom && this._bounds) return;

    const p = this.options.padding;
    const size = this._map.getSize();
    const min = this._map.containerPointToLayerPoint(size.multiplyBy(-p)).round();

    this._bounds = new L.Bounds(min, min.add(size.multiplyBy(1 + p * 2).round()));
    this._center = this._map.getCenter();
    this._zoom = this._map.getZoom();

    const b = this._bounds, sz = b.getSize();
    // Device pixels, so the lines and the label text are crisp on a retina
    // screen; the export map passes its own ratio so a 4x render is genuinely
    // four times the detail rather than four times the same pixels.
    const dpr = this._renderScale || Math.min(window.devicePixelRatio || 1, 2);
    const c = this._canvas;
    c.width = Math.max(1, Math.round(sz.x * dpr));
    c.height = Math.max(1, Math.round(sz.y * dpr));
    c.style.width = sz.x + 'px';
    c.style.height = sz.y + 'px';
    L.DomUtil.setPosition(c, b.min);

    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._draw(sz);
  },

  /** Render at a fixed pixel ratio — used by the export path. */
  setRenderScale: function (s) { this._renderScale = s; if (this._map) this._reset(); },

  /* -- the picture -------------------------------------------------------- */

  _draw: function (size) {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, size.x, size.y);
    const models = (typeof visibleContourModels === 'function') ? visibleContourModels() : [];
    // Painted in list order, so a contour map added later sits over an earlier
    // one where they overlap — the same rule as every other stack in this app.
    models.forEach(m => { if (m && m.ready && m.grid) this._drawOne(ctx, m, size); });
  },

  _drawOne: function (ctx, m, size) {
    const off = this._bounds.min;
    // Layer points rather than container points: the canvas is positioned in
    // the layer plane, so anything projected has to be measured in the same
    // plane or it drifts by the pan offset.
    const pt = (lat, lng) => {
      const q = this._map.latLngToLayerPoint(L.latLng(lat, lng));
      return [q.x - off.x, q.y - off.y];
    };

    ctx.save();

    const ring = (m.ring || []).map(p => pt(p.lat, p.lng));
    if (ring.length > 2) {
      ctx.beginPath();
      ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.clip();
    }

    // The order a printed topographic sheet uses. Water bodies and buildings
    // are ground, so they go under the contours; roads and railways are the
    // reader's frame of reference, so they go over them. Labels are last of
    // all — a road drawn afterwards would run straight through a number.
    this._drawFill(ctx, pt, m);
    this._drawOsm(ctx, pt, m, ['waterbody', 'building']);
    const labels = this._drawLines(ctx, pt, m, size);
    this._drawOsm(ctx, pt, m, ['water', 'motorway', 'trunk', 'primary', 'secondary',
      'tertiary', 'minor', 'rail']);
    if (labels && labels.length) this._drawLabels(ctx, labels, m);

    ctx.restore();
    if (ring.length > 2) this._drawOutline(ctx, ring, m);
  },

  _drawFill: function (ctx, pt, m) {
    if (!m.fillCanvas) return;
    const g = m.grid;
    // The grid is a rectangle in the DEM's own Mercator pixel space, and the
    // map is the same projection, so its corners land on an axis-aligned
    // rectangle here — no warping needed, just the two corners.
    const nw = gridToLatLng(g, 0, 0);
    const se = gridToLatLng(g, g.w, g.h);
    const [x0, y0] = pt(nw.lat, nw.lng);
    const [x1, y1] = pt(se.lat, se.lng);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = m.fillOpacity == null ? 1 : m.fillOpacity;
    try { ctx.drawImage(m.fillCanvas, x0, y0, x1 - x0, y1 - y0); } catch (e) { /* mid-teardown */ }
    ctx.restore();
  },

  _drawLines: function (ctx, pt, m, size) {
    const lines = m.lines || [];
    if (!lines.length) return null;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.font = CONTOUR_LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const pad = 60;
    const labelled = [];

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const pts = new Array(ln.pts.length);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let k = 0; k < ln.pts.length; k++) {
        const q = pt(ln.pts[k][0], ln.pts[k][1]);
        pts[k] = q;
        if (q[0] < minX) minX = q[0];
        if (q[0] > maxX) maxX = q[0];
        if (q[1] < minY) minY = q[1];
        if (q[1] > maxY) maxY = q[1];
      }
      // Off-canvas lines still cost a stroke and a projection each. Skipping
      // them is most of the difference between a smooth zoom and a stutter on
      // a selection with thousands of contours.
      if (maxX < -pad || minX > size.x + pad || maxY < -pad || minY > size.y + pad) continue;

      const wantLabel = m.labels === 'all' || (m.labels === 'bold' && ln.bold);
      const stops = wantLabel ? this._labelStops(pts, m, ln) : null;

      ctx.strokeStyle = ln.bold ? m.boldColor : m.lineColor;
      ctx.lineWidth = ln.bold ? m.boldWidth : m.lineWidth;
      this._strokePath(ctx, pts, stops);

      if (stops) stops.forEach(s => labelled.push(s));
    }

    return labelled;
  },

  /**
   * The OpenStreetMap detail, drawn in the requested classes only so the
   * caller can put some of it under the contours and the rest over them.
   *
   * @param {string[]} kinds keys of OSM_DETAIL_STYLE, in paint order
   */
  _drawOsm: function (ctx, pt, m, kinds) {
    const feats = m.osm;
    if (!feats || !feats.length) return;
    const scale = m.osmWeight == null ? 1 : m.osmWeight;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    kinds.forEach(kind => {
      const st = OSM_DETAIL_STYLE[kind];
      if (!st) return;
      let opened = false;
      ctx.beginPath();

      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        if (f.cls !== kind) continue;
        const pts = f.pts;
        for (let k = 0; k < pts.length; k++) {
          const q = pt(pts[k][0], pts[k][1]);
          if (k === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
        }
        if (f.closed || st.fill) ctx.closePath();
        opened = true;
      }
      if (!opened) return;

      // One path per class rather than one per way: a city bbox is thousands
      // of ways, and thousands of separate strokes is thousands of state
      // changes for a picture that is all the same colour anyway.
      if (st.fill) { ctx.fillStyle = st.fill; ctx.fill('evenodd'); }
      if (st.w > 0) {
        ctx.setLineDash(st.dash || []);
        ctx.lineWidth = st.w * scale;
        ctx.strokeStyle = st.color;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    ctx.restore();
  },

  /**
   * Where to interrupt a line for its own label.
   * Walks the projected line by arc length, dropping an anchor every
   * CONTOUR_LABEL_SPACING pixels, and takes the tangent there so the number
   * lies along the contour the way it does on a printed sheet.
   */
  _labelStops: function (pts, m, ln) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    if (total < CONTOUR_LABEL_MIN_RUN) return null;

    const text = ln.label;
    const halfW = (text.length * 3.1) + 7;      // the gap to burn, half-width
    const n = Math.max(1, Math.round(total / CONTOUR_LABEL_SPACING));
    const step = total / n;
    // Offset by the level so labels on neighbouring contours stagger instead of
    // lining up in a row down the slope.
    const phase = (Math.abs(ln.level) % 7) / 7;
    const stops = [];

    let want = step * (0.5 + phase * 0.4), acc = 0;
    for (let i = 1; i < pts.length && stops.length < n; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const seg = Math.hypot(bx - ax, by - ay);
      if (seg <= 0) continue;
      while (acc + seg >= want && stops.length < n) {
        const f = (want - acc) / seg;
        let ang = Math.atan2(by - ay, bx - ax);
        // Never upside down: past a quarter turn either way, flip it. A reader
        // tilts their head a little, not all the way round.
        if (ang > Math.PI / 2) ang -= Math.PI;
        if (ang < -Math.PI / 2) ang += Math.PI;
        stops.push({
          x: ax + (bx - ax) * f, y: ay + (by - ay) * f,
          at: want, half: halfW, angle: ang, text, bold: ln.bold,
        });
        want += step;
      }
      acc += seg;
    }
    return stops.length ? stops : null;
  },

  /** Stroke a projected line, leaving a gap in it under each label. */
  _strokePath: function (ctx, pts, stops) {
    ctx.beginPath();
    if (!stops) {
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      return;
    }

    let acc = 0, si = 0, drawing = true;
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const seg = Math.hypot(bx - ax, by - ay);
      let done = 0;

      while (si < stops.length && seg > 0) {
        const s = stops[si];
        const edge = drawing ? s.at - s.half : s.at + s.half;
        if (edge > acc + seg) break;
        const f = (edge - acc - done) / (seg - done);
        const cx = ax + (bx - ax) * ((done + (seg - done) * f) / seg);
        const cy = ay + (by - ay) * ((done + (seg - done) * f) / seg);
        if (drawing) { ctx.lineTo(cx, cy); drawing = false; }
        else { ctx.moveTo(cx, cy); drawing = true; si++; }
        done = edge - acc;
      }

      if (drawing) ctx.lineTo(bx, by); else ctx.moveTo(bx, by);
      acc += seg;
    }
    ctx.stroke();
  },

  _drawLabels: function (ctx, stops, m) {
    ctx.save();
    ctx.font = CONTOUR_LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    stops.forEach(s => {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.angle);
      // A halo rather than a filled plate: the fill under a contour label is
      // the elevation colour, and a box would punch a hole in the very ramp
      // the label is describing.
      ctx.lineWidth = 3;
      ctx.strokeStyle = m.labelHalo;
      ctx.strokeText(s.text, 0, 0);
      ctx.fillStyle = s.bold ? m.boldColor : m.lineColor;
      ctx.fillText(s.text, 0, 0);
      ctx.restore();
    });
    ctx.restore();
  },

  _drawOutline: function (ctx, ring, m) {
    if (!m.showOutline) return;
    ctx.save();
    ctx.beginPath();
    ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.setLineDash([7, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = m.outlineColor || 'rgba(255,122,26,.9)';
    ctx.stroke();
    ctx.restore();
  },
});
