/**
 * The vector ground as a user meets it: present in the basemap picker out of
 * the box, with a thumbnail that does not read as a broken tile, and reachable
 * by clicking it.
 *
 * Starts from NO seeded preferences at all — a first-time visitor. It used to
 * be gated behind a Preferences checkbox, which meant the only way to find a
 * basemap was to go somewhere that is not the basemap picker.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME || undefined;
const BASE = 'http://127.0.0.1:8000';
const HERE = __dirname;
const REPO = path.join(__dirname, '..', '..');
const STYLE = fs.readFileSync(path.join(HERE, 'style-fixture.json'), 'utf8');

/** Read the repo's own config.js and blank Supabase, so auth stays local. */
function localAuthConfig() {
  return fs.readFileSync(path.join(REPO, 'js', 'config.js'), 'utf8')
    .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = '';")
    .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = '';");
}

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
};

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  await page.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:'))
      ? r.continue() : r.abort();
  });
  await page.route('**/tiles.openfreemap.org/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: STYLE }));
  await page.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  check('it is offered with no preferences set at all',
    await page.evaluate(() => availableBasemaps().some(s => s.id === 'openfreemap')));

  // Satellite, so the picker is not pinned to OpenStreetMap.
  await page.evaluate(() => setMapLayout('satellite', { silent: true }));
  await page.waitForTimeout(700);
  await page.evaluate(() => { if (typeof toggleBasemapPanel === 'function') toggleBasemapPanel(); });
  await page.waitForTimeout(600);

  const tile = await page.evaluate(() => {
    const el = document.querySelector('.bm-tile[data-key="openfreemap"]');
    if (!el) return { err: 'no tile in the grid' };
    const img = el.querySelector('.bm-tile-img');
    const cs = getComputedStyle(img);
    const r = el.getBoundingClientRect();
    return {
      found: true,
      label: el.querySelector('.bm-tile-lbl').textContent,
      // The gradient IS the picture here: no tile template means no preview
      // fetch, so a single flat colour would show as an empty card.
      layers: (cs.backgroundImage.match(/gradient/g) || []).length,
      // ui/tooltips.js moves every `title` to `data-tip` on init and drops the
      // attribute, so reading `.title` here reports empty for every tile in the
      // grid — including the ones that have had a tooltip since long before the
      // vector ground existed.
      tip: (el.getAttribute('data-tip') || el.title || '').slice(0, 44),
      visible: r.width > 0 && r.height > 0 && cs.opacity !== '0',
    };
  });
  check('it has a tile in the picker grid', tile.found === true, JSON.stringify(tile));
  check('its thumbnail is a layered map-like gradient, not one flat wash',
    tile.layers >= 3, 'gradient layers = ' + tile.layers);
  check('its tooltip says what it is, not just who owns it',
    /Drawn in your browser/.test(tile.tip || ''), tile.tip);
  check('the tile is actually visible', tile.visible === true, JSON.stringify(tile));

  await page.screenshot({ path: path.join(HERE, 'shot-picker.png') });

  // Click it the way a user does.
  await page.click('.bm-tile[data-key="openfreemap"]');
  await page.waitForTimeout(4000);
  check('clicking the tile mounts the vector ground',
    await page.evaluate(() => vectorGroundActive() && activeKey === 'openfreemap'));

  // Connectivity still pins its ground: the client-facing standard must not
  // change under anyone, and that pin — not a preference — is what protects it.
  await page.evaluate(() => setMapLayout('connectivity', { silent: true }));
  await page.waitForTimeout(1500);
  const conn = await page.evaluate(() => ({
    key: activeKey, gl: document.querySelectorAll('.vector-basemap-host').length,
    locked: typeof basemapLocked === 'function' && basemapLocked(),
  }));
  check('Connectivity still pins itself to OpenStreetMap',
    conn.key === 'osm' && conn.gl === 0 && conn.locked === true, JSON.stringify(conn));

  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');

  await browser.close();
  console.log('\n' + results.filter(Boolean).length + '/' + results.length + ' passed');
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
