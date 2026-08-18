/**
 * The contour map's settings: driven by the controls, and carried by the
 * project file.
 *
 * The interesting assertion is a negative one. The contours themselves must NOT
 * be in the project file — half a million coordinates would dwarf everything
 * else in it, and they are derived data that comes back for the cost of one DEM
 * read. So this measures the serialised size with a contour map on the map and
 * insists it stays small, which is the only check that actually fails if
 * somebody later "helpfully" caches the lines into the save.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/contour-state.cjs
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

const PEAK = { lat: 19.235, lng: 72.94 };
function elevAt(lng, lat) {
  const dx = (lng - PEAK.lng) / 0.011, dy = (lat - PEAK.lat) / 0.011;
  return 420 * Math.exp(-(dx * dx + dy * dy)) + (lat - PEAK.lat) * 900 + 40;
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
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));

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
    return r.fulfill({
      status: 200, contentType: 'image/png',
      body: elevPng((i, j) => elevAt(pxToLng(tx * 256 + i, z), pxToLat(ty * 256 + j, z))),
      headers: { 'access-control-allow-origin': '*' },
    });
  });

  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);

  /* -- the controls drive the state ---------------------------------------- */

  const driven = await p.evaluate(() => {
    document.getElementById('tabBtnDraw').click();
    const fire = (id, v) => {
      const el = document.getElementById(id);
      el.value = String(v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    fire('contourBold', 10);
    fire('contourLabels', 'all');
    fire('contourSmoothing', 'heavy');
    fire('contourDetail', 'ultra');
    const op = document.getElementById('contourOpacity');
    op.value = '40'; op.dispatchEvent(new Event('input', { bubbles: true }));
    const shade = document.getElementById('contourShade');
    shade.checked = false; shade.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      boldEvery: contourState.boldEvery, labels: contourState.labels,
      smoothing: contourState.smoothing, detail: contourState.detail,
      fillOpacity: contourState.fillOpacity, shade: contourState.shade,
      opacityLabel: document.getElementById('contourOpacityVal').textContent,
    };
  });
  ck('every control writes through to the state',
    driven.boldEvery === 10 && driven.labels === 'all' && driven.smoothing === 'heavy'
      && driven.detail === 'ultra' && Math.abs(driven.fillOpacity - 0.4) < 1e-9 && driven.shade === false,
    JSON.stringify(driven));
  ck('and the fill readout follows the slider', driven.opacityLabel === '40%', driven.opacityLabel);

  /* -- units ---------------------------------------------------------------- */

  const units = await p.evaluate(() => {
    contourState.unit = 'm'; contourState.interval = 20;
    renderContourPanel();
    const before = contourIntervalMetres();
    const el = document.getElementById('contourUnit');
    el.value = 'ft'; el.dispatchEvent(new Event('change', { bubbles: true }));
    const after = contourIntervalMetres();
    const opts = [...document.getElementById('contourInterval').options].map(o => o.textContent);
    return { before, after, interval: contourState.interval, unit: contourState.unit, opts };
  });
  ck('switching to feet offers foot intervals',
    units.unit === 'ft' && units.opts.every(t => / ft$/.test(t)), units.opts.slice(0, 4).join(', '));
  ck('and keeps the vertical spacing as close as the new list allows',
    Math.abs(units.after - units.before) < units.before * 0.5,
    `20 m (${units.before.toFixed(1)} m) -> ${units.interval} ft (${units.after.toFixed(1)} m)`);

  const labelled = await p.evaluate(() => {
    contourState.unit = 'ft'; contourState.interval = 50;
    const a = contourLabelFor(50 / 3.280839895 * 2);      // the second level up
    contourState.unit = 'm'; contourState.interval = 20;
    return { ft: a, m: contourLabelFor(140) };
  });
  ck('level labels are round numbers in whichever unit is chosen',
    labelled.ft === '100' && labelled.m === '140', JSON.stringify(labelled));

  /* -- the project round trip ----------------------------------------------- */

  const saved = await p.evaluate(async () => {
    map.setView([19.235, 72.94], 14);
    contourState.unit = 'm';
    contourState.interval = 25;
    contourState.ramp = 'terrain';
    contourState.detail = 'standard';
    contourState.boldEvery = 2;
    contourAreaFromView();
    setContourEnabled(true);
    await generateContours({ silent: true });

    const proj = serialiseProject();
    const json = JSON.stringify(proj);
    return {
      lines: contourModel.lines.length,
      has: !!proj.contour,
      settings: proj.contour,
      bytes: json.length,
      // The one that matters: no coordinate arrays from the contours.
      mentionsLines: /"lines"\s*:/.test(json),
    };
  });
  ck('the project carries the contour settings', saved.has === true,
    JSON.stringify({ interval: saved.settings && saved.settings.interval, ramp: saved.settings && saved.settings.ramp }));
  ck('including the study area', !!(saved.settings && saved.settings.area && saved.settings.area.length >= 3),
    saved.settings && saved.settings.area ? saved.settings.area.length + ' points' : 'none');
  ck('but NOT the contours themselves',
    !saved.mentionsLines && saved.bytes < 60000,
    `${saved.lines} contours on the map, project is ${(saved.bytes / 1024).toFixed(1)} KB`);

  const restored = await p.evaluate(async () => {
    const proj = serialiseProject();
    // Wipe it, then put the saved project back, the way opening a file does.
    clearContourMap();
    const wiped = { ready: contourModel.ready, on: contourState.on };
    applyProject(proj);
    await new Promise(r => setTimeout(r, 2500));
    return {
      wiped,
      on: contourState.on,
      interval: contourState.interval,
      ramp: contourState.ramp,
      boldEvery: contourState.boldEvery,
      area: contourState.area ? contourState.area.length : 0,
      ready: contourModel.ready,
      lines: contourModel.lines.length,
      tgl: document.getElementById('contourTgl').checked,
    };
  });
  ck('opening a project puts the contour map back',
    restored.wiped.ready === false && restored.on === true && restored.ready === true && restored.lines > 0,
    JSON.stringify({ ready: restored.ready, lines: restored.lines }));
  ck('with the settings it was saved with',
    restored.interval === 25 && restored.ramp === 'terrain' && restored.boldEvery === 2 && restored.area >= 3,
    JSON.stringify({ interval: restored.interval, ramp: restored.ramp, bold: restored.boldEvery, area: restored.area }));
  ck('and the panel reflects it', restored.tgl === true);

  const other = await p.evaluate(async () => {
    const proj = serialiseProject();
    delete proj.contour;                       // a project made before this existed
    applyProject(proj);
    await new Promise(r => setTimeout(r, 600));
    return {
      on: contourState.on,
      ready: contourModel.ready,
      onMap: !!document.querySelector('.leaflet-overlay-pane canvas.contour-canvas'),
      legend: !!document.getElementById('contourLegendCard').offsetParent,
    };
  });
  ck('a project with no contour map clears the one that was on screen',
    !other.on && !other.ready && !other.onMap && !other.legend, JSON.stringify(other));

  ck('the pref vocabulary declares the contour key',
    await p.evaluate(() => Object.prototype.hasOwnProperty.call(PREF_DEFAULTS, 'contour')));

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
