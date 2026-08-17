/**
 * Delete every shape of one colour, and get them all back with one Undo.
 *
 * A ring scan can drop a hundred shapes at once, and the only practical way
 * back out is by the property they share. The danger in a bulk delete is not
 * the deleting — it is a bulk delete that costs a hundred presses of Undo, or
 * takes shapes that were not in the group.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/group-delete.cjs
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

  // The panel lives in the Draw tab. Without opening it every element inside
  // still reports display:block and opacity:1 — a hidden ANCESTOR does not
  // change a descendant's own computed style — so a DOM-only visibility check
  // passes on a panel nobody can see. Playwright's click is what catches it.
  await p.click('#tabBtnDraw');
  await p.waitForTimeout(600);

  // Two colour groups: 6 red, 4 blue.
  await p.evaluate(() => {
    const mk = (color, n, latOff) => {
      for (let i = 0; i < n; i++) {
        const g = registerGeom(
          L.polygon([[19.10 + latOff + i * 0.002, 72.86], [19.10 + latOff + i * 0.002, 72.87],
                     [19.101 + latOff + i * 0.002, 72.87]]),
          'Polygon', { name: color + ' ' + i, fillColor: color });
        g.fillColor = color; applyGeomStyle(g);
      }
    };
    mk('#e11d48', 6, 0);
    mk('#2563eb', 4, 0.02);
    if (typeof renderGeomGroups === 'function') renderGeomGroups();
  });
  await p.waitForTimeout(800);

  const before = await p.evaluate(() => ({
    total: geometries.length,
    groups: geomColorGroups().map(g => g.key + ':' + g.count),
  }));
  ck('two colour groups exist', before.total === 10 && before.groups.length === 2,
    JSON.stringify(before));

  // Select the red group the way a user does — click its chip.
  await p.evaluate(() => { geomGroupSelected = '#e11d48'; renderGeomGroups(); });
  await p.waitForTimeout(400);

  const btn = await p.evaluate(() => {
    const el = document.querySelector('.gg-del');
    if (!el) return { err: 'no delete button' };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      found: true,
      // ui/tooltips.js moves every `title` to `data-tip` on init and drops the
      // attribute, so reading .title here reports empty for every control in
      // the app, not just this one.
      tip: el.getAttribute('data-tip') || el.title || '',
      w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, opacity: cs.opacity,
      // The honest test: null offsetParent means it or an ancestor is hidden.
      reallyVisible: el.offsetParent !== null && r.width > 0 && r.height > 0,
    };
  });
  ck('the group has a delete button the user can actually see',
    btn.found && btn.reallyVisible && btn.opacity !== '0', JSON.stringify(btn));
  ck('the button says how many it will take, and that Undo is one press',
    /6 shapes/.test(btn.tip || '') && /Undo/i.test(btn.tip || ''), btn.tip);

  await p.screenshot({ path: path.join(__dirname, 'shot-group-delete.png') });

  await p.click('.gg-del');
  await p.waitForTimeout(700);
  const after = await p.evaluate(() => ({
    total: geometries.length,
    colours: geometries.map(g => g.fillColor),
    status: (document.getElementById('statusMsg') || {}).textContent || '',
    undoOffered: !!document.querySelector('.status-action'),
  }));
  ck('every red shape is gone', after.total === 4 && !after.colours.includes('#e11d48'),
    JSON.stringify(after).slice(0, 160));
  ck('the blue ones are untouched',
    after.colours.filter(c => c === '#2563eb').length === 4, JSON.stringify(after.colours));
  ck('the status line offers Undo rather than asking first',
    after.undoOffered && /deleted/i.test(after.status), JSON.stringify(after.status));

  // ONE undo, not six.
  await p.evaluate(() => doUndo());
  await p.waitForTimeout(800);
  const undone = await p.evaluate(() => ({
    total: geometries.length,
    red: geometries.filter(g => g.fillColor === '#e11d48').length,
    onMap: document.querySelectorAll('#map path').length > 0,
  }));
  ck('ONE undo brings the whole group back',
    undone.total === 10 && undone.red === 6, JSON.stringify(undone));
  ck('and they are drawn on the map again', undone.onMap === true, JSON.stringify(undone));

  // Redo takes them away again.
  await p.evaluate(() => doRedo());
  await p.waitForTimeout(700);
  ck('redo removes the group again',
    await p.evaluate(() => geometries.length === 4));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
