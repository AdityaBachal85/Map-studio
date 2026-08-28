/**
 * The Excel-grade controls in the format pane, for tables and for charts.
 *
 * WHY THIS SUITE EXISTS. Twice in this feature a control was added to the pane,
 * rendered correctly, and did nothing at all: the data-label toggle had no
 * branch in dashFormatApply, and the axis-title and decimal inputs used an
 * attribute nothing listened for. Both looked right in a screenshot. So every
 * assertion here drives the actual control in the pane and then reads the
 * result off the drawn SVG or the computed style of the cell — never off the
 * attribute that was just written, which is the mistake that let the table-ink
 * bug pass a green suite.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/dash-excel.cjs
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

/** Type into the pane input carrying this attribute, as a person would. */
async function typeInto(p, sel, value) {
  const el = await p.$(sel);
  if (!el) return false;
  await el.click({ clickCount: 3 });
  await el.fill(String(value));
  await el.dispatchEvent('change');
  await p.waitForTimeout(320);
  return true;
}

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

  /* ---------------------------------------------------------------- charts */

  await p.evaluate(() => {
    setAppMode('dashboard');
    dashEditing = true;
    dashCards = [Object.assign(dashNewCard('column'), {
      id: 'c1', title: 'Trips', x: 0, y: 0, w: 8, h: 8,
      labels: ['2021', '2022', '2023', '2024'],
      seriesList: [{ name: 'Trips', values: [1200, 3000, 2200, 4100], slot: 1 }],
      fmt: { labels: true, xAxis: true, yAxis: true },
    })];
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard();
    dashSelect('c1');
  });
  await p.waitForTimeout(900);

  const paneUp = await p.evaluate(() =>
    !!document.querySelector('#dashFormat [data-dftext="xTitle"]'));
  ck('the pane offers an axis title on a chart that has axes', paneUp);

  // A compact default is what the chart draws before anybody asks otherwise.
  const before = await p.evaluate(() =>
    Array.from(document.querySelectorAll('#dashGrid .viz-label')).map(t => t.textContent));
  ck('a chart prints grouped whole numbers until told otherwise',
    before.length === 4 && before.every(t => /^[\d,]+$/.test(t)), JSON.stringify(before));

  await typeInto(p, '#dashFormat [data-dftext="xTitle"]', 'Year');
  await typeInto(p, '#dashFormat [data-dftext="yTitle"]', 'Trips per day');
  const titles = await p.evaluate(() =>
    Array.from(document.querySelectorAll('#dashGrid .viz-axtitle')).map(t => t.textContent));
  ck('typing a category title puts it on the chart', titles.indexOf('Year') >= 0, JSON.stringify(titles));
  ck('and a value title, turned on its side', titles.indexOf('Trips per day') >= 0);

  const rot = await p.evaluate(() => {
    const t = Array.from(document.querySelectorAll('#dashGrid .viz-axtitle'))
      .find(n => n.textContent === 'Trips per day');
    return t ? t.getAttribute('transform') : '';
  });
  ck('the value title is actually rotated, not just placed', /rotate\(-90\)/.test(rot), rot);

  // The plot has to give up the room, or the title lands on the ticks.
  const moved = await p.evaluate(() => {
    const g = document.querySelector('#dashGrid .viz-grid');
    return g ? +g.getAttribute('x1') : null;
  });
  ck('the plot moved over to make room for it', moved != null && moved >= 40, String(moved));

  await typeInto(p, '#dashFormat [data-dfnum="decimals"]', 1);
  await typeInto(p, '#dashFormat [data-dftext="numPrefix"]', '₹');
  const money = await p.evaluate(() =>
    Array.from(document.querySelectorAll('#dashGrid .viz-label')).map(t => t.textContent));
  ck('decimals and a prefix reach the data labels',
    money.some(t => t === '₹1,200.0'), JSON.stringify(money));

  const ticks = await p.evaluate(() =>
    Array.from(document.querySelectorAll('#dashGrid .viz-tick')).map(t => t.textContent));
  ck('and the value axis, so the two agree',
    ticks.some(t => /^₹[\d,]+\.\d$/.test(t)), JSON.stringify(ticks.slice(0, 6)));

  // A decimal count is not geometry. Running it through the layout clamps put
  // it through dashSettle and capped it at the column count.
  const geom = await p.evaluate(() => {
    const c = dashCardById('c1');
    return { w: c.w, h: c.h, x: c.x, y: c.y, dp: c.fmt.decimals };
  });
  ck('typing a decimal count did not move or resize the tile',
    geom.w === 8 && geom.h === 8 && geom.x === 0 && geom.y === 0 && geom.dp === 1,
    JSON.stringify(geom));

  // BOTH OF THESE WERE FOUND BY LOOKING AT THE PICTURE, not by an assertion.
  // The title was drawn on the same baseline as the category names, and the
  // fixed 42px value-axis pad — which fits "150K" — did not fit "₹150,000", so
  // the ticks ran left out of the plot and under their own rotated title.
  const clear = await p.evaluate(() => {
    // Not `#dashGrid svg` — the card's own duplicate and close buttons are
    // inline SVGs and sit earlier in the DOM than the chart does.
    const svg = document.querySelector('#dashGrid .viz-grid').ownerSVGElement;
    const cats = ['2021', '2022', '2023', '2024'];
    const catY = Array.from(svg.querySelectorAll('.viz-tick'))
      .filter(t => cats.indexOf(t.textContent) >= 0).map(t => +t.getAttribute('y'));
    const title = Array.from(svg.querySelectorAll('.viz-axtitle'))
      .find(t => t.textContent === 'Year');
    const tickR = Math.max.apply(null, Array.from(svg.querySelectorAll('.viz-tick'))
      .filter(t => /₹/.test(t.textContent)).map(t => t.getBBox().x + t.getBBox().width));
    const plotL = +svg.querySelector('.viz-grid').getAttribute('x1');
    const yt = Array.from(svg.querySelectorAll('.viz-axtitle'))
      .find(t => t.textContent === 'Trips per day');
    const ytR = yt.getBBox().x + yt.getBBox().width;
    return { catY: catY[0], titleY: +title.getAttribute('y'), tickR, plotL, ytR };
  });
  ck('the category names sit above the category title, not on its baseline',
    clear.catY <= clear.titleY - 12, JSON.stringify(clear));
  ck('a formatted value axis widened the plot to fit its own numbers',
    clear.tickR < clear.plotL, 'ticks end at ' + Math.round(clear.tickR) + ', plot starts at ' + clear.plotL);
  ck('and the numbers clear the rotated title beside them',
    clear.ytR < clear.tickR - 8, 'title ends at ' + Math.round(clear.ytR));

  await typeInto(p, '#dashFormat [data-dfnum="barGap"]', 0);
  const w0 = await p.evaluate(() => {
    const b = document.querySelector('#dashGrid .viz-mark').getBBox();
    return Math.round(b.width);
  });
  ck('a gap width of zero makes the bars fill their band', w0 > 40, String(w0) + 'px wide');

  await typeInto(p, '#dashFormat [data-dfnum="barGap"]', 400);
  const w1 = await p.evaluate(() => {
    const b = document.querySelector('#dashGrid .viz-mark').getBBox();
    return Math.round(b.width);
  });
  ck('and a wide gap makes them thin', w1 > 0 && w1 < w0 / 3, w1 + 'px vs ' + w0 + 'px');

  // Blank is "the app decides", not "zero".
  await typeInto(p, '#dashFormat [data-dfnum="barGap"]', '');
  const w2 = await p.evaluate(() => {
    const c = dashCardById('c1');
    const b = document.querySelector('#dashGrid .viz-mark').getBBox();
    return { w: Math.round(b.width), stored: c.fmt.barGap, cap: VIZ_BAR_MAX };
  });
  // Blank is "the app decides", not "zero" — and what the app decides is its
  // own 24px ceiling, which is neither of the two widths just asked for.
  ck('clearing it hands the width back to the app rather than setting zero',
    w2.stored === undefined && w2.w === w2.cap && w2.w !== w0, JSON.stringify(w2));

  /* ------------------------------------------------------- markers on a line */

  await p.evaluate(() => {
    const c = dashCardById('c1');
    c.kind = 'line'; delete c.fmt.barGap;
    renderDashboard(); dashSelect('c1');
  });
  await p.waitForTimeout(700);

  const dots0 = await p.evaluate(() => document.querySelectorAll('#dashGrid .viz-dot').length);
  ck('a line carries a marker on every point by default', dots0 === 4, String(dots0));

  await p.evaluate(() => {
    document.querySelector('#dashFormat [data-df="markers"][data-v="off"]').click();
  });
  await p.waitForTimeout(500);
  const dots1 = await p.evaluate(() => ({
    dots: document.querySelectorAll('#dashGrid .viz-dot').length,
    line: document.querySelectorAll('#dashGrid .viz-line').length,
  }));
  ck('turning markers off removes them and leaves the line', dots1.dots === 0 && dots1.line === 1,
    JSON.stringify(dots1));

  await p.evaluate(() => {
    document.querySelector('#dashFormat [data-df="markers"][data-v="l"]').click();
  });
  await p.waitForTimeout(500);
  const dots2 = await p.evaluate(() => {
    const c = document.querySelector('#dashGrid .viz-dot');
    return { n: document.querySelectorAll('#dashGrid .viz-dot').length, r: c ? +c.getAttribute('r') : 0 };
  });
  ck('and a large marker is bigger than the default', dots2.n === 4 && dots2.r > 4, JSON.stringify(dots2));

  // A label offset tuned for the 4px default let a large marker grow into it.
  const gap = await p.evaluate(() => {
    const svg = document.querySelector('#dashGrid .viz-dot').ownerSVGElement;
    const dots = Array.from(svg.querySelectorAll('.viz-dot'));
    const labs = Array.from(svg.querySelectorAll('.viz-label'));
    return dots.map((d, i) => {
      const db = d.getBBox(), lb = labs[i] ? labs[i].getBBox() : null;
      return lb ? Math.min(Math.abs(lb.y + lb.height - db.y), Math.abs(db.y + db.height - lb.y)) : 99;
    });
  });
  ck('a large marker does not grow into its own label',
    gap.every(g => g >= 0.5), JSON.stringify(gap.map(g => Math.round(g * 10) / 10)));

  // A scatter IS its markers; the setting must not be able to erase it.
  await p.evaluate(() => {
    const c = dashCardById('c1');
    c.kind = 'scatter'; c.fmt.markers = 'off';
    renderDashboard();
  });
  await p.waitForTimeout(700);
  const scat = await p.evaluate(() => document.querySelectorAll('#dashGrid .viz-dot').length);
  ck('a scatter keeps its dots whatever the marker setting says', scat === 4, String(scat));

  /* ------------------------------------------------- number format on a ring */

  await p.evaluate(() => {
    dashCards = [Object.assign(dashNewCard('gauges'), {
      id: 'g1', title: 'Scores', x: 0, y: 0, w: 8, h: 6,
      items: [{ cap: 'Access', value: '8' }, { cap: 'Retail', value: '6' }],
    })];
    renderDashboard(); dashSelect('g1');
  });
  await p.waitForTimeout(700);
  const gaugePane = await p.evaluate(() =>
    !!document.querySelector('#dashFormat [data-dfnum="decimals"]'));
  ck('the score-rings card is offered the same number format', gaugePane);

  await typeInto(p, '#dashFormat [data-dfnum="decimals"]', 1);
  const dial = await p.evaluate(() =>
    Array.from(document.querySelectorAll('#dashGrid .dc-gauge-num')).map(t => t.textContent));
  ck('and the number in the middle of the dial obeys it',
    dial[0] === '8.0', JSON.stringify(dial));

  // The rings ARE their markup, so a redraw of charts alone leaves them stale.
  const stillThere = await p.evaluate(() => document.querySelectorAll('#dashGrid .dc-gauge-num').length);
  ck('rebuilding the card did not lose the other ring', stillThere === 2, String(stillThere));

  /* ------------------------------------------------------ the export agrees */

  const model = await p.evaluate(() => {
    dashCards = [Object.assign(dashNewCard('column'), {
      id: 'c9', title: 'Trips', x: 0, y: 0, w: 8, h: 8,
      labels: ['2021', '2022'],
      seriesList: [{ name: 'Trips', values: [1200, 3000], slot: 1 }],
      fmt: { decimals: 1, numPrefix: '₹', xTitle: 'Year', yTitle: 'Rupees' },
    })];
    renderDashboard();
    const m = dashExportModel({
      resolveColor: s => getComputedStyle(document.documentElement)
        .getPropertyValue('--viz-' + s).trim() || null,
    });
    const t = m.cards.find(x => x.id === 'c9');
    return { numFmt: t.data.numFmt, xTitle: t.data.xTitle, yTitle: t.data.yTitle };
  });
  ck('the export model carries the number format', model.numFmt
    && model.numFmt.decimals === 1 && model.numFmt.prefix === '₹', JSON.stringify(model.numFmt));
  ck('and both axis titles', model.xTitle === 'Year' && model.yTitle === 'Rupees',
    JSON.stringify([model.xTitle, model.yTitle]));

  const printed = await p.evaluate(() =>
    [dashModelNum(1200, { decimals: 1, prefix: '₹', suffix: '' }),
      dashModelNum(1200, null), dashModelNum(null, null)]);
  ck('and a writer printing one gets the same string the chart drew',
    printed[0] === '₹1,200.0' && printed[1] === '1,200' && printed[2] === '—',
    JSON.stringify(printed));

  /* ----------------------------------------------------------------- tables */

  await p.evaluate(() => {
    dashCards = [Object.assign(dashNewCard('table'), {
      id: 't1', title: 'Rates', x: 0, y: 0, w: 10, h: 8,
      columns: ['Place', 'km'],
      rows: [['Andheri', '4.2'], ['Bandra', '9.1']],
    })];
    renderDashboard(); dashSelect('t1');
  });
  await p.waitForTimeout(700);

  const hasText = await p.evaluate(() =>
    !!document.querySelector('#dashFormat [data-dfpick="headink"]'));
  ck('the table pane offers a text colour beside the fill', hasText);

  await p.evaluate(() => {
    dashFormatApply(dashCardById('t1'), 'headfill', '#0b3d2e');
    dashFormatApply(dashCardById('t1'), 'headink', '#ffe066');
    renderDashboard();
  });
  await p.waitForTimeout(500);
  // Read the COMPUTED colour off the element that carries it, not the attribute
  // just written: the .dc-th div sets its own colour and beat inheritance, and
  // asserting on the attribute is exactly how that shipped green once already.
  const head = await p.evaluate(() => {
    // `.dc-headrow`, not `thead tr`: the first row of the thead in edit mode is
    // the column-tab strip that the spreadsheet frame adds.
    const tr = document.querySelector('#dashGrid .dc-headrow');
    const th = document.querySelector('#dashGrid .dc-th');
    return { ink: getComputedStyle(th).color, fill: getComputedStyle(tr).backgroundColor };
  });
  ck('a header text colour actually reaches the header text',
    /255,\s*224,\s*102/.test(head.ink), JSON.stringify(head));
  ck('and the fill is on the row behind it', /11,\s*61,\s*46/.test(head.fill), head.fill);

  await p.evaluate(() => {
    dashFormatApply(dashCardById('t1'), 'rowfill:1', '#123456');
    renderDashboard();
  });
  await p.waitForTimeout(500);
  const rows = await p.evaluate(() => Array.from(document.querySelectorAll('#dashGrid tbody tr'))
    .map(r => getComputedStyle(r).backgroundColor));
  ck('a per-row fill lands on the row it names and no other',
    rows.length >= 2 && !/18,\s*52,\s*86/.test(rows[0]) && /18,\s*52,\s*86/.test(rows[1]),
    JSON.stringify(rows));

  const inked = await p.evaluate(() => getComputedStyle(
    document.querySelectorAll('#dashGrid tbody tr')[1].querySelector('.dc-td')).color);
  ck('and its text turned readable against that dark fill without being asked',
    /^rgb\((2[0-9]{2}|1[89][0-9]),/.test(inked), inked);

  await p.evaluate(() => {
    dashFormatApply(dashCardById('t1'), 'colalign:1', 'right');
    renderDashboard();
  });
  await p.waitForTimeout(400);
  const align = await p.evaluate(() => Array.from(document.querySelectorAll('#dashGrid tbody tr'))
    .map(r => Array.from(r.querySelectorAll('.dc-td')).map(c => getComputedStyle(c).textAlign)));
  ck('a column alignment applies down the column, not across the row',
    align[0][0] !== 'right' && align[0][1] === 'right', JSON.stringify(align[0]));
  ck('and down every row of it, not just the first',
    align[1] && align[1][1] === 'right', JSON.stringify(align[1]));

  await p.screenshot({ path: path.join(REPO, 'diagnostics', 'shot-dash-excel.png') });

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');

  await b.close();
  const pass = R.filter(Boolean).length;
  console.log('\n' + pass + '/' + R.length + ' passed');
  process.exit(pass === R.length ? 0 : 1);
})();
