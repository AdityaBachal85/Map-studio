/**
 * A drawn text label, and the line breaks it can now carry.
 *
 * The field was an <input type="text">, which cannot hold a newline, rendered
 * into a single <span> with `white-space: nowrap`. So a label was one straight
 * line and there was no way to make it anything else — "Kalyan / Padgha Road /
 * Phase II" had to be typed as one run-on string or as three separate labels
 * dragged into alignment by hand.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/draw-text.cjs
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

  const one = await p.evaluate(() => {
    const g = addTextLabel(19.25, 73.15, 'Kalyan');
    return { name: g.name, id: g.id };
  });
  await p.waitForTimeout(700);

  const single = await p.evaluate(() => {
    const el = document.querySelector('.map-text');
    return { brs: el.querySelectorAll('br').length, h: Math.round(el.getBoundingClientRect().height),
      wrap: getComputedStyle(el).whiteSpace };
  });
  ck('a one-line label is still one line', single.brs === 0 && one.name === 'Kalyan',
    JSON.stringify(single));
  // nowrap stays: a break should be where the author put it, never where the
  // pin happened to sit. <br> breaks regardless of white-space, which is why
  // this works without loosening it.
  ck('and still refuses to wrap itself at some arbitrary point',
    single.wrap === 'nowrap', single.wrap);

  const multi = await p.evaluate(() => {
    const g = geometries.find(x => x.shape === 'Label');
    const nm = g.card.querySelector('.gnm');
    nm.value = 'Kalyan\nPadgha Road\nPhase II';
    nm.dispatchEvent(new Event('input', { bubbles: true }));
    return { tag: nm.tagName, val: nm.value };
  });
  ck('the field is one you can type a second line into', multi.tag === 'TEXTAREA', multi.tag);

  await p.waitForTimeout(500);
  const drawn = await p.evaluate(() => {
    const el = document.querySelector('.map-text');
    return {
      brs: el.querySelectorAll('br').length,
      text: el.textContent,
      h: Math.round(el.getBoundingClientRect().height),
      align: getComputedStyle(el).textAlign,
    };
  });
  ck('three lines typed are three lines drawn', drawn.brs === 2, drawn.brs + ' breaks');
  ck('the label grew to hold them', drawn.h > single.h * 2, single.h + 'px -> ' + drawn.h + 'px');
  // Left-ragged text hung off a map point reads as an accident.
  ck('and they are centred on the point they mark', drawn.align === 'center', drawn.align);

  const grew = await p.evaluate(() => {
    const nm = document.querySelector('.label-card .gnm');
    return Math.round(nm.getBoundingClientRect().height);
  });
  // The card is wired before it is in the document, where scrollHeight is 0 —
  // so a single measurement always sized the field to one line.
  ck('the field itself grew too, rather than scrolling inside one row',
    grew > 45, grew + 'px');

  const enter = await p.evaluate(() => {
    const nm = document.querySelector('.label-card .gnm');
    let escaped = false;
    const spy = () => { escaped = true; };
    document.addEventListener('keydown', spy);
    nm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    document.removeEventListener('keydown', spy);
    return escaped;
  });
  // Enter is a newline here, which is the point — it must not reach the panel
  // handlers that read Enter as "commit and close".
  ck('Enter stays in the field rather than reaching the panel', enter === false);

  const saved = await p.evaluate(() => {
    const snap = JSON.parse(JSON.stringify(serialiseProject()));
    // Geometries are saved as GeoJSON Features (project/geojson.js), so the
    // shape and the text live in `properties`, not on the feature itself.
    const f = (snap.geometries || []).find(x => (x.properties || {}).shape === 'Label');
    const g = f && f.properties;
    clearProject();
    applyProject(snap);
    const el = document.querySelector('.map-text');
    return { stored: g && g.name, brs: el ? el.querySelectorAll('br').length : null };
  });
  ck('the breaks are saved with the project', /\n/.test(saved.stored || ''), JSON.stringify(saved.stored));
  ck('and drawn again when it is reopened', saved.brs === 2, String(saved.brs));

  const shot = await p.evaluate(async () => {
    // The .map-text-wrap around it is a Leaflet divIcon declared
    // `iconSize: [0, 0]`, so it genuinely measures zero — the span inside is
    // absolutely positioned and is the thing with the text in it.
    const el = document.querySelector('.map-text');
    const c = await html2canvas(el,
      { backgroundColor: '#ffffff', scale: 2, logging: false });
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    // Ink per row: a multi-line label leaves gaps between its lines, a single
    // line does not. Counting rows that carry ink proves the breaks survived
    // the rasteriser rather than collapsing back to one line.
    const rows = [];
    for (let y = 0; y < c.height; y++) {
      let ink = 0;
      for (let x = 0; x < c.width; x++) {
        const o = (y * c.width + x) * 4;
        if (d[o] + d[o + 1] + d[o + 2] < 600) ink++;
      }
      rows.push(ink > 0);
    }
    let bands = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i] && !rows[i - 1]) bands++;
    return { w: c.width, h: c.height, bands };
  });
  ck('and the export rasterises them as separate lines, not one',
    shot.w > 0 && shot.bands >= 3, shot.bands + ' bands of ink in ' + shot.w + 'x' + shot.h);

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');

  await p.screenshot({ path: path.join(REPO, 'diagnostics', 'shot-draw-text.png') });
  await b.close();
  const pass = R.filter(Boolean).length;
  console.log('\n' + pass + '/' + R.length + ' passed');
  process.exit(pass === R.length ? 0 : 1);
})();
