/**
 * map/contourGen.js — contour extraction, smoothing and hypsometric shading.
 *
 * Pure arithmetic: no DOM, no Leaflet, no fetch. Everything here takes an
 * elevation grid and returns numbers. That is deliberate — it makes the whole
 * of the hard part testable in Node with no browser at all
 * (diagnostics/contour-math.cjs), which matters because the failure modes are
 * geometric and a screenshot will not tell you that two isolines crossed.
 *
 * A GRID is `{ w, h, data: Float32Array }` in row-major order, metres above sea
 * level, `NaN` for no data. Grid coordinates are sample-centred: sample (0,0)
 * sits at grid position (0,0), and a contour crossing at x = 3.5 lies halfway
 * between samples 3 and 4.
 *
 * WHY MARCHING SQUARES AND NOT A LIBRARY. d3-contour does this well, but it
 * returns filled bands as GeoJSON polygons, and this map wants open polylines
 * it can label along and taper. Vendoring 40 KB to then unpick its output was
 * more code than the 200 lines below, and it would have to be lazy-loaded to
 * avoid growing the boot payload for a feature most sessions never open.
 */

/* ---------------------------------------------------------------------------
 * Levels
 * ------------------------------------------------------------------------- */

/**
 * The contour levels crossing a range, at multiples of the interval.
 *
 * Levels land on multiples of the interval rather than starting at `min`, so
 * the 100 m line is at 100 m on every map at every interval and two maps of
 * neighbouring areas agree about where their shared contours are. Feet work
 * the same way: the caller passes an interval already converted to metres, so
 * a 20 ft interval puts levels on round foot values.
 *
 * @param {number} min @param {number} max @param {number} interval metres
 * @param {number} [cap] most levels to return; beyond it the interval is too
 *   fine for the relief and the map would be solid ink.
 * @returns {number[]}
 */
function contourLevels(min, max, interval, cap) {
  const out = [];
  if (!(interval > 0) || !isFinite(min) || !isFinite(max) || max <= min) return out;

  const limit = cap || 400;
  // Exclusive of a level sitting exactly on the minimum: a contour along the
  // lowest sample is not a line, it is the edge of the data.
  const first = Math.floor(min / interval) * interval + interval;
  for (let v = first; v <= max; v += interval) {
    out.push(Math.round(v * 1e6) / 1e6);   // kill the drift that repeated adding accumulates
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * How many levels an interval WOULD produce, without building them.
 * Used to warn before a slow render rather than during one.
 * @param {number} min @param {number} max @param {number} interval
 * @returns {number}
 */
function contourLevelCount(min, max, interval) {
  if (!(interval > 0) || !(max > min)) return 0;
  return Math.max(0, Math.floor(max / interval) - Math.floor(min / interval));
}

/* ---------------------------------------------------------------------------
 * Marching squares
 * ------------------------------------------------------------------------- */

/**
 * Isolines at one level, as chained polylines in grid coordinates.
 *
 * Each cell contributes at most two segments, and every segment endpoint lies
 * on exactly one cell EDGE. That is the whole trick behind the chaining: an
 * edge has an integer identity, so two segments meet when they name the same
 * edge — no float comparison, no rounding tolerance, no hash of a coordinate
 * pair. Chaining is then a pair of lookups per segment instead of a search
 * through them, which is the difference between linear and quadratic. The
 * first cut of this function used `indexOf` and took half a second on a single
 * 256x256 tile; a real selection is twenty times that area.
 *
 * @param {{w:number,h:number,data:Float32Array}} grid
 * @param {number} level
 * @returns {Array<Array<[number,number]>>} polylines; a closed ring repeats its
 *   first point as its last.
 */
function isoLines(grid, level) {
  const { w, h, data } = grid;
  if (w < 2 || h < 2) return [];

  // Segment i runs from edge sa[i] to edge sb[i]; px/py hold each edge's
  // crossing point, filled in as edges are first touched.
  const sa = [], sb = [];
  const px = new Map(), py = new Map();

  // Edge identities. A horizontal edge is the top of cell (x,y); a vertical
  // edge is its left. Doubling and adding a bit keeps the two families apart
  // in one integer space.
  const hEdge = (x, y) => 2 * (y * w + x);
  const vEdge = (x, y) => 2 * (y * w + x) + 1;

  const markH = (x, y, va, vb) => {          // between (x,y) and (x+1,y)
    const id = hEdge(x, y);
    if (!px.has(id)) { px.set(id, x + (level - va) / (vb - va)); py.set(id, y); }
    return id;
  };
  const markV = (x, y, va, vb) => {          // between (x,y) and (x,y+1)
    const id = vEdge(x, y);
    if (!px.has(id)) { px.set(id, x); py.set(id, y + (level - va) / (vb - va)); }
    return id;
  };

  const seg = (a, b) => { sa.push(a); sb.push(b); };

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = data[y * w + x], tr = data[y * w + x + 1];
      const bl = data[(y + 1) * w + x], br = data[(y + 1) * w + x + 1];
      // A void anywhere in the cell and the cell is skipped entirely. Treating
      // NaN as "below" instead would draw a shoreline around every hole in the
      // DEM and call it terrain.
      if (!(tl === tl && tr === tr && bl === bl && br === br)) continue;

      let idx = 0;
      if (tl > level) idx |= 8;
      if (tr > level) idx |= 4;
      if (br > level) idx |= 2;
      if (bl > level) idx |= 1;
      if (idx === 0 || idx === 15) continue;

      const T = () => markH(x, y, tl, tr);
      const B = () => markH(x, y + 1, bl, br);
      const L = () => markV(x, y, tl, bl);
      const R = () => markV(x + 1, y, tr, br);

      // Directed so the four single-corner cases run clockwise around the
      // corner they cut off, which makes every endpoint the start of exactly
      // one segment and the end of exactly one. The chainer relies on that.
      switch (idx) {
        case 8:  seg(L(), T()); break;                       // tl alone, above
        case 4:  seg(T(), R()); break;                        // tr alone, above
        case 2:  seg(R(), B()); break;                        // br alone, above
        case 1:  seg(B(), L()); break;                        // bl alone, above
        case 7:  seg(T(), L()); break;                        // tl alone, below
        case 11: seg(R(), T()); break;                        // tr alone, below
        case 13: seg(B(), R()); break;                        // br alone, below
        case 14: seg(L(), B()); break;                        // bl alone, below
        case 12: seg(L(), R()); break;                        // top half above
        case 3:  seg(R(), L()); break;                        // bottom half above
        case 9:  seg(B(), T()); break;                        // left half above
        case 6:  seg(T(), B()); break;                        // right half above
        // The two ambiguous cells. Opposite corners are above and the other
        // two below, so the contour can either pinch in the middle or pass
        // through it — and the two readings produce visibly different terrain.
        // The cell's own centre decides: bilinear interpolation puts it at the
        // average of the four corners, so if that is above the level the high
        // ground is joined through the middle and the contour must wrap the
        // two low corners instead.
        case 5: {                                             // tr + bl above
          if ((tl + tr + bl + br) / 4 > level) { seg(T(), L()); seg(B(), R()); }
          else { seg(T(), R()); seg(B(), L()); }
          break;
        }
        case 10: {                                            // tl + br above
          if ((tl + tr + bl + br) / 4 > level) { seg(R(), T()); seg(L(), B()); }
          else { seg(L(), T()); seg(R(), B()); }
          break;
        }
      }
    }
  }

  return chainSegments(sa, sb, px, py);
}

/**
 * Join directed segments end-to-start into the longest runs they support.
 *
 * Open lines are walked first, from the segments whose start nothing feeds
 * into — a line that runs off the edge of the grid has to keep both its ends,
 * and starting mid-line would split it in two. Whatever is left over is a
 * closed ring, walked afterwards from any point on it.
 *
 * @returns {Array<Array<[number,number]>>}
 */
function chainSegments(sa, sb, px, py) {
  const n = sa.length;
  if (!n) return [];

  const from = new Map();      // edge id -> index of the segment leaving it
  const into = new Map();      // edge id -> index of the segment arriving at it
  for (let i = 0; i < n; i++) { from.set(sa[i], i); into.set(sb[i], i); }

  const used = new Uint8Array(n);
  const lines = [];
  const pt = id => [px.get(id), py.get(id)];

  const walk = start => {
    const line = [pt(sa[start])];
    let i = start;
    for (;;) {
      used[i] = 1;
      line.push(pt(sb[i]));
      const next = from.get(sb[i]);
      // `next === i` cannot happen (a segment never returns to its own start),
      // and `used[next]` closes the ring.
      if (next === undefined || used[next]) break;
      i = next;
    }
    if (line.length > 1) lines.push(line);
  };

  for (let i = 0; i < n; i++) if (!used[i] && !into.has(sa[i])) walk(i);
  for (let i = 0; i < n; i++) if (!used[i]) walk(i);
  return lines;
}

/* ---------------------------------------------------------------------------
 * Shaping the lines
 * ------------------------------------------------------------------------- */

/**
 * Chaikin corner-cutting: the Smoothing control.
 *
 * A contour off a 30 m DEM is a staircase of half-cell steps, and at a 5 m
 * interval on gentle ground the staircase is most of what you see. Chaikin
 * replaces each corner with two points a quarter and three quarters along,
 * which pulls the line towards the shape the terrain implies without moving it
 * more than half a sample — so it stays honest about where the contour is.
 *
 * Each pass roughly doubles the point count, which is why the control tops out
 * at three: a fourth pass costs eight times the points for a curve nobody can
 * see is smoother.
 *
 * @param {Array<[number,number]>} pts @param {number} iters 0-3
 * @returns {Array<[number,number]>}
 */
function smoothLine(pts, iters) {
  let out = pts;
  const closed = pts.length > 2
    && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];

  for (let k = 0; k < (iters || 0); k++) {
    if (out.length < 3) break;
    const next = [];
    // An open line keeps its endpoints: they sit on the edge of the data, and
    // cutting that corner would pull the contour away from the boundary it is
    // supposed to meet. A ring has no endpoints to keep.
    if (!closed) next.push(out[0]);
    const last = closed ? out.length - 1 : out.length - 1;
    for (let i = 0; i < last; i++) {
      const [x0, y0] = out[i], [x1, y1] = out[i + 1];
      next.push([x0 + (x1 - x0) * 0.25, y0 + (y1 - y0) * 0.25]);
      next.push([x0 + (x1 - x0) * 0.75, y0 + (y1 - y0) * 0.75]);
    }
    if (closed) next.push(next[0]); else next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/**
 * Douglas-Peucker, run after smoothing rather than instead of it.
 *
 * Marching squares emits a vertex per cell edge whether the line bends there
 * or not, so a contour crossing flat ground diagonally is hundreds of points
 * describing a straight line. Dropping the ones that sit within a tolerance of
 * the chord is invisible on screen and is most of the difference between a
 * responsive pan and a stuttering one.
 *
 * @param {Array<[number,number]>} pts @param {number} tol in grid samples
 * @returns {Array<[number,number]>}
 */
function simplifyLine(pts, tol) {
  const n = pts.length;
  if (!(tol > 0) || n < 3) return pts;

  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tol2 = tol * tol;
  // An explicit stack rather than recursion: a 200,000-point ring off a big
  // selection would blow the call stack, and it would do it only for the
  // operators with the most interesting terrain.
  const stack = [[0, n - 1]];

  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;

    let far = -1, best = tol2;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i];
      let d2;
      if (len2 === 0) {
        d2 = (x - ax) * (x - ax) + (y - ay) * (y - ay);
      } else {
        let t = ((x - ax) * dx + (y - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + t * dx - x, cy = ay + t * dy - y;
        d2 = cx * cx + cy * cy;
      }
      if (d2 > best) { best = d2; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** Total length of a polyline, in grid samples. Used to drop specks. */
function lineLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
    d += Math.sqrt(dx * dx + dy * dy);
  }
  return d;
}

/* ---------------------------------------------------------------------------
 * Sampling and shading
 * ------------------------------------------------------------------------- */

/**
 * Bilinear sample of the grid at fractional coordinates.
 * @returns {number} metres, or NaN outside the grid or over a void.
 */
function sampleGrid(grid, gx, gy) {
  const { w, h, data } = grid;
  if (!(gx >= 0 && gy >= 0 && gx <= w - 1 && gy <= h - 1)) return NaN;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = gx - x0, fy = gy - y0;
  const a = data[y0 * w + x0], b = data[y0 * w + x1];
  const c = data[y1 * w + x0], d = data[y1 * w + x1];
  if (!(a === a && b === b && c === c && d === d)) return NaN;
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/**
 * Relief shading computed from THIS grid, as a 0..1 brightness per sample.
 *
 * The app already carries an Esri hillshade tile layer, but that is a picture
 * of the whole world at a fixed exaggeration and a fixed sun. This one is
 * derived from the same samples the contours are, so it agrees with them
 * exactly — no half-pixel drift between a ridge line and the shadow beside it —
 * and it can be lit and exaggerated to suit the map.
 *
 * Horn's operator over the 3x3 neighbourhood, lit from the north-west at 45
 * degrees, which is the convention every printed relief map uses. Lighting
 * from the south-east is equally valid physics and reliably reads as craters
 * instead of hills.
 *
 * @param {{w:number,h:number,data:Float32Array}} grid
 * @param {number} metresPerSample ground distance between samples
 * @param {number} [exaggeration]
 * @returns {Float32Array} one brightness per sample, 0 (shadow) to 1 (lit)
 */
function hillshadeGrid(grid, metresPerSample, exaggeration) {
  const { w, h, data } = grid;
  const out = new Float32Array(w * h);
  const z = exaggeration || 1;
  const sc = 8 * Math.max(0.0001, metresPerSample);
  const az = (360 - 315 + 90) * Math.PI / 180;     // north-west, in maths angles
  const alt = 45 * Math.PI / 180;
  const sinAlt = Math.sin(alt), cosAlt = Math.cos(alt);

  const at = (x, y) => {
    const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
    const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
    return data[cy * w + cx];
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1);
      const d = at(x - 1, y), f = at(x + 1, y);
      const g = at(x - 1, y + 1), i = at(x, y + 1), j = at(x + 1, y + 1);
      if (!(a === a && b === b && c === c && d === d && f === f && g === g && i === i && j === j)) {
        out[y * w + x] = 1;                        // a void is left unshaded
        continue;
      }
      const dzdx = ((c + 2 * f + j) - (a + 2 * d + g)) / sc * z;
      const dzdy = ((g + 2 * i + j) - (a + 2 * b + c)) / sc * z;
      const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const v = cosAlt * Math.cos(slope) + sinAlt * Math.sin(slope) * Math.cos(az - aspect);
      out[y * w + x] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
  return out;
}

/**
 * The hypsometric fill: one RGBA pixel per grid sample.
 *
 * Returned as a plain `{width, height, data}` rather than an `ImageData` so
 * this file stays runnable in Node. The renderer wraps it in a real ImageData,
 * which is a zero-copy constructor call.
 *
 * @param {{w:number,h:number,data:Float32Array}} grid
 * @param {Uint8ClampedArray} lut 256*3 ramp bytes, from rampLut()
 * @param {object} o `{min, max, alpha, shade, shadeStrength}`
 * @returns {{width:number, height:number, data:Uint8ClampedArray}}
 */
function hypsoPixels(grid, lut, o) {
  const { w, h, data } = grid;
  const out = new Uint8ClampedArray(w * h * 4);
  const min = o.min, span = (o.max - o.min) || 1;
  const alpha = Math.round(255 * (o.alpha == null ? 1 : o.alpha));
  const shade = o.shade || null;
  const k = o.shadeStrength == null ? 0.55 : o.shadeStrength;

  for (let i = 0; i < w * h; i++) {
    const v = data[i];
    if (v !== v) { out[i * 4 + 3] = 0; continue; }     // void stays transparent
    let t = (v - min) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const s = (t * 255) | 0;
    let r = lut[s * 3], g = lut[s * 3 + 1], b = lut[s * 3 + 2];
    if (shade) {
      // Blended towards the shading rather than multiplied by it: a straight
      // multiply drags the whole map towards black and the low end of the ramp
      // turns to mud. This keeps the ramp's own colour and lets the relief
      // modulate it.
      const m = 1 - k + k * (0.4 + 1.2 * shade[i]);
      r *= m; g *= m; b *= m;
    }
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = alpha;
  }
  return { width: w, height: h, data: out };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    contourLevels, contourLevelCount, isoLines, chainSegments,
    smoothLine, simplifyLine, lineLength, sampleGrid, hillshadeGrid, hypsoPixels,
  };
}
