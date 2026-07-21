/**
 * pptLabels.js — all editable text: location & route label chips, badges,
 * ring-distance chips, and the title card. Each is a real PowerPoint text box
 * (with a rounded-rectangle background) so the recipient can retype it.
 */

import { validateText } from './pptValidation.js';
import { addTitleUnderline } from './pptShapes.js';

/**
 * Add a rounded text chip. Shared by every label variant.
 * @param {object} slide pptxgenjs slide.
 * @param {object} chip Fully-resolved chip: `{text,x,y,w,h,fill,line,color,fontSize,bold,rectRadius,charSpacing}`.
 * @param {object} log Logger.
 * @returns {boolean} true when added.
 */
function addTextChip(slide, chip, log, kind) {
  if (!validateText(chip, log, kind)) return false;
  slide.addText(String(chip.text), {
    x: chip.x, y: chip.y, w: chip.w, h: chip.h,
    shape: 'roundRect', rectRadius: chip.rectRadius,
    fill: chip.fill, line: chip.line,
    color: chip.color, fontSize: chip.fontSize, bold: !!chip.bold,
    fontFace: 'Arial', align: 'center', valign: 'middle', margin: 0.02,
    charSpacing: chip.charSpacing,
  });
  return true;
}

/**
 * Add a location label chip (site labels are one point larger).
 * @param {object} slide
 * @param {{px:{x:number,y:number}, text:string, site:boolean, bg:string}} w
 * @param {object} ctx Build context `{tf, hex, textOn, chipFont, chipWidth}`.
 * @param {object} log
 * @returns {boolean}
 */
export function addLocationLabel(slide, w, ctx, log) {
  const px = w.site ? ctx.chipFont + 1 : ctx.chipFont, pt = ctx.tf.pt(px);
  return addTextChip(slide, {
    text: w.text, x: ctx.tf.X(w.px.x), y: ctx.tf.Y(w.px.y),
    w: ctx.chipWidth(w.text, px, true), h: pt * 2.1 / 72, rectRadius: 0.5,
    fill: { color: ctx.hex(w.bg) }, line: { type: 'none' },
    color: ctx.textOn(w.bg), fontSize: pt, bold: true,
  }, log, 'location-label');
}

/**
 * Add a route label chip.
 * @param {object} slide
 * @param {{px:{x:number,y:number}, text:string, bg:string}} w
 * @param {object} ctx @param {object} log @returns {boolean}
 */
export function addRouteLabel(slide, w, ctx, log) {
  const px = ctx.chipFont - 1, pt = ctx.tf.pt(px);
  return addTextChip(slide, {
    text: w.text, x: ctx.tf.X(w.px.x), y: ctx.tf.Y(w.px.y),
    w: ctx.chipWidth(w.text, px, true), h: pt * 2.1 / 72, rectRadius: 0.5,
    fill: { color: ctx.hex(w.bg) }, line: { type: 'none' },
    color: ctx.textOn(w.bg), fontSize: pt, bold: true,
  }, log, 'route-label');
}

/**
 * Add a badge chip (centred on its anchor).
 * @param {object} slide
 * @param {{px:{x:number,y:number}, text:string, color:string}} w
 * @param {object} ctx @param {object} log @returns {boolean}
 */
export function addBadge(slide, w, ctx, log) {
  const pt = ctx.tf.pt(11);
  const bw = ctx.chipWidth(w.text, 11, true), bh = pt * 2.2 / 72;
  return addTextChip(slide, {
    text: w.text, x: ctx.tf.X(w.px.x) - bw / 2, y: ctx.tf.Y(w.px.y) - bh / 2,
    w: bw, h: bh, rectRadius: 0.05,
    fill: { color: ctx.hex(w.color) }, line: { color: 'FFFFFF', width: 1.5 },
    color: '111111', fontSize: pt, bold: true,
  }, log, 'badge');
}

/**
 * Add a ring-distance chip (white pill, coloured outline).
 * @param {object} slide
 * @param {{px:{x:number,y:number}, text:string, color:string}} w
 * @param {object} ctx @param {object} log @returns {boolean}
 */
export function addRingLabel(slide, w, ctx, log) {
  const px = ctx.chipFont - 2, pt = ctx.tf.pt(px);
  return addTextChip(slide, {
    text: w.text, x: ctx.tf.X(w.px.x), y: ctx.tf.Y(w.px.y),
    w: ctx.chipWidth(w.text, px, false), h: pt * 2 / 72, rectRadius: 0.5,
    fill: { color: 'FFFFFF' }, line: { color: ctx.hex(w.color), width: 0.75 },
    color: '17202B', fontSize: pt, bold: false,
  }, log, 'ring-label');
}

/**
 * Add the title card and its underline bar.
 * @param {object} slide
 * @param {{text:string}} title
 * @param {object} ctx Build context (also uses `ctx.slideW` and `ctx.fit.offY`).
 * @param {object} log
 * @returns {boolean} true when the title text was added.
 */
export function addTitle(slide, title, ctx, log) {
  const tw = Math.max(3.4, ctx.chipWidth(title.text, 15, true) + 0.5), th = 0.44;
  const tx = (ctx.slideW - tw) / 2, ty = ctx.fit.offY + 0.12;
  const ok = addTextChip(slide, {
    text: title.text, x: tx, y: ty, w: tw, h: th, rectRadius: 0.05,
    fill: { color: '0A1E3C' }, line: { type: 'none' },
    color: 'FFFFFF', fontSize: 16, bold: true, charSpacing: 1,
  }, log, 'title');
  if (ok) addTitleUnderline(slide, { x: tx + 0.08, y: ty + th - 0.045, w: tw - 0.16, h: 0.045 }, log);
  return ok;
}
