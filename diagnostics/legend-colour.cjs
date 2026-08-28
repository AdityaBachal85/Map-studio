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

  /* -- and the SHAPE of a row is a choice too ------------------------------- */

  // The mark carried half the meaning and none of the choice. A line class got
  // a bar, a point got a dot, an area got a block, and that was the end of it —
  // so two different things drawn in the same colour could not be told apart in
  // the key, and a reader with a printed sheet has nothing else to go on.
  const shapes = await p.evaluate(() => {
    const site = addLocation({ name: 'Site', lat: 19.10, lng: 72.88, type: 'site' });
    [['Kalyan station', 19.11, 72.90, '#8B5CF6'], ['Airport', 19.09, 72.86, '#22C55E'],
      ['Ring road', 19.12, 72.87, '#EF4444']].forEach(([nm, lat, lng, col], i) => {
      const d = addLocation({ name: nm, lat, lng });
      const rt = addRoute();
      rt.fromId = site.id; rt.toId = d.id; rt.color = col; rt.labelText = ''; rt.cls = null;
      rt.alts = [{ d: (i + 1) * 700, t: (i + 1) * 180, coords: [[19.10, 72.88], [lat, lng]] }];
      rt.altIndex = 0;
    });
    rebuildLegend();
    const tgl = document.getElementById('colorKeyTgl');
    if (tgl && !tgl.checked) { tgl.checked = true; tgl.dispatchEvent(new Event('change')); }
    setColorKeyEditing(true);
    return { rows: colorKeyRows().length,
      buttons: document.querySelectorAll('.ck-shape').length,
      catalogue: CK_SHAPES.length };
  });
  await p.waitForTimeout(400);
  ck('every row offers a symbol to choose while the key is being edited',
    shapes.rows > 1 && shapes.buttons === shapes.rows, JSON.stringify(shapes));
  ck('and there are nine of them, not three',
    shapes.catalogue === 9, String(shapes.catalogue));

  // A row that was never given one has to look exactly as it always did, or
  // this feature quietly restyles every map made before it.
  ck('a row nobody has chosen for still takes the shape its kind implies',
    await p.evaluate(() => {
      const rows = colorKeyRows();
      return rows.every(r => colorKeyShapeOf(r)
        === (r.kind === 'line' ? 'line' : r.kind === 'mark' ? 'dot' : 'area'));
    }) === true);

  const press = async sel => {
    const bx = await p.evaluate(s => {
      const el = document.querySelector(s); if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
    if (!bx) return false;
    await p.mouse.move(bx.x, bx.y); await p.mouse.down(); await p.mouse.up();
    await p.waitForTimeout(300);
    return true;
  };

  // Read which row this actually is rather than assuming: this suite builds its
  // own scene before the routes above are added, so "the second row" is not the
  // one this section created and hardcoding its colour tested the fixture.
  const target = await p.evaluate(() => {
    const el = document.querySelectorAll('.ck-row')[1];
    const key = el.dataset.ckKey;
    const row = colorKeyRows().find(r => r.key === key);
    return { key: key, shape: colorKeyShapeOf(row), color: row.color.toLowerCase() };
  });
  await press('.ck-row:nth-child(2) .ck-shape');
  const shapePop = await p.evaluate(want => {
    const el = document.querySelector('.ck-shapes');
    if (!el) return null;
    const rgb = h => {
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
      return m ? [1, 2, 3].map(i => parseInt(m[i], 16)).join(', ') : null;
    };
    const hexNeedle = want.color.replace('#', '');
    const rgbNeedle = rgb(want.color);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      options: el.querySelectorAll('button[data-shape]').length,
      marked: [...el.querySelectorAll('button.on')].map(b => b.dataset.shape),
      // `--surface` is the GLASS token on this card, so a popover taking it came
      // up see-through and the rows underneath read straight through the shapes
      // you were choosing between.
      opaque: !/rgba\([^)]+,\s*0?\.\d+\)/.test(cs.backgroundColor),
      onScreen: r.top >= 0 && r.bottom <= 1000 && r.left >= 0,
      // Drawn in the row's own colour: a grid of grey shapes makes you imagine
      // the answer rather than showing it.
      inRowColour: [...el.querySelectorAll('button[data-shape] .ck-mark')]
        .every(m => {
          // A dash carries its colour on its pieces, not on the wrapper.
          const st = (m.getAttribute('style') || '')
            + [...m.querySelectorAll('i')].map(i => i.getAttribute('style') || '').join('');
          const l = st.toLowerCase();
          return l.indexOf(hexNeedle) >= 0 || (rgbNeedle && l.indexOf(rgbNeedle) >= 0);
        }),
    };
  }, target);
  ck('the button opens a popover of every symbol', !!shapePop && shapePop.options === 9,
    JSON.stringify(shapePop));
  ck('with the one this row already uses marked',
    shapePop.marked.join() === target.shape, shapePop.marked.join() + ' vs ' + target.shape);
  ck('drawn in the row\'s own colour, not in grey', shapePop.inRowColour === true);
  ck('opaque, so the rows underneath do not read through it', shapePop.opaque === true);
  ck('and on the screen rather than off the edge of it', shapePop.onScreen === true);

  const picked = await p.evaluate(async () => {
    const before = colorKeyRows().map(r => colorKeyShapeOf(r));
    document.querySelector('.ck-shapes [data-shape="star"]').click();
    await new Promise(r => setTimeout(r, 200));
    return { before: before, after: colorKeyRows().map(r => colorKeyShapeOf(r)),
      gone: !document.querySelector('.ck-shapes'),
      stored: JSON.stringify(colorKeyEdits) };
  });
  ck('choosing one changes that row and leaves the others alone',
    picked.after[1] === 'star'
      && picked.after.filter((v, i) => i !== 1 && v === picked.before[i]).length === picked.before.length - 1,
    picked.before.join(',') + ' -> ' + picked.after.join(','));
  ck('and the popover closes behind it', picked.gone === true);
  ck('the choice is stored on the row, so it saves with the project',
    /"shape":"star"/.test(picked.stored), picked.stored.slice(0, 90));

  // The mark is drawn for four renderers — the screen, html2canvas for the
  // picture exports, and the PowerPoint and Word writers, which can only put
  // text in a cell. A dash made from a repeating gradient comes out of
  // html2canvas as a SOLID bar, which is a different legend entry.
  const drawn = await p.evaluate(() => {
    const m = s => {
      const d = document.createElement('div');
      d.innerHTML = colorKeyMark({ color: '#8B5CF6', kind: 'line', shape: s });
      return d.firstChild;
    };
    return { dashPieces: m('dash').querySelectorAll('i').length,
      dashNoGradient: !/gradient/i.test(getComputedStyle(m('dash')).backgroundImage || 'none'),
      starIsText: (m('star').textContent || '').trim() === '★',
      lineIsBar: (m('line').textContent || '') === '' };
  });
  ck('a dashed line is drawn as pieces, not as a gradient a screenshot flattens',
    drawn.dashPieces === 3 && drawn.dashNoGradient === true, JSON.stringify(drawn));
  ck('and the point shapes are characters, which every writer can place',
    drawn.starIsText === true && drawn.lineIsBar === true, JSON.stringify(drawn));

  // A symbol that only exists on screen is not a symbol choice.
  const exported = await p.evaluate(() => {
    setAppMode('dashboard');
    const cs = getComputedStyle(document.documentElement);
    const m = dashExportModel({ title: 'Key',
      resolveColor: n => cs.getPropertyValue(n).trim(),
      liveRows: { legend: colorKeyRows() } });
    const card = m.cards.find(c => c.type === 'legend');
    setAppMode('map');
    return card ? card.data.rows.map(r => r.shape) : null;
  });
  await p.waitForTimeout(600);
  ck('the export model carries the symbol beside the colour',
    Array.isArray(exported) && exported.indexOf('star') >= 0, JSON.stringify(exported));

  /* ---- the key describes the whole map, not just the site ---------------- */

  // connLegendRows() read `if (l.type === 'site')`, so a map carrying a site,
  // four stations, an airport and a school produced exactly ONE row — the card
  // that says what the map means said "Site / subject property" and stopped.
  const auto = await p.evaluate(() => {
    locations.length = 0;
    if (typeof routes !== 'undefined') routes.length = 0;
    if (typeof geometries !== 'undefined') geometries.length = 0;
    addLocation({ lat: 19.23, lng: 73.13, name: 'Site', type: 'site' });
    addLocation({ lat: 19.25, lng: 73.16, name: 'Kalyan', type: 'station' });
    addLocation({ lat: 19.21, lng: 73.10, name: 'Ambivli', type: 'station' });
    addLocation({ lat: 19.27, lng: 73.19, name: 'Line 5', type: 'metroStation' });
    addLocation({ lat: 19.19, lng: 73.22, name: 'Airport', type: 'airport' });
    return colorKeyRows().map(r => r.label);
  });
  ck('every kind of pin on the map earns a legend row, not only the site',
    auto.indexOf('Railway station') >= 0 && auto.indexOf('Metro station') >= 0
    && auto.indexOf('Airport') >= 0 && auto.indexOf('Site / subject property') >= 0,
    JSON.stringify(auto));
  // A legend names kinds, not instances: two stations are one row.
  ck('and two of the same kind share one row rather than printing twice',
    auto.filter(l => l === 'Railway station').length === 1, JSON.stringify(auto));

  // A type with no class in the standard still has a colour on the map, and a
  // colour on the map with nothing beside it in the key is the complaint this
  // whole card exists to answer.
  const loose = await p.evaluate(() => {
    addLocation({ lat: 19.24, lng: 73.08, name: 'DPS School', type: 'school', color: '#7C3AED' });
    return colorKeyRows().map(r => r.label + '=' + String(r.color).toLowerCase());
  });
  ck('a pin whose type is not in the standard is named after itself',
    loose.some(l => l === 'DPS School=#7c3aed'), JSON.stringify(loose));

  // Editing off first: an empty card while the pencil is open is deliberate —
  // that is the state you add a custom row from — so leaving it on here would
  // assert the opposite of what the card is for.
  await p.evaluate(() => {
    colorKeyEditing = false;
    locations.length = 0;
    rebuildColorKey();
  });
  await p.waitForTimeout(400);
  const empty = await p.evaluate(() => ({
    rows: colorKeyRows().length,
    shown: getComputedStyle(document.getElementById('colorKeyCard')).display,
  }));
  ck('and a map with nothing on it hides the card rather than showing an empty one',
    empty.rows === 0 && empty.shown === 'none', JSON.stringify(empty));

  /* ---- the compass ------------------------------------------------------- */

  const rose = await p.evaluate(() => {
    const n = document.getElementById('northArrow');
    const r = n.getBoundingClientRect();
    const wrap = document.getElementById('mapWrap').getBoundingClientRect();
    const sb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sbw')) || 0;
    const svg = n.querySelector('svg');
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
      sb: Math.round(sb), wrapH: Math.round(wrap.height),
      paths: svg.querySelectorAll('path').length,
      letters: Array.from(svg.querySelectorAll('text')).map(t => t.textContent).join(''),
      // html2canvas resolves no CSS variables, and this element is captured
      // into every export — a currentColor here comes out black.
      vars: /var\(|currentColor/.test(svg.outerHTML),
    };
  });
  ck('the compass is at the TOP of the map, not the bottom', rose.y < rose.wrapH / 3,
    'y=' + rose.y + ' of ' + rose.wrapH);
  ck('and on the left, clear of the sidebar rather than under it',
    rose.x >= rose.sb && rose.x < rose.sb + 40, 'x=' + rose.x + ', sidebar ' + rose.sb);
  ck('it is a rose — folded points, a ring and an inner star, not one triangle',
    rose.paths >= 5, rose.paths + ' paths');
  ck('and it names all four cardinal directions', rose.letters === 'NESW', rose.letters);
  ck('every colour in it is a literal, since exports resolve no variables', !rose.vars);

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
