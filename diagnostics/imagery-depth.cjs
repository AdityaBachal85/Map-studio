/**
 * When a satellite service runs out of imagery, the map must settle on the
 * deepest zoom it really has — not sit on a screen of "Map data not yet
 * available".
 *
 * Esri answers 200 OK with a flat placeholder past its coverage, so nothing
 * errors and nothing retries. attachAdaptiveDepth() is supposed to notice and
 * step back. It stopped noticing when the placeholder gained a lavender tint,
 * and it was never attached at all unless HD was on.
 *
 * Esri is unreachable from the sandbox, so its tiles are served here: a flat
 * lavender placeholder above the pretend coverage limit, noisy photography at
 * or below it. What is being tested is the loop, not the network.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/imagery-depth.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { png } = require(path.join(__dirname, 'fake-tile-png.cjs'));

const BASE = 'http://127.0.0.1:8000';
const REPO = path.join(__dirname, '..');
const localAuthConfig = () => fs.readFileSync(path.join(REPO, 'js', 'config.js'), 'utf8')
  .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = '';")
  .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = '';");

/** The service pretends to have imagery only to here. */
const REAL_COVERAGE_Z = 18;
const PLACEHOLDER = png(198, 200, 222);          // the tint that broke the detector
const IMAGERY = png(120, 140, 90, 110);          // noisy, like photography

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

(async () => {
  const b = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const asked = [];

  await p.route('**', r => {
    const u = r.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
    // Esri tile URLs end /MapServer/tile/{z}/{y}/{x}
    const m = u.match(/\/tile\/(\d+)\/(\d+)\/(\d+)/);
    if (m) {
      const z = +m[1];
      // Only the imagery layer. `hybrid` also carries two reference overlays
      // that legitimately go to z19 and are not what backs off here, and
      // counting them made "stopped asking" impossible to ever satisfy.
      if (/World_Imagery/.test(u)) asked.push(z);
      const body = z > REAL_COVERAGE_Z ? PLACEHOLDER : IMAGERY;
      // CORS headers matter: without them the canvas taints and the depth
      // probe disables itself, which is a different bug wearing this one's face.
      return r.fulfill({
        status: 200, contentType: 'image/png', body,
        headers: { 'access-control-allow-origin': '*' },
      });
    }
    return r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  // Satellite layout, HD OFF — the case that had no recovery at all.
  await p.addInitScript(() => localStorage.setItem('dbotMapStudioPrefs.v1', JSON.stringify({
    layout: 'satellite', basemap: 'hybrid', theme: 'light',
  })));
  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);

  // HD ships on. Turn it OFF deliberately: that is the case that previously had
  // no recovery at all, because the probe was gated behind the HD toggle.
  await p.evaluate(() => {
    const t = document.getElementById('hdTgl');
    if (t.checked) { t.checked = false; t.dispatchEvent(new Event('change')); }
  });
  await p.waitForTimeout(1500);
  const hd = await p.evaluate(() => document.getElementById('hdTgl').checked);
  ck('this run has HD off, the case with no recovery before', hd === false, 'hd=' + hd);

  const probed = await p.evaluate(() => {
    const l = activeBase[0];
    return { attached: typeof l._events === 'object' && !!(l._events && l._events.tileload),
             startDepth: l.options.maxNativeZoom };
  });
  ck('the depth probe is attached even with HD off', probed.attached === true, JSON.stringify(probed));

  // Zoom past the pretend coverage.
  await p.evaluate(() => map.setView([19.10, 72.88], 20, { animate: false }));
  await p.waitForTimeout(6000);

  const settled = await p.evaluate(() => ({
    depth: activeBase[0].options.maxNativeZoom,
    zoom: map.getZoom(),
  }));
  ck('the layer backs off to the depth the service actually has',
    settled.depth <= REAL_COVERAGE_Z, JSON.stringify(settled) + ' coverage=z' + REAL_COVERAGE_Z);

  // And having backed off, it stops asking for tiles it cannot get.
  const before = asked.length;
  await p.evaluate(() => { map.setView([19.104, 72.884], 20, { animate: false }); });
  await p.waitForTimeout(3500);
  const deepAfter = asked.slice(before).filter(z => z > REAL_COVERAGE_Z).length;
  ck('and stops requesting levels past it',
    deepAfter === 0, deepAfter + ' deep requests after settling');

  // What the user sees: real imagery upscaled, not placeholders.
  const pixels = await p.evaluate(() => {
    const img = document.querySelector('.leaflet-tile-pane img.leaflet-tile');
    if (!img || !img.complete) return { err: 'no tile' };
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, 8, 8);
    const d = x.getImageData(0, 0, 8, 8).data;
    return { corners: [d[0], d[1], d[2]], isPlaceholder: looksLikeNoDataTile(
      [].concat([d[0], d[1], d[2], 255], [d[0], d[1], d[2], 255],
                [d[0], d[1], d[2], 255], [d[0], d[1], d[2], 255])) };
  });
  ck('the tiles on screen are imagery, not placeholders',
    pixels.isPlaceholder === false, JSON.stringify(pixels));

  /* ---- the map is sharp between zoom levels, not only on them ------------- */

  // WHY THE MAP LOOKED SOFT. zoomSnap is 0.25, so the map rests between whole
  // levels — which is what makes framing possible. Leaflet fetched tiles for
  // the NEAREST whole level and CSS-scaled the layer to bridge the gap, so at
  // 14.25 the whole basemap was drawn at scale(1.189): every road name baked
  // into those tiles resampled 19% larger, and 19% softer. Three of every four
  // resting positions did it, which is why the map's own road names came out
  // fuzzy while the app's DOM labels beside them stayed crisp.
  //
  // Rounding the tile zoom UP makes a fractional rest scale the tiles DOWN, and
  // downsampling is sharp where upsampling is not. Read off the live transform
  // rather than off the option, because the option was never the thing that
  // was wrong.
  const scales = await p.evaluate(async () => {
    const at = async z => {
      map.setView([19.076, 72.877], z, { animate: false });
      await new Promise(r => setTimeout(r, 700));
      const c = document.querySelector('.leaflet-tile-container');
      const m = c ? /matrix\(([-\d.]+)/.exec(getComputedStyle(c).transform) : null;
      return m ? +(+m[1]).toFixed(3) : null;
    };
    return { whole: await at(14), quarter: await at(14.25),
      half: await at(14.5), threeQ: await at(14.75), next: await at(15) };
  });
  ck('a whole zoom level draws its tiles at their own size',
    scales.whole === 1 && scales.next === 1, JSON.stringify([scales.whole, scales.next]));
  ck('and a quarter level shrinks them rather than stretching them',
    scales.quarter > 0 && scales.quarter < 1, String(scales.quarter));
  ck('as does a half', scales.half > 0 && scales.half < 1, String(scales.half));
  ck('and three quarters', scales.threeQ > 0 && scales.threeQ < 1, String(scales.threeQ));
  // The exact number matters: 1.189 is the upscale this replaced.
  ck('no resting position stretches the basemap, which is what blurred it',
    [scales.whole, scales.quarter, scales.half, scales.threeQ, scales.next].every(v => v <= 1),
    JSON.stringify(scales));

  await p.screenshot({ path: path.join(__dirname, 'shot-imagery-depth.png') });
  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');

  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
