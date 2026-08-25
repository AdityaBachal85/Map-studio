/**
 * The board shows each thing once.
 *
 * #mapWrap carries the map's floating furniture — the title card, Key
 * Distances, the colour key, the contour legend — as child elements, and
 * dashMapToCanvas() moves that whole element into the board with appendChild.
 * So all of it rode along into the map tile: Key Distances printed the same
 * five places, distances and times as the Key access points card beside it,
 * from the identical legendRows(), over about a third of the map.
 *
 * The colour key was worse than duplicated. It named every route from
 * `labelText`, which is empty until somebody types one, so five different
 * colours all fell through to the generic "Road / line" — a legend that
 * identifies nothing, in the position readers look first.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/dash-board.cjs
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

/** The five destinations, each on its own colour, with a measured leg. */
const SCENE = [
  ['SVPN Police Academy', 19.12, 72.90, '#8B5CF6'],
  ['Bum-Rukn-Ud Dowla Lake Park', 19.11, 72.85, '#22C55E'],
  ['Shivarampalli Railway Station', 19.08, 72.90, '#EF4444'],
  ['PVNR Express Highway', 19.09, 72.86, '#F97316'],
  ['Epione hera hospital', 19.13, 72.87, '#3B82F6'],
];

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
  await p.waitForTimeout(3200);

  // The routing service is unreachable from here, so the measured result it
  // would have written is supplied directly. `cls` is cleared because that is
  // the case in the report: unclassed routes, each with its own colour, which
  // is the path through colorKeyUnclassedRows() where the naming broke.
  await p.evaluate(scene => {
    map.setView([19.10, 72.88], 13, { animate: false });
    const site = addLocation({ name: 'Ashoka Site', lat: 19.10, lng: 72.88, type: 'site' });
    scene.forEach(([nm, lat, lng, col], i) => {
      const d = addLocation({ name: nm, lat, lng });
      const rt = addRoute();
      rt.fromId = site.id; rt.toId = d.id; rt.color = col; rt.labelText = ''; rt.cls = null;
      rt.alts = [{ d: (i + 1) * 600, t: (i + 1) * 180, coords: [[19.10, 72.88], [lat, lng]] }];
      rt.altIndex = 0;
    });
    rebuildLegend();
  }, SCENE);
  await p.waitForTimeout(700);

  /* -- the colour key names what carries the colour -------------------------- */

  const keyRows = await p.evaluate(() => colorKeyRows().map(r => r.label));
  ck('every colour is named after something',
    keyRows.length > 0 && !keyRows.some(l => /^(Road \/ line|Marked point|Area)$/.test(l)),
    JSON.stringify(keyRows));
  ck('and the names are the places the routes reach',
    SCENE.every(([nm]) => keyRows.indexOf(nm) >= 0),
    keyRows.filter(l => SCENE.some(([nm]) => nm === l)).length + '/' + SCENE.length + ' matched');
  ck('the key agrees with the Key Distances card about those names',
    await p.evaluate(() => {
      const a = legendRows().map(r => r.name).sort();
      const k = colorKeyRows().map(r => r.label);
      return a.every(n => k.indexOf(n) >= 0);
    }) === true);

  /* -- board mode: the map tile carries the map ------------------------------ */

  await p.evaluate(() => setAppMode('dashboard'));
  await p.waitForTimeout(2200);

  const hidden = await p.evaluate(() => {
    const ids = ['titleCard', 'legendCard', 'colorKeyCard', 'contourLegendCard'];
    const out = {};
    ids.forEach(id => {
      const el = document.getElementById(id);
      out[id] = el ? getComputedStyle(el).display : 'missing';
    });
    out.mapParent = document.getElementById('mapWrap').parentNode.id;
    return out;
  });
  ck('the map tile is the map — its four floating cards are hidden on the board',
    ['titleCard', 'legendCard', 'colorKeyCard', 'contourLegendCard'].every(id => hidden[id] === 'none'),
    JSON.stringify(hidden));
  ck('and the map really is inside the board canvas', hidden.mapParent === 'dashGrid', hidden.mapParent);

  /* -- the Legend card ------------------------------------------------------- */

  const legendCard = await p.evaluate(() => {
    const c = dashCards.find(x => x.type === 'legend');
    if (!c) return { found: false };
    const el = document.querySelector('#dashGrid .dash-card[data-card="' + c.id + '"]');
    return {
      found: true,
      onDefaultBoard: true,
      rows: [...el.querySelectorAll('.dc-row-name')].map(n => n.textContent),
      swatches: el.querySelectorAll('.ck-mark').length,
    };
  });
  ck('a Legend card is on the board by default, since the map no longer carries one',
    legendCard.found === true);
  ck('it lists the colours with a swatch each',
    legendCard.rows.length > 0 && legendCard.swatches === legendCard.rows.length,
    JSON.stringify({ rows: legendCard.rows.length, swatches: legendCard.swatches }));
  ck('and none of them reads "Road / line"',
    !legendCard.rows.some(t => /Road \/ line/.test(t)), JSON.stringify(legendCard.rows));

  /* -- the live cards stay live ---------------------------------------------- */

  const live = await p.evaluate(() => {
    const loc = locations.find(l => l.name === 'PVNR Express Highway');
    loc.name = 'Outer Ring Road';
    locChanged(loc);
    rebuildLegend();
    // The CARDS, not the whole grid. #mapWrap lives inside #dashGrid, so the
    // grid's text also contains the map's own pin labels — and those repaint on
    // a scheduled frame, so reading them here would be timing the billboard
    // rather than testing whether the live cards followed.
    const text = [...document.querySelectorAll('#dashGrid .dash-card')]
      .map(el => el.textContent).join(' ');
    return {
      renamed: text.indexOf('Outer Ring Road') >= 0,
      oldGone: text.indexOf('PVNR Express Highway') < 0,
    };
  });
  ck('renaming a place on the map reaches the board\'s live cards, and the old name goes',
    live.renamed === true && live.oldGone === true, JSON.stringify(live));

  await p.screenshot({ path: path.join(__dirname, 'shot-dash-board.png') });

  /* -- and map mode gets its cards back --------------------------------------- */

  await p.evaluate(() => setAppMode('map'));
  await p.waitForTimeout(1400);
  const back = await p.evaluate(() => {
    const ck2 = document.getElementById('colorKeyCard');
    const lc = document.getElementById('legendCard');
    const vis = el => getComputedStyle(el).display !== 'none';
    const overlap = (a, c) => {
      const x = a.getBoundingClientRect(), y = c.getBoundingClientRect();
      return !(x.bottom <= y.top || y.bottom <= x.top || x.right <= y.left || y.right <= x.left);
    };
    return {
      colorKeyVisible: vis(ck2),
      legendVisible: vis(lc),
      // positionColorKey() stacks the key under the distances card by measuring
      // it; a hidden card measures zero, so the board hid both and the key gave
      // up. Nothing recomputed on the way back, leaving it on top of the card.
      stacked: vis(ck2) && vis(lc) ? !overlap(ck2, lc) : 'n/a',
    };
  });
  ck('leaving the board restores the map\'s own cards',
    back.colorKeyVisible === true && back.legendVisible === true, JSON.stringify(back));
  ck('and the colour key is re-stacked under Key Distances rather than on top of it',
    back.stacked === true || back.stacked === 'n/a', JSON.stringify(back));

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
