/**
 * The oblique relief view: it mounts, it really has a terrain mesh, and it
 * puts the map back exactly as it found it.
 *
 * The last of those is the one worth testing hardest. Mounting is visible — you
 * either see hills or you do not — but an asymmetric unmount is invisible until
 * much later, when the flat map turns out to be 0x0, or the tilt slider is
 * still disabled, or Leaflet is still hidden under a host that was removed.
 * The vector ground had exactly this class of bug.
 *
 * Terrain is asserted through contour3dStatus() rather than through the
 * checkbox, because setTerrain can be refused: a DEM that will not load leaves
 * a tilted FLAT map, which looks enough like relief to be believed.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/contour-3d.cjs
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

  /* -- 3D refuses politely before there is anything to drape ---------------- */

  const early = await p.evaluate(async () => {
    const ok = await setContour3d(true);
    return { ok, active: contour3dActive(), msg: document.getElementById('statusMsg').textContent };
  });
  ck('3D declines until there is a contour map to drape, and says why',
    early.ok === false && early.active === false && /contour map first/i.test(early.msg),
    JSON.stringify(early));

  /* -- mount ---------------------------------------------------------------- */

  const before = await p.evaluate(async () => {
    map.setView([19.235, 72.94], 14);
    contourState.detail = 'standard';
    contourState.interval = 25;
    contourAreaFromView();
    setContourEnabled(true);
    await generateContours({ silent: true });
    const tilt = document.getElementById('tiltRange');
    return { lines: contourModel.lines.length, tiltDisabled: tilt.disabled, mapSize: map.getSize() };
  });
  ck('a contour map is ready to drape', before.lines > 0, JSON.stringify({ lines: before.lines }));

  const mounted = await p.evaluate(async () => {
    const ok = await setContour3d(true);
    await new Promise(r => setTimeout(r, 2500));
    const host = document.querySelector('.contour-3d-host');
    const cv = host && host.querySelector('canvas');
    const wrapBox = document.getElementById('mapWrap').getBoundingClientRect();
    const hostBox = host ? host.getBoundingClientRect() : null;
    return {
      ok,
      status: contour3dStatus(),
      host: !!host,
      wrapClass: document.getElementById('mapWrap').classList.contains('contour-3d-on'),
      canvas: cv ? { w: cv.width, h: cv.height } : null,
      // Measured on the page, not read off the canvas. A GL buffer can render
      // a perfect picture into a host that is zero pixels tall, and reading the
      // buffer would never notice.
      fills: !!(hostBox && Math.abs(hostBox.width - wrapBox.width) < 2
        && Math.abs(hostBox.height - wrapBox.height) < 2),
      hostBox: hostBox ? { w: Math.round(hostBox.width), h: Math.round(hostBox.height) } : null,
      wrapBox: { w: Math.round(wrapBox.width), h: Math.round(wrapBox.height) },
      tiltDisabled: document.getElementById('tiltRange').disabled,
      leafletHidden: getComputedStyle(document.getElementById('tiltStage')).visibility === 'hidden',
      mode: contourState.mode,
    };
  });
  ck('the oblique view mounts', mounted.ok === true && mounted.host && mounted.wrapClass,
    JSON.stringify({ ok: mounted.ok, host: mounted.host, wrapClass: mounted.wrapClass }));
  ck('with a real terrain mesh, not just a tilted flat map',
    mounted.status.terrain === true, JSON.stringify(mounted.status));
  ck('the contour picture is draped over it',
    mounted.status.drape === true, JSON.stringify(mounted.status));
  ck('the camera is pitched', mounted.status.pitch > 30, `${mounted.status.pitch}°`);
  ck('the host fills the map area on the page, not just in its own buffer',
    mounted.fills === true,
    `host ${JSON.stringify(mounted.hostBox)} vs map ${JSON.stringify(mounted.wrapBox)}`);
  ck('and the GL canvas is sized to it',
    mounted.canvas && Math.abs(mounted.canvas.w - mounted.wrapBox.w) < 4
      && Math.abs(mounted.canvas.h - mounted.wrapBox.h) < 4,
    `canvas ${JSON.stringify(mounted.canvas)} vs map ${JSON.stringify(mounted.wrapBox)}`);
  ck('the flat map is hidden while it is up', mounted.leafletHidden === true);
  ck('and the CSS tilt slider is locked out, since this view has its own camera',
    mounted.tiltDisabled === true);

  /* -- it renders something ------------------------------------------------- */

  const pixels = await p.evaluate(() => {
    const cv = document.querySelector('.contour-3d-host canvas');
    const probe = document.createElement('canvas');
    probe.width = 70; probe.height = 45;
    const cx = probe.getContext('2d');
    cx.drawImage(cv, 0, 0, 70, 45);
    const d = cx.getImageData(0, 0, 70, 45).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
    return { colours: seen.size };
  });
  ck('and it draws the draped contour map rather than an empty sky',
    pixels.colours > 12, `${pixels.colours} distinct colours in the GL buffer`);

  await p.screenshot({ path: path.join(__dirname, 'shot-contour-3d.png') });

  /* -- live updates and export ---------------------------------------------- */

  const live = await p.evaluate(() => {
    contour3dSetExaggeration(3.2);
    contourState.interval = 50;
    contourBuildLines();
    contour3dRedrape();
    const shot = renderContour3dCanvas({ W: 900, H: 560 });
    return { exag: contour3dStatus().exaggeration, drape: contour3dStatus().drape,
             shot: shot ? { w: shot.width, h: shot.height } : null };
  });
  ck('exaggeration is applied to the live mesh', Math.abs(live.exag - 3.2) < 0.01, String(live.exag));
  ck('re-draping after a new interval keeps the drape source alive', live.drape === true);
  ck('and the view exports at the size the export asks for',
    live.shot && live.shot.w === 900 && live.shot.h === 560, JSON.stringify(live.shot));

  const exported = await p.evaluate(async () => {
    const shot = await captureMapHiRes({ scale: 2 });
    const probe = document.createElement('canvas');
    probe.width = 70; probe.height = 45;
    const cx = probe.getContext('2d');
    cx.drawImage(shot.canvas, 0, 0, 70, 45);
    const d = cx.getImageData(0, 0, 70, 45).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
    return { w: shot.canvas.width, colours: seen.size };
  });
  ck('a full export in 3D mode captures the oblique view, not the hidden flat map',
    exported.colours > 12, `${exported.colours} distinct colours in a ${exported.w}px export`);

  /* -- unmount must put everything back ------------------------------------- */

  const after = await p.evaluate(async () => {
    await setContour3d(false);
    await new Promise(r => setTimeout(r, 300));
    map.invalidateSize({ animate: false });
    const size = map.getSize();
    return {
      active: contour3dActive(),
      host: !!document.querySelector('.contour-3d-host'),
      wrapClass: document.getElementById('mapWrap').classList.contains('contour-3d-on'),
      tiltDisabled: document.getElementById('tiltRange').disabled,
      leafletHidden: getComputedStyle(document.getElementById('tiltStage')).visibility === 'hidden',
      mapSize: { x: size.x, y: size.y },
      mode: contourState.mode,
      contoursStillThere: !!document.querySelector('.leaflet-overlay-pane canvas.contour-canvas'),
    };
  });
  ck('unmounting removes the GL host and its class',
    !after.active && !after.host && !after.wrapClass, JSON.stringify(after));
  ck('the flat map is visible again, with a real size',
    !after.leafletHidden && after.mapSize.x > 100 && after.mapSize.y > 100, JSON.stringify(after.mapSize));
  ck('the tilt slider is handed back', after.tiltDisabled === false);
  ck('the 2D contour map is still there underneath', after.contoursStillThere === true);
  ck('and the mode is recorded as flat again', after.mode === '2d', after.mode);

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
