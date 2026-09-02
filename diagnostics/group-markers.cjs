/**
 * Editing a whole colour group's markers at once.
 *
 * "Purple is the colleges" is one decision, so changing the symbol, the marker
 * style, the caption or its size across all of them should be one action — not
 * seven cards edited by hand, which is how a deck ends up with three different
 * caption sizes on shapes that mean the same thing.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/group-markers.cjs
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
  await p.evaluate(() => map.setView([18.73, 73.67], 13, { animate: false }));
  await p.click('#tabBtnDraw');
  await p.waitForTimeout(500);

  // Seven purple college pins and three orange station pins, as on a real map.
  await p.evaluate(() => {
    const mk = (colour, n, tag, lat) => {
      for (let i = 0; i < n; i++) {
        registerGeom(L.marker([lat + i * 0.004, 73.66 + i * 0.004]), 'Marker', {
          name: tag + ' ' + (i + 1), fillColor: colour, borderColor: '#FFFFFF',
          markerStyle: 'pin', showLabel: true, iconKey: 'school',
        });
      }
    };
    mk('#7048e8', 7, 'College', 18.72);
    mk('#f76707', 3, 'Station', 18.70);
    renderGeomGroups();
  });
  await p.waitForTimeout(700);

  await p.evaluate(() => { geomGroupSelected = '#7048e8'; renderGeomGroups(); });
  await p.waitForTimeout(500);

  const controls = await p.evaluate(() => {
    const box = document.querySelector('.geom-group-edit');
    if (!box) return { err: 'no group editor' };
    const vis = sel => {
      const el = box.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { present: true, seen: el.offsetParent !== null && r.width > 0 && r.height > 0 };
    };
    return {
      marker: vis('.gg-marker'), icon: vis('.gg-icon'),
      label: vis('.gg-showlabel'), size: vis('.gg-capsize'),
      markerValue: (box.querySelector('.gg-marker') || {}).value,
      sizeValue: (box.querySelector('.gg-capsize') || {}).value,
    };
  });
  ck('the group offers marker, symbol, caption and size controls',
    ['marker', 'icon', 'label', 'size'].every(k => controls[k] && controls[k].seen),
    JSON.stringify(controls));
  ck('they open on the group\'s shared values, not "Mixed"',
    controls.markerValue === 'pin' && controls.sizeValue === '11', JSON.stringify(controls));

  await p.screenshot({ path: path.join(__dirname, 'shot-group-markers.png') });

  // Change the SYMBOL for the whole purple group.
  await p.evaluate(() => {
    geomGroupApply('#7048e8', g => { if (g.shape === 'Marker') g.iconKey = 'college'; }, 'Set the symbol');
  });
  await p.waitForTimeout(700);
  const icons = await p.evaluate(() => ({
    purple: geometries.filter(g => g.fillColor === '#7048e8').map(g => g.iconKey),
    orange: geometries.filter(g => g.fillColor === '#f76707').map(g => g.iconKey),
  }));
  ck('every purple pin takes the new symbol',
    icons.purple.length === 7 && icons.purple.every(k => k === 'college'), JSON.stringify(icons.purple));
  ck('and the orange ones are untouched',
    icons.orange.every(k => k === 'school'), JSON.stringify(icons.orange));

  // Caption size across the group.
  await p.evaluate(() => geomGroupApply('#7048e8', g => { g.captionSize = 17; }, 'Set the caption size'));
  await p.waitForTimeout(700);
  const sized = await p.evaluate(() => {
    const purple = geometries.filter(g => g.fillColor === '#7048e8');
    const span = purple[0]._el;
    return {
      all17: purple.every(g => g.captionSize === 17),
      rendered: span ? getComputedStyle(span).fontSize : null,
      orange: geometries.filter(g => g.fillColor === '#f76707').map(g => g.captionSize),
    };
  });
  ck('the caption size applies to the whole group', sized.all17 === true, JSON.stringify(sized));
  ck('and it actually reaches the pixels', sized.rendered === '17px', 'fontSize=' + sized.rendered);
  ck('the other group keeps its own size',
    sized.orange.every(v => v === undefined || v === 11), JSON.stringify(sized.orange));

  // Marker style across the group, and captions off.
  await p.evaluate(() => {
    geomGroupApply('#7048e8', g => { if (g.shape === 'Marker') g.markerStyle = 'square'; }, 'Marker');
    geomGroupApply('#7048e8', g => { g.showLabel = false; }, 'Captions off');
  });
  await p.waitForTimeout(700);
  const restyled = await p.evaluate(() => ({
    squares: geometries.filter(g => g.fillColor === '#7048e8' && geomMarkerStyle(g) === 'square').length,
    captions: document.querySelectorAll('.label-badge.geom').length,
    orangePins: geometries.filter(g => g.fillColor === '#f76707' && geomMarkerStyle(g) === 'pin').length,
  }));
  ck('marker style applies across the group', restyled.squares === 7, JSON.stringify(restyled));
  ck('captions can be turned off for the group only',
    restyled.captions === 3 && restyled.orangePins === 3, JSON.stringify(restyled));

  // One Undo per group action, not one per shape.
  await p.evaluate(() => doUndo());
  await p.waitForTimeout(600);
  ck('one Undo takes back the whole group change',
    await p.evaluate(() => geometries.filter(g => g.fillColor === '#7048e8' && g.showLabel).length === 7));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
