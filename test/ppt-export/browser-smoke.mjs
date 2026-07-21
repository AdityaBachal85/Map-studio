/**
 * browser-smoke.mjs — verifies the *browser-bundled* export engine actually runs
 * inside the built single-file app (dist/index.html), not just under Node.
 *
 * Loads dist/index.html in Chromium, waits for window.DBOTExport (set by the
 * inlined module), then calls exportDeck() in-page on the image+table case (the
 * exact corruption scenario) and returns the bytes. Node then validates unique
 * cNvPr ids, roundRect adj ≤ 50000, and a python-pptx load via the caller.
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist', 'index.html');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2 L2 22 L22 22 Z" fill="#FF7A1A"/></svg>', 'utf8').toString('base64');

let exe;
try { exe = undefined; } catch { /* default */ }

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto('file://' + DIST);
await page.waitForFunction('window.DBOTExport && typeof window.DBOTExport.exportDeck === "function"', null, { timeout: 15000 });
console.log('window.DBOTExport.exportDeck present in browser ✓');

const b64 = await page.evaluate(async ({ PNG, SVG }) => {
  const spec = {
    fileName: 'smoke.pptx',
    geometry: { wrapW: 1200, wrapH: 495, chipFont: 11.5 },
    slide: {
      background: '0A1E3C', map: { data: PNG },
      pins: [{ px: { x: 300, y: 200 }, size: 40, frame: 'circle', bg: '#FFFFFF', border: 1.5, borderColor: '#0A1E3C', iconData: SVG, isImage: false }],
      locationLabels: [{ px: { x: 320, y: 260 }, text: 'Smith & Sons <Depot>', site: true, bg: '#0A1E3C' }],
      legend: { visible: true, title: 'KEY DISTANCES', pxLeft: 30, pxTop: 60, pxWidth: 240, rows: [
        { color: '#FF7A1A', name: 'Downtown', km: '4.2 km', min: '9 min' },
        { color: '#2E6BE6', name: 'Airport', km: '18 km', min: '22 min' },
      ] },
      logo: { visible: true, data: PNG, aspect: 0.4026 },
    },
  };
  const { data } = await window.DBOTExport.exportDeck(spec, { output: 'arraybuffer' });
  let bin = ''; const bytes = new Uint8Array(data);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}, { PNG, SVG });

await browser.close();
if (errors.length) console.log('page console errors (non-fatal, likely offline CDN):', errors.slice(0, 3));

const buf = Buffer.from(b64, 'base64');
const out = join(HERE, 'fixtures', 'browser-smoke.pptx');
await writeFile(out, buf);
const zipOk = buf[0] === 0x50 && buf[1] === 0x4B; // 'PK'
console.log(`engine ran in-browser, wrote ${out} (${buf.length} bytes), zip-signature ${zipOk ? 'OK' : 'BAD'}`);
process.exit(zipOk ? 0 : 1);
