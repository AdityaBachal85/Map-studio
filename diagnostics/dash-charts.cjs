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

  // Read in the SAME call that draws. Split across two round trips there is a
  // window in which the observer can redraw the board — and a redraw with the
  // same numbers deliberately does NOT replay, so the class is gone before the
  // second call arrives and a working reveal is reported as broken.
  const afterData = await p.evaluate(() => {
    dashCardById('k0').seriesList[0].values = [5, 9, 14, 20, 26];
    dashDrawAllCharts();
    return document.querySelector('.dc-plot[data-card="k0"] svg').classList.contains('viz-enter');
  });
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
  //
  // Then POLLED, not slept on. `mouse.move` resolves when the input is
  // delivered, not when the page has handled it, and under SwiftShader the
  // pointerleave that hides these can land after a fixed wait has expired — so
  // a sleep here reports a working teardown as broken about one run in three.
  await p.mouse.move(10, 10, { steps: 8 });
  let left = true;
  try {
    await p.waitForFunction(() =>
      [...document.querySelectorAll('.dc-plot[data-card="k2"] .viz-hit')]
        .every(c => c.style.display === 'none'), null, { timeout: 4000 });
  } catch (e) { left = false; }
  ck('and they leave with the pointer', left,
    left ? '' : await p.evaluate(() => {
      const h = document.querySelector('.dc-plot[data-card="k2"]');
      const u = document.elementFromPoint(10, 10);
      return JSON.stringify({
        disp: [...h.querySelectorAll('.viz-hit')].map(c => c.style.display || 'unset'),
        hits: h.querySelectorAll('.viz-hit').length,
        svgs: h.querySelectorAll('svg').length,
        at: h._vizAt ? 'set' : 'null',
        rect: (r => ({ l: Math.round(r.left), t: Math.round(r.top),
          w: Math.round(r.width), h: Math.round(r.height) }))(h.getBoundingClientRect()),
        under: u ? u.tagName + '.' + (u.getAttribute('class') || '') : 'none',
      });
    }));

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

  /* -- a score ring is its score, not a closed circle ----------------------- */

  // The enter animation set stroke-dasharray to the full circumference so it
  // had something to sweep along — and a CSS declaration beats a presentation
  // attribute, so it overrode the arc that MAKES a 9 a nine-tenths ring. Every
  // score drew as a closed circle: a 9 and a 10 were the same picture. Only the
  // offset may be animated.
  const arcs = await p.evaluate(() => {
    dashCards = [Object.assign(dashNewCard('gauges'), { id: 'r9', x: 0, y: 0, w: 7, h: 7,
      items: [{ cap: 'Ten', value: '10' }, { cap: 'Nine', value: '9' },
        { cap: 'Eight', value: '8' }, { cap: 'Five', value: '5' }] })];
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard(); dashLayoutApply();
    return [...document.querySelectorAll('.dash-card[data-card="r9"] .dc-gauge .val')].map(c => {
      const d = getComputedStyle(c).strokeDasharray.match(/[0-9.]+/g).map(Number);
      return Math.round((d[0] / d[1]) * 100) / 100;
    });
  });
  ck('every score draws its own fraction of the ring',
    arcs.length === 4 && arcs[0] === 1 && Math.abs(arcs[1] - 0.9) < 0.02
      && Math.abs(arcs[2] - 0.8) < 0.02 && Math.abs(arcs[3] - 0.5) < 0.02,
    JSON.stringify(arcs));
  ck('so a nine and a ten are not the same picture',
    arcs[0] - arcs[1] > 0.05, arcs[0] + ' vs ' + arcs[1]);

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

  /* -- the data-label switch is live on every kind that offers it ----------- */

  // THE SWITCH USED TO BE A LIE ON HALF THE BOARD. Six of the fifteen kinds
  // drew nothing when it was on — the stacks, the combo's bar series and the
  // radar — and two more (funnel, treemap) drew their numbers whatever it said,
  // so turning it off did nothing either. A control that changes nothing is
  // worse than an absent one: it teaches people to stop reading the panel.
  //
  // Ring and gauge are the two deliberate absences, and the assertion below is
  // that they do not OFFER the control rather than that they ignore it: a ring
  // prints its score in the legend beside it and a gauge prints it in the
  // middle of its own dial, so a second copy on the arc would be the same
  // number twice.
  // Every part scoped: `host .viz-label, .viz-inlabel` is TWO selectors, and the
  // second one matches the whole document. Written unscoped this reported a
  // gauge as carrying fifteen data labels — every label on the board.
  const LABEL_SEL = ['.viz-label', '.viz-inlabel', '.viz-tm-val'];
  const labelled = await p.evaluate(([kinds, sel]) => {
    dashCards = kinds.map((k, i) => Object.assign(dashNewCard(k), {
      id: 'L' + i, title: k, x: (i % 2) * 12, y: Math.floor(i / 2) * 9, w: 12, h: 9,
      labels: ['North', 'East', 'South', 'West', 'Central'],
      seriesList: [
        { name: 'Trips', values: [12, 30, 22, 41, 35], slot: 1 },
        { name: 'Cost', values: [8, 14, 26, 19, 30], slot: 2 },
      ],
      fmt: { labels: true },
    }));
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard(); dashLayoutApply(); dashDrawAllCharts();
    const out = {};
    kinds.forEach((k, i) => {
      const host = document.querySelector('.dc-plot[data-card="L' + i + '"]');
      out[k] = host ? sel.reduce((n, q) => n + host.querySelectorAll(q).length, 0) : -1;
    });
    return out;
  }, [KINDS, LABEL_SEL]);
  const noLabels = KINDS.filter(k => k !== 'ring' && k !== 'gauge' && !labelled[k]);
  ck('every kind that offers data labels draws them when they are on',
    noLabels.length === 0, noLabels.join(', ') || JSON.stringify(labelled));

  const labelsOff = await p.evaluate(([kinds, sel]) => {
    dashCards.forEach(c => { c.fmt.labels = false; });
    renderDashboard(); dashLayoutApply(); dashDrawAllCharts();
    const out = {};
    kinds.forEach((k, i) => {
      const host = document.querySelector('.dc-plot[data-card="L' + i + '"]');
      out[k] = host ? sel.reduce((n, q) => n + host.querySelectorAll(q).length, 0) : -1;
    });
    return out;
  }, [KINDS, LABEL_SEL]);
  const stuckOn = KINDS.filter(k => labelsOff[k] > 0);
  ck('and switching them off takes them away again, on every one of those kinds',
    stuckOn.length === 0, stuckOn.join(', ') || 'all clear');

  // A funnel and a treemap print their numbers unless told not to, because they
  // always did — the switch was made live without taking anything away from a
  // board that already existed.
  const defaults = await p.evaluate(() => [vizFmt({ kind: 'funnel' }).labels,
    vizFmt({ kind: 'treemap' }).labels, vizFmt({ kind: 'column' }).labels,
    vizFmt({ kind: 'funnel', fmt: { labels: false } }).labels]);
  ck('a funnel and a treemap keep their numbers by default',
    JSON.stringify(defaults) === '[true,true,false,false]', JSON.stringify(defaults));

  ck('and a ring and a gauge are not offered the switch at all',
    await p.evaluate(() => {
      const pane = document.getElementById('dashFormat');
      const offered = k => {
        dashCards = [Object.assign(dashNewCard(k), { id: 'q', x: 0, y: 0, w: 8, h: 8,
          labels: ['a', 'b'], seriesList: [{ name: 'S', values: [7, 9], slot: 1 }] })];
        dashEditing = true; dashSelectedId = 'q';
        renderDashboard(); renderDashFormat();
        return !!pane.querySelector('[data-df="labels"]');
      };
      const out = [offered('ring'), offered('gauge'), offered('column'), offered('radar')];
      dashEditing = false; dashSelectedId = null;
      return JSON.stringify(out);
    }) === '[false,false,true,true]');

  /* -- the biggest number's label is the one that gets clipped -------------- */

  // The axis always scales to the data, so the tallest bar's top IS the top of
  // the plot and a label six pixels above it is six pixels outside the drawing.
  // That is not an edge case — it is the largest value on every chart, i.e. the
  // one number a reader looks for first. It was landing 3px past the edge.
  const clipped = await p.evaluate(() => {
    dashCards = [
      Object.assign(dashNewCard('column'), { id: 'c1', title: 'Up', x: 0, y: 0, w: 10, h: 9,
        labels: ['a', 'b', 'c', 'd'], seriesList: [{ name: 'S', values: [4, 9, 20, 6], slot: 1 }],
        fmt: { labels: true } }),
      Object.assign(dashNewCard('bar'), { id: 'c2', title: 'Across', x: 10, y: 0, w: 10, h: 9,
        labels: ['a', 'b', 'c', 'd'], seriesList: [{ name: 'S', values: [4, 9, 20, 6], slot: 1 }],
        fmt: { labels: true } }),
    ];
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard(); dashLayoutApply(); dashDrawAllCharts();
    const read = id => {
      const host = document.querySelector('.dc-plot[data-card="' + id + '"]');
      const svg = host.querySelector('svg');
      const vb = svg.viewBox.baseVal;
      return [...host.querySelectorAll('.viz-label')].map(t => {
        const b = t.getBBox();
        return { txt: t.textContent, inside: t.classList.contains('viz-label-in'),
          out: b.x < -0.5 || b.y < -0.5 || b.x + b.width > vb.width + 0.5
            || b.y + b.height > vb.height + 0.5 };
      });
    };
    return { col: read('c1'), bar: read('c2') };
  });
  const escaped = clipped.col.concat(clipped.bar).filter(l => l.out);
  ck('no data label is drawn outside its own chart',
    clipped.col.length === 4 && clipped.bar.length === 4 && escaped.length === 0,
    escaped.map(l => l.txt).join(', ') || (clipped.col.length + '+' + clipped.bar.length + ' labels'));
  ck('the biggest bar carries its number inside itself, the rest outside',
    clipped.col.filter(l => l.inside).map(l => l.txt).join() === '20'
      && clipped.bar.filter(l => l.inside).map(l => l.txt).join() === '20',
    JSON.stringify(clipped.col.map(l => l.txt + (l.inside ? '*' : ''))));

  // The other direction. A column below the axis grows DOWN the screen, so
  // every offset in the placement rule flips — and a rule written as "up is
  // negative" reads a negative bar as an upward one and labels it above the
  // axis, beside a bar that is not there.
  const negative = await p.evaluate(() => {
    dashCards = [Object.assign(dashNewCard('column'), { id: 'n1', title: 'Swing', x: 0, y: 0, w: 12, h: 9,
      labels: ['a', 'b', 'c', 'd'], seriesList: [{ name: 'S', values: [8, -6, 3, -11], slot: 1 }],
      fmt: { labels: true } })];
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard(); dashLayoutApply(); dashDrawAllCharts();
    const host = document.querySelector('.dc-plot[data-card="n1"]');
    const c = dashCardById('n1');
    const f = vizFrame(c, Math.round(host.clientWidth), Math.round(host.clientHeight));
    const vb = host.querySelector('svg').viewBox.baseVal;
    return [...host.querySelectorAll('.viz-label')].map((t, i) => {
      const b = t.getBBox();
      return { v: c.seriesList[0].values[i], mid: b.y + b.height / 2, zero: f.vOf(0),
        out: b.y < -0.5 || b.y + b.height > vb.height + 0.5 };
    });
  });
  ck('a bar below the axis is labelled below the axis, and still on the drawing',
    negative.length === 4 && negative.every(l => l.out === false)
      && negative.every(l => (l.v > 0) === (l.mid < l.zero)),
    JSON.stringify(negative.map(l => l.v + '@' + Math.round(l.mid) + '/' + Math.round(l.zero))));

  /* -- and no two of them are printed in the same place --------------------- */

  // TWO LINES RUNNING CLOSE TOGETHER IS THE NORMAL CASE, NOT AN EDGE ONE. Every
  // series labelled above its own point, so wherever the numbers were close the
  // two labels printed on top of each other — which is what "the data labels
  // are not working" looks like from the outside. Measured, not eyeballed: the
  // rendered boxes are read back and checked against each other.
  const overlaps = await p.evaluate(() => {
    const kinds = ['column', 'bar', 'line', 'area', 'scatter', 'combo'];
    // Deliberately cruel numbers: two series whose values sit within a pixel or
    // two of each other at four of the five categories.
    dashCards = kinds.map((k, i) => Object.assign(dashNewCard(k), {
      id: 'o' + i, title: k, x: (i % 2) * 6, y: Math.floor(i / 2) * 8, w: 6, h: 8,
      labels: ['Station', 'School', 'Hospital', 'Mall', 'Airport'],
      seriesList: [
        { name: 'Distance', values: [2.4, 5.1, 12.8, 3.6, 27.5], slot: 1 },
        { name: 'Drive', values: [2.9, 5.4, 13.1, 3.9, 28.0], slot: 3 },
      ],
      fmt: { labels: true },
    }));
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard(); dashLayoutApply(); dashDrawAllCharts();
    const bad = {};
    kinds.forEach((k, i) => {
      const host = document.querySelector('.dc-plot[data-card="o' + i + '"]');
      const boxes = [...host.querySelectorAll('.viz-label')].map(t => {
        const b = t.getBBox();
        return { t: t.textContent, x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height };
      });
      const clash = [];
      for (let a = 0; a < boxes.length; a++) {
        for (let c = a + 1; c < boxes.length; c++) {
          const u = boxes[a], w = boxes[c];
          if (u.x0 < w.x1 - 1 && w.x0 < u.x1 - 1 && u.y0 < w.y1 - 1 && w.y0 < u.y1 - 1) {
            clash.push(u.t + '/' + w.t);
          }
        }
      }
      if (clash.length) bad[k] = clash;
    });
    return bad;
  });
  ck('no two data labels are printed over each other, even on series that touch',
    Object.keys(overlaps).length === 0, JSON.stringify(overlaps));

  /* -- one bar can be a different colour from the bar beside it ------------- */

  // Excel's "format data point". Colour lived on the series, so the only way to
  // call out one category was to split it into a series of its own — which
  // changes the chart's shape to change one bar's hue.
  const points = await p.evaluate(() => {
    // Its own board: every section above replaces dashCards, so reaching back
    // for a card an earlier one made is a test that breaks when a test is added.
    const c = Object.assign(dashNewCard('column'), { id: 'c1', title: 'Up', x: 0, y: 0, w: 10, h: 9,
      labels: ['a', 'b', 'c', 'd'], seriesList: [{ name: 'S', values: [4, 9, 20, 6], slot: 1 }],
      fmt: { labels: true } });
    dashCards = [c];
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard(); dashLayoutApply(); dashDrawAllCharts();
    const fills = () => [...document.querySelectorAll('.dc-plot[data-card="c1"] .viz-mark')]
      .map(m => m.style.fill);
    const before = fills();
    dashFormatApply(c, 'pt:0:2', '#e03131');
    dashDrawAllCharts();
    const after = fills();
    dashFormatApply(c, 'ptclear:0:2', '1');
    dashDrawAllCharts();
    return { before, after, cleared: fills(), stored: JSON.stringify(c.seriesList[0].points || {}) };
  });
  // `style.fill` reads back as the browser's normal form, not as it was written.
  ck('a point colour repaints exactly one bar',
    /^rgb\(\s*224,\s*49,\s*49\s*\)$/.test(points.after[2])
      && points.after.filter((f, i) => i !== 2 && f === points.before[i]).length === 3,
    points.after.join(' '));
  ck('and clearing it hands that bar back to the series',
    points.cleared.join() === points.before.join(), points.cleared.join(' '));
  const inFile = await p.evaluate(() => {
    dashFormatApply(dashCardById('c1'), 'pt:0:1', '#12b886');
    const m = dashExportModel({ title: 'Points' });
    return JSON.stringify((m.cards.find(t => t.id === 'c1').data.series[0] || {}).points || null);
  });
  ck('and a point colour reaches the export model, so it survives into the file',
    /12b886/i.test(inFile), inFile);

  /* -- a slice can be given its own colour, on every circular form ---------- */

  // THESE FIVE HAD NO COLOUR CONTROL AT ALL. A pie, a donut, a ring stack, a
  // funnel and a treemap each draw one mark per category out of a single
  // series, so "the series colour" cannot describe them — five slices cannot
  // all be blue — and every one of them took vizSlot(i + 1), the palette slot
  // its POSITION happened to land on. Meanwhile the panel went on offering them
  // the series swatch, so the one colour control they had did nothing.
  const CAT_KINDS = ['ring', 'donut', 'pie', 'funnel', 'treemap'];
  const CAT_MARK = { ring: '.viz-arc', donut: '.viz-arc', pie: '.viz-slice',
    funnel: '.viz-mark', treemap: '.viz-tm' };

  const slices = await p.evaluate(([kinds, marks]) => {
    const pts = { 0: '#e03131', 2: '#7048e8', 4: '#0ca678' };
    dashCards = kinds.map((k, i) => Object.assign(dashNewCard(k), {
      id: 'z' + i, title: k, x: (i % 2) * 6, y: Math.floor(i / 2) * 9, w: 6, h: 9,
      labels: ['2021', '2022', '2023', '2024', '2025'],
      seriesList: [{ name: 'Value', values: [10, 20, 15, 25, 30], slot: 1,
        points: Object.assign({}, pts) }],
    }));
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard(); dashLayoutApply(); dashDrawAllCharts();
    const out = {};
    kinds.forEach((k, i) => {
      const card = document.querySelector('.dash-card[data-card="z' + i + '"]');
      const host = card.querySelector('.dc-plot');
      // A treemap sorts its tiles by value, so the third RECTANGLE is not the
      // third category — read the colours back by name, the way a reader does.
      const marksByCat = {};
      if (k === 'treemap') {
        [...host.querySelectorAll('.viz-tm')].forEach((m, j) => {
          const nm = host.querySelectorAll('.viz-tm-name')[j];
          marksByCat[nm ? nm.textContent : j] = m.style.fill;
        });
      }
      out[k] = {
        fills: [...host.querySelectorAll(marks[k])].map(m => m.style.fill || m.style.stroke),
        byCat: marksByCat,
        keys: [...card.querySelectorAll('.dc-key i')].map(el => el.style.background),
      };
    });
    return out;
  }, [CAT_KINDS, CAT_MARK]);

  const rgb = h => 'rgb(' + [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ') + ')';
  const WANT = [rgb('#e03131'), null, rgb('#7048e8'), null, rgb('#0ca678')];
  const missed = CAT_KINDS.filter(k => {
    const f = slices[k].fills;
    if (f.length !== 5) return true;
    return WANT.some((w, i) => w && f[i] !== w);
  });
  ck('a slice takes the colour it was given, on every circular form',
    // The treemap is read by name below — its rectangles are in value order.
    missed.filter(k => k !== 'treemap').length === 0,
    JSON.stringify(missed) + ' ' + JSON.stringify(slices.pie.fills));
  ck('and a treemap tile follows its category rather than its position',
    slices.treemap.byCat['2021'] === rgb('#e03131')
      && slices.treemap.byCat['2023'] === rgb('#7048e8')
      && slices.treemap.byCat['2025'] === rgb('#0ca678'),
    JSON.stringify(slices.treemap.byCat));
  // A key that disagrees with the picture it is the key to is worse than none.
  const keyOff = CAT_KINDS.filter(k => {
    const ks = slices[k].keys;
    if (!ks.length) return false;                 // a funnel has no legend
    return WANT.some((w, i) => w && ks[i] !== w);
  });
  ck('the legend swatch follows the slice, not the palette slot',
    keyOff.length === 0, JSON.stringify(keyOff) + ' ' + JSON.stringify(slices.ring.keys));
  ck('and the ones left alone still take the palette in order',
    slices.pie.fills[1] !== slices.pie.fills[3]
      && /var\(--viz-|rgb/.test(slices.pie.fills[1]), slices.pie.fills.join(' '));

  // THE FILE HAS TO AGREE WITH THE SCREEN, which is the whole reason the export
  // model exists. `color` on the series describes none of these five — a pie's
  // slices are not the series' colour — so a writer reading it would paint every
  // slice the same. The model answers "what colour is slice three" itself, and
  // the answer is checked against the mark actually on the card.
  const modelSlices = await p.evaluate(([kinds, marks]) => {
    // The resolver is INJECTED — the model may not touch the DOM, so a call
    // without one reports grey for every palette slot. That is what the real
    // export passes (dashExport.js), and a test that leaves it out is testing a
    // model the export never builds.
    const cs = getComputedStyle(document.documentElement);
    const m = dashExportModel({ title: 'Slices',
      resolveColor: name => cs.getPropertyValue(name).trim() });
    const out = {};
    kinds.forEach((k, i) => {
      const host = document.querySelector('.dc-plot[data-card="z' + i + '"]');
      const drawn = [...host.querySelectorAll(marks[k])].map(el => el.style.fill || el.style.stroke);
      const said = (m.cards.find(c => c.id === 'z' + i).data || {}).sliceColors;
      out[k] = { drawn: drawn, said: said };
    });
    return out;
  }, [CAT_KINDS, CAT_MARK]);
  // The drawing writes `var(--viz-N)` so it follows the theme; the file cannot
  // carry a custom property, so the model resolves it. Compared after resolving.
  const asHex = await p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (let n = 1; n <= 8; n++) out['var(--viz-' + n + ')'] = cs.getPropertyValue('--viz-' + n).trim().toLowerCase();
    return out;
  });
  const norm = v => {
    const s2 = String(v || '').trim().toLowerCase();
    if (asHex[s2]) return asHex[s2];
    const m2 = s2.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    return m2 ? '#' + [1, 2, 3].map(i => (+m2[i]).toString(16).padStart(2, '0')).join('') : s2;
  };
  const disagree = CAT_KINDS.filter(k => {
    const said = modelSlices[k].said;
    if (!said || said.length !== 5) return true;
    // The treemap draws in value order, so only the set has to match there.
    if (k === 'treemap') {
      return said.map(norm).sort().join() !== modelSlices[k].drawn.map(norm).sort().join();
    }
    return said.map(norm).join() !== modelSlices[k].drawn.map(norm).join();
  });
  ck('the export model says the same colours the card is drawn in',
    disagree.length === 0,
    JSON.stringify(disagree) + ' ' + JSON.stringify(modelSlices.ring));
  ck('and a chart whose colours belong to its series is not given a slice list',
    await p.evaluate(() => {
      dashCards = dashCards.concat([Object.assign(dashNewCard('column'), { id: 'zz', x: 0, y: 60, w: 6, h: 8,
        labels: ['a', 'b'], seriesList: [{ name: 'S', values: [1, 2], slot: 1 }] })]);
      renderDashboard();
      return 'sliceColors' in (dashExportModel({ title: 'x' }).cards.find(c => c.id === 'zz').data);
    }) === false);

  /* -- and a filter does not throw the colours away ------------------------- */

  // vizFiltered() REBUILDS each series rather than copying it, so everything a
  // series carries has to be carried over by hand — and `hex` and `points` were
  // not. Switching on a slicer reverted every custom colour on the board to its
  // palette slot, which reads as the colours being lost rather than as the
  // filter doing it. The indices move too: after a filter the third category is
  // no longer at index three, so the map is remapped rather than passed through.
  const filtered = await p.evaluate(() => {
    const cats = ['2021', '2022', '2023', '2024', '2025'];
    const c = Object.assign(dashNewCard('column'), { id: 'fl', title: 'Filter', x: 0, y: 0, w: 8, h: 8,
      labels: cats, seriesList: [{ name: 'V', values: [10, 20, 15, 25, 30],
        hex: '#123456', points: { 0: '#e03131', 3: '#0ca678' } }] });
    dashCards = [c];
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard(); dashLayoutApply(); dashDrawAllCharts();
    const fills = () => [...document.querySelectorAll('.dc-plot[data-card="fl"] .viz-mark')]
      .map(m => m.style.fill);
    const before = fills();
    // Drop 2022, so 2024 — which was index 3 — becomes index 2.
    const real = dashFilter;
    dashFilter = () => new Set(['2021', '2023', '2024', '2025']);
    dashDrawAllCharts();
    const after = fills();
    dashFilter = real;
    dashDrawAllCharts();
    return { before: before, after: after, restored: fills() };
  });
  const RED = rgb('#e03131'), GREEN = rgb('#0ca678'), SER = rgb('#123456');
  ck('a filtered chart keeps the series colour it was given',
    filtered.after.length === 4 && filtered.after[1] === SER && filtered.after[3] === SER,
    filtered.after.join(' '));
  ck('and each point colour moves with its own category',
    filtered.after[0] === RED && filtered.after[2] === GREEN,
    filtered.after.join(' '));
  ck('clearing the filter puts them all back where they were',
    filtered.restored.join() === filtered.before.join(),
    filtered.restored.join(' '));

  /* -- the funnel's numbers fit on the funnel ------------------------------- */

  // The only labelled chart whose text never went through the placement rule:
  // it reserved a flat 46px for a string that is 55px wide at three digits and
  // a percentage, so the longest row — always the last one — ran off the card.
  const funnelFit = await p.evaluate(() => {
    dashCards = [Object.assign(dashNewCard('funnel'), { id: 'fn', title: 'Funnel', x: 0, y: 0, w: 7, h: 9,
      labels: ['2021', '2022', '2023', '2024', '2025'],
      seriesList: [{ name: 'V', values: [10, 20, 15, 25, 30], slot: 1 }], fmt: { labels: true } })];
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard(); dashLayoutApply(); dashDrawAllCharts();
    const host = document.querySelector('.dc-plot[data-card="fn"]');
    const vb = host.querySelector('svg').viewBox.baseVal;
    return [...host.querySelectorAll('.viz-label')].map(t => {
      const b = t.getBBox();
      return { t: t.textContent, over: b.x + b.width > vb.width + 0.5 };
    });
  });
  ck('no funnel row is labelled off the edge of its own card',
    funnelFit.length === 5 && funnelFit.every(l => !l.over),
    funnelFit.filter(l => l.over).map(l => l.t).join(', ') || 'all 5 fit');

  /* -- a ring reads as rings, and its middle says something ----------------- */

  const rings = await p.evaluate(() => {
    dashCards = [Object.assign(dashNewCard('ring'), { id: 'rg', title: 'Scores', x: 0, y: 0, w: 6, h: 9,
      labels: ['Connectivity', 'Infrastructure', 'Social', 'Green cover', 'Retail'],
      seriesList: [{ name: 'Score', values: [9, 7, 8, 6, 9], slot: 1 }] })];
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard(); dashLayoutApply(); dashDrawAllCharts();
    const host = document.querySelector('.dc-plot[data-card="rg"]');
    const tr = [...host.querySelectorAll('.viz-track')];
    const r = tr.map(t => +t.getAttribute('r'));
    const thick = parseFloat(getComputedStyle(tr[0]).strokeWidth);
    return { n: tr.length, step: r[0] - r[1], thick: thick,
      trackInk: getComputedStyle(tr[0]).stroke,
      gridInk: getComputedStyle(document.documentElement).getPropertyValue('--viz-grid').trim(),
      mid: (host.querySelector('.viz-donut-total') || {}).textContent,
      cap: (host.querySelector('.viz-donut-cap') || {}).textContent };
  });
  // At a flat 4px gap against a 17px band the rings covered 81% of the radius
  // they were spread over and merged into one grey disc.
  ck('the gap between rings is real negative space, not a hairline',
    rings.step - rings.thick >= rings.thick * 0.4,
    'band ' + rings.thick.toFixed(1) + ', gap ' + (rings.step - rings.thick).toFixed(1));
  ck('and a track is lighter than a gridline, because it is 17 times as wide',
    /0\.0[0-6]/.test(rings.trackInk), rings.trackInk + ' vs grid ' + rings.gridInk);
  ck('the hole in the middle carries the summary rather than nothing',
    rings.mid === '7.8' && /of 10$/.test(rings.cap || ''),
    JSON.stringify(rings.mid) + ' / ' + JSON.stringify(rings.cap));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');

  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})();
