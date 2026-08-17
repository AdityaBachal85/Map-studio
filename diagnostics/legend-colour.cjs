/**
 * The legend has to say what is on the map, and the brand colours have to be
 * one click away.
 *
 * Recolouring nineteen built-up parcels to red used to leave the key showing
 * the standard's dusty pink — the key contradicting the drawing it explains,
 * which is worse than no key because the reader trusts it.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/legend-colour.cjs
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
  await p.evaluate(() => map.setView([19.10, 72.88], 13, { animate: false }));
  await p.click('#tabBtnDraw');
  await p.waitForTimeout(500);

  // Five shapes carrying the built-up class, drawn in its standard colour.
  const start = await p.evaluate(() => {
    const cc = connClass('builtUp');
    for (let i = 0; i < 5; i++) {
      const g = registerGeom(
        L.polygon([[19.10 + i * 0.003, 72.86], [19.10 + i * 0.003, 72.87], [19.101 + i * 0.003, 72.87]]),
        'Polygon', { name: 'Parcel ' + i, cls: 'builtUp', fillColor: cc.color });
      g.fillColor = cc.color; applyGeomStyle(g);
    }
    rebuildLegend();
    const row = connLegendRows().find(r => r.cls === 'builtUp');
    return { classColour: cc.color.toLowerCase(), legend: (row || {}).color };
  });
  ck('the legend starts on the standard colour',
    start.legend && start.legend.toLowerCase() === start.classColour, JSON.stringify(start));

  // Recolour the whole group to red, the way the group panel does.
  const after = await p.evaluate(() => {
    geomGroupApply(geomVisibleColor(geometries[0]), g => { g.fillColor = '#e11d48'; }, 'Recoloured');
    const row = connLegendRows().find(r => r.cls === 'builtUp');
    const sw = document.querySelector('#colorKeyCard .ck-sw, #colorKey .ck-sw, .ck-row .ck-sw');
    return {
      legend: (row || {}).color,
      swatch: sw ? getComputedStyle(sw).backgroundColor || getComputedStyle(sw).color : null,
    };
  });
  ck('recolouring the group moves the legend with it',
    (after.legend || '').toLowerCase() === '#e11d48', JSON.stringify(after));

  // Mixed colours must NOT invent a single swatch.
  const mixed = await p.evaluate(() => {
    geometries[0].fillColor = '#12b886'; applyGeomStyle(geometries[0]);
    const row = connLegendRows().find(r => r.cls === 'builtUp');
    return { legend: (row || {}).color, classColour: connClass('builtUp').color.toLowerCase() };
  });
  ck('a class drawn in two colours falls back to the standard, not a guess',
    (mixed.legend || '').toLowerCase() === mixed.classColour, JSON.stringify(mixed));

  // ---- the four logo colours are in the preset palette --------------------
  const brand = await p.evaluate(() => {
    const want = ['#002166', '#0073c6', '#7ed236', '#e2bd60'];
    const have = COLOR_PRESETS.map(c => c.hex.toLowerCase());
    return {
      missing: want.filter(w => have.indexOf(w) < 0),
      names: want.map(w => colorName(w.toUpperCase())),
      total: COLOR_PRESETS.length,
    };
  });
  ck('all four logo colours are presets', brand.missing.length === 0, JSON.stringify(brand));
  ck('each is named rather than announced as a hex string',
    brand.names.every(n => /DBOT/.test(n)), JSON.stringify(brand.names));

  // And they are reachable in the popover a user actually opens.
  await p.evaluate(() => { geomGroupSelected = geomVisibleColor(geometries[1]); renderGeomGroups(); });
  await p.waitForTimeout(400);
  // enhanceColorInputs() wraps each <input type="color"> in a .clrBtn button
  // and hides the input behind it, so clicking the input is clicking through
  // the thing that actually opens the popover.
  const sw = await p.$('.gg-head ~ .r .clrBtn, .geom-group-edit .clrBtn');
  if (sw) { await sw.click(); await p.waitForTimeout(600); }
  const pop = await p.evaluate(() => {
    const el = document.querySelector('.cp-pop');
    if (!el) return { err: 'no popover' };
    const btns = [].map.call(el.querySelectorAll('button[data-hex], .cp-sw'), x =>
      (x.dataset.hex || x.getAttribute('data-hex') || '').toLowerCase());
    const r = el.getBoundingClientRect();
    return {
      open: true, count: btns.length,
      hasBrand: ['#002166', '#0073c6', '#7ed236', '#e2bd60'].filter(h => btns.indexOf(h) >= 0).length,
      onScreen: r.width > 0 && r.bottom <= window.innerHeight + 2 && r.top >= -2,
    };
  });
  ck('the brand colours appear in the picker a user opens',
    pop.open && pop.hasBrand === 4, JSON.stringify(pop));
  ck('the popover still fits on screen with the extra row',
    pop.onScreen === true, JSON.stringify(pop));
  await p.screenshot({ path: path.join(__dirname, 'shot-presets.png') });

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
