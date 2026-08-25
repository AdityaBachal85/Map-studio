/**
 * When the depth probe backs all the way down to its floor and STILL sees
 * placeholders — a spot with no real Esri coverage even at the shallowest
 * depth it will settle for — the map used to say nothing about it anywhere
 * but a `console.warn`. Someone without devtools open just saw a wall of
 * "Map data not yet available" with no way to tell a real service limit from
 * a broken app.
 *
 * Same fake-tile rig as imagery-depth.cjs, but with the pretend coverage
 * pushed below the probe's own floor (z17) so it never finds real imagery to
 * settle on and has to give up.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/imagery-depth-floor.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { png } = require(path.join(__dirname, 'fake-tile-png.cjs'));

const BASE = 'http://127.0.0.1:8000';
const REPO = path.join(__dirname, '..');
const localAuthConfig = () => fs.readFileSync(path.join(REPO, 'js', 'config.js'), 'utf8')
  .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = '';")
  .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = '';");

// Below the probe's floor of max(17, declaredMaxNative - 4) = 17 for the
// World_Imagery layer (declared maxNative 20) — so no depth it will ever try
// has real imagery, and it has to reach the floor and give up.
const PLACEHOLDER = png(198, 200, 222);

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

(async () => {
  const b = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));

  await p.route('**', r => {
    const u = r.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
    const m = u.match(/\/tile\/(\d+)\/(\d+)\/(\d+)/);
    if (m) {
      // Every zoom is the placeholder — this service has nothing, anywhere.
      return r.fulfill({
        status: 200, contentType: 'image/png', body: PLACEHOLDER,
        headers: { 'access-control-allow-origin': '*' },
      });
    }
    return r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  await p.addInitScript(() => localStorage.setItem('dbotMapStudioPrefs.v1', JSON.stringify({
    layout: 'satellite', basemap: 'hybrid', theme: 'light',
  })));
  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);

  await p.evaluate(() => map.setView([19.10, 72.88], 20, { animate: false }));
  // Each step needs two flat tile loads and a redraw; walking from z20 down
  // to the z17 floor is a handful of such cycles.
  await p.waitForTimeout(9000);

  const result = await p.evaluate(() => ({
    depth: activeBase[0].options.maxNativeZoom,
    statusText: document.getElementById('statusMsg').textContent,
  }));
  ck('the probe reaches its floor rather than climbing back up on its own',
    result.depth <= 17, JSON.stringify(result));
  ck('and says so on screen — not just to a console nobody but a developer sees',
    /imagery/i.test(result.statusText) && /zoom out/i.test(result.statusText),
    JSON.stringify(result.statusText));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
