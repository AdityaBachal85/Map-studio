/**
 * The contour map, drawn.
 *
 * Elevation tiles are faked, but faked HONESTLY: the fixture encodes a smooth
 * Gaussian hill into real terrarium PNGs, as a function of longitude and
 * latitude rather than of tile pixels, so the surface is continuous across
 * every tile seam and every zoom the app might ask for. A mosaicking bug or a
 * decode bug therefore shows up as a broken contour, which is the point — a
 * stubbed decoder would prove only that the stub works.
 *
 * The hill's shape is known in advance, so the assertions can be about the
 * terrain rather than about "something was drawn": a single peak means nested
 * closed rings, a known height means a known number of levels, and the legend
 * has to agree with both.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/contour-render.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { elevPng } = require('./fake-tile-png.cjs');

const BASE = 'http://127.0.0.1:8000';
const REPO = path.join(__dirname, '..');
const localAuthConfig = () => fs.readFileSync(path.join(REPO, 'js', 'config.js'), 'utf8')
  .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = '';")
  .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = '';");

/** The hill: 420 m, about 2 km across, on a gentle regional slope. */
const PEAK = { lat: 19.235, lng: 72.94 };
const PEAK_H = 420;
const SPREAD = 0.011;
function elevAt(lng, lat) {
  const dx = (lng - PEAK.lng) / SPREAD, dy = (lat - PEAK.lat) / SPREAD;
  return PEAK_H * Math.exp(-(dx * dx + dy * dy)) + (lat - PEAK.lat) * 900 + 40;
}
const pxToLng = (px, z) => px / (256 * 2 ** z) * 360 - 180;
const pxToLat = (py, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * py / (256 * 2 ** z)))) * 180 / Math.PI;

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

(async () => {
  const b = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const p = await (await b.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));

  const demHits = [];
  // Catch-all first: Playwright matches the LAST matching route, so anything
  // registered after this one wins, and anything registered before would never
  // be reached.
  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));
  await p.route('**/elevation-tiles-prod/**', r => {
    const m = r.request().url().match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
    if (!m) return r.abort();
    const z = +m[1], tx = +m[2], ty = +m[3];
    demHits.push(z + '/' + tx + '/' + ty);
    const body = elevPng((i, j) =>
      elevAt(pxToLng(tx * 256 + i, z), pxToLat(ty * 256 + j, z)));
    return r.fulfill({
      status: 200, contentType: 'image/png', body,
      headers: { 'access-control-allow-origin': '*' },
    });
  });

  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);

  const wired = await p.evaluate(() => ({
    layer: typeof ContourLayer === 'function',
    gen: typeof generateContours === 'function',
    panel: !!document.getElementById('contourTgl'),
    card: !!document.getElementById('contourLegendCard'),
    inDraw: !!(document.getElementById('contourTgl') || {}).closest
      && !!document.getElementById('contourTgl').closest('#paneDraw'),
  }));
  ck('the contour module is loaded and its controls are in the Draw tab',
    wired.layer && wired.gen && wired.panel && wired.card && wired.inDraw, JSON.stringify(wired));
  if (!wired.gen) { await b.close(); process.exit(1); }

  /* -- generate ----------------------------------------------------------- */

  const built = await p.evaluate(async () => {
    map.setView([19.235, 72.94], 14);
    contourState.detail = 'high';
    contourState.interval = 20;
    contourState.labels = 'bold';
    contourState.boldEvery = 5;
    contourAreaFromView();
    setContourEnabled(true);
    const ok = await generateContours({ silent: true });
    const g = contourModel.grid;
    return {
      ok,
      ready: contourModel.ready,
      grid: g ? { w: g.w, h: g.h, zoom: g.zoom, min: +g.min.toFixed(1), max: +g.max.toFixed(1),
                  mps: +g.metresPerSample.toFixed(1), partial: g.partial } : null,
      lines: contourModel.lines.length,
      levels: [...new Set(contourModel.lines.map(l => l.level))].sort((a, z) => a - z),
      bold: contourModel.lines.filter(l => l.bold).length,
      fill: contourModel.fillCanvas ? [contourModel.fillCanvas.width, contourModel.fillCanvas.height] : null,
    };
  });

  ck('a contour map is generated from the elevation tiles',
    built.ok && built.ready && built.lines > 0,
    JSON.stringify({ ok: built.ok, lines: built.lines, grid: built.grid }));
  // Checked against the fixture's own formula rather than against numbers typed
  // in here: the summit is wherever elevAt() says it is, and a tolerance of one
  // sample's worth of relief allows for the grid landing beside the exact peak
  // rather than on it.
  const expectPeak = elevAt(PEAK.lng, PEAK.lat);
  ck('the DEM decodes to the height the fixture encoded',
    built.grid && Math.abs(built.grid.max - expectPeak) < 6,
    built.grid ? `read ${built.grid.max} m at the summit, fixture encodes ${expectPeak.toFixed(1)} m`
      : 'no grid');
  ck('and the regional slope comes through as well as the hill',
    built.grid && built.grid.min < expectPeak - 300,
    built.grid ? `${built.grid.min} m to ${built.grid.max} m` : 'no grid');
  ck('and it mosaics without holes',
    built.grid && !built.grid.partial, JSON.stringify(built.grid));
  ck('the fill is built at the grid\'s own resolution',
    built.fill && built.fill[0] === built.grid.w && built.fill[1] === built.grid.h,
    JSON.stringify(built.fill));

  const badLevel = built.levels.find(v => Math.abs(v / 20 - Math.round(v / 20)) > 1e-6);
  ck('every level sits on a multiple of the interval',
    badLevel === undefined, `${built.levels.length} levels, ${built.levels[0]}..${built.levels[built.levels.length - 1]}`);
  ck('bold contours are every fifth line, not every line',
    built.bold > 0 && built.bold < built.lines, `${built.bold} bold of ${built.lines}`);

  /* -- what is actually on the canvas ------------------------------------- */

  const painted = await p.evaluate(() => {
    const pane = document.querySelector('.leaflet-overlay-pane');
    const cv = pane.querySelector('canvas.contour-canvas');
    if (!cv) return { found: false };
    // A probe canvas, the technique the export check uses: shrink it and count
    // distinct colours. A blank or flat-filled canvas has one or two.
    const probe = document.createElement('canvas');
    probe.width = 60; probe.height = 60;
    const px = probe.getContext('2d');
    px.drawImage(cv, 0, 0, 60, 60);
    const d = px.getImageData(0, 0, 60, 60).data;
    const seen = new Set();
    let opaque = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 8) { opaque++; seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3)); }
    }
    return {
      found: true,
      first: pane.querySelector('canvas') === cv,
      colours: seen.size,
      coverage: opaque / (60 * 60),
      w: cv.width, h: cv.height,
    };
  });
  ck('the contour canvas is in the overlay pane', painted.found, JSON.stringify(painted));
  ck('and it is the first canvas there, so shapes and pins draw over it',
    painted.first === true, JSON.stringify(painted));
  ck('it is a real picture, not a flat wash',
    painted.colours > 20, `${painted.colours} distinct colours over ${(painted.coverage * 100).toFixed(0)}% of the canvas`);
  ck('and it covers the study area', painted.coverage > 0.5,
    `${(painted.coverage * 100).toFixed(0)}% opaque`);

  await p.screenshot({ path: path.join(__dirname, 'shot-contour-render.png') });

  /* -- the legend ---------------------------------------------------------- */

  const legend = await p.evaluate(() => {
    const card = document.getElementById('contourLegendCard');
    const bands = [...document.querySelectorAll('#contourLegendBands .cl-band')].map(el => ({
      text: el.textContent.trim(),
      bg: el.style.background || el.style.backgroundColor,
      ink: el.style.color,
    }));
    return {
      visible: !!card.offsetParent,
      bands,
      foot: document.getElementById('contourLegendFoot').textContent,
      area: document.getElementById('contourAreaInfo').textContent,
      stats: document.getElementById('contourStats').textContent,
    };
  });
  ck('the elevation scale is up', legend.visible === true, JSON.stringify({ visible: legend.visible }));
  ck('it is banded, one labelled block per contour band',
    legend.bands.length >= 4 && legend.bands.every(b => /^\d+ m$/.test(b.text)),
    `${legend.bands.length} bands: ${legend.bands.slice(0, 3).map(b => b.text).join(', ')} … ${legend.bands[legend.bands.length - 1].text}`);
  ck('the bands run high at the top, the way a scale reads',
    parseInt(legend.bands[0].text, 10) > parseInt(legend.bands[legend.bands.length - 1].text, 10),
    legend.bands[0].text + ' … ' + legend.bands[legend.bands.length - 1].text);
  ck('the band steps are even', (() => {
    const v = legend.bands.map(b => parseInt(b.text, 10));
    const d = v.slice(1).map((x, i) => v[i] - x);
    return d.every(x => x === d[0]);
  })(), legend.bands.map(b => b.text).join(' / '));
  ck('every band label is a level the map actually draws', await p.evaluate(bands => {
    const step = contourIntervalMetres();
    return bands.every(t => {
      const m = contourState.unit === 'ft' ? parseInt(t, 10) / 3.280839895 : parseInt(t, 10);
      return Math.abs(m / step - Math.round(m / step)) < 1e-6;
    });
  }, legend.bands.map(b => b.text)), `interval ${20} m`);
  ck('the footer states the interval and the true range',
    /20 m interval/i.test(legend.foot) && /–/.test(legend.foot), legend.foot);
  ck('the study area reports its size', /km²|ha|m²/.test(legend.area), legend.area);
  ck('and the panel states the resolution it actually achieved',
    /m per sample/.test(legend.stats), legend.stats.slice(0, 90));

  /* -- the legend's colours are the map's colours -------------------------- */

  // The claim a legend makes is that a colour on the map means a number. That
  // is checked here by reading the FILL ITSELF: for each band, find the grid
  // sample closest to that elevation, read the pixel the fill painted there,
  // and compare. Relief shading is switched off first — it deliberately
  // modulates the fill, so with it on the two would differ for a good reason
  // and the test would prove nothing either way.
  const accuracy = await p.evaluate(() => {
    contourState.shade = false;
    contourBuildFill();
    renderContourLegend();

    const g = contourModel.grid;
    const fill = contourModel.fillCanvas;
    const px = fill.getContext('2d').getImageData(0, 0, fill.width, fill.height).data;
    const hex = (r, gg, bl) => '#' + [r, gg, bl].map(v => v.toString(16).padStart(2, '0')).join('');

    const rows = [...document.querySelectorAll('#contourLegendBands .cl-band')];
    const out = [];
    rows.forEach(el => {
      const metres = parseInt(el.textContent, 10);
      // The sample whose height is closest to this band's level.
      let best = -1, bestD = Infinity;
      for (let i = 0; i < g.data.length; i += 7) {          // strided: 1-in-7 is plenty
        const d = Math.abs(g.data[i] - metres);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0 || bestD > 0.6) return;
      const o = best * 4;
      out.push({
        band: el.textContent.trim(),
        mapHex: hex(px[o], px[o + 1], px[o + 2]),
        legendHex: (el.style.background || '').trim(),
        atMetres: +g.data[best].toFixed(2),
      });
    });
    return out;
  });
  // Compared as numbers, not as text: the inline `background:#bf3016` is read
  // back from the DOM as `rgb(191, 48, 22)`, which is the same colour written
  // the browser's way.
  const rgb = v => {
    const m = String(v).match(/^#?([0-9a-f]{6})$/i);
    if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
    const n = String(v).match(/(\d+)\D+(\d+)\D+(\d+)/);
    return n ? [+n[1], +n[2], +n[3]] : null;
  };
  const mismatched = accuracy.filter(a => {
    const x = rgb(a.mapHex), y = rgb(a.legendHex);
    return !x || !y || x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2];
  });
  ck('every legend band is exactly the colour the map paints at that height',
    accuracy.length >= 3 && mismatched.length === 0,
    mismatched.length
      ? `${mismatched.length} mismatched, e.g. ${JSON.stringify(mismatched[0])}`
      : `${accuracy.length} bands checked against the fill, e.g. ${accuracy[0].band} = ${accuracy[0].mapHex}`);

  await p.evaluate(() => { contourState.shade = true; contourBuildFill(); contourRefresh(); });

  /* -- recompute policy: the expensive stage must not re-run --------------- */

  const before = demHits.length;
  const cheap = await p.evaluate(async () => {
    const n0 = contourModel.lines.length;
    contourState.interval = 100;
    contourBuildLines();
    const n1 = contourModel.lines.length;
    contourState.ramp = 'viridis';
    contourBuildFill();
    return { n0, n1 };
  });
  await p.waitForTimeout(400);
  ck('a wider interval means fewer contours',
    cheap.n1 < cheap.n0 && cheap.n1 > 0, `${cheap.n0} at 20 m -> ${cheap.n1} at 100 m`);
  ck('and neither the interval nor the ramp re-reads the elevation data',
    demHits.length === before, `${before} tile requests before, ${demHits.length} after`);
  ck('every elevation tile was fetched exactly once',
    new Set(demHits).size === demHits.length, `${demHits.length} requests, ${new Set(demHits).size} distinct`);

  /* -- contours as shapes -------------------------------------------------- */

  const shaped = await p.evaluate(() => {
    const before = geometries.length;
    contourState.interval = 100;
    contourBuildLines();
    contoursToShapes('all');
    const made = geometries.slice(before);
    return {
      added: made.length,
      allLines: made.every(g => g.shape === 'Line'),
      named: made[0] ? made[0].name : null,
      coloured: made[0] ? made[0].borderColor : null,
      hasCard: made[0] ? !!made[0].card : false,
    };
  });
  ck('contours convert into real editable shapes',
    shaped.added > 0 && shaped.allLines, JSON.stringify(shaped));
  ck('each carries its height as its name and a colour from the ramp',
    /^\d+ m$/.test(shaped.named || '') && /^#[0-9a-f]{6}$/i.test(shaped.coloured || ''),
    `${shaped.named} / ${shaped.coloured}`);
  ck('and gets a sidebar card like any other shape', shaped.hasCard === true);

  /* -- clearing takes the converted shapes with it -------------------------- */

  // The gap this closes: a converted contour was an ordinary Line as far as the
  // rest of the app was concerned, so clearing the contour map left every one
  // of them on the map with a sidebar card each and no way to tell them from
  // something drawn by hand.
  const tagged = await p.evaluate(() => {
    const mine = geometries.filter(g => g.fromContour);
    return { tagged: mine.length, total: geometries.length, level: mine[0] ? mine[0].contourLevel : null };
  });
  ck('converted contours are tagged as such',
    tagged.tagged > 0 && tagged.level != null, JSON.stringify(tagged));

  const cleared = await p.evaluate(() => {
    const handDrawn = registerGeom(L.polyline([[19.20, 72.90], [19.21, 72.91]]), 'Line',
      { name: 'drawn by hand' });
    const before = geometries.length;
    document.getElementById('contourClearBtn').click();
    return {
      before,
      after: geometries.length,
      survivor: geometries.some(g => g.id === handDrawn.id),
      leftovers: geometries.filter(g => g.fromContour).length,
      ready: contourModel.ready,
      onMap: !!document.querySelector('.leaflet-overlay-pane canvas.contour-canvas'),
      legend: !!document.getElementById('contourLegendCard').offsetParent,
      msg: document.getElementById('statusMsg').textContent,
    };
  });
  ck('clearing takes the layer and the legend off the map',
    !cleared.ready && !cleared.onMap && !cleared.legend, JSON.stringify({
      ready: cleared.ready, onMap: cleared.onMap, legend: cleared.legend }));
  ck('and the shapes the conversion created',
    cleared.leftovers === 0 && cleared.after < cleared.before,
    `${cleared.before} shapes -> ${cleared.after}, ${cleared.leftovers} contour shapes left`);
  ck('but not the ones drawn by hand', cleared.survivor === true);
  ck('and it says how many it removed', /converted shape/.test(cleared.msg), cleared.msg);

  const undone = await p.evaluate(() => {
    const btn = document.querySelector('#statusMsg .status-action');
    if (btn) btn.click();
    return { restored: geometries.filter(g => g.fromContour).length, on: contourState.on };
  });
  ck('and Undo puts them back', undone.restored > 0, JSON.stringify(undone));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
