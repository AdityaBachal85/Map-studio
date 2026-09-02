/**
 * Undo takes back one action, and leaves alone what is not an action.
 *
 * Undo here is snapshot-based: it restores the whole map from a serialised
 * copy, which is what makes it catch every kind of edit without instrumenting
 * every call site. The cost is that whatever the snapshot does NOT carry gets
 * reset by every step, and one thing it did not carry was which layers you had
 * switched off. So an undo undid one edit AND every hide anybody had made,
 * which does not read as an undo — it reads as the map resetting.
 *
 * Hiding a layer is the same kind of act as panning: it changes what you are
 * looking at, not what the map IS. The snapshot drops `view` deliberately for
 * that reason; visibility was dropped by omission, which is a different thing
 * and had the opposite effect.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/undo.cjs
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

  /* -- one action at a time ------------------------------------------------ */

  const steps = await p.evaluate(async () => {
    map.setView([19.10, 72.88], 13, { animate: false });
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const A = addLocation({ name: 'One', lat: 19.10, lng: 72.88 });
    historyCommit(); await wait(60);
    const seen = [];
    for (const nm of ['Two', 'Three', 'Four']) {
      A.name = nm; historyCommit(); await wait(60);
    }
    for (let i = 0; i < 3; i++) {
      doUndo(); await wait(300);
      seen.push(locations.find(l => Math.abs(l.lat - 19.10) < 1e-9).name);
    }
    return seen;
  });
  // Three edits, three undos, walked back in order — not one jump to the start.
  ck('three edits undo one at a time, in order',
    steps.join(' -> ') === 'Three -> Two -> One', steps.join(' -> '));

  const redo = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    doRedo(); await wait(300);
    const a = locations.find(l => Math.abs(l.lat - 19.10) < 1e-9).name;
    doRedo(); await wait(300);
    return [a, locations.find(l => Math.abs(l.lat - 19.10) < 1e-9).name];
  });
  ck('and redo walks forward the same way', redo.join(' -> ') === 'Two -> Three', redo.join(' -> '));

  /* -- what you hid stays hidden ------------------------------------------- */

  const hide = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    clearProject();
    const A = addLocation({ name: 'Alpha', lat: 19.10, lng: 72.88 });
    const B = addLocation({ name: 'Beta', lat: 19.12, lng: 72.90 });
    const g1 = registerGeom(L.polyline([[19.10, 72.88], [19.12, 72.90]]), 'Line', { name: 'Shape one' });
    const g2 = registerGeom(L.polyline([[19.11, 72.87], [19.13, 72.91]]), 'Line', { name: 'Shape two' });
    historyCommit(); await wait(60);

    setLocVisible(B, false);
    setGeomVisible(g2, false);
    await wait(60);
    const off = { loc: B._hidden === true, geom: g2._hidden === true,
      geomOffMap: !map.hasLayer(g2.layer) };

    A.name = 'Alpha renamed';
    historyCommit(); await wait(60);
    doUndo(); await wait(400);

    const A2 = locations.find(l => Math.abs(l.lat - 19.10) < 1e-9);
    const B2 = locations.find(l => Math.abs(l.lat - 19.12) < 1e-9);
    const g1b = geometries.find(x => x.name === 'Shape one');
    const g2b = geometries.find(x => x.name === 'Shape two');
    return {
      off,
      undone: A2 && A2.name === 'Alpha',
      locHidden: !!(B2 && B2._hidden),
      geomHidden: !!(g2b && g2b._hidden),
      // The flag alone would leave the shape drawn and only the tick box
      // changed, so this is the assertion that matters.
      geomOffMap: g2b ? !map.hasLayer(g2b.layer) : null,
      shownStillShown: !!(g1b && !g1b._hidden && map.hasLayer(g1b.layer)),
      ids: g1b && g2b ? [g1b.id, g2b.id] : null,
    };
  });
  ck('hiding a layer takes it off the map to begin with',
    hide.off.loc && hide.off.geom && hide.off.geomOffMap === true, JSON.stringify(hide.off));
  ck('an undo takes back the edit', hide.undone === true);
  // The complaint, exactly: "it reset the map, all the layers I have hid get back".
  ck('and leaves the hidden location hidden', hide.locHidden === true);
  ck('and the hidden shape hidden — off the map, not just unticked',
    hide.geomHidden === true && hide.geomOffMap === true,
    'flag ' + hide.geomHidden + ', off the map ' + hide.geomOffMap);
  ck('while what was showing is still showing', hide.shownStillShown === true);

  /* -- which needs a shape to still be the same shape afterwards ----------- */

  // Every applyProject renumbered the shapes from 1, so nothing outside the
  // geometry could name a particular shape and still mean it afterwards. That
  // is why the visibility could not be put back: there was no way to say which
  // shape had been hidden.
  const ids = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const before = geometries.map(g => g.id);
    const names = geometries.map(g => g.name);
    const snap = JSON.parse(JSON.stringify(serialiseProject()));
    clearProject();
    applyProject(snap);
    await wait(200);
    return { before, after: geometries.map(g => g.id), names,
      sameOrder: geometries.map(g => g.name).join() === names.join(),
      inFile: (snap.geometries || []).map(f => (f.properties || {}).id) };
  });
  ck('a shape keeps its id through a rebuild',
    ids.before.join() === ids.after.join() && ids.sameOrder,
    ids.before.join() + ' -> ' + ids.after.join());
  ck('because the id is written into the file with it',
    ids.inFile.every(v => v != null), JSON.stringify(ids.inFile));

  // An id from a foreign file must not be able to claim a shape that exists.
  const clash = await p.evaluate(() => {
    const taken = geometries[0].id;
    const g = registerGeom(L.polyline([[19.2, 72.8], [19.21, 72.81]]), 'Line',
      { id: taken, name: 'Imported' });
    return { asked: taken, got: g.id, first: geometries[0].id,
      unique: new Set(geometries.map(x => x.id)).size === geometries.length };
  });
  ck('but an id already in use is refused rather than duplicated',
    clash.got !== clash.asked && clash.unique === true,
    'asked for ' + clash.asked + ', given ' + clash.got);

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');

  await b.close();
  const pass = R.filter(Boolean).length;
  console.log('\n' + pass + '/' + R.length + ' passed');
  process.exit(pass === R.length ? 0 : 1);
})();
