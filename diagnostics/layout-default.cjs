/**
 * The layout a map opens as.
 *
 * Switching layout on the map used to write setPref('layout'), so one visit to
 * Satellite made every later map open in Satellite — the Preferences default
 * never applied again. These assertions pin the intended split: Preferences
 * owns "what new maps open as", the map's own layout buttons are a per-session
 * choice, and a saved project carries its own and restores it without changing
 * anyone's default.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/layout-default.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8000';
const REPO = path.join(__dirname, '..');
const localAuthConfig = () => fs.readFileSync(path.join(REPO, 'js', 'config.js'), 'utf8')
  .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = '';")
  .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = '';");

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };
const snap = pg => pg.evaluate(() => ({ layout: mapLayout(), basemap: activeKey, pref: getPref('layout') }));

(async () => {
  const b = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const p = await (await b.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  const fresh = await snap(p);
  ck('a fresh browser opens in Connectivity on OpenStreetMap',
    fresh.layout === 'connectivity' && fresh.basemap === 'osm', JSON.stringify(fresh));

  await p.evaluate(() => setMapLayout('satellite'));
  await p.waitForTimeout(1500);
  const switched = await snap(p);
  ck('switching to Satellite works', switched.layout === 'satellite', JSON.stringify(switched));
  ck('...but does NOT overwrite the preference', switched.pref === 'connectivity',
    'pref=' + switched.pref);

  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  const back = await snap(p);
  ck('reloading comes back to Connectivity, not the last layout used',
    back.layout === 'connectivity' && back.basemap === 'osm', JSON.stringify(back));

  // Preferences is the writer: set Satellite there and it must stick.
  await p.click('#prefsBtn');
  await p.waitForTimeout(500);
  const seg = await p.evaluate(() => !!document.querySelector('#prefLayout .seg-btn[data-v="satellite"]'));
  ck('Preferences has a "New maps open as" control', seg === true);
  await p.click('#prefLayout .seg-btn[data-v="satellite"]');
  await p.waitForTimeout(1200);
  await p.click('#prefsClose');
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  const prefSat = await snap(p);
  ck('the Preferences choice survives a reload',
    prefSat.layout === 'satellite' && prefSat.pref === 'satellite', JSON.stringify(prefSat));

  // Put it back to Connectivity, then check a project overrides without
  // rewriting the preference.
  await p.click('#prefsBtn'); await p.waitForTimeout(400);
  await p.click('#prefLayout .seg-btn[data-v="connectivity"]');
  await p.waitForTimeout(1200);
  await p.click('#prefsClose'); await p.waitForTimeout(300);

  await p.evaluate(() => {
    const proj = serialiseProject();
    proj.layout = 'satellite';
    window.__proj = proj;
  });
  await p.evaluate(() => applyProject(window.__proj, { silent: true }));
  await p.waitForTimeout(2500);
  const opened = await snap(p);
  ck('a project opens in the layout it was saved with',
    opened.layout === 'satellite', JSON.stringify(opened));
  ck('...without changing what new maps open as',
    opened.pref === 'connectivity', 'pref=' + opened.pref);

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
