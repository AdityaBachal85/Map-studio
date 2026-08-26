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
  'combo', 'pie', 'donut', 'scatter', 'funnel', 'treemap',
  'ring', 'gauge', 'radar'];

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
      marks: h.querySelectorAll('.viz-mark, .viz-line, .viz-slice, .viz-arc, .viz-tm,'
        + ' .viz-dot, .viz-dial, .viz-web').length,
    })));
  ck('every kind draws something',
    drawn.length === KINDS.length && drawn.every(d => d.svg && d.marks > 0),
    drawn.filter(d => !d.marks).map(d => d.card).join(', ')
      || drawn.length + ' of ' + KINDS.length);
  ck('and the gallery offers every one of them',
    await p.evaluate(k => k.every(x => DASH_GALLERY.some(g => g[0] === x)), KINDS) === true);

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

  /* -- the score forms are read against a ceiling, not against a total ------ */

  const scores = await p.evaluate(() => {
    const site = ['Connectivity', 'Infrastructure', 'Social', 'Green cover', 'Retail'];
    dashCards = [
      Object.assign(dashNewCard('ring'), { id: 's1', title: 'Rings', x: 0, y: 0, w: 6, h: 9,
        labels: site, seriesList: [{ name: 'Score', values: [82, 64, 71, 48, 57], slot: 1 }] }),
      Object.assign(dashNewCard('gauge'), { id: 's2', title: 'Gauge', x: 6, y: 0, w: 6, h: 9,
        labels: ['Overall'], seriesList: [{ name: 'Score', values: [74], slot: 3 }] }),
      Object.assign(dashNewCard('radar'), { id: 's3', title: 'Radar', x: 0, y: 9, w: 6, h: 10,
        labels: site, seriesList: [
          { name: 'This site', values: [82, 64, 71, 48, 57], slot: 1 },
          { name: 'District', values: [61, 72, 55, 66, 44], slot: 2 }] }),
      Object.assign(dashNewCard('donut'), { id: 's4', title: 'Donut', x: 6, y: 9, w: 6, h: 10,
        labels: site, seriesList: [{ name: 'Score', values: [82, 64, 71, 48, 57], slot: 1 }] }),
    ];
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard();
    return true;
  });
  await p.waitForTimeout(2400);

  const shapes = await p.evaluate(() => {
    const q = (id, sel) => document.querySelectorAll('.dc-plot[data-card="' + id + '"] ' + sel);
    return {
      rings: q('s1', '.viz-arc').length, tracks: q('s1', '.viz-track').length,
      dial: q('s2', '.viz-dial').length, gaugeTrack: q('s2', '.viz-track').length,
      webs: q('s3', '.viz-web').length, webGrid: q('s3', 'path.viz-grid').length,
      spokes: q('s3', 'line.viz-grid').length,
    };
  });
  ck('a ring per category, each on its own track',
    shapes.rings === 5 && shapes.tracks === 5, JSON.stringify(shapes));
  ck('a gauge is one arc on one track', shapes.dial === 1 && shapes.gaugeTrack === 1);
  ck('a radar is one closed shape per series, on a web with a spoke per axis',
    shapes.webs === 2 && shapes.webGrid === 4 && shapes.spokes === 5, JSON.stringify(shapes));

  // The ceiling. A score of 82 is 82% of 100 and not 82% of the largest number
  // on the card — the second reading would make the best category always full.
  const ceiling = await p.evaluate(() => {
    const c = dashCardById('s1');
    const arc = document.querySelector('.dc-plot[data-card="s1"] .viz-arc');
    const r = +arc.getAttribute('r');
    const dash = arc.getAttribute('stroke-dasharray').split(' ').map(Number);
    return { max: vizScoreMax(c, c.seriesList[0].values),
      frac: dash[0] / (2 * Math.PI * r) };
  });
  ck('a score out of 100 is drawn as a fraction of 100',
    ceiling.max === 100 && Math.abs(ceiling.frac - 0.82) < 0.01,
    JSON.stringify(ceiling));

  const big = await p.evaluate(() => vizScoreMax({ }, [1840]));
  ck('and above 100 the ceiling is a round number over the top value',
    big === 2000, String(big));
  ck('an explicit scale overrides both',
    await p.evaluate(() => vizScoreMax({ max: 5 }, [4, 3, 5])) === 5);

  // The funnel's lesson, applied. A share kind may print a percentage beside a
  // name because the arc IS that percentage. A ring's arc is a fraction of the
  // scale, so the same percentage beside it would be a different, contradictory
  // number for the same category.
  const legends = await p.evaluate(() => {
    const read = id => [...document.querySelectorAll('.dash-card[data-card="' + id + '"] .dc-key b')]
      .map(b => b.textContent);
    return { ring: read('s1'), donut: read('s4'),
      gauge: document.querySelectorAll('.dash-card[data-card="s2"] .dc-legend').length,
      radar: [...document.querySelectorAll('.dash-card[data-card="s3"] .dc-key')].map(k => k.textContent) };
  });
  ck('a ring legend prints the score, not a share of the total',
    legends.ring.join(',') === '82,64,71,48,57', legends.ring.join(','));
  ck('a donut legend still prints the share, because that is what its arc is',
    legends.donut.every(v => /%$/.test(v)), legends.donut.join(','));
  ck('a gauge has no legend — it is one number, printed on its own dial',
    legends.gauge === 0);
  ck('a radar is keyed by series, because that is what its shapes are',
    legends.radar.length === 2 && /This site/.test(legends.radar[0]),
    legends.radar.join(' | '));

  // The ceiling has to reach the file too: "82" read out of a document without
  // it has lost the half that made it a score.
  const model = await p.evaluate(() => {
    const m = dashExportModel({ title: 'Scores' });
    const by = k => m.cards.find(t => t.id === k);
    return { ring: by('s1').data.max, gauge: by('s2').data.max,
      radar: by('s3').data.max, donut: 'max' in by('s4').data };
  });
  ck('the export model carries the ceiling for every score form, and only those',
    model.ring === 100 && model.gauge === 100 && model.radar === 100 && model.donut === false,
    JSON.stringify(model));

  /* -- the figures arrive too ----------------------------------------------- */

  // The charts have had an entrance since the bklit pass and the numbers beside
  // them did not, so on a board whose loudest visual is a row of score rings the
  // charts arrived and the scores just sat there.
  const figures = await p.evaluate(() => {
    dashCards = [
      Object.assign(dashNewCard('column'), { id: 'f1', x: 0, y: 0, w: 5, h: 7,
        labels: ['a', 'b', 'c'], seriesList: [{ name: 'S', values: [4, 8, 6], slot: 1 }] }),
      Object.assign(dashNewCard('gauges'), { id: 'f2', x: 5, y: 0, w: 5, h: 7,
        items: [{ cap: 'Connectivity', value: '10' }, { cap: 'Infrastructure', value: '9' }] }),
      Object.assign(dashNewCard('rating'), { id: 'f3', x: 0, y: 7, w: 4, h: 5, value: '8', label: 'Overall' }),
      Object.assign(dashNewCard('stat'), { id: 'f4', x: 4, y: 7, w: 3, h: 5, label: 'Trips', value: '1,840' }),
    ];
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard(); dashLayoutApply();
    const anim = sel => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).animationName : 'missing';
    };
    return {
      chart: anim('.dc-plot[data-card="f1"] .viz-mark'),
      ring: anim('.dash-card[data-card="f2"] .dc-gauge .val'),
      badge: anim('.dash-card[data-card="f3"] .dc-rating-badge'),
      kpi: anim('.dash-card[data-card="f4"] .dc-stat-val'),
    };
  });
  ck('a score ring sweeps in like the chart beside it',
    figures.ring === 'viz-draw', figures.ring);
  ck('the rating badge lands', figures.badge === 'viz-pop', figures.badge);
  ck('and a KPI figure rises rather than bouncing', figures.kpi === 'dashIn', figures.kpi);

  // THE EXPORT GUARANTEE, for the figures as well as the charts. Every keyframe
  // is `from`-only and every element is emitted in its final state, so an
  // export that freezes the animation loses nothing — which is what makes it
  // safe to rasterise a board mid-entrance.
  const frozen = await p.evaluate(() => {
    const grid = document.getElementById('dashGrid');
    const ringSel = '.dash-card[data-card="f2"] .dc-gauge .val';
    const before = document.querySelector(ringSel).getAttribute('stroke-dasharray');
    grid.classList.add('exporting');
    const names = ['.dash-card[data-card="f2"] .dc-gauge .val',
      '.dash-card[data-card="f3"] .dc-rating-badge',
      '.dash-card[data-card="f4"] .dc-stat-val']
      .map(s => getComputedStyle(document.querySelector(s)).animationName);
    const after = document.querySelector(ringSel).getAttribute('stroke-dasharray');
    grid.classList.remove('exporting');
    return { names, same: before === after };
  });
  ck('an export freezes every one of them',
    frozen.names.every(n => n === 'none'), frozen.names.join(','));
  ck('and freezing changes nothing about what is drawn', frozen.same === true);

  ck('reduced motion switches them off rather than taking a second path',
    await p.evaluate(() => {
      document.body.classList.add('reduce-motion');
      const n = ['.dash-card[data-card="f2"] .dc-gauge .val',
        '.dash-card[data-card="f3"] .dc-rating-badge']
        .map(s => getComputedStyle(document.querySelector(s)).animationName);
      document.body.classList.remove('reduce-motion');
      return n.every(x => x === 'none');
    }) === true);

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');

  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})();
