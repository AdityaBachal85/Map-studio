/**
 * pptImages.js — raster/vector image placement: the background map capture,
 * icon pins (a frame shape plus the icon glyph), and the brand logo. Icons stay
 * editable: the frame is a native shape and the glyph is an embedded image, so
 * nothing is flattened into the map picture.
 */

import { validateImage } from './pptValidation.js';
import { addIconFrame } from './pptShapes.js';

/**
 * Add the letterboxed background map image.
 * @param {object} slide pptxgenjs slide.
 * @param {{data:string, x:number, y:number, w:number, h:number}} img
 * @param {object} log Logger.
 * @returns {boolean} true when added.
 */
export function addBackground(slide, img, log) {
  if (!validateImage(img, log, 'background')) return false;
  slide.addImage({ data: img.data, x: img.x, y: img.y, w: img.w, h: img.h });
  return true;
}

/**
 * Add one icon pin: optional frame shape plus the padded icon glyph. Positions
 * are computed from the pin's bottom-centre anchor, matching the v4.9 layout.
 * @param {object} slide pptxgenjs slide.
 * @param {{px:{x:number,y:number}, size:number, frame:string, bg:string,
 *   border:number, borderColor:string, iconData:string, isImage:boolean}} pin
 * @param {{X:Function, Y:Function, rr:number}} tf Transform (+ px→inch ratio).
 * @param {object} log Logger.
 * @param {Function} hex Colour normaliser.
 * @returns {boolean} true when the glyph image was added.
 */
export function addIconPin(slide, pin, tf, log, hex) {
  const inSize = pin.size * tf.rr;
  const cx = tf.X(pin.px.x), cy = tf.Y(pin.px.y);
  const bx = cx - inSize / 2, by = cy - inSize; // bottom-centre anchor
  const box = { x: bx, y: by, w: inSize, h: inSize };
  const glyph = { data: pin.iconData };

  if (pin.frame === 'none') {
    Object.assign(glyph, box);
    if (!validateImage(glyph, log, 'icon')) return false;
    slide.addImage(glyph);
    return true;
  }
  addIconFrame(slide, { ...box, frame: pin.frame, bg: pin.bg, border: pin.border, borderColor: pin.borderColor }, log, hex);
  const pad = inSize * (pin.isImage ? 0.11 : 0.17);
  Object.assign(glyph, { x: bx + pad, y: by + pad, w: inSize - pad * 2, h: inSize - pad * 2 });
  if (!validateImage(glyph, log, 'icon')) return false;
  slide.addImage(glyph);
  return true;
}

/**
 * Add the brand logo inside a white rounded card, bottom-right.
 * @param {object} slide pptxgenjs slide.
 * @param {{data:string, x:number, y:number, w:number, h:number,
 *   card:{x:number,y:number,w:number,h:number}}} logo
 * @param {object} log Logger.
 * @param {Function} hex Colour normaliser.
 * @returns {boolean} true when the logo image was added.
 */
export function addLogo(slide, logo, log, hex) {
  if (!validateImage(logo, log, 'logo')) return false;
  const c = logo.card;
  slide.addShape('roundRect', {
    x: c.x, y: c.y, w: c.w, h: c.h, rectRadius: 0.06,
    fill: { color: 'FFFFFF' }, line: { color: 'E5EAF1', width: 0.5 },
  });
  slide.addImage({ data: logo.data, x: logo.x, y: logo.y, w: logo.w, h: logo.h });
  return true;
}
