/**
 * pptTables.js — the "KEY DISTANCES" legend, rendered as a native PowerPoint
 * table (a coloured swatch column + name/distance/time columns) with a header
 * bar above it. Column widths are computed to sum exactly to the table width,
 * and the whole thing is validated before it is added.
 */

/**
 * Add the legend header bar and distance table.
 * @param {object} slide pptxgenjs slide.
 * @param {{title:string, rows:Array<{color:string,name:string,km:string,min:string}>,
 *   pxLeft:number, pxTop:number, pxWidth:number}} legend
 * @param {{tf:{X:Function,Y:Function,rr:number}, hex:Function}} ctx
 * @param {object} log Logger.
 * @returns {boolean} true when the table was added.
 */
function addLegend(slide, legend, ctx, log) {
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

  // A coloured bullet, not a filled cell. On screen this column is a round dot;
  // as a fill it became a solid block the height of the row, which is the single
  // biggest reason the exported card did not look like the card. A glyph also
  // travels inside the table, so it cannot come adrift when the table is moved
  // in PowerPoint — which is what a floating shape would do.
  const rows = legend.rows.map(r => ([
    { text: '●', options: { color: hex(r.color), fontSize: 11, align: 'center' } },
    { text: String(r.name ?? ''), options: { align: 'left' } },
    { text: String(r.km ?? ''), options: { align: 'right' } },
    { text: String(r.min ?? ''), options: { align: 'right' } },
  ]));

  slide.addTable(rows, {
    x: lx, y: ly + 0.3, w: lw, colW,
    fontFace: 'Arial', fontSize: 8.5, color: '17202B',
    // No grid. The card on screen separates rows with white space, and the
    // ruled lines were what made the export read as a spreadsheet.
    fill: { color: 'FFFFFF' }, border: { type: 'none' },
    rowH: 0.22, valign: 'middle', margin: 0.04,
  });
  return true;
}

/**
 * Add the colour key: what each colour on the map means.
 *
 * A table like the distances legend rather than free shapes, so the swatch
 * column stays aligned with its labels when somebody drags the whole thing
 * around in PowerPoint — which is the point of exporting it natively instead of
 * baking it into the background picture.
 *
 * The swatch is a filled cell in every case. Reproducing the on-screen
 * distinction between a line, a block and a dot would need three shapes
 * floating over a table, and floating shapes come adrift the moment the table
 * is moved or the row heights reflow — the colour is what the key is for, and a
 * key that survives being repositioned beats one that is prettier until touched.
 *
 * @param {object} slide pptxgenjs slide.
 * @param {{title:string, rows:Array<{color:string,label:string}>,
 *   pxLeft:number, pxTop:number, pxWidth:number}} key
 * @param {{tf:{X:Function,Y:Function,rr:number}, hex:Function}} ctx
 * @param {object} log Logger.
 * @returns {boolean} true when it was added.
 */
function addColorKey(slide, key, ctx, log) {
  const { tf, hex } = ctx;
  if (!key || !key.rows || !key.rows.length) return false;
  const lx = tf.X(key.pxLeft), ly = tf.Y(key.pxTop);
  const lw = Math.max(1.7, key.pxWidth * tf.rr);
  const colW = [0.22, lw - 0.22];

  if (!validateTable({ x: lx, y: ly + 0.3, w: lw, colW, rows: key.rows }, log, 'colorKey')) return false;

  slide.addText(String(key.title || 'LEGEND'), {
    x: lx, y: ly, w: lw, h: 0.3,
    fill: { color: '0A1E3C' }, color: 'FFFFFF', bold: true, fontSize: 9.5,
    fontFace: 'Arial', align: 'left', valign: 'middle', charSpacing: 2, margin: 0.06,
  });

  // The mark carries the same distinction the card does: a bar for a line
  // class, a dot for a point, a square for an area. "The red line" and "the red
  // block" are different things on the map, and a legend that renders both as
  // the same filled cell throws that away.
  // A row that was given its own symbol uses it; one that was not falls back to
  // what its kind implies, exactly as it always did. The characters are the
  // same set the card offers — see CK_SHAPES in js/ui/colorKey.js — because a
  // second list here is a second list to forget to update.
  const SHAPE = { line: '▬', dash: '▬', area: '▬', dot: '●', ring: '○',
    square: '■', triangle: '▲', diamond: '◆', star: '★' };
  const mark = r => SHAPE[r.shape]
    || (r.kind === 'line' ? '▬' : r.kind === 'mark' ? '●' : '■');

  slide.addTable(key.rows.map(r => ([
    { text: mark(r), options: { color: hex(r.color), fontSize: 11, align: 'center' } },
    { text: String(r.label ?? ''), options: { align: 'left' } },
  ])), {
    x: lx, y: ly + 0.3, w: lw, colW,
    fontFace: 'Arial', fontSize: 8.5, color: '17202B',
    fill: { color: 'FFFFFF' }, border: { type: 'none' },
    rowH: 0.22, valign: 'middle', margin: 0.04,
  });
  return true;
}
