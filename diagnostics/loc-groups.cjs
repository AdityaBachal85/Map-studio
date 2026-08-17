/**
 * Restyling a colour group of LOCATIONS at once.
 *
 * The shape panel had this; locations are where it was actually wanted — the
 * purple pins are the colleges, the orange ones the stations, and "give all the
 * purple ones the college symbol and a smaller caption" is one intention.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/loc-groups.cjs
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

  // Five purple colleges and three orange stations, as on the reported map.
  await p.evaluate(() => {
    const mk = (colour, n, tag, lat) => {
      for (let i = 0; i < n; i++) {
        addLocation({ name: tag + ' ' + (i + 1), lat: lat + i * 0.005, lng: 73.66 + i * 0.005,
                      color: colour, iconKey: 'school' });
      }
    };
    mk('#7048E8', 5, 'College', 18.72);
    mk('#F76707', 3, 'Station', 18.70);
  });
  await p.waitForTimeout(1200);

  const listed = await p.evaluate(() => ({
    total: realLocations().length,
    groups: locColorGroups().map(g => g.key + ':' + g.count),
    panelShown: getComputedStyle(document.getElementById('locGroups')).display !== 'none',
  }));
  ck('the Locations tab groups them by colour',
    listed.total === 8 && listed.groups.length === 2 && listed.panelShown, JSON.stringify(listed));

  // The panel lives in the Locations tab, which is open by default.
  await p.evaluate(() => { locGroupSelected = '#7048e8'; renderLocGroups(); });
  await p.waitForTimeout(500);

  const controls = await p.evaluate(() => {
    const box = document.querySelector('#locGroups .geom-group-edit');
    if (!box) return { err: 'no editor' };
    const seen = sel => {
      const el = box.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return el.offsetParent !== null && r.width > 0 && r.height > 0;
    };
    return {
      colour: seen('.lg-color'), border: seen('.lg-bcolor'), symbol: seen('.lg-icon'),
      frame: seen('.lg-frame'), size: seen('.lg-size'), edge: seen('.lg-bw'),
      label: seen('.lg-label'), scale: seen('.lg-scale'),
      count: box.querySelector('.gg-head-count').textContent,
    };
  });
  ck('it offers colour, border, symbol, frame, size, edge, label and label size',
    ['colour', 'border', 'symbol', 'frame', 'size', 'edge', 'label', 'scale'].every(k => controls[k]),
    JSON.stringify(controls));
  ck('the header names the group size', /5 locations/.test(controls.count || ''), controls.count);

  await p.screenshot({ path: path.join(__dirname, 'shot-loc-groups.png') });

  // Symbol across the group.
  await p.evaluate(() => locGroupApply('#7048e8', l => { l.iconKey = 'college'; }, 'Symbol'));
  await p.waitForTimeout(700);
  const icons = await p.evaluate(() => ({
    purple: realLocations().filter(l => l.color.toLowerCase() === '#7048e8').map(l => l.iconKey),
    orange: realLocations().filter(l => l.color.toLowerCase() === '#f76707').map(l => l.iconKey),
  }));
  ck('every purple location takes the new symbol',
    icons.purple.length === 5 && icons.purple.every(k => k === 'college'), JSON.stringify(icons.purple));
  ck('the orange ones keep theirs', icons.orange.every(k => k === 'school'), JSON.stringify(icons.orange));

  // Border, size and label size across the group.
  await p.evaluate(() => {
    locGroupApply('#7048e8', l => { l.iconBorder = 5; }, 'Edge');
    locGroupApply('#7048e8', l => { l.iconSize = 46; }, 'Size');
    locGroupApply('#7048e8', l => { l.labelScale = 140; }, 'Label size');
  });
  await p.waitForTimeout(900);
  const styled = await p.evaluate(() => {
    const purple = realLocations().filter(l => l.color.toLowerCase() === '#7048e8');
    const orange = realLocations().filter(l => l.color.toLowerCase() === '#f76707');
    return {
      borders: purple.map(l => l.iconBorder), sizes: purple.map(l => l.iconSize),
      scales: purple.map(l => l.labelScale),
      orangeUntouched: orange.every(l => l.iconBorder !== 5 && l.iconSize !== 46 && l.labelScale !== 140),
    };
  });
  ck('border, marker size and label size all apply to the group',
    styled.borders.every(v => v === 5) && styled.sizes.every(v => v === 46)
    && styled.scales.every(v => v === 140), JSON.stringify(styled));
  ck('and the other colour is untouched by all three',
    styled.orangeUntouched === true, JSON.stringify(styled));

  // It reaches the pixels, not just the record.
  const drawn = await p.evaluate(() => {
    const l = realLocations().find(x => x.color.toLowerCase() === '#7048e8');
    const el = l && l._pinEl;
    const icon = el && el.querySelector('.pin-icon');
    return icon ? { w: Math.round(icon.getBoundingClientRect().width) } : { err: 'no pin element' };
  });
  ck('the bigger marker is actually drawn bigger', drawn.w >= 40, JSON.stringify(drawn));

  // Recolouring the group moves it, and the panel follows.
  await p.evaluate(() => locGroupApply('#7048e8', l => { l.color = '#12B886'; }, 'Colour'));
  await p.waitForTimeout(700);
  const moved = await p.evaluate(() => ({
    selected: locGroupSelected,
    green: realLocations().filter(l => l.color === '#12B886').length,
    groups: locColorGroups().map(g => g.key),
  }));
  ck('recolouring the group moves it and the panel follows',
    moved.selected === '#12b886' && moved.green === 5, JSON.stringify(moved));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
