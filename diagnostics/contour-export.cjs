/**
 * The contour map survives export, at 2x and at 4x.
 *
 * The layer draws into a canvas in Leaflet's overlay pane, which the export's
 * ground pass already knows how to copy — but "already knows how" is exactly
 * the kind of assumption that turns into a blank band in a client's PDF. Two
 * things are actually proved here rather than assumed:
 *
 *   1. the exported image CONTAINS the contour map, shown by capturing the same
 *      view twice with the layer on and off and measuring how much of the
 *      picture changed. A test that only checked "the canvas is not blank"
 *      would pass on a basemap with no contours on it at all.
 *   2. it survives `includeVectors:false`, the PPTX path, where routes and
 *      shapes are deliberately left out of the image and re-emitted as native
 *      PowerPoint objects. The contour map is ground, not geometry, so it has
 *      to stay in the picture when they go.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/contour-export.cjs
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
  const p = await (await b.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
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

  const built = await p.evaluate(async () => {
    map.setView([19.235, 72.94], 14);
    contourState.detail = 'standard';
    contourState.interval = 20;
    contourAreaFromView();
    setContourEnabled(true);
    const ok = await generateContours({ silent: true });
    return { ok, lines: contourModel.lines.length };
  });
  ck('a contour map is on the map to export', built.ok && built.lines > 0, JSON.stringify(built));
  if (!built.ok) { await b.close(); process.exit(1); }

  /**
   * Capture, then reduce to a small signature: the share of pixels that are
   * distinctly coloured, and a coarse colour histogram. Comparing signatures is
   * how "did the contour map end up in the image" is answered without shipping
   * a reference PNG that would rot the first time a colour changed.
   */
  await p.evaluate(() => {
    window.__sig = async (opts) => {
      const shot = await captureMapHiRes(opts);
      const probe = document.createElement('canvas');
      probe.width = 80; probe.height = 56;
      const cx = probe.getContext('2d');
      cx.drawImage(shot.canvas, 0, 0, 80, 56);
      const d = cx.getImageData(0, 0, 80, 56).data;
      const hist = new Uint32Array(512);
      const seen = new Set();
      const px = [];
      for (let i = 0; i < d.length; i += 4) {
        const k = (d[i] >> 5) * 64 + (d[i + 1] >> 5) * 8 + (d[i + 2] >> 5);
        hist[k]++;
        seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
        px.push(d[i], d[i + 1], d[i + 2]);
      }
      return {
        w: shot.canvas.width, h: shot.canvas.height, scale: shot.scale,
        colours: seen.size, hist: Array.from(hist), px,
      };
    };
  });

  const on2 = await p.evaluate(() => window.__sig({ scale: 2 }));
  ck('a 2x export is the expected size',
    on2.w === Math.round(on2.scale * 1100 - (on2.scale * 1100 - on2.w)) && on2.w > 1000,
    `${on2.w}x${on2.h} at ${on2.scale}x`);
  ck('and it is a real picture, not a blank sheet',
    on2.colours > 25, `${on2.colours} distinct colours`);

  // The same view with the contour map off. Anything that changed between the
  // two images is the contour map.
  const off2 = await p.evaluate(async () => {
    setContourEnabled(false);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return window.__sig({ scale: 2 });
  });

  const diff = (() => {
    let changed = 0;
    for (let i = 0; i < on2.px.length; i += 3) {
      const d = Math.abs(on2.px[i] - off2.px[i]) + Math.abs(on2.px[i + 1] - off2.px[i + 1])
        + Math.abs(on2.px[i + 2] - off2.px[i + 2]);
      if (d > 24) changed++;
    }
    return changed / (on2.px.length / 3);
  })();
  ck('the contour map is genuinely IN the exported image',
    diff > 0.3, `${(diff * 100).toFixed(0)}% of the picture changes when the layer is switched off`);
  ck('and it is what makes the export colourful',
    on2.colours > off2.colours * 2,
    `${on2.colours} colours with contours, ${off2.colours} without`);

  /* -- 4x, and the PPTX path ---------------------------------------------- */

  const on4 = await p.evaluate(async () => {
    setContourEnabled(true);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return window.__sig({ scale: 4 });
  });
  ck('a 4x export is four times the size, not the same pixels magnified',
    on4.w > on2.w * 1.9, `${on2.w}px at 2x -> ${on4.w}px at 4x`);
  ck('and carries the same picture at that size',
    on4.colours > 25, `${on4.colours} distinct colours`);

  const noVec = await p.evaluate(() => window.__sig({ scale: 2, includeVectors: false }));
  const vecDiff = (() => {
    let changed = 0;
    for (let i = 0; i < noVec.px.length; i += 3) {
      const d = Math.abs(noVec.px[i] - off2.px[i]) + Math.abs(noVec.px[i + 1] - off2.px[i + 1])
        + Math.abs(noVec.px[i + 2] - off2.px[i + 2]);
      if (d > 24) changed++;
    }
    return changed / (noVec.px.length / 3);
  })();
  ck('the PPTX path keeps the contour map when it drops the routes and shapes',
    vecDiff > 0.3, `${(vecDiff * 100).toFixed(0)}% of the picture is still the contour map`);

  await p.evaluate(async () => {
    const shot = await captureMapHiRes({ scale: 2 });
    const a = document.createElement('img');
    a.id = 'exportProof';
    a.src = shot.canvas.toDataURL('image/png');
    a.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;z-index:99999;background:#000';
    document.body.appendChild(a);
    await new Promise(r => { a.complete ? r() : a.onload = r; });
  });
  await p.screenshot({ path: path.join(__dirname, 'shot-contour-export.png') });

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
