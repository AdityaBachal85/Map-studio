/**
 * demo.mjs — builds ONE visible, fully-composed demo deck (demo-map.pptx) with a
 * real map-like background image, so a human can confirm the engine renders the
 * whole layout (map + pins + labels + title + legend + logo) and opens clean in
 * PowerPoint 365. This is the "full composed layout" step made visible.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exportDeck } from '../../js/export/exportPPT.js';
import { makeMapPngDataUrl } from './makeMapPng.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP = makeMapPngDataUrl(1200, 495);
const SVG = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7z" fill="#FF7A1A"/><circle cx="12" cy="9" r="2.6" fill="#fff"/></svg>', 'utf8').toString('base64');
const LOGO = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><rect width="200" height="80" fill="#0A1E3C"/><text x="100" y="50" font-family="Arial" font-size="34" font-weight="bold" fill="#fff" text-anchor="middle">DBOT</text></svg>', 'utf8').toString('base64');

const pin = (x, y, frame, iconData, color) => ({ px: { x, y }, size: 44, frame, bg: '#FFFFFF', border: 1.5, borderColor: color, iconData, isImage: false });

const spec = {
  fileName: 'demo-map.pptx', author: 'DBOT · Property Map Studio',
  geometry: { wrapW: 1200, wrapH: 495, chipFont: 11.5 },
  slide: {
    background: '0A1E3C', map: { data: MAP },
    leaders: [
      { a: { x: 470, y: 210 }, b: { x: 560, y: 130 }, color: '#FF7A1A' },
      { a: { x: 300, y: 250 }, b: { x: 250, y: 330 }, color: '#2E6BE6' },
      { a: { x: 720, y: 250 }, b: { x: 820, y: 330 }, color: '#22A06B' },
    ],
    pins: [
      pin(470, 220, 'circle', SVG, '#FF7A1A'),
      pin(300, 260, 'rounded', SVG, '#2E6BE6'),
      pin(720, 260, 'square', SVG, '#22A06B'),
    ],
    locationLabels: [
      { px: { x: 500, y: 110 }, text: 'THE PROPERTY', site: true, bg: '#0A1E3C' },
      { px: { x: 175, y: 335 }, text: 'Smith & Sons Depot', site: false, bg: '#FFFFFF' },
      { px: { x: 760, y: 335 }, text: "O'Hare Terminal", site: false, bg: '#FFFFFF' },
    ],
    routeLabels: [{ px: { x: 560, y: 90 }, text: 'I-95 & Route 1', bg: '#FFFFFF' }],
    badges: [{ px: { x: 640, y: 200 }, text: 'A', color: '#FF7A1A' }],
    rings: [{ px: { x: 900, y: 160 }, text: '10 min drive', color: '#22A06B' }],
    title: { visible: true, text: 'PROPERTY LOCATION & ACCESS' },
    legend: { visible: true, title: 'KEY DISTANCES', pxLeft: 24, pxTop: 60, pxWidth: 250, rows: [
      { color: '#FF7A1A', name: 'Downtown Core', km: '4.2 km', min: '9 min' },
      { color: '#2E6BE6', name: 'Intl. Airport', km: '18.1 km', min: '22 min' },
      { color: '#22A06B', name: 'Regional Park', km: '2.6 km', min: '6 min' },
    ] },
    logo: { visible: true, data: LOGO, aspect: 0.4 },
  },
};

const { data } = await exportDeck(spec, { output: 'nodebuffer' });
await writeFile(join(HERE, 'fixtures', 'demo-map.pptx'), data);
console.log('wrote fixtures/demo-map.pptx');
