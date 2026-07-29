/**
 * project/xlsx.js — a minimal .xlsx reader and writer.
 *
 * WHY NOT A LIBRARY
 *
 * SheetJS is the obvious answer and it is ~300 KB for what amounts to reading
 * one rectangle of text out of a zip. An .xlsx *is* a zip of XML, and JSZip is
 * already vendored for the PPTX exporter, so the whole cost here is knowing
 * which four files to look at. The app has no build step and every kilobyte is
 * parsed on every page load, so a dependency that large has to earn its place;
 * this one does not.
 *
 * WHAT IS SUPPORTED
 *
 * Reading: the first worksheet, as a grid of strings. Shared strings, inline
 * strings and raw values. Not formulas (the cached result is used), not dates
 * as dates, not styles. That is exactly enough for a data-entry sheet.
 *
 * Writing: text cells, a styled header row, column widths, and — the part that
 * matters for a template someone has to fill in by hand — **data validation
 * dropdowns**, including one whose list is the Name column, so "Route to"
 * offers the other rows instead of asking the operator to retype a name.
 *
 * The generated file is deliberately minimal OOXML: fewer parts means fewer
 * ways to produce something Excel refuses to open. The PPTX exporter in this
 * repo exists partly to repair that class of defect, and the lesson taken from
 * it is to emit less, not more.
 */

/* ---------------------------------------------------------------------------
 * Reading
 * ------------------------------------------------------------------------- */

/** `A1` → `{col: 0, row: 0}`; `AB12` → `{col: 27, row: 11}`. */
function cellRefToIndex(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref || '').toUpperCase());
  if (!m) return null;
  let col = 0;
  for (let i = 0; i < m[1].length; i++) col = col * 26 + (m[1].charCodeAt(i) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

/** 0 → `A`, 27 → `AB`. */
function colIndexToRef(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - r) / 26); }
  return s;
}

/** Concatenated text of every `<t>` under a node — shared strings can be split into runs. */
function xlsxText(node) {
  if (!node) return '';
  const ts = node.getElementsByTagName('t');
  let out = '';
  for (let i = 0; i < ts.length; i++) out += ts[i].textContent;
  return out;
}

/**
 * Read the first worksheet of an .xlsx as a grid of trimmed strings.
 *
 * Rows and columns are padded so the result is rectangular: a sheet where one
 * row stops early would otherwise silently shift every column after it, which
 * is the kind of bug that turns a longitude into a route name.
 *
 * @param {ArrayBuffer} buf
 * @returns {Promise<string[][]>}
 */
async function readXlsx(buf) {
  if (typeof JSZip === 'undefined') throw new Error('JSZip is not loaded.');
  const zip = await JSZip.loadAsync(buf);
  const parse = xml => new DOMParser().parseFromString(xml, 'application/xml');
  const read = async path => {
    const f = zip.file(path);
    return f ? f.async('string') : null;
  };

  const wbXml = await read('xl/workbook.xml');
  if (!wbXml) throw new Error('That does not look like an Excel file.');

  // Follow workbook → relationship → worksheet part, rather than assuming
  // sheet1.xml: Excel renumbers parts when sheets are deleted, and a file that
  // has been edited a few times often has its first sheet at sheet3.xml.
  const wb = parse(wbXml);
  const sheetEl = wb.getElementsByTagName('sheet')[0];
  const rid = sheetEl && (sheetEl.getAttribute('r:id') || sheetEl.getAttribute('id'));
  let target = 'worksheets/sheet1.xml';
  const relsXml = await read('xl/_rels/workbook.xml.rels');
  if (relsXml && rid) {
    const rels = parse(relsXml).getElementsByTagName('Relationship');
    for (let i = 0; i < rels.length; i++) {
      if (rels[i].getAttribute('Id') === rid) { target = rels[i].getAttribute('Target'); break; }
    }
  }
  const sheetPath = ('xl/' + String(target).replace(/^\/?xl\//, '').replace(/^\//, ''));

  // Shared strings: Excel stores repeated text once and refers to it by index.
  const shared = [];
  const ssXml = await read('xl/sharedStrings.xml');
  if (ssXml) {
    const sis = parse(ssXml).getElementsByTagName('si');
    for (let i = 0; i < sis.length; i++) shared.push(xlsxText(sis[i]));
  }

  const wsXml = await read(sheetPath);
  if (!wsXml) throw new Error('The Excel file has no readable worksheet.');
  const rowEls = parse(wsXml).getElementsByTagName('row');

  const grid = [];
  let width = 0;
  for (let i = 0; i < rowEls.length; i++) {
    const cells = rowEls[i].getElementsByTagName('c');
    // Honour the row's own index: a sheet with blank rows in the middle would
    // otherwise close the gap and misalign nothing visible until much later.
    const rIdx = parseInt(rowEls[i].getAttribute('r'), 10) - 1;
    const row = grid[isNaN(rIdx) ? grid.length : rIdx] || [];
    for (let j = 0; j < cells.length; j++) {
      const c = cells[j];
      const pos = cellRefToIndex(c.getAttribute('r'));
      const type = c.getAttribute('t');
      let val = '';
      if (type === 's') {
        const v = c.getElementsByTagName('v')[0];
        val = v ? (shared[parseInt(v.textContent, 10)] || '') : '';
      } else if (type === 'inlineStr') {
        val = xlsxText(c.getElementsByTagName('is')[0]);
      } else {
        const v = c.getElementsByTagName('v')[0];
        val = v ? v.textContent : '';
      }
      const col = pos ? pos.col : j;
      row[col] = String(val).trim();
      if (col + 1 > width) width = col + 1;
    }
    grid[isNaN(rIdx) ? grid.length : rIdx] = row;
  }

  // Rectangularise, and keep blank rows in place.
  //
  // Dropping them would renumber everything below: the report would say "row 3"
  // for something the operator sees on row 5, and send them to the wrong line
  // of their own spreadsheet to fix it. Blank rows are discarded later, by
  // parseSheetGrid, once each record has already recorded where it came from.
  // A plain `map` cannot be used because `grid` is sparse — map skips holes.
  const out = [];
  for (let i = 0; i < grid.length; i++) {
    const r = grid[i] || [];
    const row = [];
    for (let j = 0; j < width; j++) row.push(r[j] != null ? r[j] : '');
    out.push(row);
  }
  while (out.length && out[out.length - 1].every(v => v === '')) out.pop();
  return out;
}

/* ---------------------------------------------------------------------------
 * CSV — the fallback that always works
 * ------------------------------------------------------------------------- */

/**
 * Parse CSV, including quoted fields containing commas and newlines.
 *
 * Hand-rolled rather than split(',') because the very first column of this
 * template is a place name and the second is `19.07, 72.87` — both of which
 * contain the delimiter as a matter of course.
 * @param {string} text @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = String(text).replace(/^﻿/, '');   // strip Excel's UTF-8 BOM

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field.trim()); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  row.push(field.trim());
  rows.push(row);
  // Interior blank lines are kept so row numbers still match the file the
  // operator is looking at; only trailing ones are dropped.
  while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
  return rows;
}

/** Quote a CSV field only when it needs it. */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** @param {Array<Array<*>>} rows @returns {string} */
function buildCsv(rows) {
  // The BOM is what makes Excel open a UTF-8 CSV without mangling accented
  // place names, which is most of them.
  return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

/* ---------------------------------------------------------------------------
 * Writing
 * ------------------------------------------------------------------------- */

const XL_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XL_R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** XML-escape a cell value. */
function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One worksheet's XML.
 *
 * Every cell is written as an inline string. That skips the shared-strings part
 * entirely — one fewer part to get wrong — at the cost of a slightly larger
 * file, which for a few hundred rows is irrelevant.
 *
 * @param {object} sheet
 * @param {Array<Array<*>>} sheet.rows      Row 0 is treated as the header.
 * @param {number[]}        [sheet.widths]  Column widths, in characters.
 * @param {object[]}        [sheet.validations] `{col, rows:[from,to], list|formula}`
 * @param {boolean}         [sheet.freezeHeader]
 * @returns {string}
 */
function sheetXml(sheet) {
  const rows = sheet.rows || [];
  const body = rows.map((cells, r) => {
    const cs = cells.map((v, c) => {
      if (v == null || v === '') return '';
      // Style 1 = header (bold on navy); style 2 = forced text, so a coordinate
      // pair is never reinterpreted by Excel's number parser.
      const style = r === 0 ? ' s="1"' : ' s="2"';
      return `<c r="${colIndexToRef(c)}${r + 1}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cs}</row>`;
  }).join('');

  const cols = (sheet.widths || []).length
    ? '<cols>' + sheet.widths.map((w, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
    : '';

  // A frozen header row is not decoration on a sheet someone scrolls through
  // twenty rows of: it is the only thing keeping column 4 identifiable.
  const pane = sheet.freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '';

  // Order inside <worksheet> is fixed by the schema: sheetViews, cols,
  // sheetData, then dataValidations. Excel rejects the file if they are swapped.
  const dv = (sheet.validations || []).length
    ? '<dataValidations count="' + sheet.validations.length + '">' +
    sheet.validations.map(v => {
      const ref = colIndexToRef(v.col);
      const sqref = `${ref}${v.rows[0]}:${ref}${v.rows[1]}`;
      const f1 = v.list ? '"' + v.list.join(',') + '"' : v.formula;
      return '<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="0" ' +
        `sqref="${sqref}"><formula1>${xmlEsc(f1)}</formula1></dataValidation>`;
    }).join('') + '</dataValidations>'
    : '';

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<worksheet xmlns="${XL_NS}" xmlns:r="${XL_R_NS}">${pane}${cols}` +
    `<sheetData>${body}</sheetData>${dv}</worksheet>`;
}

/** Minimal styles: default, header (bold white on navy), and forced-text. */
function stylesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<styleSheet xmlns="${XL_NS}">` +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF0A1E3C"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    // numFmtId 49 is "@" — text. Without it Excel helpfully reformats
    // "19.076090, 72.877426" the moment someone opens and saves the file.
    '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    // The named-style table. Omitting it is not fatal — Excel substitutes its
    // own — but strict readers warn that the workbook has no default style, and
    // a warning on a file we hand to someone else is worth one line to avoid.
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

/**
 * Build an .xlsx workbook.
 * @param {{name:string, rows:Array<Array<*>>, widths?:number[], validations?:object[], freezeHeader?:boolean}[]} sheets
 * @returns {Promise<Blob>}
 */
async function writeXlsx(sheets) {
  if (typeof JSZip === 'undefined') throw new Error('JSZip is not loaded.');
  const zip = new JSZip();
  const n = sheets.length;

  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map((s, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>');

  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${XL_R_NS}/officeDocument" Target="xl/workbook.xml"/>` +
    '</Relationships>');

  zip.file('xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<workbook xmlns="${XL_NS}" xmlns:r="${XL_R_NS}"><sheets>` +
    sheets.map((s, i) =>
      `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>');

  zip.file('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    sheets.map((s, i) =>
      `<Relationship Id="rId${i + 1}" Type="${XL_R_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${n + 1}" Type="${XL_R_NS}/styles" Target="styles.xml"/>` +
    '</Relationships>');

  zip.file('xl/styles.xml', stylesXml());
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    compression: 'DEFLATE',
  });
}

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { cellRefToIndex, colIndexToRef, parseCsv, buildCsv, csvCell, sheetXml, stylesXml, xmlEsc };
}
