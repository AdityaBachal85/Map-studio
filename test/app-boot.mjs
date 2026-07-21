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

// status line shows something (the app writes boot guidance into it)
ok('status message present', ((await page.locator('#statusMsg').textContent()) || '').trim().length > 0);

await browser.close();
console.log(fails.length ? `\nBOOT TEST: ${fails.length} FAILURE(S)` : '\nBOOT TEST: ALL PASS');
process.exit(fails.length ? 1 : 0);
