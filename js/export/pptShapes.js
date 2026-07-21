/**
 * pptShapes.js — native (editable) vector shapes: leader lines, icon frames,
 * and the title underline bar. Every shape is validated before it is added so a
 * degenerate object is skipped, not emitted.
 */

import { validateBox } from './pptValidation.js';

/**
 * Add a leader line between two source-px points as a native line shape.
 * @param {object} slide pptxgenjs slide.
 * @param {{a:{x:number,y:number}, b:{x:number,y:number}, color:string}} leader
 * @param {{X:Function, Y:Function}} tf Coordinate transform.
 * @param {object} log Logger.
 * @param {Function} hex Colour normaliser (`hexColor`).
 * @returns {boolean} true when the line was added.
 */
export function addLeaderLine(slide, leader, tf, log, hex) {
  const x1 = tf.X(leader.a.x), y1 = tf.Y(leader.a.y);
  const x2 = tf.X(leader.b.x), y2 = tf.Y(leader.b.y);
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) { log.skip('leader', 'zero-length'); return false; }
  const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(dx), h: Math.abs(dy) };
  if (!validateBox(box, log, 'leader', { allowZeroAxis: true })) return false;
  slide.addShape('line', {
    ...box,
    flipH: (dx < 0) !== (dy < 0),
    line: { color: hex(leader.color), width: 0.75 },
  });
  return true;
}

/** Map an icon frame name to a pptxgenjs shape type + corner radius. */
function frameGeometry(frame) {
  if (frame === 'circle') return { shape: 'ellipse', radius: 0 };
  if (frame === 'square') return { shape: 'roundRect', radius: 0.02 };
  if (frame === 'rounded') return { shape: 'roundRect', radius: 0.16 };
  return { shape: 'roundRect', radius: 0.5 };
}

/**
 * Add the background frame behind an icon pin (skipped for frame `none`).
 * @param {object} slide pptxgenjs slide.
 * @param {{x:number,y:number,w:number,h:number,frame:string,bg:string,borderColor:string,border:number}} pin
 * @param {object} log Logger.
 * @param {Function} hex Colour normaliser.
 * @returns {boolean} true when a frame shape was added.
 */
export function addIconFrame(slide, pin, log, hex) {
  if (pin.frame === 'none') return false;
  if (!validateBox(pin, log, 'icon-frame')) return false;
  const { shape, radius } = frameGeometry(pin.frame);
  slide.addShape(shape, {
    x: pin.x, y: pin.y, w: pin.w, h: pin.h, rectRadius: radius,
    fill: { color: hex(pin.bg) },
    line: { color: hex(pin.borderColor), width: Math.max(0.5, pin.border) },
  });
  return true;
}

/**
 * Add the orange underline bar drawn under the title card.
 * @param {object} slide pptxgenjs slide.
 * @param {{x:number,y:number,w:number,h:number}} box Placement in inches.
 * @param {object} log Logger.
 * @param {string} [color] Bar colour hex (no `#`). Defaults to DBOT orange.
 * @returns {boolean} true when added.
 */
export function addTitleUnderline(slide, box, log, color = 'FF7A1A') {
  if (!validateBox(box, log, 'title-underline')) return false;
  slide.addShape('rect', { ...box, fill: { color } });
  return true;
}
