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

  /* -- a score is out of ten unless somebody says otherwise ----------------- */

  // Back onto the board: the test above left the app in map mode, where the
  // gallery has no height and every clearance check below would pass without
  // measuring anything.
  await p.evaluate(() => setAppMode('dashboard'));
  await p.waitForTimeout(1800);

  // The rings divided every score by a hardcoded hundred, so a site rated 8, 9
  // and 10 — which is how these are rated — drew three rings each about a tenth
  // full under three large correct-looking numbers. The number said 10 and the
  // ring said 10%.
  const rings = await p.evaluate(() => {
    const g = dashCards.find(c => c.type === 'gauges');
    g.items = [{ cap: 'Connectivity', value: '10' }, { cap: 'Infrastructure', value: '9' },
      { cap: 'Development', value: '8' }, { cap: 'Livability', value: '10' }];
    delete g.max;
    renderDashboard();
    const arcs = [...document.querySelectorAll('.dash-card[data-card="' + g.id + '"] .dc-gauge .val')];
    const circ = 2 * Math.PI * 24;
    return { id: g.id, fracs: arcs.map(a => +(parseFloat(a.getAttribute('stroke-dasharray')) / circ).toFixed(2)) };
  });
  ck('ten out of ten is a full ring, not a tenth of one',
    rings.fracs.length === 4 && rings.fracs[0] === 1 && Math.abs(rings.fracs[2] - 0.8) < 0.02,
    JSON.stringify(rings.fracs));

  ck('and a hundred-point card still reads against a hundred',
    await p.evaluate(id => {
      const g = dashCardById(id);
      g.items = [{ cap: 'A', value: '82' }, { cap: 'B', value: '64' }];
      renderDashboard();
      const a = document.querySelector('.dash-card[data-card="' + id + '"] .dc-gauge .val');
      return Math.abs(parseFloat(a.getAttribute('stroke-dasharray')) / (2 * Math.PI * 24) - 0.82) < 0.02;
    }, rings.id) === true);

  ck('an explicit ceiling overrides the guess',
    await p.evaluate(id => {
      const g = dashCardById(id);
      g.max = 20;
      g.items = [{ cap: 'A', value: '10' }];
      renderDashboard();
      const a = document.querySelector('.dash-card[data-card="' + id + '"] .dc-gauge .val');
      return Math.abs(parseFloat(a.getAttribute('stroke-dasharray')) / (2 * Math.PI * 24) - 0.5) < 0.02;
    }, rings.id) === true);

  /* -- the legend can move onto the map ------------------------------------- */

  // Board mode hides every on-map overlay card, and it does that for a reason:
  // the same rows were being printed twice, once in a box over the map and once
  // in a card beside it. So moving the legend back onto the map has to take the
  // card away in the same breath, or the defect returns.
  const moved = await p.evaluate(() => {
    // With the map's OWN colour-key switch off, which is its default. That is
    // the case that was broken: the stylesheet un-hid the card, but
    // rebuildColorKey() writes an inline display and an inline style wins, so
    // the board asked for the legend and nothing appeared.
    const tgl = document.getElementById('colorKeyTgl');
    if (tgl) { tgl.checked = false; if (typeof rebuildColorKey === 'function') rebuildColorKey(); }
    const c = dashCards.find(x => x.type === 'legend');
    c.onMap = true;
    renderDashboard();
    dashLayoutApply();
    const key = document.getElementById('colorKeyCard');
    const mw = document.getElementById('mapWrap').getBoundingClientRect();
    const kr = key.getBoundingClientRect();
    return {
      id: c.id,
      shown: getComputedStyle(key).display !== 'none',
      insideMap: kr.left >= mw.left - 2 && kr.top >= mw.top - 2
        && kr.right <= mw.right + 2 && kr.bottom <= mw.bottom + 2,
      card: !!document.querySelector('.dash-card[data-card="' + c.id + '"]'),
      tiled: dashTiles().some(t => t.id === c.id),
    };
  });
  ck('the legend can sit on the map instead of beside it',
    moved.shown === true && moved.insideMap === true, JSON.stringify(moved));
  ck('and its card leaves the board, so no row is printed twice',
    moved.card === false && moved.tiled === false, JSON.stringify(moved));

  // The map is excluded from the board's html2canvas pass and painted by
  // captureMapHiRes instead, so an overlay on it only reaches the file if that
  // renderer's furniture pass draws it.
  ck('and it reaches the export, which paints the map separately',
    await p.evaluate(() => {
      const wrap = document.getElementById('mapWrap');
      wrap.classList.add('capturing');
      const key = document.getElementById('colorKeyCard');
      const vis = getComputedStyle(key).display !== 'none';
      const shadow = getComputedStyle(key).boxShadow;
      wrap.classList.remove('capturing');
      // No shadow into the capture: html2canvas draws box-shadow as a hard
      // offset slab, which is the defect that put a grey rectangle across the
      // board's right-hand column.
      return vis && (shadow === 'none' || !shadow);
    }) === true);

  ck('switching it back restores the card',
    await p.evaluate(id => {
      const c = dashCardById(id);
      delete c.onMap;
      renderDashboard();
      return !!document.querySelector('.dash-card[data-card="' + id + '"]')
        && getComputedStyle(document.getElementById('colorKeyCard')).display === 'none';
    }, moved.id) === true);

  /* -- title and body align separately -------------------------------------- */

  ck('a card can centre its title and leave its body alone',
    await p.evaluate(() => {
      const c = dashCards.find(x => x.type === 'text') || dashCards[0];
      c.fmt = Object.assign({}, c.fmt, { align: 'center' });
      delete c.fmt.alignBody;
      renderDashboard();
      const el = document.querySelector('.dash-card[data-card="' + c.id + '"]');
      return el.classList.contains('talign-center') && !el.className.match(/balign-/);
    }) === true);

  ck('and align its body without moving the title',
    await p.evaluate(() => {
      const c = dashCards.find(x => x.type === 'text') || dashCards[0];
      c.fmt = Object.assign({}, c.fmt, { alignBody: 'right' });
      delete c.fmt.align;
      renderDashboard();
      const el = document.querySelector('.dash-card[data-card="' + c.id + '"]');
      const t = el.querySelector('.dc-title');
      delete c.fmt.alignBody;
      renderDashboard();
      return el.classList.contains('balign-right') && getComputedStyle(t).textAlign !== 'right';
    }) === true);

  // THE CONTROL ITSELF, not what it sets. It read "Left / Centre / Right" in
  // words, which is three times the width of the icon strip every other
  // application puts there and reads as a sentence rather than a control. Four
  // rules with one of them short is the alignment glyph everywhere from Word to
  // Figma, and it needs no reading at all.
  const align = await p.evaluate(() => {
    const c = dashCards.find(x => x.type === 'text') || dashCards[0];
    dashEditing = true; dashSelectedId = c.id;
    renderDashboard(); renderDashFormat();
    const seg = document.querySelector('#dashFormat [data-df="alignBody"]').closest('.df-seg');
    const btns = [...seg.querySelectorAll('button')];
    return {
      icons: seg.classList.contains('df-seg-icons'),
      words: btns.some(b => /left|centre|right/i.test(b.textContent)),
      glyphs: btns.filter(b => b.querySelector('svg path[d]')).length,
      // An icon with no accessible name is a control only a sighted user who
      // already knows the convention can operate.
      named: btns.every(b => (b.getAttribute('aria-label') || '').trim().length > 2
        && (b.getAttribute('title') || '').trim().length > 2),
      // Four rules per glyph, and no two of the three alike — one path reused
      // for all three would look like a control and set three different things.
      paths: [...new Set(btns.map(b => b.querySelector('svg path').getAttribute('d')))].length,
      rules: btns.every(b => (b.querySelector('svg path').getAttribute('d').match(/M/g) || []).length === 4),
    };
  });
  ck('alignment is set with glyphs rather than with the words for them',
    align.icons === true && align.words === false && align.glyphs >= 3, JSON.stringify(align));
  ck('each glyph is four rules and no two of them are the same drawing',
    align.paths >= 3 && align.rules === true, align.paths + ' distinct');
  ck('and every one of them still says what it is',
    align.named === true);

  /* -- a single bar can be given its own colour ----------------------------- */

  // Excel's "format data point", which had no equivalent here: colour lived on
  // the series, so calling out one category meant splitting it into a series of
  // its own — changing the chart's shape in order to change one bar's hue.
  // Behind a disclosure because most charts never want it and eight more
  // swatches per series would undo the tidying the single trigger just bought.
  const pointsUi = await p.evaluate(() => {
    // Borrowed, then given back: every section after this one reads the board
    // this suite has been building since the top, so a section that leaves its
    // own fixture in place breaks whatever is written below it.
    const board = dashCards;
    const c = Object.assign(dashNewCard('column'), { id: 'pc', title: 'Points', x: 0, y: 0, w: 10, h: 8,
      labels: ['North', 'East', 'South'], seriesList: [{ name: 'S', values: [4, 9, 6], slot: 1 }] });
    dashCards = [c];
    dashEditing = true; dashSelectedId = 'pc';
    renderDashboard(); renderDashFormat();
    const d = document.querySelector('#dashFormat details.df-points');
    const shut = d && !d.open;
    const rows = d ? [...d.querySelectorAll('.df-row > span, .df-row > label')].map(x => x.textContent.trim()) : [];
    dashFormatApply(c, 'pt:0:1', '#e03131');
    renderDashFormat();
    const d2 = document.querySelector('#dashFormat details.df-points');
    const out = { shut: shut, rows: rows, openNow: !!(d2 && d2.open),
      summary: d2 ? d2.querySelector('summary').textContent : '',
      clears: d2 ? d2.querySelectorAll('[data-df^="ptclear:"]').length : -1 };
    dashFormatApply(c, 'ptclear:0:1', '1');
    dashEditing = false; dashSelectedId = null;
    dashCards = board;
    renderDashboard(); dashLayoutApply();
    return out;
  });
  ck('every category gets a swatch of its own, named after the category',
    pointsUi.rows.join() === 'North,East,South', pointsUi.rows.join(' '));
  ck('folded away until it is used, and open once it is',
    pointsUi.shut === true && pointsUi.openNow === true,
    'shut ' + pointsUi.shut + ' / open ' + pointsUi.openNow);
  ck('the summary says how many bars were given their own colour',
    /1/.test(pointsUi.summary), JSON.stringify(pointsUi.summary));
  ck('and only a bar that has one offers a way back to the series colour',
    pointsUi.clears === 1, String(pointsUi.clears));

  // A PIE HAS NO SERIES COLOUR, so the swatches are not an override of one —
  // they are the only colour control it has, and folding them away behind a
  // disclosure made the colours of five chart kinds unreachable. The series
  // swatch above them is worse than useless on those kinds: it is a control
  // that sets a value the chart never reads.
  const catUi = await p.evaluate(() => {
    const board = dashCards;
    const look = kind => {
      const c = Object.assign(dashNewCard(kind), { id: 'cc', title: kind, x: 0, y: 0, w: 8, h: 8,
        labels: ['North', 'East', 'South'], seriesList: [{ name: 'S', values: [4, 9, 6], slot: 1 }] });
      dashCards = [c];
      dashEditing = true; dashSelectedId = 'cc';
      renderDashboard(); renderDashFormat();
      const pane = document.getElementById('dashFormat');
      const series = pane.querySelector('.df-series');
      return {
        folded: !!pane.querySelector('details.df-points'),
        open: !!pane.querySelector('.df-points-open'),
        swatches: pane.querySelectorAll('[data-dfpick^="pt:0:"]').length,
        seriesSwatch: series ? series.querySelectorAll('[data-dfpick^="slot:"]').length : -1,
      };
    };
    const out = { pie: look('pie'), ring: look('ring'), treemap: look('treemap'),
      column: look('column') };
    dashEditing = false; dashSelectedId = null;
    dashCards = board;
    renderDashboard(); dashLayoutApply();
    return out;
  });
  ck('a pie, a ring and a treemap show a swatch per category, unfolded',
    ['pie', 'ring', 'treemap'].every(k => catUi[k].open && !catUi[k].folded && catUi[k].swatches === 3),
    JSON.stringify(catUi));
  ck('and none of them is offered a series colour it would ignore',
    ['pie', 'ring', 'treemap'].every(k => catUi[k].seriesSwatch === 0),
    ['pie', 'ring', 'treemap'].map(k => k + ':' + catUi[k].seriesSwatch).join(' '));
  ck('a column still leads with its series colour and folds the rest away',
    catUi.column.seriesSwatch === 1 && catUi.column.folded && !catUi.column.open,
    JSON.stringify(catUi.column));

  /* -- a table fills its rows, like a table in any spreadsheet -------------- */

  const fills = await p.evaluate(() => {
    const board = dashCards;
    const c = Object.assign(dashNewCard('table'), { id: 'tf', title: 'Table', x: 0, y: 0, w: 7, h: 8,
      columns: ['Item', 'Value'],
      rows: [['Station', '2.4 km'], ['Airport', '27.5 km'], ['Mall', '3.6 km']],
      headFill: '#14243d', rowFill: { 1: '#e03131' } });
    dashCards = [c];
    dashEditing = true; dashSelectedId = 'tf';
    renderDashboard(); dashLayoutApply(); renderDashFormat();
    const el = document.querySelector('.dash-card[data-card="tf"]');
    const trs = [...el.querySelectorAll('tbody tr')];
    const read = n => ({ bg: n.style.background || n.style.backgroundColor, ink: n.style.color });
    const pane = document.getElementById('dashFormat');
    const out = {
      head: read(el.querySelector('thead tr')),
      rows: trs.map(read),
      // Only a filled row loses the zebra; the rest keep it.
      classed: trs.map(t => t.classList.contains('dc-tr-fill')),
      swatches: pane.querySelectorAll('[data-dfpick^="rowfill:"]').length,
      headSwatch: pane.querySelectorAll('[data-dfpick="headfill"]').length,
      clears: pane.querySelectorAll('[data-df^="rowfillclear:"]').length,
    };
    dashEditing = false; dashSelectedId = null;
    dashCards = board; renderDashboard(); dashLayoutApply();
    return out;
  });
  ck('a filled row carries the colour it was given',
    /224,\s*49,\s*49|#e03131/i.test(fills.rows[1].bg), JSON.stringify(fills.rows[1]));
  ck('and rows nobody filled are left alone',
    !fills.rows[0].bg && !fills.rows[2].bg, JSON.stringify(fills.rows.map(r => r.bg)));
  ck('the header is its own choice', /20,\s*36,\s*61|#14243d/i.test(fills.head.bg),
    JSON.stringify(fills.head));

  // A fill the operator chose is any colour at all, so the row's text cannot
  // stay the theme's ink and hope. A dark fill under grey body text is a row
  // nobody can read, and in an export there is no way to turn the fill off to
  // find out what it said.
  ck('a dark fill takes light ink and a light fill takes dark',
    fills.rows[1].ink === 'rgb(255, 255, 255)' && fills.head.ink === 'rgb(255, 255, 255)',
    fills.rows[1].ink + ' / ' + fills.head.ink);
  ck('only a filled row drops the card\'s zebra striping',
    fills.classed.join() === 'false,true,false', fills.classed.join());
  ck('every row is offered a fill, and only the filled one a way back',
    fills.swatches === 3 && fills.headSwatch === 1 && fills.clears === 1,
    JSON.stringify(fills));

  const inks = await p.evaluate(() => ({
    white: dashInkOn('#14243d'), dark: dashInkOn('#c8f0d2'),
    mid: dashInkOn('#e03131'), none: dashInkOn(''), bad: dashInkOn('nonsense'),
  }));
  ck('and the ink rule is luminance, not a guess',
    inks.white === '#ffffff' && inks.dark === '#14243d' && inks.mid === '#ffffff'
      && inks.none === null && inks.bad === null, JSON.stringify(inks));

  // A fill that exists only on screen is not a fill: both writers that can set
  // a cell background are handed one.
  const model = await p.evaluate(() => {
    const c = Object.assign(dashNewCard('table'), { id: 'tm', title: 'T', x: 0, y: 0, w: 6, h: 7,
      columns: ['A', 'B'], rows: [['1', '2'], ['3', '4']],
      headFill: '#14243d', rowFill: { 1: '#E03131' } });
    const cs = getComputedStyle(document.documentElement);
    const m = dashExportModel({ title: 'T', cards: [c], mapTile: null,
      resolveColor: n => cs.getPropertyValue(n).trim() });
    return m.cards[0].data;
  });
  ck('the export model carries the fills, normalised and validated',
    model.headFill === '#14243d' && model.rowFill[0] === null
      && model.rowFill[1] === '#e03131',
    JSON.stringify({ h: model.headFill, r: model.rowFill }));

  /* -- the top bar is a toolbar, not a map with buttons on it --------------- */

  // The search box in the bar is the MAP's search box, re-parented rather than
  // duplicated. It arrives dressed for a map: 46px tall, with a 30px drop
  // shadow made to lift it off imagery and a 36px circular button on the end.
  // In a row of 32px controls that reads as a floating pill dropped on the
  // toolbar — and being the tallest thing in the row, it set the bar's height.
  const bar = await p.evaluate(() => {
    const el = document.getElementById('dashTop');
    const inner = document.querySelector('#dashTopSearch .inner');
    const btn = document.getElementById('dashExportBtn');
    return {
      barH: Math.round(el.getBoundingClientRect().height),
      searchH: Math.round(inner.getBoundingClientRect().height),
      btnH: Math.round(btn.getBoundingClientRect().height),
      shadow: getComputedStyle(inner).boxShadow,
      slotAnchored: getComputedStyle(document.getElementById('dashTopSearch')).position,
    };
  });
  ck('the search field is the same height as the buttons beside it',
    bar.searchH === bar.btnH, bar.searchH + ' vs ' + bar.btnH);
  ck('and it does not float above the bar it is sitting in',
    bar.shadow === 'none', bar.shadow);
  ck('the bar is sized by its contents, not by a pill that used to be taller',
    bar.barH <= bar.searchH + 14, bar.barH + 'px around a ' + bar.searchH + 'px control');
  ck('and the results list has something to hang from',
    bar.slotAnchored === 'relative', bar.slotAnchored);

  /* -- colour is a choice, and every choice is legible ---------------------- */

  // A header bar can take any of the eight palette slots, and several of those
  // hues are far too light to carry 9.5px type: white on slot one is 4.3:1 and
  // navy on it is 3.8:1, so NEITHER ink reaches AA and picking between them by
  // luminance only chooses the less bad one. The bar is therefore the slot mixed
  // into navy, which keeps the hue and guarantees the ink. This measures it.
  const bars = await p.evaluate(() => {
    const c = dashCards.find(x => x.type === 'text') || dashCards[0];
    const lin = v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    const out = {};
    ['navy', '1', '2', '3', '4', '5', '6', '7', '8'].forEach(t => {
      c.fmt = Object.assign({}, c.fmt, { head: 'bar', headTone: t });
      renderDashboard();
      const head = document.querySelector('.dash-card[data-card="' + c.id + '"] .dc-head');
      const bg = getComputedStyle(head).backgroundColor;
      // color-mix() computes to color(srgb r g b) with 0-1 channels, not rgb().
      const nums = (bg.match(/[0-9.]+/g) || []).map(Number);
      const ch = /^color\(/.test(bg) ? nums.slice(0, 3).map(v => v * 255) : nums.slice(0, 3);
      const L = 0.2126 * lin(ch[0]) + 0.7152 * lin(ch[1]) + 0.0722 * lin(ch[2]);
      out[t] = { ratio: Math.round((1.05 / (L + 0.05)) * 100) / 100,
        ink: getComputedStyle(head.querySelector('.dc-title')).color };
    });
    delete c.fmt.head;
    renderDashboard();
    return out;
  });
  const worst = Object.keys(bars).reduce((a, k) => Math.min(a, bars[k].ratio), 99);
  ck('every header bar clears AA against its own title',
    worst >= 4.5, 'worst ' + worst + ':1');
  ck('and the title is white on all of them, so one rule covers every tone',
    Object.keys(bars).every(k => bars[k].ink === 'rgb(255, 255, 255)'),
    Object.keys(bars).filter(k => bars[k].ink !== 'rgb(255, 255, 255)').join(',') || 'all white');

  // The rings had no colour control at all — they took the slot their position
  // gave them while every chart series beside them had swatches.
  ck('a score ring takes the colour it was given, not the one its position implies',
    await p.evaluate(() => {
      const g = dashCards.find(x => x.type === 'gauges');
      g.items = [{ cap: 'A', value: '9', slot: 5 }, { cap: 'B', value: '7' }];
      renderDashboard();
      const strokes = [...document.querySelectorAll('.dash-card[data-card="' + g.id + '"] .dc-gauge .val')]
        .map(c => c.getAttribute('stroke'));
      return strokes[0] === 'var(--viz-5)' && strokes[1] === 'var(--viz-2)';
    }) === true);

  // A legend that cannot be resized either crowds the map or cannot fit its own
  // longest name. The browser forgets the size on every rebuild, so it is
  // written back onto the card.
  const sized = await p.evaluate(async () => {
    const c = dashCards.find(x => x.type === 'legend');
    c.onMap = true;
    renderDashboard();
    const key = document.getElementById('colorKeyCard');
    // Read, do not hold: getComputedStyle returns a live view, so a reference
    // taken here reports the state at the END of this function rather than at
    // the moment it was taken.
    const resize = getComputedStyle(key).resize;
    key.style.width = '268px';
    key.style.height = '188px';
    await new Promise(r => setTimeout(r, 320));
    const remembered = { w: c.mapW, h: c.mapH };
    renderDashboard();
    await new Promise(r => setTimeout(r, 200));
    const back = document.getElementById('colorKeyCard');
    const reapplied = back.style.width + ' ' + back.style.height;
    delete c.onMap;
    renderDashboard();
    return { resize, remembered, reapplied };
  });
  ck('the on-map legend has a real resize grip', sized.resize === 'both', sized.resize);
  ck('and the size it was dragged to survives a rebuild',
    sized.remembered.w === 268 && sized.reapplied === '268px 188px',
    JSON.stringify(sized));

  /* -- the gallery does not stand on the board ------------------------------ */

  // #dashAdd is absolutely positioned at the bottom of the grid, and the grid
  // used to reserve a fixed two spare rows for it. The gallery wraps, so its
  // height depends on how many kinds there are — at three rows it was taller
  // than the space reserved and grew upward over the cards.
  await p.evaluate(() => setDashEditing(true));
  await p.waitForTimeout(700);
  const gallery = await p.evaluate(() => {
    const grid = document.getElementById('dashGrid');
    const add = document.getElementById('dashAdd');
    const ar = add.getBoundingClientRect();
    const over = [...grid.querySelectorAll('.dash-card')].filter(el => {
      const r = el.getBoundingClientRect();
      return !(r.bottom <= ar.top || r.top >= ar.bottom || r.right <= ar.left || r.left >= ar.right);
    }).length;
    return { addH: Math.round(ar.height), over,
      insideGrid: ar.bottom <= grid.getBoundingClientRect().bottom + 1 };
  });
  ck('the visual gallery covers no card, however many rows it wraps to',
    gallery.over === 0 && gallery.addH > 40, JSON.stringify(gallery));
  ck('and the board still ends below it', gallery.insideGrid === true);
  await p.evaluate(() => setDashEditing(false));
  await p.waitForTimeout(500);

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
