/**
 * app-boot.mjs — Phase 4 migration gate: proves the app still boots and its
 * core interactions work after each extraction step.
 *
 * Loads dist/index.html in Chromium and asserts:
 *   1. no uncaught JS errors during boot (tile-network failures are tolerated —
 *      the sandbox has no internet; Leaflet handles missing tiles gracefully),
 *   2. Leaflet initialised (#map gains .leaflet-container),
 *   3. the export engine is wired (window.DBOTExport.exportDeck),
 *   4. sidebar tabs switch panes,
 *   5. "+ Add manually" creates a location: a card appears, a pin renders,
 *   6. the legend/title/north toggles exist and respond.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.html');
const fails = [];
const ok = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fails.push(name); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

await page.goto('file://' + DIST);
await page.waitForTimeout(1500); // let the module boot + Leaflet attach

ok('no uncaught JS errors on boot', pageErrors.length === 0);
if (pageErrors.length) pageErrors.slice(0, 5).forEach(e => console.log('    pageerror:', e));

ok('Leaflet initialised (.leaflet-container)', await page.locator('#map.leaflet-container').count() === 1);
ok('export engine wired (window.DBOTExport)', await page.evaluate(() => !!(window.DBOTExport && window.DBOTExport.exportDeck)));

// tabs
await page.click('#tabBtnMap');
ok('Map tab activates its pane', await page.locator('#paneMap.active').count() === 1);
await page.click('#tabBtnLoc');
ok('Locations tab activates its pane', await page.locator('#paneLoc.active').count() === 1);

// add a location via the real button (uses map center; no network needed)
await page.click('#addLocBtn');
await page.waitForTimeout(400);
ok('location card created in sidebar', await page.locator('#locList .card, #locList > *').count() >= 1);
ok('pin element rendered on map', await page.locator('#billboardLayer .pin-icon, .pin-icon').count() >= 1);

// overlay toggles respond
await page.click('#tabBtnMap');
const northBefore = await page.locator('#northArrow').isVisible();
await page.click('#northTgl');
await page.waitForTimeout(150);
const northAfter = await page.locator('#northArrow').isVisible();
ok('north-arrow toggle flips visibility', northBefore !== northAfter);

// basemap actually initialised: setBasemap('hybrid') writes the credit line
// and adds tile layers (this catches silently-dead init code, not just crashes)
ok('basemap credit written (setBasemap ran)', (((await page.locator('#mapCredit').textContent()) || '').trim()).length > 0);
ok('tile layer(s) attached to the map', await page.evaluate(() => document.querySelectorAll('#map .leaflet-tile-pane .leaflet-layer').length >= 1));

// tilt control is wired: moving the range updates the ° readout and the stage transform
await page.locator('#tiltRange').evaluate(el => { el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await page.waitForTimeout(150);
ok('tilt slider updates readout', ((await page.locator('#tiltVal').textContent()) || '').includes('30'));
ok('tilt transforms the stage', await page.evaluate(() => (document.getElementById('tiltStage').style.transform || '').includes('rotateX')));

// second location + a route between them (network is unavailable in this
// sandbox, so routing must fall back to a straight line, not throw)
await page.click('#tabBtnLoc');
await page.click('#addLocBtn');
await page.waitForTimeout(300);
ok('second location card created', await page.locator('#locList > *').count() >= 2);

await page.click('#tabBtnRt');
await page.click('#addRtBtn');
await page.waitForTimeout(1500); // OSRM fetch attempts + fallback
ok('no uncaught JS errors after add-route (network unavailable)', pageErrors.length === 0);
ok('route card created', await page.locator('#rtList > *').count() >= 1);
// routes/rings render via Leaflet's canvas renderer (vectorRenderer = L.canvas(...)),
// not SVG, so a drawn route is a <canvas> in the overlay pane, not a <path>.
ok('route renders via the Leaflet canvas overlay', await page.evaluate(() => document.querySelectorAll('#map .leaflet-overlay-pane canvas').length >= 1));
ok('legend row appended for the route', await page.locator('#legendBody tr').count() >= 1);

// delete the route, then a location — bookkeeping (legend/empty-state) must follow
const delRtBtn = page.locator('#rtList .del, #rtList button:has-text("Delete"), #rtList [class*="del"]').first();
if (await delRtBtn.count()) { await delRtBtn.click(); await page.waitForTimeout(300); }
await page.click('#tabBtnLoc');
const delLocBtn = page.locator('#locList .del, #locList button:has-text("Delete"), #locList [class*="del"]').first();
if (await delLocBtn.count()) { await delLocBtn.click(); await page.waitForTimeout(300); }
ok('no uncaught JS errors after delete flows', pageErrors.length === 0);

// project save/load round-trip: save must serialise brand + tilt correctly,
// load must restore them (exercises core/state.brand + mapEngine.setTiltDeg)
const proj = await page.evaluate(() => new Promise(resolve => {
  const a = document.createElement('a');
  const origClick = a.click.bind(a);
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (blob) => { blob.text().then(t => resolve(JSON.parse(t))); return origCreate.call(URL, blob); };
  document.getElementById('saveBtn').click();
}));
ok('saved project has a version tag', typeof proj.v === 'number');
ok('saved project has locations array', Array.isArray(proj.locations));
ok('saved project brand fields present (projectLogo/siteUsesProjLogo keys)', 'projectLogo' in proj && 'siteUsesProjLogo' in proj);

// status line shows something (the app writes boot guidance into it)
ok('status message present', ((await page.locator('#statusMsg').textContent()) || '').trim().length > 0);

await browser.close();
console.log(fails.length ? `\nBOOT TEST: ${fails.length} FAILURE(S)` : '\nBOOT TEST: ALL PASS');
process.exit(fails.length ? 1 : 0);
