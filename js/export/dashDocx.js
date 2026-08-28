/**
 * export/dashDocx.js — the board as a Word document.
 *
 * WHY A DOCUMENT AND NOT A PICTURE. The PDF is the thing you send and the deck
 * is the thing you present; this is the thing somebody edits. A property note
 * gets a paragraph added, a caveat, a client's name, a section reordered — and
 * for that it has to arrive as headings, paragraphs and tables, not as a page
 * with a screenshot on it.
 *
 * So this is NOT the board's layout. The other two writers reproduce the grid;
 * a Word file that tried to would be a nest of floating frames that fall apart
 * the moment a line of text is added. It is the board read out in order
 * instead: the map first, then each card as a heading and its content, top to
 * bottom, left to right — which is exactly `model.ordered`.
 *
 * WHY NOT A LIBRARY, AGAIN. A .docx is a zip of XML, the same way an .xlsx is,
 * and js/project/xlsx.js already builds one of those by hand over the JSZip
 * that the PPTX exporter vendored anyway. Following that file's shape costs a
 * couple of hundred lines against the several hundred kilobytes a docx library
 * would add to every page load.
 *
 * WHAT IS SUPPORTED. Headings, paragraphs, tables with a header row, inline
 * images, and a title block. Not styles anyone can pick from Word's gallery,
 * not headers and footers, not a table of contents. Enough that the file opens
 * clean in Word, Google Docs and LibreOffice and reads like something written
 * rather than dumped.
 */

const DOCX_W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DOCX_R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DOCX_PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** A4 portrait content width, in EMU (914400 per inch). Margins are 1in. */
const DOCX_CONTENT_EMU = Math.round(6.27 * 914400);

/** Escape for XML text. */
function docxEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One paragraph.
 * @param {string} text @param {object} [o] {bold, size, color, caps, spaceAfter, align}
 * @returns {string}
 */
function docxP(text, o) {
  o = o || {};
  // Word sizes are HALF-points, which is the single most common way to get a
  // document that opens at twice the intended size.
  const sz = Math.round((o.size || 10) * 2);
  const props = '<w:rPr>'
    + (o.bold ? '<w:b/>' : '')
    + (o.caps ? '<w:caps/>' : '')
    + '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/>'
    + (o.color ? '<w:color w:val="' + String(o.color).replace('#', '').toUpperCase() + '"/>' : '')
    + '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>'
    + '</w:rPr>';
  const pPr = '<w:pPr>'
    + '<w:spacing w:after="' + (o.spaceAfter == null ? 80 : o.spaceAfter) + '"/>'
    + (o.align ? '<w:jc w:val="' + o.align + '"/>' : '')
    + '</w:pPr>';
  // Word collapses runs of spaces unless told not to; xml:space keeps the text
  // the author typed.
  return '<w:p>' + pPr + '<w:r>' + props
    + '<w:t xml:space="preserve">' + docxEsc(text) + '</w:t></w:r></w:p>';
}

/** A table with an optional header row. @returns {string} */
function docxTable(columns, rows, pal, fills) {
  const widthPct = 5000;                       // fiftieths of a percent = 100%
  // `w:shd` is Word's cell shading; the fill has to be a bare six-digit hex.
  // The ink travels with it for the same reason it does in the deck: a dark
  // fill under the document's own grey body text is a cell nobody can read.
  const shd = h => (h ? '<w:shd w:val="clear" w:color="auto" w:fill="'
    + String(h).replace('#', '').toUpperCase() + '"/>' : '');
  const inkOn = h => (typeof dashInkOn === 'function' ? dashInkOn(h) : null);
  const cell = (text, o, fill) => '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>'
    + shd(fill) + '</w:tcPr>'
    + docxP(text, Object.assign({ spaceAfter: 0 }, o)) + '</w:tc>';
  const f = fills || {};
  const headFill = f.head || null;
  const rowFill = f.rows || [];
  const rowInk = f.inks || [];
  const head = columns && columns.length
    ? '<w:tr><w:trPr><w:tblHeader/></w:trPr>'
      + columns.map(c => cell(String(c).toUpperCase(),
        { bold: true, size: 8, color: f.headInk || inkOn(headFill) || pal.faint }, headFill)).join('')
      + '</w:tr>'
    : '';
  const body = rows.map((r, ri) => {
    const fill = rowFill[ri] || null;
    const ink = rowInk[ri] || inkOn(fill);
    return '<w:tr>'
      + (r || []).map((c, i) => cell(c,
        { size: 9, color: ink || (i === 0 ? pal.ink : pal.dim) }, fill)).join('')
      + '</w:tr>';
  }).join('');
  return '<w:tbl><w:tblPr>'
    + '<w:tblW w:w="' + widthPct + '" w:type="pct"/>'
    + '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side =>
      '<w:' + side + ' w:val="single" w:sz="4" w:space="0" w:color="'
      + pal.rule.replace('#', '').toUpperCase() + '"/>').join('')
    + '</w:tblBorders></w:tblPr>' + head + body + '</w:tbl>';
}

/** An inline image paragraph. @returns {string} */
function docxImage(rId, emuW, emuH, name) {
  return '<w:p><w:pPr><w:spacing w:after="160"/></w:pPr><w:r><w:drawing>'
    + '<wp:inline distT="0" distB="0" distL="0" distR="0" '
    + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
    + '<wp:extent cx="' + emuW + '" cy="' + emuH + '"/>'
    + '<wp:docPr id="' + rId.replace(/\D/g, '') + '" name="' + docxEsc(name) + '"/>'
    + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:nvPicPr><pic:cNvPr id="0" name="' + docxEsc(name) + '"/><pic:cNvPicPr/></pic:nvPicPr>'
    + '<pic:blipFill><a:blip xmlns:r="' + DOCX_R_NS + '" r:embed="' + rId + '"/>'
    + '<a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + emuW + '" cy="' + emuH + '"/></a:xfrm>'
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
}

/**
 * Build the .docx.
 *
 * @param {object} model @param {HTMLCanvasElement} canvas
 * @param {Object<string,object>} rects @param {number} scale
 * @returns {Promise<{blob:Blob, sections:number}>}
 */
async function dashBuildDocx(model, canvas, rects, scale) {
  if (typeof JSZip === 'undefined') throw new Error('The zip library did not load.');
  const pal = dashPdfPalette();
  const mapCanvas = (canvas && canvas._dashMap && canvas._dashMap.canvas) || null;

  const images = [];
  const addImage = (dataUrl, pxW, pxH, name) => {
    const rId = 'rId' + (100 + images.length);
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    images.push({ rId, bytes, file: 'media/image' + images.length + '.jpg' });
    const emuW = DOCX_CONTENT_EMU;
    const emuH = Math.round(emuW * (pxH / Math.max(1, pxW)));
    return docxImage(rId, emuW, emuH, name || 'Image');
  };

  const body = [];
  body.push(docxP(model.title || 'Dashboard', { size: 20, bold: true, spaceAfter: 40, color: pal.ink }));
  body.push(docxP(model.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    { size: 9, color: pal.dim, spaceAfter: 240 }));

  model.ordered.forEach(t => {
    if (t.type === 'map') {
      const src = mapCanvas || null;
      const r = rects[t.id];
      if (src) {
        body.push(addImage(src.toDataURL('image/jpeg', DASH_JPEG_Q), src.width, src.height, 'Map'));
      } else if (r) {
        const crop = dashPptxCropData(canvas, r.x, r.y, r.w, r.h);
        body.push(addImage(crop, r.w, r.h, 'Map'));
      }
      return;
    }

    if (t.title) body.push(docxP(t.title, { size: 12, bold: true, spaceAfter: 60, color: pal.ink }));

    if (t.isEmpty) {
      body.push(docxP('No data.', { size: 9, color: pal.faint, spaceAfter: 200 }));
      return;
    }

    const d = t.data || {};
    switch (t.type) {
      case 'text':
        body.push(docxP(d.body, { size: 10, color: pal.ink, spaceAfter: 200 }));
        break;
      case 'stat':
        body.push(docxP((d.label ? d.label + ': ' : '') + (d.value || '—'),
          { size: 11, bold: true, color: pal.ink, spaceAfter: 200 }));
        break;
      case 'stats':
        body.push(docxTable(['Metric', 'Value'],
          (d.items || []).map(i => [i.label, i.value || '—']), pal));
        body.push(docxP('', { spaceAfter: 200 }));
        break;
      case 'gauges':
        body.push(docxTable(['Score', 'Value'],
          (d.items || []).map(i => [i.cap, i.value || '—']), pal));
        body.push(docxP('', { spaceAfter: 200 }));
        break;
      case 'list':
        body.push(docxTable(null, (d.items || []).map(i => [i.name, i.meta]), pal));
        body.push(docxP('', { spaceAfter: 200 }));
        break;
      case 'legend':
        body.push(docxTable(['Colour means'], (d.rows || []).map(r => [r.label]), pal));
        body.push(docxP('', { spaceAfter: 200 }));
        break;
      case 'access':
      case 'table':
        body.push(docxTable(d.columns, d.rows, pal,
          { head: d.headFill, rows: d.rowFill, headInk: d.headInk, inks: d.rowInk }));
        body.push(docxP('', { spaceAfter: 200 }));
        break;
      case 'chart': {
        // A chart is a picture; Word gets the picture, then the numbers
        // underneath it as a table — which is the half a reader can actually
        // use in a document they are going to edit.
        const r = rects[t.id];
        if (r) body.push(addImage(dashPptxCropData(canvas, r.x, r.y, r.w, r.h), r.w, r.h, t.title || 'Chart'));
        const labels = d.labels || [];
        const series = d.series || [];
        if (labels.length && series.length) {
          // The corner cell names what every number under it is. Blank leaves a
          // table of bare figures whose units live only in the picture above.
          body.push(docxTable([d.yTitle || ''].concat(labels),
            // Printed the way the picture above prints them: a chart drawn in
            // rupees to one decimal with a table of bare integers under it is
            // two different answers to the same question on one page.
            series.map(s => [s.name].concat(labels.map((_, i) =>
              dashModelNum(s.values[i], d.numFmt)))), pal));
        }
        // Scores are a fraction of a ceiling, and the table above prints only
        // the numerator. Saying so once under the table is the difference
        // between a score and a number.
        if (d.max) body.push(docxP('Scored out of ' + d.max + '.', { size: 9, color: pal.dim }));
        body.push(docxP('', { spaceAfter: 200 }));
        break;
      }
      case 'comment':
        if (d.body) body.push(docxP(d.body, { size: 10, spaceAfter: 200 }));
        break;

      case 'rating':
        // The badge is a graphic; in a document the same fact is a sentence,
        // which is also the half somebody can edit.
        body.push(docxP((d.label ? d.label + ' \u2014 ' : '')
          + (d.value == null ? 'not rated' : d.value + ' out of ' + (d.max || 10)),
          { size: 11, bold: true }));
        if (d.note) body.push(docxP(d.note, { size: 9, color: pal.dim, spaceAfter: 200 }));
        else body.push(docxP('', { spaceAfter: 200 }));
        break;

      case 'slicer':
        body.push(docxP((d.picked && d.picked.length ? d.picked : d.items || []).join(', '),
          { size: 9, color: pal.dim, spaceAfter: 200 }));
        break;
      default:
        break;
    }
  });

  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="' + DOCX_W_NS + '" xmlns:r="' + DOCX_R_NS + '">'
    + '<w:body>' + body.join('')
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
    + '</w:body></w:document>';

  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="jpg" ContentType="image/jpeg"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="' + DOCX_PKG_REL_NS + '">'
    + '<Relationship Id="rId1" Type="' + DOCX_R_NS + '/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  zip.file('word/document.xml', doc);
  zip.file('word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="' + DOCX_PKG_REL_NS + '">'
    + images.map(im => '<Relationship Id="' + im.rId + '" Type="' + DOCX_R_NS + '/image" Target="'
      + im.file + '"/>').join('')
    + '</Relationships>');
  images.forEach(im => zip.file('word/' + im.file, im.bytes));

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  return { blob, sections: model.ordered.length };
}
