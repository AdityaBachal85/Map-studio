/**
 * pptTables.js — the "KEY DISTANCES" legend, rendered as a native PowerPoint
 * table (a coloured swatch column + name/distance/time columns) with a header
 * bar above it. Column widths are computed to sum exactly to the table width,
 * and the whole thing is validated before it is added.
 */

import { validateTable } from './pptValidation.js';

/**
 * Add the legend header bar and distance table.
 * @param {object} slide pptxgenjs slide.
 * @param {{title:string, rows:Array<{color:string,name:string,km:string,min:string}>,
 *   pxLeft:number, pxTop:number, pxWidth:number}} legend
 * @param {{tf:{X:Function,Y:Function,rr:number}, hex:Function}} ctx
 * @param {object} log Logger.
 * @returns {boolean} true when the table was added.
 */
export function addLegend(slide, legend, ctx, log) {
  const { tf, hex } = ctx;
  const lx = tf.X(legend.pxLeft), ly = tf.Y(legend.pxTop);
  const lw = Math.max(2.3, legend.pxWidth * tf.rr);
  const colW = [0.16, lw - 0.16 - 0.62 - 0.55, 0.62, 0.55];

  if (!validateTable({ x: lx, y: ly + 0.3, w: lw, colW, rows: legend.rows }, log, 'legend')) return false;

  slide.addText(String(legend.title || 'KEY DISTANCES'), {
    x: lx, y: ly, w: lw, h: 0.3,
    fill: { color: '0A1E3C' }, color: 'FFFFFF', bold: true, fontSize: 9.5,
    fontFace: 'Arial', align: 'left', valign: 'middle', charSpacing: 2, margin: 0.06,
  });

  const rows = legend.rows.map(r => ([
    { text: '', options: { fill: { color: hex(r.color) } } },
    { text: String(r.name ?? ''), options: { align: 'left' } },
    { text: String(r.km ?? ''), options: { align: 'right' } },
    { text: String(r.min ?? ''), options: { align: 'right' } },
  ]));

  slide.addTable(rows, {
    x: lx, y: ly + 0.3, w: lw, colW,
    fontFace: 'Arial', fontSize: 8.5, color: '17202B',
    fill: { color: 'FFFFFF' }, border: { pt: 0.5, color: 'E5EAF1' },
    rowH: 0.22, valign: 'middle', margin: 0.04,
  });
  return true;
}
