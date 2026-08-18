/**
 * The contour maths, proved without a browser.
 *
 * Every failure mode here is geometric — a ring that does not close, two
 * isolines crossing at a saddle, a chainer that is quietly quadratic — and none
 * of them show up in a screenshot until the map is already wrong. So the maths
 * is tested against surfaces whose contours are known in advance: a cone (whose
 * every contour is a closed ring), a plane (parallel straight lines), and a
 * saddle (the one cell configuration marching squares cannot resolve from the
 * corners alone).
 *
 *   node diagnostics/contour-math.cjs
 *
 * No server and no network: it requires the app's own files directly.
 */
const path = require('path');
const REPO = path.join(__dirname, '..');

// The app's files are plain scripts sharing lexical globals, not modules. The
// two that matter here export themselves under Node; contourRamps additionally
// needs the colour helpers that utils/color.js would have provided.
global.hexToRgb = h => ({
  r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16),
});
global.rgbToHex = (r, g, b) =>
  '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

const G = require(path.join(REPO, 'js/map/contourGen.js'));
const P = require(path.join(REPO, 'js/map/contourRamps.js'));

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

/** Build a grid from f(x, y) -> metres. */
function surface(w, h, f) {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y);
  return { w, h, data };
}
const isClosed = l =>
  l.length > 2 && Math.abs(l[0][0] - l[l.length - 1][0]) < 1e-9 && Math.abs(l[0][1] - l[l.length - 1][1]) < 1e-9;

/* -- levels ---------------------------------------------------------------- */

const lv = G.contourLevels(-1, 451, 25);
ck('levels land on multiples of the interval, not on the minimum',
  lv[0] === 0 && lv[1] === 25 && lv[lv.length - 1] === 450,
  `first=${lv[0]} second=${lv[1]} last=${lv[lv.length - 1]} n=${lv.length}`);
ck('a level exactly on the minimum is excluded',
  G.contourLevels(100, 200, 50)[0] === 150, JSON.stringify(G.contourLevels(100, 200, 50)));
ck('the level cap is honoured', G.contourLevels(0, 100000, 1, 400).length === 400);
ck('a nonsense interval yields nothing',
  G.contourLevels(0, 100, 0).length === 0 && G.contourLevels(0, 100, -5).length === 0);
ck('the count predictor agrees with the generator',
  G.contourLevelCount(-1, 451, 25) === lv.length,
  `predicted=${G.contourLevelCount(-1, 451, 25)} actual=${lv.length}`);

/* -- a cone: every contour is a closed ring -------------------------------- */

const cone = surface(120, 120, (x, y) => {
  const d = Math.hypot(x - 60, y - 60);
  return Math.max(0, 50 - d * 0.8);
});
let coneLines = 0, coneOpen = 0;
[10, 20, 30, 40].forEach(l => {
  G.isoLines(cone, l).forEach(line => { coneLines++; if (!isClosed(line)) coneOpen++; });
});
ck('a cone yields one contour per level', coneLines === 4, `lines=${coneLines}`);
ck('and every one of them is a closed ring', coneOpen === 0, `open=${coneOpen}/${coneLines}`);

// Radius should shrink as the level rises — the rings are nested, not stacked.
const radii = [10, 20, 30, 40].map(l => {
  const r = G.isoLines(cone, l)[0];
  return r ? Math.hypot(r[0][0] - 60, r[0][1] - 60) : NaN;
});
ck('the rings nest, tightening as the level rises',
  radii.every((v, i) => i === 0 || v < radii[i - 1]), radii.map(v => v.toFixed(1)).join(' > '));

/* -- a plane: parallel straight lines that reach both edges ---------------- */

const plane = surface(80, 60, x => x * 2);              // 0..158 m, contours vertical
const pl = G.isoLines(plane, 100);
ck('a plane yields exactly one contour per level', pl.length === 1, `lines=${pl.length}`);
ck('and it spans the full height of the grid',
  pl[0] && Math.abs(pl[0][0][1] - pl[0][pl[0].length - 1][1]) === 59,
  pl[0] ? `y ${pl[0][0][1]} -> ${pl[0][pl[0].length - 1][1]}` : 'none');
ck('and it is straight, sitting exactly where the level crosses',
  pl[0] && pl[0].every(p => Math.abs(p[0] - 50) < 1e-9), pl[0] ? `x0=${pl[0][0][0]}` : 'none');

/* -- a saddle: the ambiguous case must not produce crossing lines ---------- */

// z = (x-c)(y-c) is a hyperbolic paraboloid; the level 0 runs exactly through
// the saddle point, which is the configuration marching squares cannot resolve
// from the four corners alone.
const saddle = surface(41, 41, (x, y) => (x - 20) * (y - 20) / 20);
const sd = G.isoLines(saddle, 0);

function segsCross(a1, a2, b1, b2) {
  const d = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const shares = p => (p[0] === a1[0] && p[1] === a1[1]) || (p[0] === a2[0] && p[1] === a2[1]);
  if (shares(b1) || shares(b2)) return false;          // touching at a shared vertex is fine
  const d1 = d(a1, a2, b1), d2 = d(a1, a2, b2), d3 = d(b1, b2, a1), d4 = d(b1, b2, a2);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
const segs = [];
sd.forEach(l => { for (let i = 1; i < l.length; i++) segs.push([l[i - 1], l[i]]); });
let crossings = 0;
for (let i = 0; i < segs.length; i++) {
  for (let j = i + 1; j < segs.length; j++) {
    if (segsCross(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) crossings++;
  }
}
ck('a saddle produces contours', sd.length >= 2, `lines=${sd.length}`);
ck('and no two of their segments cross', crossings === 0, `crossings=${crossings}, segs=${segs.length}`);

// Both readings of the ambiguous cell are legitimate; what matters is that the
// choice is consistent, so the same grid always gives the same answer.
const again = G.isoLines(saddle, 0);
ck('the ambiguous cell resolves the same way every time',
  JSON.stringify(again) === JSON.stringify(sd));

/* -- voids ----------------------------------------------------------------- */

const holed = surface(60, 60, (x, y) => (x > 25 && x < 35 && y > 25 && y < 35) ? NaN : x);
const hl = G.isoLines(holed, 30);
const throughHole = hl.some(l => l.some(p => p[0] > 25 && p[0] < 35 && p[1] > 25 && p[1] < 35));
ck('no data is left as a hole, not contoured through', !throughHole, `lines=${hl.length}`);

/* -- chaining stays linear ------------------------------------------------- */

const bump = (w, h) => surface(w, h, (x, y) =>
  60 * Math.sin(x / 9) * Math.cos(y / 11) + 30 * Math.sin((x + y) / 17));
const timeFor = (w, h) => {
  const g = bump(w, h);
  const levels = G.contourLevels(-90, 90, 4);
  const t0 = Date.now();
  let pts = 0;
  levels.forEach(l => G.isoLines(g, l).forEach(li => { pts += li.length; }));
  return { ms: Date.now() - t0, pts, levels: levels.length };
};
const small = timeFor(150, 150);
const big = timeFor(600, 600);          // 16x the cells
// Quadratic chaining would be ~256x here. Linear is ~16x. The bound is loose
// enough to survive a noisy machine and tight enough that indexOf can never
// sneak back in.
const ratio = big.ms / Math.max(1, small.ms);
ck('a 600x600 grid at a 4 m interval finishes promptly',
  big.ms < 4000, `${big.ms} ms for ${big.levels} levels, ${big.pts} points`);
ck('chaining scales with the work, not with its square',
  ratio < 60, `150^2 ${small.ms} ms -> 600^2 ${big.ms} ms (x${ratio.toFixed(1)}, 16x the cells)`);

/* -- smoothing and simplification ------------------------------------------ */

const openLine = [[0, 0], [10, 0], [10, 10], [20, 10]];
const sm = G.smoothLine(openLine, 2);
ck('smoothing keeps an open line\'s endpoints where the data put them',
  sm[0][0] === 0 && sm[0][1] === 0 && sm[sm.length - 1][0] === 20 && sm[sm.length - 1][1] === 10,
  `${JSON.stringify(sm[0])} .. ${JSON.stringify(sm[sm.length - 1])}`);
ck('and it adds detail rather than moving the line',
  sm.length > openLine.length && sm.every(p => p[0] >= -0.01 && p[0] <= 20.01),
  `${openLine.length} -> ${sm.length} points`);

const ring = G.isoLines(cone, 20)[0];
ck('a smoothed ring is still closed', isClosed(G.smoothLine(ring, 3)),
  `${ring.length} -> ${G.smoothLine(ring, 3).length} points`);

const straight = Array.from({ length: 200 }, (_, i) => [i, 50]);
ck('simplification collapses a straight run to its endpoints',
  G.simplifyLine(straight, 0.5).length === 2, `${G.simplifyLine(straight, 0.5).length} points`);
const kept = G.simplifyLine(ring, 0.4);
ck('and keeps the shape of a ring while dropping its redundant points',
  kept.length < ring.length && kept.length > 8 && isClosed(kept),
  `${ring.length} -> ${kept.length} points`);
ck('simplification survives a line long enough to blow a recursive stack',
  G.simplifyLine(Array.from({ length: 200000 }, (_, i) => [i, Math.sin(i / 100) * 5]), 0.1).length > 2);

/* -- sampling, shading, fill ----------------------------------------------- */

ck('bilinear sampling reads between the samples',
  Math.abs(G.sampleGrid(plane, 10.5, 3) - 21) < 1e-6, String(G.sampleGrid(plane, 10.5, 3)));
ck('and returns NaN off the grid', Number.isNaN(G.sampleGrid(plane, -1, 0)));

const shade = G.hillshadeGrid(cone, 30, 1);
const nw = shade[45 * 120 + 45], se = shade[75 * 120 + 75];
ck('relief is lit from the north-west, so a cone\'s far side is darker',
  nw > se, `nw=${nw.toFixed(3)} se=${se.toFixed(3)}`);
ck('relief brightness stays inside 0..1',
  shade.every(v => v >= 0 && v <= 1));

const px = G.hypsoPixels(cone, P.rampLut(P.contourRamp('rainbow')), { min: 0, max: 50, alpha: 1 });
ck('the fill covers every sample', px.data.length === 120 * 120 * 4);
const seen = new Set();
for (let i = 0; i < px.data.length; i += 4) seen.add(px.data[i] + ',' + px.data[i + 1] + ',' + px.data[i + 2]);
ck('and spans many colours rather than one flat wash', seen.size > 30, `${seen.size} distinct colours`);

const voided = G.hypsoPixels(holed, P.rampLut(P.contourRamp('rainbow')), { min: 0, max: 60, alpha: 1 });
ck('a void is transparent in the fill, not black',
  voided.data[(30 * 60 + 30) * 4 + 3] === 0,
  `alpha=${voided.data[(30 * 60 + 30) * 4 + 3]}`);

console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
process.exit(R.every(Boolean) ? 0 : 1);
