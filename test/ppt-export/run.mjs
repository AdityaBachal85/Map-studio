/**
 * run.mjs — Phase 1 standalone test harness for the PPTX export engine.
 *
 * Builds the five incremental decks the build plan calls for, in order:
 *   1. one text box only
 *   2. + shapes (leader lines)
 *   3. + images (background map + icon pins)
 *   4. + a table (legend)
 *   5. the full composed layout
 *
 * For each deck it writes a .pptx into fixtures/ and runs the automated checks
 * we *can* do headlessly (unique cNvPr ids, JSZip round-trip, skipped-object
 * log). The one check no script can do — "opens in real PowerPoint 365 with no
 * repair" — is left to a human; these files exist so that test is one open away.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import { exportDeck } from '../../js/export/exportPPT.js';
import { auditShapeIds } from '../../js/export/pptValidation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'fixtures');

// tiny valid assets (stand-ins for the map capture / logo / image icon)
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2 L2 22 L22 22 Z" fill="#FF7A1A"/></svg>', 'utf8').toString('base64');

const geometry = { wrapW: 1200, wrapH: 495, chipFont: 11.5 };

const label = (x, y, text, site, bg) => ({ px: { x, y }, text, site, bg });
const pin = (x, y, frame, iconData, isImage) => ({
  px: { x, y }, size: 40, frame, bg: '#FFFFFF', border: 1.5, borderColor: '#0A1E3C', iconData, isImage });

/** The five incremental decks. Each returns a full spec. */
const decks = {
  '1-text': { fileName: '1-text.pptx', geometry, slide: {
    background: '0A1E3C',
    locationLabels: [label(300, 220, 'Single Text Box', true, '#0A1E3C')],
  } },

  '2-shapes': { fileName: '2-shapes.pptx', geometry, slide: {
    background: '0A1E3C',
    leaders: [
      { a: { x: 100, y: 100 }, b: { x: 300, y: 240 }, color: '#FF7A1A' },
      { a: { x: 400, y: 120 }, b: { x: 400, y: 260 }, color: '#2E6BE6' }, // vertical
      { a: { x: 500, y: 200 }, b: { x: 700, y: 200 }, color: '#22A06B' }, // horizontal
    ],
    locationLabels: [label(300, 260, 'Shapes + Text', false, '#FFFFFF')],
  } },

  '3-images': { fileName: '3-images.pptx', geometry, slide: {
    background: '0A1E3C', map: { data: PNG },
    pins: [pin(200, 200, 'none', SVG, false), pin(300, 200, 'circle', SVG, false),
      pin(400, 200, 'rounded', SVG, false), pin(500, 200, 'square', PNG, true)],
    locationLabels: [label(300, 300, 'Images + Text', false, '#FFFFFF')],
  } },

  '4-tables': { fileName: '4-tables.pptx', geometry, slide: {
    background: '0A1E3C', map: { data: PNG },
    legend: { visible: true, title: 'KEY DISTANCES', pxLeft: 30, pxTop: 60, pxWidth: 240, rows: [
      { color: '#FF7A1A', name: 'Downtown', km: '4.2 km', min: '9 min' },
      { color: '#2E6BE6', name: 'Airport', km: '18 km', min: '22 min' },
    ] },
  } },

  '5-full': { fileName: '5-full.pptx', author: 'DBOT · Property Map Studio', geometry, slide: {
    background: '0A1E3C', map: { data: PNG },
    leaders: [{ a: { x: 210, y: 180 }, b: { x: 320, y: 300 }, color: '#FF7A1A' }],
    pins: [pin(210, 190, 'circle', SVG, false), pin(360, 210, 'rounded', PNG, true)],
    locationLabels: [label(320, 300, "Smith & Sons <Depot>", true, '#0A1E3C'),
      label(500, 260, "O'Hare Terminal", false, '#FFFFFF')],
    routeLabels: [{ px: { x: 600, y: 330 }, text: 'I-95 & Route 1', bg: '#FFFFFF' }],
    badges: [{ px: { x: 700, y: 260 }, text: 'A', color: '#FF7A1A' }],
    rings: [{ px: { x: 820, y: 200 }, text: '5 min', color: '#22A06B' }],
    title: { visible: true, text: 'PROPERTY LOCATION & ACCESS' },
    legend: { visible: true, title: 'KEY DISTANCES', pxLeft: 30, pxTop: 60, pxWidth: 240, rows: [
      { color: '#FF7A1A', name: 'Downtown', km: '4.2 km', min: '9 min' },
      { color: '#2E6BE6', name: 'Airport', km: '18 km', min: '22 min' },
    ] },
    logo: { visible: true, data: PNG, aspect: 0.4026 },
  } },
};

/** Reload a written deck and confirm every slide has unique cNvPr ids. */
async function auditFile(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  const dups = [];
  for (const p of slides) dups.push(...auditShapeIds(await zip.file(p).async('string')).duplicates);
  return { slideCount: slides.length, duplicates: dups };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  let allPass = true;
  for (const [name, spec] of Object.entries(decks)) {
    const { data, log } = await exportDeck(spec, { output: 'nodebuffer' });
    const path = join(OUT, spec.fileName);
    await writeFile(path, data);
    const audit = await auditFile(data);
    const pass = audit.duplicates.length === 0 && audit.slideCount === 1;
    allPass = allPass && pass;
    console.log(`\n[${name}] -> ${spec.fileName}`);
    console.log(`  slides: ${audit.slideCount}  duplicate ids: ${audit.duplicates.length ? audit.duplicates.join(',') : 'NONE'}  ${pass ? 'PASS' : 'FAIL'}`);
    if (log.skipped) log.entries.filter(e => e.level === 'skip').forEach(e => console.log(`  skipped ${e.kind}: ${e.reason}`));
  }
  console.log(`\n${allPass ? 'ALL AUTOMATED CHECKS PASS' : 'SOME CHECKS FAILED'} — now open fixtures/*.pptx in real PowerPoint 365.`);
  process.exit(allPass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
