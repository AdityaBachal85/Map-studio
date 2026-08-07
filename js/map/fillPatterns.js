/**
 * map/fillPatterns.js — hatched and stippled fills for drawn shapes.
 *
 * A flat translucent wash is the wrong symbol for a lake. On satellite imagery
 * it either hides the water — the one thing the shape is pointing at — or it is
 * so faint nobody sees the shape at all, and there is no setting between those
 * two that works. Every printed map solves this the same way and has for two
 * centuries: you fill water with ruled lines. The tint says "this area", the
 * lines say "this is water", and the imagery stays visible through the gaps.
 *
 * HOW. SVG `<pattern>`, referenced as `fill="url(#id)"` on the path Leaflet
 * already draws. Two details that are not optional:
 *
 *   The defs go inside the *same* `<svg>` element as the path, not a shared one
 *   parked elsewhere in the document. On screen a document-wide fragment
 *   reference resolves fine — but html2canvas exports an SVG by serialising
 *   that one element to a data URI, and a pattern living in a different element
 *   is simply not in the serialised copy. The fill silently falls back to
 *   nothing, and the shape exports as an outline with a hole in it.
 *
 *   Tiles must repeat seamlessly, which means no stroke may cross a tile edge
 *   unless the piece that leaves one side is drawn back in on the other. The
 *   diagonals below carry those extra corner strokes for exactly that reason;
 *   without them a hatch shows a visible grid of seams at every tile boundary.
 *
 * WHAT DOES NOT CARRY IT. Canvas-rendered layers have no `_path` to hang a fill
 * on, so glow halos and routes are unaffected by design. PowerPoint export
 * re-emits shapes as native objects and gets a flat fill, because a PPTX shape
 * has no equivalent — the picture in the PPTX is right, the editable object
 * behind it is a solid colour. KML has the same limitation and the same
 * outcome. The PNG/JPEG exports do carry it: see applyFillPatternTo() and its
 * caller in export/hiResRender.js.
 */

/** [value, label] for the Fill select on a shape card. */
const FILL_PATTERN_OPTS = [
  ['none', 'Solid'],
  ['water', 'Water'],
  ['hatch', 'Hatched'],
  ['crosshatch', 'Cross-hatch'],
  ['vertical', 'Ruled'],
  ['grid', 'Grid'],
  ['dots', 'Stipple'],
];

/**
 * One tile per pattern: its size in px and the marks inside it.
 *
 * `w` is a stroke-width multiplier, so a pattern that reads as heavy at 1.4 can
 * be tuned without touching the geometry. Sizes are chosen so that at a normal
 * zoom a small pond still shows three or four lines — a tile any larger and a
 * shape the size of a plot looks like it was filled with nothing.
 */
const FILL_PATTERN_TILES = {
  // Two rows of short ruled strokes, offset — the standard "open water" mark.
  // Neither stroke touches a tile edge, so this one tiles trivially.
  water: { size: 24, w: 1.3, marks: c =>
    `<path d="M1,5 h10 M13,15 h10" stroke="${c}" stroke-width="1.3" stroke-linecap="round" fill="none"/>` },

  // 45 degrees. The two short corner strokes are the halves of the diagonal
  // that leave the tile, drawn back in on the opposite side.
  hatch: { size: 8, w: 1.4, marks: c =>
    `<path d="M0,8 L8,0 M-2,2 L2,-2 M6,10 L10,6" stroke="${c}" stroke-width="1.4" fill="none"/>` },

  crosshatch: { size: 8, w: 1.2, marks: c =>
    `<path d="M0,8 L8,0 M-2,2 L2,-2 M6,10 L10,6 M0,0 L8,8 M-2,6 L2,10 M6,-2 L10,2"`
    + ` stroke="${c}" stroke-width="1.2" fill="none"/>` },

  vertical: { size: 7, w: 1.4, marks: c =>
    `<path d="M3.5,0 v7" stroke="${c}" stroke-width="1.4" fill="none"/>` },

  // Drawn on the top and left edges, which is what makes a grid tile: each
  // line is completed by the neighbouring tile's opposite edge.
  grid: { size: 10, w: 1.1, marks: c =>
    `<path d="M0,0 h10 M0,0 v10" stroke="${c}" stroke-width="1.1" fill="none"/>` },

  dots: { size: 8, w: 1, marks: c =>
    `<circle cx="2" cy="2" r="1.2" fill="${c}"/><circle cx="6" cy="6" r="1.2" fill="${c}"/>` },
};

/** @param {string} kind @returns {boolean} whether this is a real pattern */
function isFillPattern(kind) {
  return !!kind && kind !== 'none' && !!FILL_PATTERN_TILES[kind];
}

/**
 * Find or create the pattern def inside one `<svg>`, and return its fill value.
 *
 * Cached by everything that affects the drawing — kind, colour and scale — so a
 * map with forty hatched plots holds one def, not forty. The id is derived from
 * those same three things rather than a counter, which is what makes the lookup
 * a `getElementById` instead of bookkeeping.
 *
 * @param {SVGSVGElement} svg
 * @param {string} kind
 * @param {string} color
 * @param {number} scale tile multiplier, >1 for a high-resolution export
 * @returns {string} a `url(#id)` fill value, or the colour if unsupported
 */
function ensureFillPattern(svg, kind, color, scale) {
  const tile = FILL_PATTERN_TILES[kind];
  if (!svg || !tile) return color;

  const s = (isFinite(scale) && scale > 0) ? scale : 1;
  const id = 'dbot-fp-' + kind + '-' + String(color || '').replace(/[^a-z0-9]/gi, '') + '-' + Math.round(s * 100);

  // Scoped to this svg: two renderers (screen and export) legitimately hold
  // patterns with the same id, and a document-wide lookup would hand the export
  // the screen's un-scaled tile.
  if (svg.querySelector('#' + CSS.escape(id))) return 'url(#' + id + ')';

  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }

  const size = tile.size;
  const pat = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
  pat.setAttribute('id', id);
  pat.setAttribute('patternUnits', 'userSpaceOnUse');
  pat.setAttribute('width', String(size * s));
  pat.setAttribute('height', String(size * s));
  // The marks are authored once at tile size and scaled by the viewBox, so an
  // export at 3x gets the same drawing three times larger rather than the same
  // hairlines spaced three times further apart.
  pat.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
  pat.innerHTML = tile.marks(color || '#FF7A1A');
  defs.appendChild(pat);

  return 'url(#' + id + ')';
}

/**
 * Put a pattern fill on a Leaflet path, or take one off.
 *
 * Called after every setStyle(), because Leaflet writes `fill` from fillColor
 * each time and would otherwise wipe the pattern the moment anything else about
 * the shape changed — a border colour, the opacity slider, a corner style.
 *
 * @param {L.Path} layer
 * @param {string} kind
 * @param {string} color
 * @param {number} [scale] tile multiplier for high-resolution export
 */
function applyFillPatternTo(layer, kind, color, scale) {
  if (!layer) return;
  // Recorded on the layer as well as the geometry record, because the export
  // path clones layers by their options and never sees the record.
  layer.options.fillPattern = kind || 'none';

  const path = layer._path;
  if (!path) {
    // No path yet. registerGeom() styles a shape before it puts it on the map,
    // and Leaflet only creates the element on add — so without this a shape
    // built with a pattern arrived flat, and only picked the pattern up if you
    // happened to touch one of its other controls afterwards. Re-read from
    // options on the way in, so a style change between now and then wins.
    if (isFillPattern(kind) && layer.once) {
      layer.once('add', () => applyFillPatternTo(layer, layer.options.fillPattern, layer.options.fillColor, scale));
    }
    return;                          // canvas-rendered, or a divIcon marker
  }

  if (!isFillPattern(kind)) {
    // setStyle has already written the flat colour; only a leftover url() from
    // a pattern that was just switched off needs clearing.
    if (String(path.getAttribute('fill') || '').indexOf('url(') === 0) {
      path.setAttribute('fill', layer.options.fillColor || color || 'none');
    }
    return;
  }

  const svg = path.ownerSVGElement;
  if (!svg) return;
  path.setAttribute('fill', ensureFillPattern(svg, kind, color, scale));
}

/* ---------------------------------------------------------------------------
 * The same patterns, on canvas, for export
 * ------------------------------------------------------------------------ */

/**
 * WHY THERE IS A SECOND PATH AT ALL.
 *
 * The PNG/JPEG exporter rebuilds the map offscreen with `preferCanvas` and
 * rasterises it with html2canvas. That was measured, not assumed: cloning a
 * shape onto Leaflet's SVG renderer so it could carry an SVG pattern made the
 * shape vanish from the export entirely — no fill and no border — while the
 * identical shape on the canvas renderer came through solid. html2canvas does
 * not rasterise Leaflet's transformed SVG overlay pane; it handles a <canvas>
 * natively, which is exactly why the exporter was built on canvas.
 *
 * So screen and export take different routes to the same picture: SVG
 * <pattern> on screen, where it is crisp and updates live, and a CanvasPattern
 * for export. They cannot drift apart, because both are drawn from the one set
 * of tile definitions above — the export rasterises that very SVG through an
 * Image rather than reimplementing it with canvas calls.
 *
 * The trick that makes it small: Leaflet's canvas renderer assigns
 * `options.fillColor` straight to `ctx.fillStyle`, and fillStyle accepts a
 * CanvasPattern as readily as a colour string. Nothing in Leaflet needs
 * patching — the layer is simply handed a pattern where it expected a colour.
 */

/**
 * Rasterise one tile to an Image, ready for createPattern.
 * @param {string} kind @param {string} color @param {number} px tile size
 * @returns {Promise<HTMLImageElement|null>}
 */
function fillPatternImage(kind, color, px) {
  const tile = FILL_PATTERN_TILES[kind];
  if (!tile) return Promise.resolve(null);

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '"'
    + ' viewBox="0 0 ' + tile.size + ' ' + tile.size + '">' + tile.marks(color || '#FF7A1A') + '</svg>';

  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    // Not a Blob URL: this is measured in hundreds of bytes, and a data URI has
    // no lifetime to manage — no revoke to forget in an export path that can
    // bail out at half a dozen points.
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

/**
 * Give a canvas-rendered layer a pattern fill.
 *
 * @param {L.Path} layer must already be on a map with a canvas renderer
 * @param {string} kind @param {string} color
 * @param {number} [scale] tile multiplier for high-resolution export
 * @returns {Promise<boolean>} whether a pattern was applied
 */
async function applyCanvasFillPattern(layer, kind, color, scale) {
  if (!layer || !isFillPattern(kind)) return false;
  const ctx = layer._renderer && layer._renderer._ctx;
  if (!ctx || typeof ctx.createPattern !== 'function') return false;

  const tile = FILL_PATTERN_TILES[kind];
  const img = await fillPatternImage(kind, color, Math.max(2, Math.round(tile.size * (scale || 1))));
  if (!img) return false;

  let pattern;
  try { pattern = ctx.createPattern(img, 'repeat'); } catch (e) { return false; }
  if (!pattern) return false;

  layer.options.fillColor = pattern;
  if (layer.redraw) layer.redraw();
  return true;
}

/**
 * The fill opacity a pattern wants when it is first switched on.
 *
 * A pattern is mostly gaps, so it needs far more opacity than a wash to read at
 * all — the 25% default that suits a solid fill leaves a hatch nearly invisible
 * over satellite imagery. Rather than silently overriding the slider, the panel
 * moves it: the change is visible, and dragging it back does what it says.
 *
 * @param {number} current @returns {number} the opacity to use
 */
function fillPatternOpacityFor(current) {
  return current < 0.5 ? 0.8 : current;
}
