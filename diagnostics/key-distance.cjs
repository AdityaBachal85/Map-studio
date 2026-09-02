/**
 * What a Key Distance is a distance FROM.
 *
 * The card answers one question — how far is this from the site — and for a
 * route drawn from the site that is the route's own length, which is what it
 * reported and was right.
 *
 * It was not that for a road traced across the map with the site sitting
 * beside it. A highway drawn from one town to another and passing the plot
 * reported the distance between those two towns: a real number, measuring
 * something nobody asked about, in the row where the reader is looking for
 * "the highway is 200 m away". A T-junction is the same shape of mistake —
 * the arm the site sits on is what matters and the crossbar's length is not.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/key-distance.cjs
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
  const b = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3200);

  /* -- a highway passing the plot ------------------------------------------ */

  const beside = await p.evaluate(async () => {
    map.setView([19.20, 72.88], 13, { animate: false });
    // The site, 200 m south of a highway that runs 19 km across the map.
    const site = addLocation({ name: 'Site', lat: 19.1982, lng: 72.88, type: 'site' });
    const w = addLocation({ name: 'Bhiwandi', lat: 19.20, lng: 72.80 });
    const e = addLocation({ name: 'Kalyan', lat: 19.20, lng: 72.98 });
    const coords = [];
    for (let i = 0; i <= 40; i++) coords.push([19.20, 72.80 + i * 0.0045]);
    const rt = addRoute({ fromId: w.id, toId: e.id, labelText: 'NH 48',
      saved: { d: 19000, t: 1500, coords } });
    rebuildLegend();
    await new Promise(r => setTimeout(r, 300));
    const row = legendRows().find(r => r.name === 'NH 48');
    return {
      roadKm: 19,
      row: row && { km: row.km, approach: row.approach, approx: row.approx },
      at: rt.approach && { lat: +rt.approach.at.lat.toFixed(5), lng: +rt.approach.at.lng.toFixed(5) },
      siteId: site.id,
    };
  });
  ck('a road passing the site is measured to the site, not end to end',
    beside.row.km === '0.20 km', beside.row.km + ' (the road itself is ' + beside.roadKm + ' km)');
  ck('and the point it is measured to is the nearest one on the road',
    Math.abs(beside.at.lat - 19.20) < 1e-4 && Math.abs(beside.at.lng - 72.88) < 1e-4,
    JSON.stringify(beside.at));
  // Two decimals under a kilometre: "0.20 km" and "0.15 km" are different
  // answers to "can I walk to the highway", and one decimal makes them one.
  ck('a distance under a kilometre keeps the digit that decides it',
    /^0\.\d\d km$/.test(beside.row.km), beside.row.km);
  ck('the row says it is measuring an approach, not a journey',
    beside.row.approach === true);
  // Routing is unreachable from here, so this is the straight line — and it
  // has to admit that rather than pass a crow-flies figure off as a driven one.
  ck('and when live routing cannot be reached it says the number is a straight line',
    beside.row.approx === true);

  /* -- the T-junction ------------------------------------------------------ */

  const tee = await p.evaluate(async () => {
    const n1 = addLocation({ name: 'Tee W', lat: 19.24, lng: 72.84 });
    const n2 = addLocation({ name: 'Tee E', lat: 19.24, lng: 72.94 });
    const coords = [];
    for (let i = 0; i <= 20; i++) coords.push([19.24, 72.84 + i * 0.005]);
    const rt = addRoute({ fromId: n1.id, toId: n2.id, labelText: 'Ghodbunder Rd',
      saved: { d: 10500, t: 900, coords } });
    rebuildLegend();
    await new Promise(r => setTimeout(r, 300));
    const row = legendRows().find(r => r.name === 'Ghodbunder Rd');
    return { km: row && row.km, approach: row && row.approach,
      at: rt.approach && { lat: +rt.approach.at.lat.toFixed(4), lng: +rt.approach.at.lng.toFixed(4) } };
  });
  // The site is 4.7 km south of the crossbar's middle. The crossbar is 10.5 km
  // long, and that number answers nothing anybody asked.
  ck('a T crossbar is measured down the stem, not along the bar',
    tee.km === '4.7 km' && tee.approach === true, tee.km + ' of a 10.5 km bar');
  ck('and it meets the bar at the point opposite the site',
    Math.abs(tee.at.lng - 72.88) < 2e-3, JSON.stringify(tee.at));

  /* -- and the case that was already right --------------------------------- */

  const own = await p.evaluate(async () => {
    const site = locations.find(l => l.type === 'site');
    const dest = addLocation({ name: 'Airport', lat: 19.09, lng: 72.87 });
    const rt = addRoute({ fromId: site.id, toId: dest.id,
      saved: { d: 12800, t: 1600, coords: [[19.1982, 72.88], [19.09, 72.87]] } });
    // The other way round is the same journey.
    const back = addRoute({ fromId: dest.id, toId: site.id,
      saved: { d: 12800, t: 1600, coords: [[19.09, 72.87], [19.1982, 72.88]] } });
    rebuildLegend();
    await new Promise(r => setTimeout(r, 300));
    const rows = legendRows();
    return {
      out: rows.find(r => r.name === 'Airport'),
      untouched: !rt.approach && !back.approach,
      backNamed: rows.filter(r => r.name === 'Airport').length,
    };
  });
  // A route drawn FROM the site already answers the question the card asks.
  ck('a route that starts at the site is left exactly as it was',
    own.out.km === '12.8 km' && own.untouched === true && !own.out.approach,
    own.out.km);
  ck('and one drawn back towards the site is the same journey, named the same way',
    own.backNamed === 2, own.backNamed + ' rows named Airport');

  /* -- it follows the site, which is what makes it live -------------------- */

  const moved = await p.evaluate(async () => {
    const site = locations.find(l => l.type === 'site');
    const before = legendRows().find(r => r.name === 'NH 48').km;
    site.lat = 19.1932;                       // 800 m south instead of 200
    rebuildLegend();
    await new Promise(r => setTimeout(r, 300));
    return { before, after: legendRows().find(r => r.name === 'NH 48').km };
  });
  // Measured when the card is built rather than when the route is computed,
  // because a site being dragged does not recompute a single route.
  ck('moving the site changes what the distances say',
    moved.before === '0.20 km' && moved.after === '0.76 km',
    moved.before + ' -> ' + moved.after);

  const noSite = await p.evaluate(async () => {
    const site = locations.find(l => l.type === 'site');
    site.type = 'pin';
    rebuildLegend();
    await new Promise(r => setTimeout(r, 250));
    const row = legendRows().find(r => r.name === 'NH 48');
    site.type = 'site';
    return { km: row.km, approach: !!row.approach };
  });
  // With no site there is nothing to measure from, and the road's own length
  // is the only honest thing left to say.
  ck('with no site on the map a road reports its own length again',
    noSite.km === '19.0 km' && noSite.approach === false, noSite.km);

  /* -- which service answered, said rather than assumed -------------------- */

  const via = await p.evaluate(() => {
    const rt = routes.find(r => r.labelText === 'NH 48');
    const shown = t => { rt.via = t; return routeAutoText(rt); };
    return { google: shown('google'), osrm: shown('osrm'),
      keyed: typeof googleReady === 'function' && googleReady() };
  });
  // Google is first in the routing chain and falls through to OSRM without a
  // word when it cannot help, so "are these Google's roads" was a question
  // nobody could answer by looking. The two disagree about Indian roads, which
  // is the whole reason Google is first.
  ck('a route says which service drew it', /Google/.test(via.google), via.google);
  ck('and says when it was the free one instead', /OSM/.test(via.osrm), via.osrm);

  /* -- a road's name stays on its road ------------------------------------- */

  /*
   * THE SOLVER PUSHED OVERLAPPING LABELS APART AND ITERATED, WITH NOTHING TO
   * STOP IT. Each pass moves a box half an overlap, each neighbour it lands on
   * moves it again, and a crowded sheet compounds that into hundreds of pixels
   * — a road name floating over open ground with a leader reaching back to the
   * road it belongs to. That is not a solution to an overlap. It is a worse
   * problem, because the reader now has to work out which line the name is
   * for, and the obvious guess is whatever is underneath it.
   *
   * It went from a rounding error to the first thing you notice when drawn
   * shapes joined the billboard: a station chip is about 90px wide and
   * "Mumbai-Ahmedabad High-Speed Rail Corridor" is 263px, so road names
   * overlap far more and shove far harder.
   */
  const shove = await p.evaluate(async () => {
    clearProject();
    map.setView([19.16, 73.00], 13, { animate: false });
    const names = [];
    for (let i = 0; i < 12; i++) {
      names.push(['Kalyan - Shil Road', 'Mumbai-Ahmedabad High-Speed Rail Corridor',
        'Airoli - Katai Naka', 'Mumbai Panvel Highway', 'Shil Phata - Mahape Road'][i % 5] + ' ' + i);
    }
    // Stacked 44 m apart, so every box wants the same band of the map.
    const els = names.map((n, i) => {
      const g = [];
      for (let k = 0; k <= 20; k++) g.push({ lat: 19.160 + i * 0.0004, lon: 72.97 + k * 0.003 });
      return { type: 'way', tags: { highway: 'trunk', name: n }, geometry: g };
    });
    const found = joinRingFeatures(els.map(el => overpassToFeature(el, 'highway')));
    ringScanState = { loc: null, km: 9, ids: ['highway'],
      picked: new Set(found.map((f, i) => i)), result: found };
    keepRingScanSelection();
    await new Promise(r => setTimeout(r, 900));
    const gs = geometries.filter(g => g._labelEl);
    const pushed = gs.map(g => {
      const ax = g._autoOffsetX == null ? g.labelOffset.x : g._autoOffsetX;
      const ay = g._autoOffsetY == null ? g.labelOffset.y : g._autoOffsetY;
      return Math.round(Math.hypot(ax - g.labelOffset.x, ay - g.labelOffset.y));
    });
    const widest = Math.max(...gs.map(g => Math.round(g._labelEl.getBoundingClientRect().width)));
    return { n: gs.length, max: Math.max(...pushed), any: pushed.some(v => v > 0), widest };
  });
  ck('a dozen road names crowded into one band still avoid each other',
    shove.n === 12 && shove.any === true, shove.n + ' labels, some moved');
  ck('but none of them is shoved off the road it names',
    shove.max <= 41, 'furthest ' + shove.max + 'px');
  // The long names are the ones that used to walk furthest, so the cap has to
  // hold for them in particular.
  ck('including the long ones, which overlap most and used to shove hardest',
    shove.widest > 200, 'widest label ' + shove.widest + 'px');

  /* -- the report is landscape, whatever shape the board is ---------------- */

  // A connectivity sheet is a map beside its cards, read across, shown on a
  // screen in a meeting and printed into a landscape deck. A portrait page of
  // it is not a tighter version of that, it is a different document.
  const paper = await p.evaluate(() => ({
    tall: dashPdfPaper('a4'),
    a3: dashPdfPaper('a3'),
  }));
  ck('an A4 report sheet is landscape', paper.tall.w > paper.tall.h
    && /landscape/.test(paper.tall.label), paper.tall.label);
  ck('and so is A3', paper.a3.w > paper.a3.h && /landscape/.test(paper.a3.label), paper.a3.label);
  // It used to choose from the board's own aspect, so a tall board turned the
  // paper. A tall board should paginate down landscape pages instead — and the
  // proof is that the function cannot see the board at all any more.
  const arity = await p.evaluate(() => dashPdfPaper.length);
  ck('and the shape of the board cannot turn the paper, because it is not asked',
    arity === 1, 'dashPdfPaper takes ' + arity + ' argument' + (arity === 1 ? '' : 's'));

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');

  await p.screenshot({ path: path.join(REPO, 'diagnostics', 'shot-key-distance.png') });
  await b.close();
  const pass = R.filter(Boolean).length;
  console.log('\n' + pass + '/' + R.length + ' passed');
  process.exit(pass === R.length ? 0 : 1);
})();
