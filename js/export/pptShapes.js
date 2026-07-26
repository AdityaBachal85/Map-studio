/**
 * pptShapes.js — native (editable) vector shapes: leader lines, icon frames,
 * and the title underline bar. Every shape is validated before it is added so a
 * degenerate object is skipped, not emitted.
 */


/**
 * Add a leader line as a native shape.
 *
 * Two-point leaders stay `line` shapes — the simplest thing PowerPoint can
 * represent, and the easiest to grab and nudge. Leaders with a shoulder (see
 * drawLeader() in map/billboard.js) become a `custGeom` freeform so the
 * exported connector has the same cartographic shape as the one on screen.
 *
 * @param {object} slide pptxgenjs slide.
 * @param {{a:{x:number,y:number}, b:{x:number,y:number}, color:string,
 *          points?:Array<{x:number,y:number}>}} leader
 * @param {{X:Function, Y:Function}} tf Coordinate transform.
 * @param {object} log Logger.
 * @param {Function} hex Colour normaliser (`hexColor`).
 * @returns {boolean} true when the line was added.
 */
function addLeaderLine(slide, leader, tf, log, hex) {
  if (leader.points && leader.points.length > 2) {
    return addVectorPath(slide, {
      kind: 'polyline', points: leader.points, color: leader.color, weight: 1.1,
    }, tf, log, hex);
  }
  const x1 = tf.X(leader.a.x), y1 = tf.Y(leader.a.y);
  const x2 = tf.X(leader.b.x), y2 = tf.Y(leader.b.y);
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) { log.skip('leader', 'zero-length'); return false; }
  const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(dx), h: Math.abs(dy) };
  if (!validateBox(box, log, 'leader', { allowZeroAxis: true })) return false;
  slide.addShape('line', {
    ...box,
    flipH: (dx < 0) !== (dy < 0),
    line: { color: hex(leader.color), width: 0.9 },
  });
  return true;
}

/** Points-per-inch, for converting a CSS-px stroke weight to a PowerPoint line width. */
const PT_PER_INCH = 72;

/**
 * Add a route, boundary, ring or measurement as a **native editable** shape.
 *
 * This is what stops the deck arriving with the routes burned into the map
 * picture. The map image is captured with its vector pane switched off (see
 * hiResRender.js) and every path is re-emitted here as PowerPoint geometry, so
 * a route can be selected, recoloured, re-routed or deleted in PowerPoint like
 * any other drawn object.
 *
 * Polylines and polygons become `custGeom` freeforms — a single object per
 * path, not one line shape per segment. Circles become ellipses, which is both
 * smaller and easier to edit than a 60-sided freeform.
 *
 * @param {object} slide pptxgenjs slide.
 * @param {{kind:string, points?:Array<{x:number,y:number}>,
 *          rings?:Array<Array<{x:number,y:number}>>,
 *          box?:{x:number,y:number,w:number,h:number},
 *          color:string, weight:number, dash?:string, opacity?:number,
 *          fill?:{color:string, opacity:number}}} path Source-px geometry.
 * @param {{X:Function, Y:Function, rr:number}} tf Coordinate transform.
 * @param {object} log Logger.
 * @param {Function} hex Colour normaliser.
 * @returns {boolean} true when a shape was added.
 */
function addVectorPath(slide, path, tf, log, hex) {
  const line = {
    color: hex(path.color),
    width: Math.max(0.5, (path.weight || 2) * tf.rr * PT_PER_INCH),
  };
  if (path.dash) line.dashType = path.dash;
  if (path.opacity != null && path.opacity < 1) line.transparency = Math.round((1 - path.opacity) * 100);

  const fill = path.fill
    ? { color: hex(path.fill.color), transparency: Math.round((1 - (path.fill.opacity == null ? 1 : path.fill.opacity)) * 100) }
    : { type: 'none' };

  if (path.kind === 'ellipse') {
    const box = { x: tf.X(path.box.x), y: tf.Y(path.box.y), w: path.box.w * tf.rr, h: path.box.h * tf.rr };
    if (!validateBox(box, log, 'vector-ellipse')) return false;
    slide.addShape('ellipse', { ...box, line, fill });
    return true;
  }

  // A polygon may have holes; each ring is its own closed sub-path inside one
  // custGeom, which is how PowerPoint expresses an even-odd fill.
  const rings = path.rings || [path.points || []];
  const flat = rings.reduce((a, r) => a.concat(r), []);
  if (flat.length < 2) { log.skip('vector', 'too-few-points'); return false; }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  flat.forEach(p => {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  });
  const box = {
    x: tf.X(minX), y: tf.Y(minY),
    w: Math.max(0.01, (maxX - minX) * tf.rr),
    h: Math.max(0.01, (maxY - minY) * tf.rr),
  };
  if (!validateBox(box, log, 'vector-path', { allowZeroAxis: true })) return false;

  // custGeom points are inches relative to the shape's own origin.
  const points = [];
  rings.forEach(ring => {
    ring.forEach((p, i) => {
      points.push({ x: (p.x - minX) * tf.rr, y: (p.y - minY) * tf.rr, moveTo: i === 0 });
    });
    if (path.kind === 'polygon') points.push({ close: true });
  });

  slide.addShape('custGeom', { ...box, points, line, fill });
  return true;
}

/** Map an icon frame name to a pptxgenjs shape type + corner radius. */
function frameGeometry(frame) {
  if (frame === 'circle') return { shape: 'ellipse', radius: 0 };
  if (frame === 'square') return { shape: 'roundRect', radius: 0.02 };
  if (frame === 'rounded') return { shape: 'roundRect', radius: 0.16 };
  return { shape: 'roundRect', radius: 0.5 };
}

/**
 * Add the background frame behind an icon pin (skipped for frame `none`).
 * @param {object} slide pptxgenjs slide.
 * @param {{x:number,y:number,w:number,h:number,frame:string,bg:string,borderColor:string,border:number}} pin
 * @param {object} log Logger.
 * @param {Function} hex Colour normaliser.
 * @returns {boolean} true when a frame shape was added.
 */
function addIconFrame(slide, pin, log, hex) {
  if (pin.frame === 'none') return false;
  if (!validateBox(pin, log, 'icon-frame')) return false;
  const { shape, radius } = frameGeometry(pin.frame);
  slide.addShape(shape, {
    x: pin.x, y: pin.y, w: pin.w, h: pin.h, rectRadius: safeRectRadius(radius, pin.w, pin.h),
    fill: { color: hex(pin.bg) },
    line: { color: hex(pin.borderColor), width: Math.max(0.5, pin.border) },
  });
  return true;
}

/**
 * Add the orange underline bar drawn under the title card.
 * @param {object} slide pptxgenjs slide.
 * @param {{x:number,y:number,w:number,h:number}} box Placement in inches.
 * @param {object} log Logger.
 * @param {string} [color] Bar colour hex (no `#`). Defaults to DBOT orange.
 * @returns {boolean} true when added.
 */
function addTitleUnderline(slide, box, log, color = 'FF7A1A') {
  if (!validateBox(box, log, 'title-underline')) return false;
  slide.addShape('rect', { ...box, fill: { color } });
  return true;
}
