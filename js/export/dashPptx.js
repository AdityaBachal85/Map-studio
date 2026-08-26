/**
 * export/dashPptx.js — the board as an editable deck.
 *
 * The nearest thing to what Power BI's "Export to PowerPoint" produces, and
 * wanted for the same reason: a PDF is the end of the conversation, and a deck
 * is the middle of one. Somebody drops the slide into a pitch, retypes a
 * heading, moves the map, deletes the card that does not apply. None of that is
 * possible with a picture of a board.
 *
 * SO CARDS BECOME SHAPES, NOT PIXELS. Every textual card is a real rounded
 * rectangle with real text boxes in it, and every table is a NATIVE PowerPoint
 * table — selectable, restyleable, and copyable straight into Excel. Only the
 * genuinely pictorial cards (the map, charts, gauges) go in as images, because
 * that is what they are.
 *
 * IT SHARES THE PDF'S LAYOUT MATHS ON PURPOSE. dashPdfBreaks() decides where a
 * tall board splits, and this calls the same function, so a board that is two
 * pages of PDF is the same two slides with the same cards on each. Two
 * paginators would drift apart, and the one that drifted would be the format
 * nobody checked that week.
 *
 * Units here are INCHES, which is what pptxgenjs takes.
 */

/** 13.33 × 7.5in — LAYOUT_WIDE, the 16:9 default every modern deck uses. */
const DASH_PPT_W = 13.333;
const DASH_PPT_H = 7.5;
const DASH_PPT_MARGIN = 0.42;
const DASH_PPT_HEADER = 0.62;
const DASH_PPT_FOOTER = 0.3;

/** pptxgenjs wants hex without the hash. */
const pptHex = h => String(h || '#000000').replace('#', '').toUpperCase().slice(0, 6);

/**
 * Draw one textual card onto a slide.
 *
 * @param {object} slide @param {object} tile @param {object} box inches
 * @param {object} pal
 */
function dashPptxCard(slide, tile, box, pal) {
  slide.addShape('roundRect', {
    x: box.x, y: box.y, w: box.w, h: box.h,
    fill: { color: pptHex(pal.card) },
    line: { color: pptHex(pal.cardEdge), width: 0.75 },
    rectRadius: 0.04,
  });

  const pad = 0.13;
  let y = box.y + pad;
  const innerW = box.w - pad * 2;
  const d = tile.data || {};

  if (tile.title) {
    slide.addText(tile.title.toUpperCase(), {
      x: box.x + pad, y, w: innerW, h: 0.2,
      fontSize: 8, bold: true, color: pptHex(pal.faint), charSpacing: 1,
      valign: 'top', margin: 0,
    });
    y += 0.26;
  }
  const room = () => (box.y + box.h - pad) - y;

  switch (tile.type) {
    case 'text':
      if (d.body) {
        slide.addText(d.body, {
          x: box.x + pad, y, w: innerW, h: Math.max(0.2, room()),
          fontSize: 10, color: pptHex(pal.ink), valign: 'top', margin: 0,
        });
      }
      break;

    case 'stat':
      slide.addText(d.value || '—', {
        x: box.x + pad, y, w: innerW, h: 0.5,
        fontSize: 26, bold: true, color: pptHex(pal.ink), valign: 'top', margin: 0,
      });
      if (d.label) {
        slide.addText(d.label, {
          x: box.x + pad, y: y + 0.52, w: innerW, h: 0.22,
          fontSize: 9, color: pptHex(pal.dim), valign: 'top', margin: 0,
        });
      }
      break;

    case 'stats': {
      const items = d.items || [];
      const colW = items.length ? innerW / items.length : innerW;
      items.forEach((it, i) => {
        const cx = box.x + pad + i * colW;
        slide.addText(it.value || '—', {
          x: cx, y, w: colW - 0.05, h: 0.34,
          fontSize: 17, bold: true, color: pptHex(pal.ink), valign: 'top', margin: 0,
        });
        slide.addText(it.label, {
          x: cx, y: y + 0.36, w: colW - 0.05, h: 0.2,
          fontSize: 8, color: pptHex(pal.dim), valign: 'top', margin: 0,
        });
      });
      break;
    }

    case 'list': {
      const items = d.items || [];
      if (!items.length) break;
      // A native table rather than stacked text boxes: two columns that stay
      // aligned when somebody retypes a longer milestone.
      slide.addTable(items.map(it => ([
        { text: it.name || '', options: { color: pptHex(pal.ink), fontSize: 9.5 } },
        { text: it.meta || '', options: { color: pptHex(pal.dim), fontSize: 9.5, align: 'right' } },
      ])), {
        x: box.x + pad, y, w: innerW,
        colW: [innerW * 0.66, innerW * 0.34],
        border: { type: 'none' }, margin: 2, valign: 'top',
      });
      break;
    }

    case 'legend':
      (d.rows || []).forEach((r, i) => {
        const ry = y + i * 0.24;
        if (ry + 0.2 > box.y + box.h - pad) return;
        // The swatch keeps saying what carries the colour, as it does on the
        // board and in the PDF: a bar for a line, a square for an area, a dot
        // for a point. Real shapes, so recolouring one is a click.
        if (r.kind === 'mark') {
          slide.addShape('ellipse', { x: box.x + pad, y: ry + 0.05, w: 0.1, h: 0.1, fill: { color: pptHex(r.color) }, line: { width: 0 } });
        } else if (r.kind === 'line') {
          slide.addShape('rect', { x: box.x + pad, y: ry + 0.08, w: 0.2, h: 0.035, fill: { color: pptHex(r.color) }, line: { width: 0 } });
        } else {
          slide.addShape('rect', { x: box.x + pad, y: ry + 0.04, w: 0.16, h: 0.12, fill: { color: pptHex(r.color) }, line: { width: 0 } });
        }
        slide.addText(r.label, {
          x: box.x + pad + 0.28, y: ry, w: innerW - 0.28, h: 0.22,
          fontSize: 9.5, color: pptHex(pal.ink), valign: 'top', margin: 0,
        });
      });
      break;

    case 'access':
    case 'table': {
      const cols = d.columns || [];
      const rows = d.rows || [];
      if (!cols.length && !rows.length) break;
      const head = cols.map(c => ({
        text: String(c).toUpperCase(),
        options: { bold: true, fontSize: 7.5, color: pptHex(pal.faint) },
      }));
      const body = rows.map(r => (r || []).map((cell, i) => ({
        text: String(cell == null ? '' : cell),
        options: {
          fontSize: 9, color: pptHex(i === 0 ? pal.ink : pal.dim),
          align: i === 0 ? 'left' : 'right',
        },
      })));
      slide.addTable(cols.length ? [head].concat(body) : body, {
        x: box.x + pad, y, w: innerW,
        border: { type: 'solid', pt: 0.4, color: pptHex(pal.rule) },
        margin: 2, valign: 'top', autoPage: false,
      });
      break;
    }

    default:
      break;
  }

  if (tile.isEmpty && tile.type !== 'stat' && tile.type !== 'stats') {
    slide.addText('No data', {
      x: box.x + pad, y: box.y + box.h / 2 - 0.12, w: innerW, h: 0.24,
      fontSize: 9, color: pptHex(pal.faint), align: 'center', margin: 0,
    });
  }
}

/**
 * Build the deck.
 *
 * @param {object} model from dashExportModel()
 * @param {HTMLCanvasElement} canvas the rendered board
 * @param {Object<string,object>} rects card id -> device-pixel rect
 * @param {number} scale
 * @returns {Promise<{blob:Blob, slides:number}>}
 */
async function dashBuildPptx(model, canvas, rects, scale) {
  if (typeof PptxGenJS !== 'function') throw new Error('The PowerPoint library did not load.');
  const pal = dashPdfPalette();
  const mapCanvas = (canvas && canvas._dashMap && canvas._dashMap.canvas) || null;

  const boardW = canvas.width / scale;
  const boardH = canvas.height / scale;
  const contentW = DASH_PPT_W - DASH_PPT_MARGIN * 2;
  const contentH = DASH_PPT_H - DASH_PPT_MARGIN * 2 - DASH_PPT_HEADER - DASH_PPT_FOOTER;
  // Inches per board pixel. Unlike the page, a slide is fixed 16:9 and cannot
  // be turned, so the board is fitted to whichever of the two dimensions binds
  // — a tall board would otherwise run off the bottom of every slide.
  const fit = Math.min(contentW / boardW, contentH / (boardH || 1));

  const tiles = model.ordered
    .map(t => ({ tile: t, r: rects[t.id] }))
    .filter(x => x.r)
    .map(x => ({ tile: x.tile, x: x.r.x / scale, y: x.r.y / scale, w: x.r.w / scale, h: x.r.h / scale }));

  const cuts = dashPdfBreaks(tiles, boardH, contentH / fit);
  const dateText = model.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'DBOT · Property Map Studio';
  if (model.title) pptx.title = model.title;

  cuts.forEach((cutTop, pi) => {
    const cutBottom = (pi + 1 < cuts.length) ? cuts[pi + 1] : boardH;
    const slide = pptx.addSlide();
    slide.background = { color: pptHex(pal.page) };

    if (model.title) {
      slide.addText(model.title, {
        x: DASH_PPT_MARGIN, y: DASH_PPT_MARGIN - 0.06, w: contentW * 0.7, h: 0.36,
        fontSize: 17, bold: true, color: pptHex(pal.ink), valign: 'top', margin: 0,
      });
    }
    slide.addText(dateText, {
      x: DASH_PPT_MARGIN + contentW * 0.7, y: DASH_PPT_MARGIN, w: contentW * 0.3, h: 0.28,
      fontSize: 9.5, color: pptHex(pal.dim), align: 'right', valign: 'top', margin: 0,
    });
    slide.addShape('rect', {
      x: DASH_PPT_MARGIN, y: DASH_PPT_MARGIN + 0.34, w: 0.64, h: 0.028,
      fill: { color: pptHex(pal.accent) }, line: { width: 0 },
    });

    // Centred horizontally: a board narrower than the slide would otherwise sit
    // hard against the left margin with all the empty space to its right.
    const usedW = boardW * fit;
    const originX = DASH_PPT_MARGIN + Math.max(0, (contentW - usedW) / 2);
    const originY = DASH_PPT_MARGIN + DASH_PPT_HEADER;

    tiles.forEach(t => {
      if (t.y + t.h <= cutTop || t.y >= cutBottom) return;
      const box = {
        x: originX + t.x * fit,
        y: originY + (t.y - cutTop) * fit,
        w: t.w * fit,
        h: t.h * fit,
      };
      if (DASH_PICTORIAL.indexOf(t.tile.type) >= 0) {
        const src = (t.tile.type === 'map' && mapCanvas) ? mapCanvas : null;
        const data = src
          ? src.toDataURL('image/jpeg', DASH_JPEG_Q)
          : dashPptxCropData(canvas, t.x * scale, t.y * scale, t.w * scale, t.h * scale);
        slide.addImage({ data, x: box.x, y: box.y, w: box.w, h: box.h });
      } else {
        dashPptxCard(slide, t.tile, box, pal);
      }
    });

    slide.addText('DBOT Map Studio', {
      x: DASH_PPT_MARGIN, y: DASH_PPT_H - DASH_PPT_MARGIN - 0.2, w: contentW * 0.5, h: 0.2,
      fontSize: 8, color: pptHex(pal.faint), valign: 'top', margin: 0,
    });
    slide.addText('Slide ' + (pi + 1) + ' of ' + cuts.length, {
      x: DASH_PPT_MARGIN + contentW * 0.5, y: DASH_PPT_H - DASH_PPT_MARGIN - 0.2, w: contentW * 0.5, h: 0.2,
      fontSize: 8, color: pptHex(pal.faint), align: 'right', valign: 'top', margin: 0,
    });
  });

  const raw = await pptx.write({ outputType: 'arraybuffer' });
  // pptxgenjs emits duplicate shape ids, which PowerPoint refuses to open. The
  // repair pass already exists for the map deck; this is the same defect.
  const blob = (typeof ensureUniqueShapeIds === 'function')
    ? await ensureUniqueShapeIds(raw, { outputType: 'blob' })
    : new Blob([raw], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  return { blob, slides: cuts.length };
}

/** Crop a region of the board bitmap out as a JPEG data URL. */
function dashPptxCropData(canvas, x, y, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d');
  // The board's own ground, not white: a rounded card's transparent corners have
  // no alpha to fall back on in a JPEG, and white notches show on a dark board.
  ctx.fillStyle = (canvas && canvas._dashGround)
    || (typeof dashExportGround === 'function' ? dashExportGround() : '#FFFFFF');
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, Math.round(x), Math.round(y), Math.round(w), Math.round(h), 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', DASH_JPEG_Q);
}
