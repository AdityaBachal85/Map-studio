/**
 * DMS coordinates reach the map through the two real UI paths, not just the
 * parser in isolation: pasting into the search bar, and editing a location's
 * coordinate field on its card.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/coord-parse-ui.cjs
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

const DMS = '19°22\'37.1"N 73°10\'10.4"E';

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || undefined });
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

  /* -- the search bar's coordinate paste ------------------------------------ */

  const search = await p.evaluate(async dms => {
    $('searchInput').value = dms;
    await doSearch(false);
    const hit = resultsData[0];
    return {
      resultCount: resultsData.length,
      synthetic: hit && hit.synthetic === true,
      lat: hit && hit.lat, lng: hit && hit.lng,
      label: hit && hit.label,
    };
  }, DMS);
  ck('the search bar recognises a pasted DMS string as coordinates',
    search.resultCount === 1 && search.synthetic, JSON.stringify(search));
  ck('and reports the right spot',
    search.lat && Math.abs(search.lat - 19.376972) < 1e-4 && Math.abs(search.lng - 73.169556) < 1e-4,
    JSON.stringify(search));
  ck('the result label shows decimal degrees, not the raw DMS text back',
    /19\.37697.*73\.16956/.test(search.label || ''), search.label);

  const added = await p.evaluate(async () => {
    const before = locations.length;
    await pickResult(resultsData[0]);
    const loc = locations[locations.length - 1];
    return { before, after: locations.length, lat: loc.lat, lng: loc.lng };
  });
  ck('submitting it adds a real location at that spot',
    added.after === added.before + 1
      && Math.abs(added.lat - 19.376972) < 1e-4 && Math.abs(added.lng - 73.169556) < 1e-4,
    JSON.stringify(added));

  /* -- editing a location's coordinate field on its card --------------------- */

  const edited = await p.evaluate(dms => {
    const loc = locations[locations.length - 1];
    const before = { lat: loc.lat, lng: loc.lng };
    const input = loc.card.querySelector('.coord');
    input.value = dms;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      before,
      lat: loc.lat, lng: loc.lng,
      fieldValue: input.value,
    };
  }, '19°22\'40.0"S 73°10\'10.4"W');   // a different spot, so the edit is unmistakably a real change
  const wantLat = -(19 + 22 / 60 + 40 / 3600), wantLng = -(73 + 10 / 60 + 10.4 / 3600);
  ck('editing a location\'s coordinate field to DMS text updates its position',
    Math.abs(edited.lat - wantLat) < 1e-4 && Math.abs(edited.lng - wantLng) < 1e-4,
    JSON.stringify({ edited, want: [wantLat, wantLng] }));
  ck('and the field is repainted in decimal, not left showing the DMS text typed in',
    /-?\d+\.\d+,\s*-?\d+\.\d+/.test(edited.fieldValue) && !/[°'"]/.test(edited.fieldValue),
    edited.fieldValue);

  const rejected = await p.evaluate(() => {
    const loc = locations[locations.length - 1];
    const before = { lat: loc.lat, lng: loc.lng };
    const input = loc.card.querySelector('.coord');
    input.value = 'not a coordinate';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { before, after: { lat: loc.lat, lng: loc.lng }, fieldValue: input.value };
  });
  ck('an unparsable coordinate is rejected and the field resets rather than moving the pin',
    rejected.before.lat === rejected.after.lat && rejected.before.lng === rejected.after.lng
      && !/not a coordinate/.test(rejected.fieldValue),
    JSON.stringify(rejected));

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
