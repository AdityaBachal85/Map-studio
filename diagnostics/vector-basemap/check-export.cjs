/**
 * The two integration paths test-vector.js does not reach:
 *   1. captureMapHiRes() end to end on a vector ground — the branch in
 *      renderGroundPass, the compositing, and the furniture pass that must NOT
 *      photograph the GL canvas a second time.
 *   2. serialiseProject / applyProject round-tripping the vector filters.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Set CHROME=/path/to/chrome when Playwright's own download is not present.
const CHROME = process.env.CHROME || undefined;
const BASE = 'http://127.0.0.1:8000';
const HERE = __dirname;
const REPO = path.join(__dirname, '..', '..');
const STYLE = fs.readFileSync(path.join(HERE, 'style-fixture.json'), 'utf8');

/**
 * The studio redirects to login.html whenever Supabase is configured and nobody
 * is signed in. Rather than committing a second copy of js/config.js, read the
 * real one and blank the two Supabase constants: auth degrades to local mode,
 * the guard stands down, and nothing else about the page changes.
 * @returns {string}
 */
function localAuthConfig() {
  const src = fs.readFileSync(path.join(REPO, 'js', 'config.js'), 'utf8');
  return src
    .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = '';")
    .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = '';");
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,   // undefined = Playwright's bundled build
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

  await page.route('**', r => {
    const u = r.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
    return r.abort();
  });
  await page.route('**/tiles.openfreemap.org/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: STYLE }));
  await page.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  await page.addInitScript(() => {
    if (!localStorage.getItem('dbotMapStudioPrefs.v1')) {
      localStorage.setItem('dbotMapStudioPrefs.v1', JSON.stringify({
        vectorBasemap: true, layout: 'satellite', basemap: 'hybrid', theme: 'light',
      }));
    }
  });

  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => setBasemap('openfreemap'));
  await page.waitForTimeout(3500);
  await page.evaluate(() => map.setView([19.08, 72.88], 12, { animate: false }));
  await page.waitForTimeout(2000);

  // Something of our own on the map, so the composite has vectors to carry and
  // the furniture pass has a card to photograph.
  await page.evaluate(() => {
    if (typeof addLocation === 'function') {
      addLocation({ name: 'Site', lat: 19.08, lng: 72.88, kind: 'site' });
    }
  });
  await page.waitForTimeout(1200);

  // ---- 1. the whole export, on a vector ground ---------------------------
  for (const scale of [2, 4]) {
    const out = await page.evaluate(async s => {
      const r = await captureMapHiRes({ scale: s });
      const p = document.createElement('canvas');
      p.width = 60; p.height = 38;
      const x = p.getContext('2d', { willReadFrequently: true });
      x.drawImage(r.canvas, 0, 0, 60, 38);
      const d = x.getImageData(0, 0, 60, 38).data;
      const seen = new Set();
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
        if (d[i] < 30 && d[i + 1] < 40 && d[i + 2] < 50) dark++;
      }
      return {
        w: r.canvas.width, h: r.canvas.height, complete: r.complete,
        colours: seen.size, darkPct: Math.round(dark / (60 * 38) * 100),
        png: r.canvas.toDataURL('image/png').length,
      };
    }, scale);

    const wrap = await page.evaluate(() => {
      const w = document.getElementById('mapWrap');
      return { w: w.clientWidth, h: w.clientHeight };
    });
    check('export at ' + scale + '× is the right size',
      out.w === Math.round(wrap.w * scale) && out.h === Math.round(wrap.h * scale),
      JSON.stringify(out) + ' wrap=' + JSON.stringify(wrap));
    check('export at ' + scale + '× is not a blank/dark ground',
      out.colours > 5 && out.darkPct < 60, JSON.stringify(out));
    check('export at ' + scale + '× reports complete', out.complete === true,
      'complete=' + out.complete);

    // Write it out and look at it, rather than trusting the numbers alone.
    const dataUrl = await page.evaluate(async s => {
      const r = await captureMapHiRes({ scale: s });
      return r.canvas.toDataURL('image/png');
    }, scale === 2 ? 2 : 2);
    if (scale === 2) {
      fs.writeFileSync(path.join(HERE, 'export-2x.png'),
        Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
  }

  // ---- 2. the GL host is not left visible for the furniture pass ---------
  const furniture = await page.evaluate(() => {
    const wrap = document.getElementById('mapWrap');
    wrap.classList.add('capturing', 'hires-overlay-pass');
    const host = document.querySelector('.vector-basemap-host');
    const d = host ? getComputedStyle(host).display : 'no-host';
    wrap.classList.remove('capturing', 'hires-overlay-pass');
    return d;
  });
  check('the GL host is hidden during the furniture pass', furniture === 'none',
    'display=' + furniture);

  // ---- 3. project round-trip ---------------------------------------------
  await page.evaluate(() => setVectorPoiClass('poiPharmacy', false));
  await page.evaluate(() => setVectorLayerGroup('buildings', false));
  await page.waitForTimeout(800);

  const saved = await page.evaluate(() => {
    const p = serialiseProject();
    return { basemap: p.basemap, vectorLayers: JSON.stringify(p.vectorLayers) };
  });
  check('the project saves the vector ground and its filters',
    saved.basemap === 'openfreemap' && /poiPharmacy/.test(saved.vectorLayers)
    && /buildings/.test(saved.vectorLayers), JSON.stringify(saved));

  // Wipe the settings, go back to raster, then reopen the saved project.
  await page.evaluate(() => {
    window.__proj = serialiseProject();
    setVectorPoiClass('poiPharmacy', true);
    setVectorLayerGroup('buildings', true);
    setBasemap('osm');
  });
  await page.waitForTimeout(1200);
  const wiped = await page.evaluate(() => ({
    key: activeKey, pharmacyOn: vectorPoiClassOn('poiPharmacy'), buildingsOn: vectorGroupOn('buildings'),
  }));
  check('settings really were cleared before reopening',
    wiped.key === 'osm' && wiped.pharmacyOn && wiped.buildingsOn, JSON.stringify(wiped));

  await page.evaluate(() => applyProject(window.__proj, { silent: true }));
  await page.waitForTimeout(4000);
  const reopened = await page.evaluate(() => ({
    key: activeKey,
    active: vectorGroundActive(),
    pharmacyOff: vectorPoiClassOn('poiPharmacy') === false,
    buildingsOff: vectorGroupOn('buildings') === false,
    buildingVis: vectorGroundMap() ? vectorGroundMap().getLayoutProperty('building', 'visibility') : null,
    rendered: vectorGroundMap()
      ? vectorGroundMap().queryRenderedFeatures({ layers: ['poi-level-1'] }).map(f => f.properties.class)
      : null,
  }));
  check('reopening restores the vector ground', reopened.key === 'openfreemap' && reopened.active,
    JSON.stringify(reopened));
  check('reopening restores the saved filters',
    reopened.pharmacyOff && reopened.buildingsOff && reopened.buildingVis === 'none',
    JSON.stringify(reopened));
  check('and the filters are actually applied to the style',
    reopened.rendered && !reopened.rendered.includes('pharmacy')
    && reopened.rendered.includes('hospital'), JSON.stringify(reopened.rendered));

  await page.screenshot({ path: path.join(HERE, 'shot-4-reopened.png') });

  const real = errs.filter(e => !/Failed to load resource|net::ERR|403|AbortError|favicon/i.test(e));
  check('no unexplained console errors', real.length === 0, real.slice(0, 3).join(' // ') || 'none');

  await browser.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
