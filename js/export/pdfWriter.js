/**
 * export/pdfWriter.js — a small PDF writer: pages, text, rectangles, images.
 *
 * WHY NOT A LIBRARY. The same reason the previous one-page version gave, and it
 * still holds: jsPDF is ~300KB, and this app ships every byte it uses over
 * GitHub Pages with no bundler to tree-shake anything. What changed is the
 * requirement. A single JPEG on a single page really was fifty lines; a
 * multi-page document with selectable text is not, so this is a proper little
 * writer rather than a byte-blob with a picture in it — but it is still about
 * four hundred lines against three hundred kilobytes, and it does only what
 * this app asks of it.
 *
 * WHY THE TEXT IS HELVETICA. Every PDF reader is required to have the fourteen
 * standard Type1 fonts built in, so naming one costs nothing — no font file, no
 * subsetting, no embedding, no licence. The app's own face is Geist and this is
 * not it; that is the trade for text you can select, search and copy, and it is
 * the right way round. A client can find "Shivarampalli" in the document.
 *
 * THE ENCODING IS THE SHARP EDGE. WinAnsi covers Latin-1 plus a handful of
 * typographic extras, and the strings this app produces do not stay inside it:
 * route names carry "→", areas carry "²", prices carry "₹". A byte over 255
 * written raw produces a silently mangled glyph, which is worse than an honest
 * substitution — see pdfWinAnsi().
 */

/** The two faces used, and their PDF resource names. */
const PDF_FONTS = { normal: 'F1', bold: 'F2' };

/** Widths of Helvetica, in 1/1000 em, for codes 32..126. Enough to measure a
 *  line for wrapping and centring; the bold face is close enough to share them
 *  with a scale factor rather than carrying a second table. */
const PDF_HELV_W = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/**
 * Map a JavaScript string onto WinAnsi bytes.
 *
 * Characters WinAnsi has, it keeps — including the ones that matter typograph-
 * ically: the en and em dashes, curly quotes, the middle dot this app uses to
 * join a distance to a duration, the degree sign, and the non-breaking space.
 *
 * Characters it does not have are transliterated to something a reader will
 * recognise rather than dropped or mangled. The arrow in "Airport → Site" is
 * the one that actually turns up: written raw it becomes a stray accented
 * capital, which looks like a bug in the document rather than a limit of the
 * encoding. "->" is not beautiful and it is unambiguous.
 *
 * @param {string} s @returns {number[]} byte values
 */
function pdfWinAnsi(s) {
  const SUB = {
    0x2192: '->', 0x2190: '<-', 0x21D2: '=>',
    0x20B9: 'Rs.',                     // ₹ — no WinAnsi codepoint at all
    0x00B2: '2', 0x00B3: '3',          // m², m³ superscripts WinAnsi does have,
    0x2264: '<=', 0x2265: '>=', 0x2260: '!=',
    0x00A0: ' ',
    0x2026: '...',
  };
  // These WinAnsi does carry, at codes of its own rather than their Unicode ones.
  const HIGH = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2030: 0x89,
    0x2039: 0x8B, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94,
    0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x203A: 0x9B,
  };
  const out = [];
  for (const ch of String(s == null ? '' : s)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x00B7) { out.push(0xB7); continue; }        // · the distance separator
    if (cp < 0x80) { out.push(cp); continue; }
    if (HIGH[cp] != null) { out.push(HIGH[cp]); continue; }
    if (cp <= 0xFF) { out.push(cp); continue; }             // Latin-1 maps straight through
    const sub = SUB[cp];
    if (sub) { for (const c of sub) out.push(c.charCodeAt(0)); continue; }
    out.push(0x3F);                                          // '?' — visible, not silent
  }
  return out;
}

/**
 * A PDF string literal, escaped and encoded.
 * @param {string} s @returns {string}
 */
function pdfString(s) {
  let out = '(';
  for (const b of pdfWinAnsi(s)) {
    if (b === 0x28 || b === 0x29 || b === 0x5C) out += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + ')';
}

/**
 * How wide a string is, in points.
 * @param {string} s @param {number} size @param {boolean} [bold]
 * @returns {number}
 */
function pdfTextWidth(s, size, bold) {
  let w = 0;
  for (const b of pdfWinAnsi(s)) {
    // Outside the measured range, assume an average letter. Every such
    // character is Latin-1 accented, whose Helvetica width is within a few
    // percent of its unaccented form, so this is a small error on rare input.
    w += (b >= 32 && b <= 126) ? PDF_HELV_W[b - 32] : 556;
  }
  // Helvetica-Bold runs about 4% wider than Helvetica across a mixed line.
  return w / 1000 * size * (bold ? 1.04 : 1);
}

/**
 * Break a string into lines that fit a width.
 * @param {string} s @param {number} width @param {number} size @param {boolean} [bold]
 * @returns {string[]}
 */
function pdfWrap(s, width, size, bold) {
  const words = String(s == null ? '' : s).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (pdfTextWidth(next, size, bold) <= width || !line) { line = next; continue; }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Shorten to fit, with an ellipsis.
 *
 * Used only where wrapping is not available — a table cell with one line of
 * room. Everywhere there is vertical space, pdfWrap is the better answer:
 * truncation loses information and wrapping does not.
 *
 * @param {string} s @param {number} width @param {number} size @param {boolean} [bold]
 * @returns {string}
 */
function pdfEllipsize(s, width, size, bold) {
  const str = String(s == null ? '' : s);
  if (pdfTextWidth(str, size, bold) <= width) return str;
  let lo = 0, hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pdfTextWidth(str.slice(0, mid) + '…', size, bold) <= width) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? str.slice(0, lo) + '…' : '';
}

/** #RRGGBB (or #RGB) to a PDF `r g b` triple in 0..1. @param {string} hex */
function pdfRgb(hex) {
  let h = String(hex || '#000').replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  if (!isFinite(n)) return '0 0 0';
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]
    .map(v => v.toFixed(3)).join(' ');
}

/**
 * A page under construction.
 *
 * Coordinates are given TOP-DOWN, because every other measurement in this app
 * is — the board's grid, the DOM, html2canvas. PDF's own origin is the bottom
 * left, and flipping at the boundary here means no caller ever has to think
 * about it. `y` in every method below is the distance from the top of the page.
 */
function pdfPage(w, h) {
  return { w, h, ops: [], images: [] };
}

/** @param {object} p @param {string} hex @param {number} x @param {number} y
 *  @param {number} w @param {number} h @param {number} [radius] */
function pdfRect(p, hex, x, y, w, h) {
  p.ops.push(pdfRgb(hex) + ' rg');
  p.ops.push(x.toFixed(2) + ' ' + (p.h - y - h).toFixed(2) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' re f');
}

/** A hairline rule. @param {object} p @param {string} hex @param {number} x
 *  @param {number} y @param {number} w @param {number} [weight] */
function pdfLine(p, hex, x, y, w, weight) {
  const t = weight || 0.5;
  p.ops.push(pdfRgb(hex) + ' RG');
  p.ops.push(t.toFixed(2) + ' w');
  p.ops.push(x.toFixed(2) + ' ' + (p.h - y).toFixed(2) + ' m '
    + (x + w).toFixed(2) + ' ' + (p.h - y).toFixed(2) + ' l S');
}

/**
 * One line of text. `y` is the TOP of the line, not the baseline — callers
 * think in boxes, and Helvetica's ascent is about 0.75 of its size.
 *
 * @param {object} p @param {string} s @param {object} o
 *   {x, y, size, color, bold, width, align}
 * @returns {number} the height consumed
 */
function pdfText(p, s, o) {
  const size = o.size || 10;
  const bold = !!o.bold;
  let str = String(s == null ? '' : s);
  if (o.width) str = pdfEllipsize(str, o.width, size, bold);
  let x = o.x;
  if (o.align === 'right' && o.width) x = o.x + o.width - pdfTextWidth(str, size, bold);
  else if (o.align === 'center' && o.width) x = o.x + (o.width - pdfTextWidth(str, size, bold)) / 2;

  const baseline = p.h - o.y - size * 0.78;
  p.ops.push('BT');
  p.ops.push(pdfRgb(o.color || '#000') + ' rg');
  p.ops.push('/' + (bold ? PDF_FONTS.bold : PDF_FONTS.normal) + ' ' + size + ' Tf');
  p.ops.push('1 0 0 1 ' + x.toFixed(2) + ' ' + baseline.toFixed(2) + ' Tm');
  p.ops.push(pdfString(str) + ' Tj');
  p.ops.push('ET');
  return size * 1.32;
}

/**
 * Wrapped text. Returns the height consumed so a caller can flow past it.
 * @param {object} p @param {string} s @param {object} o adds {maxLines, leading}
 * @returns {number}
 */
function pdfParagraph(p, s, o) {
  const size = o.size || 10;
  const leading = o.leading || size * 1.35;
  let lines = pdfWrap(s, o.width, size, o.bold);
  if (o.maxLines && lines.length > o.maxLines) {
    lines = lines.slice(0, o.maxLines);
    lines[lines.length - 1] = pdfEllipsize(lines[lines.length - 1] + '…', o.width, size, o.bold);
  }
  lines.forEach((line, i) => pdfText(p, line, Object.assign({}, o, { y: o.y + i * leading, width: 0 })));
  return lines.length * leading;
}

/**
 * Place a JPEG. `bytes` goes in with /DCTDecode, i.e. as-is — no re-encoding,
 * so no second generation of compression on top of the first.
 *
 * @param {object} p @param {Uint8Array} bytes @param {number} pxW @param {number} pxH
 * @param {number} x @param {number} y @param {number} w @param {number} h
 */
function pdfImage(p, bytes, pxW, pxH, x, y, w, h) {
  const name = 'Im' + p.images.length;
  p.images.push({ name, bytes, pxW, pxH });
  p.ops.push('q');
  p.ops.push(w.toFixed(2) + ' 0 0 ' + h.toFixed(2) + ' ' + x.toFixed(2) + ' '
    + (p.h - y - h).toFixed(2) + ' cm');
  p.ops.push('/' + name + ' Do');
  p.ops.push('Q');
}

/**
 * Serialise pages into a PDF.
 *
 * The xref table has to hold the byte offset of every object, so the whole file
 * is assembled as a list of chunks with a running length rather than by string
 * concatenation — an image is megabytes of binary and must never go near a
 * JavaScript string.
 *
 * @param {Array<object>} pages @returns {Blob}
 */
function pdfBuild(pages) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = b => { parts.push(b); len += b.length; };
  const pushStr = s => push(enc.encode(s));
  const obj = (n, body) => { offsets[n] = len; pushStr(n + ' 0 obj\n' + body + '\nendobj\n'); };

  // 1 catalog, 2 pages, 3 font normal, 4 font bold, then per page:
  // a page object, a contents object, and one object per image.
  const FIRST = 5;
  let next = FIRST;
  const plan = pages.map(p => {
    const rec = { page: next++, contents: next++, images: [] };
    p.images.forEach(im => rec.images.push({ id: next++, im }));
    return rec;
  });

  pushStr('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [' + plan.map(r => r.page + ' 0 R').join(' ')
    + '] /Count ' + pages.length + ' >>');
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  pages.forEach((p, i) => {
    const rec = plan[i];
    const xo = rec.images.length
      ? ' /XObject << ' + rec.images.map(r => '/' + r.im.name + ' ' + r.id + ' 0 R').join(' ') + ' >>'
      : '';
    obj(rec.page, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + p.w.toFixed(2) + ' ' + p.h.toFixed(2) + ']'
      + ' /Resources << /Font << /' + PDF_FONTS.normal + ' 3 0 R /' + PDF_FONTS.bold + ' 4 0 R >>'
      + xo + ' >> /Contents ' + rec.contents + ' 0 R >>');

    const content = p.ops.join('\n') + '\n';
    const bytes = enc.encode(content);
    offsets[rec.contents] = len;
    pushStr(rec.contents + ' 0 obj\n<< /Length ' + bytes.length + ' >>\nstream\n');
    push(bytes);
    pushStr('endstream\nendobj\n');

    rec.images.forEach(r => {
      offsets[r.id] = len;
      pushStr(r.id + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + r.im.pxW
        + ' /Height ' + r.im.pxH + ' /ColorSpace /DeviceRGB /BitsPerComponent 8'
        + ' /Filter /DCTDecode /Length ' + r.im.bytes.length + ' >>\nstream\n');
      push(r.im.bytes);
      pushStr('\nendstream\nendobj\n');
    });
  });

  const count = next;
  const xref = len;
  let table = 'xref\n0 ' + count + '\n0000000000 65535 f \n';
  for (let i = 1; i < count; i++) table += String(offsets[i] || 0).padStart(10, '0') + ' 00000 n \n';
  pushStr(table + 'trailer\n<< /Size ' + count + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

  return new Blob(parts, { type: 'application/pdf' });
}

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pdfPage, pdfRect, pdfLine, pdfText, pdfParagraph, pdfImage, pdfBuild,
    pdfWinAnsi, pdfString, pdfTextWidth, pdfWrap, pdfEllipsize, pdfRgb, PDF_FONTS,
  };
}
