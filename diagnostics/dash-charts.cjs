/**
 * The board's charts: how they arrive, and what happens when they are asked to
 * arrive again.
 *
 * The enter animation is the part with a real failure mode. `dashDrawAllCharts()`
 * is called on every tile drag, every resize and every format change, so a naive
 * "animate on draw" replays the whole board whenever a neighbouring card is
 * nudged — and, worse, an export rasterises whatever is on screen at that
 * instant, so a chart caught mid-reveal would be exported half-drawn.
 *
 * Both are avoided the same way: every mark is emitted in its final state and
 * animated `from`, and the animation is a class on the SVG rather than a
 * property of the marks. So the assertions here are about identity of state,
 * not about catching a frame — the marks are asserted to be exactly where they
 * belong with the animation switched off, which is what an export sees.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/dash-charts.cjs
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

/** Every kind the module claims to draw. */
const KINDS = ['column', 'bar', 'line', 'area', 'stackedColumn', 'stackedBar',
  'combo', 'pie', 'donut', 'scatter', 'funnel', 'treemap'];

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

  /* -- a board of one chart per kind, all carrying the same numbers --------- */

  await p.evaluate(kinds => {
    setAppMode('dashboard');
    dashCards = kinds.map((k, i) => Object.assign(dashNewCard(k), {
      id: 'k' + i, title: k, x: (i % 4) * 6, y: Math.floor(i / 4) * 8,
      labels: ['2021', '2022', '2023', '2024', '2025'],
      seriesList: [
        { name: 'Trips', values: [12, 30, 22, 41, 35], slot: 1 },
        { name: 'Cost', values: [8, 14, 26, 19, 30], slot: 2 },
      ],
    }));
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard();
  }, KINDS);
  await p.waitForTimeout(2600);

  const drawn = await p.evaluate(() => [...document.querySelectorAll('#dashGrid .dc-plot[data-card]')]
    .map(h => ({
      card: h.dataset.card,
      svg: !!h.querySelector('svg'),
      // Scatter's only mark is the dot, so it has to be in the list — leaving
      // it out reported a working chart as drawing nothing.
      marks: h.querySelectorAll('.viz-mark, .viz-line, .viz-slice, .viz-arc, .viz-tm, .viz-dot').length,
    })));
  ck('every kind draws something',
    drawn.length === 12 && drawn.every(d => d.svg && d.marks > 0),
    drawn.filter(d => !d.marks).map(d => d.card).join(', ') || '12 of 12');

  /* -- the reveal runs once, and geometry alone does not replay it ---------- */

  await p.evaluate(() => {
    dashCardById('k0').seriesList[0].values = [5, 9, 14, 20, 26];
    dashDrawAllCharts();
  });
  const afterData = await p.evaluate(() =>
    document.querySelector('.dc-plot[data-card="k0"] svg').classList.contains('viz-enter'));
  ck('new numbers replay the reveal', afterData === true);

  await p.waitForTimeout(2000);
  const settled = await p.evaluate(() =>
    document.querySelector('.dc-plot[data-card="k0"] svg').classList.contains('viz-enter'));
  ck('and it takes itself off once it has run', settled === false);

  await p.evaluate(() => dashDrawAllCharts());
  const afterRedraw = await p.evaluate(() =>
    document.querySelector('.dc-plot[data-card="k0"] svg').classList.contains('viz-enter'));
  ck('a redraw with the same numbers does not replay it', afterRedraw === false);

  await p.setViewportSize({ width: 1500, height: 1000 });
  await p.waitForTimeout(500);
  await p.evaluate(() => dashDrawAllCharts());
  ck('nor does a resize',
    await p.evaluate(() =>
      document.querySelector('.dc-plot[data-card="k0"] svg').classList.contains('viz-enter')) === false);
  await p.setViewportSize({ width: 1600, height: 1000 });
  await p.waitForTimeout(700);

  /* -- the animated state and the final state are the same drawing ---------- */

  // This is the export guarantee. Every keyframe is `from`-only, so the marks
  // are emitted where they end up and the animation only ever plays backwards
  // into them. Read the geometry with the class on and with it off: if the two
  // ever differ, an export can catch a chart half-drawn.
  const geomWith = await p.evaluate(() => {
    dashCardById('k1').seriesList[0].values = [7, 21, 13, 33, 28];
    dashDrawAllCharts();
    const svg = document.querySelector('.dc-plot[data-card="k1"] svg');
    return { enter: svg.classList.contains('viz-enter'),
      d: [...svg.querySelectorAll('.viz-mark')].map(m => m.getAttribute('d') || m.getAttribute('width')) };
  });
  const geomWithout = await p.evaluate(() => {
    const svg = document.querySelector('.dc-plot[data-card="k1"] svg');
    svg.classList.remove('viz-enter');
    return [...svg.querySelectorAll('.viz-mark')].map(m => m.getAttribute('d') || m.getAttribute('width'));
  });
  ck('the marks are emitted where they end up, not where they start',
    geomWith.enter === true && JSON.stringify(geomWith.d) === JSON.stringify(geomWithout),
    geomWith.d.length + ' marks');

  // Read from computed style rather than from a screenshot. A headless
  // screenshot of this scene takes longer than the reveal does, so every frame
  // caught that way shows a finished chart whether or not anything ran.
  const running = await p.evaluate(() => {
    dashCardById('k1').seriesList[0].values = [9, 25, 17, 38, 31];
    dashCardById('k2').seriesList[0].values = [6, 17, 12, 29, 24];
    dashDrawAllCharts();
    const bars = [...document.querySelectorAll('.dc-plot[data-card="k1"] .viz-mark')];
    const line = document.querySelector('.dc-plot[data-card="k2"] .viz-line');
    const cs = getComputedStyle(bars[0]);
    return {
      bar: cs.animationName, dur: cs.animationDuration, ease: cs.animationTimingFunction,
      origin: cs.transformOrigin,
      // The first mark is deliberately undelayed; the stagger is the gap
      // between one category and the next.
      delays: bars.slice(0, 4).map(m => getComputedStyle(m).animationDelay),
      line: line && getComputedStyle(line).animationName,
      dash: line && getComputedStyle(line).strokeDasharray,
    };
  });
  ck('a bar grows from its own baseline, not from the corner of the card',
    running.bar === 'viz-widen' && /^0px/.test(running.origin), JSON.stringify(running.origin));
  ck('and the categories are staggered rather than arriving together',
    running.delays[0] === '0s' && new Set(running.delays).size === running.delays.length,
    running.delays.join(' '));
  ck('a line draws itself in, over a measured dash',
    running.line === 'viz-draw' && parseFloat(running.dash) > 100,
    running.line + ' / ' + running.dash);

  ck('so the export pass can freeze the animation and lose nothing',
    await p.evaluate(() => {
      const grid = document.getElementById('dashGrid');
      grid.classList.add('exporting');
      dashCardById('k1').seriesList[0].values = [3, 18, 9, 27, 22];
      dashDrawAllCharts();
      const m = document.querySelector('.dc-plot[data-card="k1"] .viz-mark');
      const anim = getComputedStyle(m).animationName;
      grid.classList.remove('exporting');
      return anim;
    }) === 'none');

  /* -- reduced motion is not a second code path ---------------------------- */

  const reduced = await p.evaluate(() => {
    setPref('reduceMotion', true);
    dashCardById('k2').seriesList[0].values = [11, 4, 19, 8, 24];
    dashDrawAllCharts();
    const svg = document.querySelector('.dc-plot[data-card="k2"] svg');
    const out = { enter: svg.classList.contains('viz-enter'), marks: svg.querySelectorAll('.viz-line').length };
    setPref('reduceMotion', false);
    return out;
  });
  ck('reduced motion draws the chart and skips the reveal',
    reduced.enter === false && reduced.marks > 0, JSON.stringify(reduced));

  /* -- the wash under an area is a gradient, and it belongs to this chart --- */

  const grad = await p.evaluate(() => {
    const host = document.querySelector('.dc-plot[data-card="k3"]');       // area
    const area = host.querySelector('.viz-area');
    const ref = area && (area.getAttribute('fill') || '').match(/url\(#([^)]+)\)/);
    const def = ref && host.querySelector('#' + CSS.escape(ref[1]));
    const others = [...document.querySelectorAll('#dashGrid svg')]
      .map(s => [...s.querySelectorAll('linearGradient')].map(g => g.id));
    const ids = others.flat();
    return {
      ref: ref && ref[1],
      inThisSvg: !!def,
      stops: def ? [...def.querySelectorAll('stop')].map(st => st.style.stopColor) : [],
      unique: ids.length === new Set(ids).size,
    };
  });
  ck('an area is washed by a gradient defined in its own chart',
    grad.inThisSvg === true && grad.stops.length === 2, JSON.stringify(grad.ref));
  ck('and no two charts share a gradient id', grad.unique === true);

  /* -- hovering reads a category on every series at once -------------------- */

  const box = await p.evaluate(() => {
    const h = document.querySelector('.dc-plot[data-card="k2"]');          // line
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width * 0.62, y: r.top + r.height / 2 };
  });
  await p.mouse.move(box.x, box.y);
  await p.waitForTimeout(200);
  const hover = await p.evaluate(() => {
    const h = document.querySelector('.dc-plot[data-card="k2"]');
    const shown = [...h.querySelectorAll('.viz-hit')].filter(c => c.style.display !== 'none');
    const dots = [...h.querySelectorAll('.viz-dot')];
    // Each hover mark must sit on a real point of its own series, not near it.
    const onAPoint = shown.every(c => dots.some(d =>
      Math.abs(+d.getAttribute('cx') - +c.getAttribute('cx')) < 0.6
      && Math.abs(+d.getAttribute('cy') - +c.getAttribute('cy')) < 0.6));
    return { shown: shown.length, onAPoint, tip: !h.querySelector('.viz-tip').hidden };
  });
  ck('hovering marks the point on every series', hover.shown === 2, JSON.stringify(hover));
  ck('and each mark lands on its own line rather than near it', hover.onAPoint === true);
  ck('the tooltip comes with it', hover.tip === true);

  // Stepped, so the pointer actually crosses the card's edge. A single jump
  // from inside to outside leaves the browser with no boundary to report.
  await p.mouse.move(10, 10, { steps: 8 });
  await p.waitForTimeout(200);
  ck('and they leave with the pointer',
    await p.evaluate(() => [...document.querySelectorAll('.dc-plot[data-card="k2"] .viz-hit')]
      .every(c => c.style.display === 'none')) === true);

  /* -- the crosshair and the marks read one geometry ------------------------ */

  // vizFrame() exists because these used to be two independent copies of the
  // same padding arithmetic, agreeing only by luck.
  // Also the resize guarantee: the frame computed from the host's box NOW has
  // to be the frame the marks were drawn with. It was not, before the observer
  // — the board redrew charts in the same tick as a 160ms width transition, so
  // every chart was measured at the width it was leaving.
  ck('the frame is shared rather than recomputed',
    await p.evaluate(() => {
      const c = dashCardById('k2');
      const host = document.querySelector('.dc-plot[data-card="k2"]');
      const f = vizFrame(c, Math.round(host.clientWidth), Math.round(host.clientHeight));
      const dot = host.querySelector('.viz-dot');
      return f && Math.abs(f.cOf(0) - +dot.getAttribute('cx')) < 0.6;
    }) === true);


  await p.screenshot({ path: path.join(__dirname, 'shot-dash-charts.png'),
    clip: await p.evaluate(() => {
      const r = document.getElementById('dashGrid').getBoundingClientRect();
      return { x: Math.max(0, r.left), y: Math.max(0, r.top),
        width: Math.min(1600 - Math.max(0, r.left), r.width),
        height: Math.min(1000 - Math.max(0, r.top), r.height) };
    }) });

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');

  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})();
