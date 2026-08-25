/**
 * export/dashPdf.js — the board as a document, not a photograph of one.
 *
 * WHAT WAS WRONG. The old export was one html2canvas bitmap wrapped in a PDF:
 * one page, always landscape, the board scaled down until it fitted. A board is
 * usually taller than it is wide, so a portrait shape was letterboxed onto a
 * landscape sheet and about forty per cent of the page came out blank white.
 * Nothing in it was text, so nothing could be selected, searched or copied, and
 * the file carried no clue whose project it was.
 *
 * WHAT THIS DOES INSTEAD. Two kinds of card, drawn two ways:
 *
 *   - PICTORIAL cards — the map, charts, gauges — are pictures, and are cropped
 *     out of the board bitmap that was rendered anyway and placed as images.
 *     No second html2canvas pass per card: one raster of the whole board, then
 *     drawImage out of it, which costs a memcpy each.
 *   - TEXTUAL cards — tables, lists, KPIs, notes, the legend, key access points
 *     — are drawn as real PDF text and rectangles from dashExportModel(). That
 *     is what makes the document searchable, and it is also sharper than any
 *     rasterisation of the same words.
 *
 * So the page is recognisably the board — same cards, same grid positions, same
 * colours — while being a document rather than a screenshot of one.
 *
 * PAGINATION CUTS BETWEEN CARDS, NEVER THROUGH ONE. A tall board becomes as
 * many pages as it needs at a readable size, instead of one page at an
 * unreadable one. The cut is searched upward from the ideal page break to the
 * nearest gap that no card spans; a card taller than a whole page is the one
 * case that cannot be honoured, and it gets a page to itself.
 */

/** Paper, in PDF points (72 per inch), portrait. Turned by the board's shape. */
const DASH_PAPER_MM = {
  a4: { w: 595.28, h: 841.89, label: 'A4' },
  a3: { w: 841.89, h: 1190.55, label: 'A3' },
};

/** Page furniture. */
const DASH_PDF_MARGIN = 34;
const DASH_PDF_HEADER = 30;
const DASH_PDF_FOOTER = 22;

/** Cards that are pictures and are cropped from the bitmap rather than drawn. */
const DASH_PICTORIAL = ['map', 'chart', 'gauges', 'slicer'];

/**
 * Colours for the document, read from the live theme.
 *
 * A board built in dark mode is a dark board, and a page printed dark is a page
 * that empties a toner cartridge to say what white paper says for nothing. The
 * document is always light; only the accent is taken from the theme, so a
 * DBOT-orange board still prints DBOT orange.
 *
 * @returns {object}
 */
function dashPdfPalette() {
  const read = name => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || '';
    } catch (e) { return ''; }
  };
  return {
    ink: '#12202F',
    dim: '#5C6B7E',
    faint: '#93A0B0',
    rule: '#DCE3EB',
    card: '#FFFFFF',
    cardEdge: '#E3E9F0',
    page: '#FFFFFF',
    accent: read('--orange') || '#FF7A1A',
  };
}

/**
 * Which paper, and which way round.
 *
 * The board's own aspect decides the orientation — that single choice is what
 * removes the blank margin, because the sheet is now the shape of the thing
 * being put on it. Only a genuinely wide board turns the page sideways;
 * anything near square stays portrait, since portrait paginates better and a
 * board is read down.
 *
 * @param {string} size 'a4' | 'a3' @param {number} boardW @param {number} boardH
 * @returns {{w:number,h:number,label:string}}
 */
function dashPdfPaper(size, boardW, boardH) {
  const base = DASH_PAPER_MM[size] || DASH_PAPER_MM.a4;
  const landscape = boardW / Math.max(1, boardH) > 1.15;
  return landscape
    ? { w: base.h, h: base.w, label: base.label + ' landscape' }
    : { w: base.w, h: base.h, label: base.label + ' portrait' };
}

/**
 * Where to cut a board that is taller than one page.
 *
 * Walks down in page-sized steps, and at each one backs the cut up to the
 * highest card boundary that no card straddles. Cards are laid out on a grid
 * with real gaps between rows, so such a line almost always exists within a
 * card's height of the ideal break.
 *
 * @param {Array<{y:number,h:number}>} tiles in board pixels
 * @param {number} boardH @param {number} pageH usable height in board pixels
 * @returns {number[]} cut positions, starting at 0
 */
function dashPdfBreaks(tiles, boardH, pageH) {
  if (pageH <= 0 || boardH <= pageH) return [0];
  const cuts = [0];
  let y = 0;
  let guard = 0;
  while (y + pageH < boardH && guard++ < 500) {
    const ideal = y + pageH;
    // The highest tile bottom at or above the ideal break that nothing spans.
    let best = 0;
    tiles.forEach(t => {
      const bottom = t.y + t.h;
      if (bottom <= ideal && bottom > best && !tiles.some(o => o.y < bottom && o.y + o.h > bottom)) {
        best = bottom;
      }
    });
    // No clean line — a single card is taller than the page. Cut at the ideal
    // point and let that one card be split; the alternative is an infinite loop.
    const cut = best > y ? best : ideal;
    cuts.push(cut);
    y = cut;
  }
  return cuts;
}

/** Crop a region of a canvas out as JPEG bytes. */
function dashPdfCrop(canvas, x, y, w, h, quality) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d');
  // White under it: a card with a transparent corner radius would otherwise
  // come out black in a JPEG, which has no alpha channel to fall back on.
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, Math.round(x), Math.round(y), Math.round(w), Math.round(h),
    0, 0, c.width, c.height);
  return {
    bytes: dashJpegBytes(c.toDataURL('image/jpeg', quality == null ? DASH_JPEG_Q : quality)),
    pxW: c.width, pxH: c.height,
  };
}

/**
 * Draw one textual card natively.
 *
 * @param {object} page @param {object} tile from the model
 * @param {object} box {x, y, w, h} in points @param {object} pal
 */
function dashPdfCard(page, tile, box, pal) {
  pdfRect(page, pal.card, box.x, box.y, box.w, box.h);
  pdfLine(page, pal.cardEdge, box.x, box.y, box.w, 0.6);

  const pad = 10;
  let y = box.y + pad;
  const innerW = box.w - pad * 2;

  if (tile.title) {
    pdfText(page, tile.title.toUpperCase(), {
      x: box.x + pad, y, size: 7.5, bold: true, color: pal.faint, width: innerW,
    });
    y += 14;
  }

  const d = tile.data || {};
  const bottom = box.y + box.h - pad;
  const room = () => bottom - y;

  switch (tile.type) {
    case 'text':
      if (d.body) {
        pdfParagraph(page, d.body, {
          x: box.x + pad, y, size: 9, color: pal.ink, width: innerW,
          maxLines: Math.max(1, Math.floor(room() / 12)),
        });
      }
      break;

    case 'stat':
      pdfText(page, d.value || '—', { x: box.x + pad, y: y + 4, size: 24, bold: true, color: pal.ink, width: innerW });
      y += 34;
      if (d.label) pdfText(page, d.label, { x: box.x + pad, y, size: 8.5, color: pal.dim, width: innerW });
      y += 14;
      break;

    case 'stats': {
      const items = d.items || [];
      const colW = items.length ? innerW / items.length : innerW;
      items.forEach((it, i) => {
        const cx = box.x + pad + i * colW;
        pdfText(page, it.value || '—', { x: cx, y: y + 2, size: 16, bold: true, color: pal.ink, width: colW - 6 });
        pdfText(page, it.label, { x: cx, y: y + 24, size: 7.5, color: pal.dim, width: colW - 6 });
      });
      // Advance past what was just drawn. Without this the card reads as having
      // drawn nothing, and the "No data" note below stamps itself straight
      // across the em-dashes it duplicates.
      if (items.length) y += 38;
      break;
    }

    case 'list': {
      const items = d.items || [];
      let drawn = 0;
      items.forEach((it, i) => {
        if (room() < 12 + (i < items.length - 1 ? 11 : 0)) return;
        pdfText(page, it.name, { x: box.x + pad, y, size: 9, color: pal.ink, width: innerW * 0.66 });
        if (it.meta) {
          pdfText(page, it.meta, {
            x: box.x + pad + innerW * 0.66, y, size: 9, color: pal.dim,
            width: innerW * 0.34, align: 'right',
          });
        }
        y += 14;
        drawn++;
      });
      if (drawn < items.length) {
        pdfText(page, '+' + (items.length - drawn) + ' more', {
          x: box.x + pad, y, size: 7.5, color: pal.faint, width: innerW, align: 'right' });
      }
      break;
    }

    case 'legend': {
      const rws = d.rows || [];
      let drawn = 0;
      rws.forEach((r, i) => {
        if (room() < 11 + (i < rws.length - 1 ? 11 : 0)) return;
        // The swatch says what carries the colour, the way the card does on
        // screen: a bar for a line, a square for an area, a dot for a point.
        if (r.kind === 'line') pdfRect(page, r.color, box.x + pad, y + 4, 14, 3);
        else if (r.kind === 'mark') pdfRect(page, r.color, box.x + pad + 4, y + 2, 7, 7);
        else pdfRect(page, r.color, box.x + pad, y + 1, 11, 9);
        // Wrapped, not ellipsized. A legend card is narrow and the names in it
        // are place names — "Shivarampalli Railw…" identifies nothing, and the
        // whole reason the card exists is to say which colour is which place.
        const labelX = box.x + pad + 20;
        const labelW = innerW - 20;
        const used = pdfParagraph(page, r.label, {
          x: labelX, y, size: 8.5, color: pal.ink, width: labelW,
          leading: 10.5, maxLines: Math.max(1, Math.min(2, Math.floor(room() / 10.5))),
        });
        y += Math.max(13, used + 3);
        drawn++;
      });
      if (drawn < rws.length) {
        pdfText(page, '+' + (rws.length - drawn) + ' more', {
          x: box.x + pad, y, size: 7.5, color: pal.faint, width: innerW, align: 'right' });
      }
      break;
    }

    case 'access':
    case 'table': {
      const marks = d.marks || null;
      const lead = marks ? 13 : 0;
      const size = 8.5;

      // A COLUMN NOBODY FILLED IN IS NOT A COLUMN. Key access points always
      // offers Place / Distance / Time, but a route the router has not timed
      // has no time, and a whole column of em-dashes still charges full width
      // for saying nothing — width taken directly from the place names, which
      // is the column that then had to be cut short. Drop any column that is
      // empty all the way down, and the names get the room back.
      //
      // The first column is never dropped: it is what the row IS.
      const allCols = d.columns || [];
      const allRows = d.rows || [];
      const keep = allCols.map((c, i) => i === 0
        || allRows.some(r => { const v = String((r || [])[i] == null ? '' : (r || [])[i]).trim(); return v && v !== '—' && v !== '-'; }));
      const cols = allCols.filter((c, i) => keep[i]);
      const rows = allRows.map(r => (r || []).filter((c, i) => keep[i]));

      // MEASURE THE NUMBERS, DO NOT GUESS AT THEM. Splitting the width by a
      // fixed fraction gave every value column the same slice whatever was in
      // it, so a card four grid columns wide printed "DIST…" and "3.1 …" —
      // headings and values both cut off, in the one card whose entire job is
      // to state distances. Each value column is now as wide as its own widest
      // entry needs, and the name column keeps whatever is left, which is the
      // column that can afford to lose a few characters.
      const widest = i => {
        let w = pdfTextWidth(cols[i] || '', 6.5, true);
        rows.forEach(r => { w = Math.max(w, pdfTextWidth((r || [])[i] || '', size)); });
        return w;
      };
      const gap = 8;
      const tail = [];
      for (let i = 1; i < cols.length; i++) tail.push(Math.min(widest(i) + gap, innerW * 0.3));
      const tailW = tail.reduce((a, b) => a + b, 0);
      const firstW = Math.max(40, innerW - lead - tailW);
      const colX = i => box.x + pad + lead
        + (i === 0 ? 0 : firstW + tail.slice(0, i - 1).reduce((a, b) => a + b, 0));
      const colW = i => (i === 0 ? firstW : tail[i - 1]);

      if (cols.length) {
        cols.forEach((c, i) => pdfText(page, c.toUpperCase(), {
          x: colX(i), y, size: 6.5, bold: true, color: pal.faint,
          width: colW(i), align: i === 0 ? 'left' : 'right',
        }));
        y += 11;
        pdfLine(page, pal.rule, box.x + pad, y, innerW, 0.5);
        y += 5;
      }
      let drawnRows = 0;
      rows.forEach((r, ri) => {
        // Leave a line's worth of room for the "N more" note, unless this is
        // the last row and it will not be needed.
        const needTail = ri < rows.length - 1;
        if (room() < 12 + (needTail ? 11 : 0)) return;
        if (marks && marks[ri]) pdfRect(page, marks[ri], box.x + pad + 1, y + 2, 7, 7);
        // The name wraps; the values do not. A place name cut to "SVPN Police
        // Acad…" names nothing, and this card exists to say which places. The
        // values beside it are short by nature and sit on the first line, so
        // the numbers still read straight down the column.
        const nameLines = pdfWrap((r || [])[0] || '', colW(0), size);
        const fits = Math.max(1, Math.min(2, Math.floor((room() - (needTail ? 11 : 0)) / 10.5)));
        const shown = nameLines.slice(0, fits);
        // A dropped wrap line is a silent lie — the row reads as a shorter
        // place name rather than as a longer one that did not fit. Ellipsis on
        // the last line it could draw, so the cut is visible.
        if (nameLines.length > shown.length) {
          shown[shown.length - 1] = pdfEllipsize(shown[shown.length - 1] + '…', colW(0), size);
        }
        shown.forEach((line, li) => pdfText(page, line, {
          x: colX(0), y: y + li * 10.5, size, color: pal.ink,
        }));
        for (let i = 1; i < (r || []).length; i++) {
          pdfText(page, r[i], { x: colX(i), y, size, color: pal.dim, width: colW(i), align: 'right' });
        }
        y += Math.max(13, shown.length * 10.5 + 3);
        drawnRows++;
      });
      // How many the card could not hold. Without this the reader counts two
      // access points and believes that is all there are.
      if (drawnRows < rows.length) {
        pdfText(page, '+' + (rows.length - drawnRows) + ' more', {
          x: box.x + pad, y, size: 7.5, color: pal.faint, width: innerW, align: 'right',
        });
      }
      break;
    }

    default:
      break;
  }

  // An empty card says so, rather than being a blank rectangle the reader has
  // to decide about. The board's own prompt ("turn on Edit board to type
  // them") is an instruction to somebody who is not there and never prints.
  //
  // Only where nothing else was drawn, though. A KPI card already shows an
  // em-dash under each caption — that IS the "no data", in the card's own
  // language — and stamping a second one across the middle of it put the words
  // straight through the values. `y` has advanced past the title if and only if
  // the body drew something.
  if (tile.isEmpty && y <= box.y + pad + (tile.title ? 14 : 0)) {
    pdfText(page, 'No data', {
      x: box.x + pad, y: box.y + box.h / 2 - 4, size: 8.5, color: pal.faint,
      width: innerW, align: 'center',
    });
  }
}

/**
 * Build the whole document.
 *
 * @param {object} model from dashExportModel()
 * @param {HTMLCanvasElement} canvas the rendered board
 * @param {Object<string,object>} rects card id -> device-pixel rect on that canvas
 * @param {number} scale device pixels per board pixel
 * @param {string} size 'a4' | 'a3'
 * @returns {{blob:Blob, pages:number, paper:object}}
 */
function dashBuildDocument(model, canvas, rects, scale, size) {
  const pal = dashPdfPalette();
  const boardW = canvas.width / scale;
  const boardH = canvas.height / scale;
  const paper = dashPdfPaper(size, boardW, boardH);

  const contentW = paper.w - DASH_PDF_MARGIN * 2;
  const contentH = paper.h - DASH_PDF_MARGIN * 2 - DASH_PDF_HEADER - DASH_PDF_FOOTER;
  const fit = contentW / boardW;                 // points per board pixel

  const tiles = model.ordered
    .map(t => ({ tile: t, r: rects[t.id] }))
    .filter(x => x.r)
    .map(x => ({ tile: x.tile, x: x.r.x / scale, y: x.r.y / scale, w: x.r.w / scale, h: x.r.h / scale }));

  const cuts = dashPdfBreaks(tiles, boardH, contentH / fit);
  const dateText = model.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const pages = [];

  // A board is scaled to the page's WIDTH, so unless its proportions happen to
  // match the paper's there is height left over. Where that fits on one page,
  // the leftover is split above and below instead of all falling to the bottom:
  // a document with balanced margins reads as finished, and the same amount of
  // white pushed to the foot reads as one that stopped early. Capped, so a
  // short board does not float in the middle of an otherwise blank sheet.
  const slack = cuts.length === 1 ? Math.max(0, contentH - boardH * fit) : 0;
  // Centred when the board fills most of the page, because then the leftover is
  // a margin. Nudged only when it does not, because a small board floating in
  // the middle of an otherwise blank sheet looks lost rather than composed.
  const fills = boardH * fit > contentH * 0.5;
  const lift = fills ? slack / 2 : Math.min(slack / 2, 40);

  cuts.forEach((cutTop, pi) => {
    const cutBottom = (pi + 1 < cuts.length) ? cuts[pi + 1] : boardH;
    const page = pdfPage(paper.w, paper.h);
    pdfRect(page, pal.page, 0, 0, paper.w, paper.h);

    // Header: whose board, and when. Neither reached the old file at all — the
    // board's top bar sits outside #dashGrid, so the bitmap never saw it.
    const top = DASH_PDF_MARGIN;
    if (model.title) {
      pdfText(page, model.title, { x: DASH_PDF_MARGIN, y: top, size: 13, bold: true, color: pal.ink, width: contentW * 0.7 });
    }
    pdfText(page, dateText, {
      x: DASH_PDF_MARGIN + contentW * 0.7, y: top + 3, size: 8.5, color: pal.dim,
      width: contentW * 0.3, align: 'right',
    });
    pdfLine(page, pal.accent, DASH_PDF_MARGIN, top + 20, 46, 1.6);

    const originY = DASH_PDF_MARGIN + DASH_PDF_HEADER + lift;
    tiles.forEach(t => {
      // Anything wholly on another page.
      if (t.y + t.h <= cutTop || t.y >= cutBottom) return;
      const box = {
        x: DASH_PDF_MARGIN + t.x * fit,
        y: originY + (t.y - cutTop) * fit,
        w: t.w * fit,
        h: t.h * fit,
      };
      if (DASH_PICTORIAL.indexOf(t.tile.type) >= 0) {
        const im = dashPdfCrop(canvas, t.x * scale, t.y * scale, t.w * scale, t.h * scale);
        pdfImage(page, im.bytes, im.pxW, im.pxH, box.x, box.y, box.w, box.h);
      } else {
        dashPdfCard(page, t.tile, box, pal);
      }
    });

    const footY = paper.h - DASH_PDF_MARGIN - DASH_PDF_FOOTER + 8;
    pdfLine(page, pal.rule, DASH_PDF_MARGIN, footY - 6, contentW, 0.5);
    pdfText(page, 'DBOT Map Studio', { x: DASH_PDF_MARGIN, y: footY, size: 7.5, color: pal.faint });
    pdfText(page, 'Page ' + (pi + 1) + ' of ' + cuts.length, {
      x: DASH_PDF_MARGIN, y: footY, size: 7.5, color: pal.faint, width: contentW, align: 'right',
    });

    pages.push(page);
  });

  return { blob: pdfBuild(pages), pages: pages.length, paper };
}
