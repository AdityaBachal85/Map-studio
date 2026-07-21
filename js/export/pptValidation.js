/**
 * pptValidation.js — gate-keeping for the PPTX export engine.
 *
 * Two responsibilities:
 *  1. Validate every object *before* it is added to a slide. Anything invalid
 *     (NaN/negative/zero geometry, missing image data, empty text) is rejected
 *     and logged with a reason, so one bad object can never corrupt the deck.
 *  2. Repair the one defect pptxgenjs itself gets wrong — duplicate
 *     `<p:cNvPr id>` values — via {@link ensureUniqueShapeIds}.
 */

import JSZip from 'jszip';
import { isFiniteNumber } from './pptUtils.js';

/** Generous absolute bound (inches) for slide coordinates; guards EMU overflow. */
const MAX_IN = 100;

/**
 * Validate a rectangular placement in slide inches.
 * @param {{x:number,y:number,w:number,h:number}} box
 * @param {object} log A {@link makeLogger} instance.
 * @param {string} kind Label for the log entry.
 * @param {{allowZeroAxis?:boolean}} [opts] When set, permits w OR h (not both)
 *        to be 0 — used by axis-aligned line shapes.
 * @returns {boolean} true when the box is safe to add.
 */
export function validateBox(box, log, kind, opts = {}) {
  const { x, y, w, h } = box || {};
  for (const [k, v] of Object.entries({ x, y, w, h })) {
    if (!isFiniteNumber(v)) { log.skip(kind, `non-finite ${k}`, box); return false; }
    if (Math.abs(v) > MAX_IN) { log.skip(kind, `${k} out of bounds (${v})`, box); return false; }
  }
  if (w < 0 || h < 0) { log.skip(kind, 'negative width/height', box); return false; }
  if (opts.allowZeroAxis) {
    if (w === 0 && h === 0) { log.skip(kind, 'zero-area line', box); return false; }
  } else if (w === 0 || h === 0) {
    log.skip(kind, 'zero width/height', box); return false;
  }
  return true;
}

/**
 * Validate an image placement (background map, icon, logo).
 * @returns {boolean} true when safe to add.
 */
export function validateImage(img, log, kind = 'image') {
  if (!img || typeof img.data !== 'string' || !img.data) {
    log.skip(kind, 'missing image data'); return false;
  }
  if (!/^data:image\/(png|jpe?g|gif|svg\+xml);base64,/.test(img.data)) {
    log.skip(kind, 'unrecognised image data URL'); return false;
  }
  return validateBox(img, log, kind);
}

/**
 * Validate a text object. Coerces `text` to a non-empty string.
 * @returns {boolean} true when safe to add.
 */
export function validateText(t, log, kind = 'text') {
  const text = t == null ? '' : String(t.text);
  if (!text.trim()) { log.skip(kind, 'empty text'); return false; }
  return validateBox(t, log, kind);
}

/**
 * Validate the legend spec and confirm its column widths sum to the table
 * width (the defect class the diagnosis flagged for tables).
 * @returns {boolean} true when the table is safe to add.
 */
export function validateTable(spec, log, kind = 'table') {
  if (!spec || !Array.isArray(spec.rows) || spec.rows.length === 0) {
    log.skip(kind, 'no rows'); return false;
  }
  if (!validateBox({ x: spec.x, y: spec.y, w: spec.w, h: spec.h || 0.1 }, log, kind)) return false;
  const sum = (spec.colW || []).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - spec.w) > 0.02) {
    log.skip(kind, `column widths ${sum.toFixed(3)} != table width ${spec.w.toFixed(3)}`);
    return false;
  }
  return true;
}

/**
 * THE NAMED EXCEPTION to "no ZIP post-processing".
 *
 * pptxgenjs (verified in 3.12.0 and 4.0.1) numbers table graphic-frames from a
 * different counter than shapes/images, so a slide containing both an image and
 * a table emits two shapes with the same `<p:cNvPr id="2">`. Duplicate cNvPr
 * ids are schema-well-formed — xmllint and python-pptx accept them — but make
 * PowerPoint 365 throw the repair dialog. The library exposes no hook to fix
 * the id, so we do the minimal thing: reopen the finished package and renumber
 * every slide's `cNvPr` ids to a unique sequence (group stays id=1). No other
 * bytes are touched.
 *
 * @param {ArrayBuffer|Uint8Array|Buffer} data Raw pptxgenjs output.
 * @param {{outputType?: 'arraybuffer'|'nodebuffer'|'uint8array'|'blob'}} [opts]
 * @returns {Promise<*>} The repaired package in the requested `outputType`.
 */
export async function ensureUniqueShapeIds(data, opts = {}) {
  const outputType = opts.outputType || 'arraybuffer';
  const zip = await JSZip.loadAsync(data);
  const slidePaths = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  for (const p of slidePaths) {
    let xml = await zip.file(p).async('string');
    let next = 1; // the spTree group's cNvPr appears first and keeps id=1
    xml = xml.replace(/(<p:cNvPr id=")(\d+)(")/g, (_m, a, _id, c) => a + next++ + c);
    zip.file(p, xml);
  }
  return zip.generateAsync({ type: outputType, compression: 'DEFLATE', mimeType: PPTX_MIME });
}

/** MIME type for a .pptx package. */
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * Cheap structural audit used by tests: parse each slide's `cNvPr` ids and
 * report duplicates. Uses a regex (no XML DOM) so it runs anywhere.
 * @param {string} slideXml Raw slide XML.
 * @returns {{ids:string[], duplicates:string[]}}
 */
export function auditShapeIds(slideXml) {
  const ids = [...slideXml.matchAll(/<p:cNvPr id="(\d+)"/g)].map(m => m[1]);
  const seen = new Set(), dup = new Set();
  for (const id of ids) { if (seen.has(id)) dup.add(id); else seen.add(id); }
  return { ids, duplicates: [...dup] };
}
