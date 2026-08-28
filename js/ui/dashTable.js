/**
 * ui/dashTable.js — the table's spreadsheet behaviour: selection, paste, sizing.
 *
 * WHY A SELECTION MODEL AT ALL. The first version of the table's formatting put
 * one control per column in the format pane — an alignment row for "Place", one
 * for "km", one for each column somebody added. That is a pane that grows with
 * the data, it cannot express "these three cells", and it has no answer for a
 * single row. A spreadsheet solves all of that the same way: you select, then
 * you format what is selected. One control, any shape of target.
 *
 * WHAT A SELECTION IS. A rectangle of cells: `{ id, r0, c0, r1, c1 }` where the
 * row index is 0-based into `card.rows` and −1 is the header row. r0/c0 is the
 * anchor — where the drag started — and r1/c1 the focus, so shift-click and
 * shift-arrow extend from the anchor rather than from wherever the pointer
 * happens to be. Stored unnormalised for that reason; read it through
 * dashSelBox(), which sorts the corners.
 *
 * WHY A FRAME RATHER THAN CLICKING THE DATA. Column tabs across the top and row
 * numbers down the side, exactly as a spreadsheet has them. The alternative —
 * clicking a header cell to select its column — collides with the header cell
 * being the place you rename the column, and every gesture would then have to
 * be a double-click or a modifier. The frame is only drawn in edit mode, so a
 * finished card and every export are untouched by it.
 *
 * THE FRAME IS ALSO THE HANDLE. A column tab's right edge drags the column's
 * width and a row number's bottom edge drags its height, which is where a
 * spreadsheet puts them and means those two features cost no extra chrome.
 */

/** The live selection, or null. Rows: −1 is the header. @type {object|null} */
let dashTableSel = null;

/** Column tabs are lettered, as in a spreadsheet: A, B, … Z, AA, AB. */
function dashColName(i) {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

/**
 * The selection as a sorted rectangle, clamped to the card.
 * @param {object} card @returns {{top:number,left:number,bottom:number,right:number}|null}
 */
function dashSelBox(card) {
  const s = dashTableSel;
  if (!s || !card || s.id !== card.id) return null;
  const rowN = (card.rows || []).length, colN = (card.columns || []).length;
  if (!colN) return null;
  const top = Math.max(-1, Math.min(s.r0, s.r1));
  const bottom = Math.min(rowN - 1, Math.max(s.r0, s.r1));
  const left = Math.max(0, Math.min(s.c0, s.c1));
  const right = Math.min(colN - 1, Math.max(s.c0, s.c1));
  if (bottom < top || right < left) return null;
  return { top, left, bottom, right };
}

/**
 * Every cell in the selection, as `[row, col]` pairs.
 * @param {object} card @returns {Array<Array<number>>}
 */
function dashSelCells(card) {
  const b = dashSelBox(card);
  if (!b) return [];
  const out = [];
  for (let r = b.top; r <= b.bottom; r++) for (let c = b.left; c <= b.right; c++) out.push([r, c]);
  return out;
}

/** The default border colour: mid grey, legible on a light board and a dark one. */
const DASH_BORDER_INK = '#7f8fad';

/** @param {number} r @param {number} c @returns {string} the key a cell's style is stored under */
function dashCellKey(r, c) { return r + ':' + c; }

/**
 * Read one styling property for a cell, through the three levels that can set it.
 *
 * CELL, THEN COLUMN, THEN CARD. A value set on the cell is the most specific
 * thing anybody said about it and wins. A column-tab selection writes to the
 * column so that rows added later inherit it — which is what selecting a whole
 * column in a spreadsheet means, and what writing to every cell instead would
 * quietly fail to do.
 *
 * @param {object} card @param {number} r @param {number} c @param {string} k
 * @returns {*} the value, or undefined
 */
function dashCellStyle(card, r, c, k) {
  const cs = card.cellStyle && card.cellStyle[dashCellKey(r, c)];
  if (cs && cs[k] != null) return cs[k];
  const col = card.colStyle && card.colStyle[c];
  if (col && col[k] != null) return col[k];
  // The older per-column alignment, so a board saved before the selection
  // model existed still reads the way it was left.
  if (k === 'align' && card.colAlign && card.colAlign[c]) return card.colAlign[c];
  const all = card.tableStyle;
  if (all && all[k] != null) return all[k];
  return undefined;
}

/**
 * Write one styling property across the selection.
 *
 * A selection that spans every body row of a column is stored ON the column,
 * not as N identical cell entries: it is the same statement, it survives a row
 * being added, and it keeps the saved project small on a long table.
 *
 * @param {object} card @param {string} k @param {*} v null to clear
 */
function dashSelApply(card, k, v) {
  const b = dashSelBox(card);
  if (!b) return;
  const rowN = (card.rows || []).length;
  const wholeCols = b.top <= -1 && b.bottom >= rowN - 1;

  for (let c = b.left; c <= b.right; c++) {
    if (wholeCols) {
      card.colStyle = card.colStyle || {};
      const s = Object.assign({}, card.colStyle[c]);
      if (v == null) delete s[k]; else s[k] = v;
      if (Object.keys(s).length) card.colStyle[c] = s; else delete card.colStyle[c];
      // A column-wide statement supersedes anything said about its cells, or
      // the older per-cell values would go on overriding the new one for ever.
      for (let r = -1; r < rowN; r++) {
        const cs = card.cellStyle && card.cellStyle[dashCellKey(r, c)];
        if (cs && cs[k] != null) { delete cs[k]; if (!Object.keys(cs).length) delete card.cellStyle[dashCellKey(r, c)]; }
      }
      continue;
    }
    for (let r = b.top; r <= b.bottom; r++) {
      card.cellStyle = card.cellStyle || {};
      const key = dashCellKey(r, c);
      const s = Object.assign({}, card.cellStyle[key]);
      if (v == null) delete s[k]; else s[k] = v;
      if (Object.keys(s).length) card.cellStyle[key] = s; else delete card.cellStyle[key];
    }
  }
}

/**
 * What the selection currently says about one property.
 * @param {object} card @param {string} k
 * @returns {*} the shared value, or undefined where the cells disagree
 */
function dashSelValue(card, k) {
  const cells = dashSelCells(card);
  if (!cells.length) return undefined;
  let v; let first = true;
  for (const [r, c] of cells) {
    const x = dashCellStyle(card, r, c, k);
    if (first) { v = x; first = false; } else if (x !== v) return undefined;
  }
  return v;
}

/** The inline style one cell carries, as a style attribute fragment. */
function dashCellCss(card, r, c) {
  let s = '';
  const al = dashCellStyle(card, r, c, 'align');
  if (al) s += 'text-align:' + al + ';';
  const sz = dashCellStyle(card, r, c, 'size');
  if (sz) s += 'font-size:' + (+sz) + 'px;';
  const fill = dashCellStyle(card, r, c, 'fill');
  if (fill) s += 'background:' + fill + ';';
  const ink = dashCellStyle(card, r, c, 'ink');
  if (ink) s += 'color:' + ink + ';';
  else if (fill && typeof dashInkOn === 'function') s += 'color:' + dashInkOn(fill) + ';';
  // Borders, as Excel means them: each edge on or off, in one colour.
  const bd = dashCellStyle(card, r, c, 'bd');
  if (bd) {
    // A LITERAL, NEVER `currentColor`. html2canvas parses this string itself
    // and throws on a colour it cannot resolve — "unsupported color function"
    // — which does not fail the cell, it fails the whole export: one bordered
    // cell on the board and the PNG, PDF, deck and Word file all stop. The
    // default is a mid grey that reads on both the light and the dark board,
    // since an inline style cannot follow a theme.
    const col = dashCellStyle(card, r, c, 'bdc') || DASH_BORDER_INK;
    // 2px, not 1.5. The table collapses its borders, and in that mode the
    // browser resolves the two cells either side of an edge to one line and
    // rounds the width — a 1.5px border came back out of getComputedStyle as
    // 1px, indistinguishable from the edit-mode grid it is drawn over.
    const w = '2px solid ' + col;
    if (bd.indexOf('t') >= 0) s += 'border-top:' + w + ';';
    if (bd.indexOf('r') >= 0) s += 'border-right:' + w + ';';
    if (bd.indexOf('b') >= 0) s += 'border-bottom:' + w + ';';
    if (bd.indexOf('l') >= 0) s += 'border-left:' + w + ';';
  }
  return s;
}

/* ---- the text transforms ------------------------------------------------- */

/**
 * Title Case, the way a person means it.
 *
 * Not `toUpperCase()` on every first letter: "ANDHERI EAST" has to come back as
 * "Andheri East", which means lowercasing the rest of each word — the half a
 * naive implementation leaves alone, so shouting stays shouting. Words joined
 * by an apostrophe or a hyphen are two words, so O'BRIEN and NAVI-MUMBAI come
 * back right rather than as O'brien and Navi-mumbai.
 *
 * @param {string} s @returns {string}
 */
function dashProperCase(s) {
  return String(s).toLowerCase().replace(/(^|[\s([{"'‘“\-\/])([a-zà-ɏ])/g,
    (m, pre, ch) => pre + ch.toUpperCase());
}

/** @param {string} mode 'upper'|'lower'|'proper' @param {string} s @returns {string} */
function dashCaseText(mode, s) {
  const t = String(s == null ? '' : s);
  return mode === 'upper' ? t.toUpperCase()
    : mode === 'lower' ? t.toLowerCase()
      : dashProperCase(t);
}

/**
 * Recase every cell in the selection.
 *
 * A transform of the text, not a style: `text-transform: uppercase` would look
 * right on screen and export the original casing into the file, and would be
 * undone by the next person who edited the cell. This changes what is stored,
 * which is what a spreadsheet's UPPER() ends up doing too.
 *
 * @param {object} card @param {string} mode
 */
function dashSelCase(card, mode) {
  dashSelCells(card).forEach(([r, c]) => {
    if (r < 0) {
      if (card.columns && card.columns[c] != null) card.columns[c] = dashCaseText(mode, card.columns[c]);
    } else if (card.rows && card.rows[r]) {
      card.rows[r][c] = dashCaseText(mode, card.rows[r][c]);
    }
  });
}

/* ---- pasting a block out of a spreadsheet -------------------------------- */

/**
 * Parse what a spreadsheet puts on the clipboard.
 *
 * Excel, Sheets and Numbers all write the same thing as `text/plain`: rows
 * separated by newlines, cells by tabs, and any cell containing a tab, newline
 * or quote wrapped in double quotes with its own quotes doubled. The quoting is
 * the part a `split('\t')` gets wrong, and it is not rare — an address with a
 * comma is fine, but a cell somebody wrote two lines in is quoted, and naive
 * splitting turns one row into three.
 *
 * @param {string} text @returns {Array<Array<string>>}
 */
function dashParseTsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') { q = true; continue; }
    if (ch === '\t') { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  // A trailing newline is a line ending, not an empty row.
  while (rows.length && rows[rows.length - 1].every(c => c === '')) rows.pop();
  return rows;
}

/**
 * Write a parsed block into the table, starting at the selection's top-left.
 *
 * GROWS TO FIT. Ten rows pasted into a three-row table become ten rows; four
 * columns pasted into a two-column table become four. Clipping instead would
 * silently drop most of what somebody pasted, and they would not know which
 * part they lost.
 *
 * @param {object} card @param {Array<Array<string>>} grid
 * @returns {{rows:number, cols:number}} what was written
 */
function dashPasteGrid(card, grid) {
  if (!grid.length) return { rows: 0, cols: 0 };
  const b = dashSelBox(card) || { top: 0, left: 0 };
  let r0 = b.top, c0 = b.left;
  card.columns = card.columns || [];
  card.rows = card.rows || [];

  const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
  while (card.columns.length < c0 + width) card.columns.push('Column ' + (card.columns.length + 1));
  card.rows.forEach(r => { while (r.length < card.columns.length) r.push(''); });

  // Pasting onto the header writes the header from the first line, then the
  // body from the rest — which is what dropping a spreadsheet's own header row
  // onto ours should do.
  let g = 0;
  if (r0 < 0) {
    grid[0].forEach((v, i) => { card.columns[c0 + i] = v; });
    g = 1; r0 = 0;
  }
  const bodyRows = grid.length - g;
  while (card.rows.length < r0 + bodyRows) {
    card.rows.push(new Array(card.columns.length).fill(''));
  }
  for (let i = g; i < grid.length; i++) {
    const target = card.rows[r0 + i - g];
    grid[i].forEach((v, j) => { target[c0 + j] = v; });
  }
  dashTableSel = { id: card.id, r0: r0, c0: c0, r1: r0 + bodyRows - 1, c1: c0 + width - 1 };
  return { rows: bodyRows, cols: width };
}

/**
 * The selection as text a spreadsheet will accept back.
 * @param {object} card @returns {string}
 */
function dashSelTsv(card) {
  const b = dashSelBox(card);
  if (!b) return '';
  const q = v => {
    const s = String(v == null ? '' : v);
    return /[\t\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [];
  for (let r = b.top; r <= b.bottom; r++) {
    const line = [];
    for (let c = b.left; c <= b.right; c++) {
      line.push(q(r < 0 ? (card.columns || [])[c] : ((card.rows || [])[r] || [])[c]));
    }
    out.push(line.join('\t'));
  }
  return out.join('\n');
}

/* ---- gestures ------------------------------------------------------------ */

/** Redraw the table in place, so a selection change does not rebuild the board. */
function dashSelPaint() {
  const card = dashTableSel && typeof dashCardById === 'function' ? dashCardById(dashTableSel.id) : null;
  if (!card) return;
  const host = document.querySelector('#dashGrid .dash-card[data-card="' + card.id + '"] .dc-body');
  if (!host) return;
  const box = dashSelBox(card);
  host.querySelectorAll('.dc-cell').forEach(el => {
    const r = +el.dataset.r, c = +el.dataset.c;
    el.classList.toggle('dc-sel', !!box && r >= box.top && r <= box.bottom && c >= box.left && c <= box.right);
  });
  host.querySelectorAll('.dc-coltab').forEach(el => {
    const c = +el.dataset.col;
    el.classList.toggle('on', !!box && c >= box.left && c <= box.right);
  });
  host.querySelectorAll('.dc-rowno').forEach(el => {
    const r = +el.dataset.row;
    el.classList.toggle('on', !!box && r >= box.top && r <= box.bottom);
  });
  if (typeof renderDashFormat === 'function') renderDashFormat();
}

/** @param {object} card @param {number} r @param {number} c @param {boolean} extend */
function dashSelSet(card, r, c, extend) {
  if (extend && dashTableSel && dashTableSel.id === card.id) {
    dashTableSel.r1 = r; dashTableSel.c1 = c;
  } else {
    dashTableSel = { id: card.id, r0: r, c0: c, r1: r, c1: c };
  }
  dashSelPaint();
}

/** Everything, header included — what Ctrl-A means inside a sheet. */
function dashSelAll(card) {
  dashTableSel = { id: card.id, r0: -1, c0: 0,
    r1: (card.rows || []).length - 1, c1: (card.columns || []).length - 1 };
  dashSelPaint();
}

(function wireDashTable() {
  const app = document.getElementById('app');
  if (!app) return;

  const cardOf = el => {
    const host = el && el.closest && el.closest('.dash-card');
    return host && typeof dashCardById === 'function' ? dashCardById(host.dataset.card) : null;
  };

  let dragging = null;   // a cell drag-select
  let sizing = null;     // a column-width or row-height drag

  app.addEventListener('pointerdown', e => {
    if (!dashEditing) return;

    // The grips first: they sit inside the tab they size, so a hit on one must
    // not also read as "select this column".
    const grip = e.target.closest('[data-wcol], [data-hrow]');
    if (grip) {
      const card = cardOf(grip);
      if (!card) return;
      e.preventDefault();
      const isCol = grip.hasAttribute('data-wcol');
      const i = +(isCol ? grip.dataset.wcol : grip.dataset.hrow);
      const cellEl = isCol
        ? grip.closest('table').querySelector('.dc-cell[data-c="' + i + '"]')
        : grip.closest('tr');
      const start = isCol ? cellEl.getBoundingClientRect().width : cellEl.getBoundingClientRect().height;
      sizing = { card, isCol, i, start, from: isCol ? e.clientX : e.clientY };
      grip.setPointerCapture(e.pointerId);
      return;
    }

    // The tab's × is a delete, not a selection. Without this the pointerdown
    // selected the column and the click then deleted it, which works but flashes
    // a selection nobody asked for on the way out.
    if (e.target.closest('[data-drop-col]')) return;

    const tab = e.target.closest('.dc-coltab');
    if (tab) {
      const card = cardOf(tab);
      if (!card) return;
      e.preventDefault();
      const c = +tab.dataset.col;
      const last = (card.rows || []).length - 1;
      if (e.shiftKey && dashTableSel && dashTableSel.id === card.id) {
        dashTableSel.c1 = c; dashTableSel.r0 = -1; dashTableSel.r1 = last;
        dashSelPaint();
      } else {
        dashTableSel = { id: card.id, r0: -1, c0: c, r1: last, c1: c };
        dashSelPaint();
      }
      dragging = { card, kind: 'col' };
      return;
    }

    const rno = e.target.closest('.dc-rowno');
    if (rno) {
      const card = cardOf(rno);
      if (!card) return;
      e.preventDefault();
      const r = +rno.dataset.row;
      const lastC = (card.columns || []).length - 1;
      if (e.shiftKey && dashTableSel && dashTableSel.id === card.id) {
        dashTableSel.r1 = r; dashTableSel.c0 = 0; dashTableSel.c1 = lastC;
        dashSelPaint();
      } else {
        dashTableSel = { id: card.id, r0: r, c0: 0, r1: r, c1: lastC };
        dashSelPaint();
      }
      dragging = { card, kind: 'row' };
      return;
    }

    if (e.target.closest('.dc-selall')) {
      const card = cardOf(e.target);
      if (card) { e.preventDefault(); dashSelAll(card); }
      return;
    }

    const cell = e.target.closest('.dc-cell');
    if (cell) {
      const card = cardOf(cell);
      if (!card) return;
      // NOT preventDefault: the cell is contenteditable and a click has to put
      // the caret in it. Selecting and typing are the same gesture in a sheet.
      dashSelSet(card, +cell.dataset.r, +cell.dataset.c, e.shiftKey);
      dragging = { card, kind: 'cell' };
    }
  });

  app.addEventListener('pointermove', e => {
    if (sizing) {
      const d = (sizing.isCol ? e.clientX : e.clientY) - sizing.from;
      const v = Math.max(sizing.isCol ? 36 : 22, Math.round(sizing.start + d));
      const card = sizing.card;
      if (sizing.isCol) { card.colW = card.colW || {}; card.colW[sizing.i] = v; }
      else { card.rowH = card.rowH || {}; card.rowH[sizing.i] = v; }
      // Written straight onto the live element: rebuilding the card on every
      // pointermove of a drag drops the grip and the drag dies on the first
      // frame.
      const table = document.querySelector('#dashGrid .dash-card[data-card="' + card.id + '"] table');
      if (table) {
        if (sizing.isCol) {
          const col = table.querySelectorAll('colgroup col')[sizing.i + 1];
          if (col) col.style.width = v + 'px';
        } else {
          const tr = sizing.i < 0 ? table.querySelector('.dc-headrow')
            : table.querySelectorAll('tbody tr')[sizing.i];
          if (tr) tr.style.height = v + 'px';
        }
      }
      return;
    }
    if (!dragging || !e.buttons) return;
    const cell = e.target.closest && e.target.closest('.dc-cell, .dc-coltab, .dc-rowno');
    if (!cell || !dashTableSel) return;
    const card = dragging.card;
    if (dragging.kind === 'col' && cell.classList.contains('dc-coltab')) {
      dashTableSel.c1 = +cell.dataset.col; dashSelPaint();
    } else if (dragging.kind === 'row' && cell.classList.contains('dc-rowno')) {
      dashTableSel.r1 = +cell.dataset.row; dashSelPaint();
    } else if (dragging.kind === 'cell' && cell.classList.contains('dc-cell')) {
      dashTableSel.r1 = +cell.dataset.r; dashTableSel.c1 = +cell.dataset.c;
      dashSelPaint();
    }
  });

  const endDrag = () => {
    if (sizing && typeof renderDashFormat === 'function') renderDashFormat();
    dragging = null; sizing = null;
  };
  app.addEventListener('pointerup', endDrag);
  app.addEventListener('pointercancel', endDrag);

  // A whole block out of a spreadsheet, in one paste.
  app.addEventListener('paste', e => {
    if (!dashEditing) return;
    const cell = e.target.closest && e.target.closest('.dc-cell');
    if (!cell) return;
    const card = cardOf(cell);
    if (!card || card.type !== 'table') return;
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    // One cell's worth of text is an ordinary paste and is left alone —
    // hijacking it would break typing a value in with the keyboard.
    if (!text || !/[\t\n]/.test(text)) return;
    e.preventDefault();
    dashTableSel = dashTableSel && dashTableSel.id === card.id
      ? dashTableSel : { id: card.id, r0: +cell.dataset.r, c0: +cell.dataset.c, r1: +cell.dataset.r, c1: +cell.dataset.c };
    const got = dashPasteGrid(card, dashParseTsv(text));
    if (typeof renderDashboard === 'function') renderDashboard();
    if (typeof status === 'function') {
      status(got.rows + (got.rows === 1 ? ' row' : ' rows') + ' × '
        + got.cols + (got.cols === 1 ? ' column' : ' columns') + ' pasted.');
    }
  }, true);

  app.addEventListener('copy', e => {
    if (!dashEditing) return;
    const cell = e.target.closest && e.target.closest('.dc-cell');
    if (!cell) return;
    const card = cardOf(cell);
    const box = card && dashSelBox(card);
    // Only a real range: copying inside one cell is the browser's job, and
    // taking it over would break copying half a word.
    if (!box || (box.top === box.bottom && box.left === box.right)) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', dashSelTsv(card));
  }, true);

  app.addEventListener('keydown', e => {
    if (!dashEditing) return;
    const cell = e.target.closest && e.target.closest('.dc-cell');
    if (!cell) return;
    const card = cardOf(cell);
    if (!card) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      dashSelAll(card);
      return;
    }
    // Shift-arrow grows the selection. Without shift the arrows are the caret's,
    // which is what typing in a cell needs them to be.
    if (!e.shiftKey || !dashTableSel || dashTableSel.id !== card.id) return;
    const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    dashTableSel.r1 = Math.max(-1, Math.min((card.rows || []).length - 1, dashTableSel.r1 + d[0]));
    dashTableSel.c1 = Math.max(0, Math.min((card.columns || []).length - 1, dashTableSel.c1 + d[1]));
    dashSelPaint();
  });
})();

/* ---- adding and removing rows and columns -------------------------------- */

/**
 * Shift the style maps after row `at` is removed.
 *
 * WHY THIS IS NOT OPTIONAL. Every per-cell style is keyed by position — 'row:col'
 * — so deleting row 2 leaves row 3's fill sitting on what is now row 2, and the
 * bottom row keeps the style of a row that no longer exists. The styles have to
 * move with the data or the table silently repaints itself every time somebody
 * deletes a line.
 *
 * @param {object} card @param {number} at
 */
function dashDropRowStyles(card, at) {
  if (card.cellStyle) {
    const next = {};
    Object.keys(card.cellStyle).forEach(k => {
      const [r, c] = k.split(':').map(Number);
      if (r === at) return;
      next[(r > at ? r - 1 : r) + ':' + c] = card.cellStyle[k];
    });
    card.cellStyle = next;
  }
  ['rowFill', 'rowInk', 'rowH'].forEach(key => {
    if (!card[key]) return;
    const next = {};
    Object.keys(card[key]).forEach(k => {
      const r = +k;
      if (r === at) return;
      next[r > at ? r - 1 : r] = card[key][k];
    });
    card[key] = next;
  });
}

/**
 * Shift the style maps after column `at` is removed.
 * @param {object} card @param {number} at
 */
function dashDropColStyles(card, at) {
  if (card.cellStyle) {
    const next = {};
    Object.keys(card.cellStyle).forEach(k => {
      const [r, c] = k.split(':').map(Number);
      if (c === at) return;
      next[r + ':' + (c > at ? c - 1 : c)] = card.cellStyle[k];
    });
    card.cellStyle = next;
  }
  ['colStyle', 'colW', 'colAlign'].forEach(key => {
    if (!card[key]) return;
    const next = {};
    Object.keys(card[key]).forEach(k => {
      const c = +k;
      if (c === at) return;
      next[c > at ? c - 1 : c] = card[key][k];
    });
    card[key] = next;
  });
}

/**
 * Insert a row or a column, carrying the styles either side of it along.
 * @param {object} card @param {string} what 'row'|'col' @param {number} at
 */
function dashInsertAt(card, what, at) {
  if (what === 'row') {
    card.rows = card.rows || [];
    card.rows.splice(at, 0, new Array((card.columns || []).length).fill(''));
    // Same reasoning as the deletes: everything below the new line moves down.
    if (card.cellStyle) {
      const next = {};
      Object.keys(card.cellStyle).forEach(k => {
        const [r, c] = k.split(':').map(Number);
        next[(r >= at && r >= 0 ? r + 1 : r) + ':' + c] = card.cellStyle[k];
      });
      card.cellStyle = next;
    }
    ['rowFill', 'rowInk', 'rowH'].forEach(key => {
      if (!card[key]) return;
      const next = {};
      Object.keys(card[key]).forEach(k => { const r = +k; next[r >= at ? r + 1 : r] = card[key][k]; });
      card[key] = next;
    });
    return;
  }
  card.columns = card.columns || [];
  card.columns.splice(at, 0, 'Column ' + (card.columns.length + 1));
  (card.rows || []).forEach(r => r.splice(at, 0, ''));
  if (card.cellStyle) {
    const next = {};
    Object.keys(card.cellStyle).forEach(k => {
      const [r, c] = k.split(':').map(Number);
      next[r + ':' + (c >= at ? c + 1 : c)] = card.cellStyle[k];
    });
    card.cellStyle = next;
  }
  ['colStyle', 'colW', 'colAlign'].forEach(key => {
    if (!card[key]) return;
    const next = {};
    Object.keys(card[key]).forEach(k => { const c = +k; next[c >= at ? c + 1 : c] = card[key][k]; });
    card[key] = next;
  });
}

/* ---- the right-click menu ------------------------------------------------ */

/**
 * The sheet's own context menu.
 *
 * Right-clicking a column letter or a row number is where a spreadsheet user
 * looks for Insert and Delete, and it is the only place Insert can live at all —
 * "+ Row" appends, and there was no way to put a row in the middle. Its own
 * element rather than the map's #ctxMenu, which is positioned inside #mapWrap
 * and would open off-screen over a board card.
 *
 * @param {object} card @param {string} what 'row'|'col' @param {number} i
 * @param {number} x @param {number} y
 */
function dashSheetMenu(card, what, i, x, y) {
  dashSheetMenuClose();
  const row = what === 'row';
  const n = row ? (card.rows || []).length : (card.columns || []).length;
  const name = row ? 'row ' + (i + 1) : 'column ' + dashColName(i);
  const el = document.createElement('div');
  el.className = 'dc-sheetmenu frost';
  el.innerHTML = '<div class="lbl">' + esc(name) + '</div>'
    + '<div class="mi" data-a="before"><span class="ico">+</span>Insert '
      + (row ? 'above' : 'to the left') + '</div>'
    + '<div class="mi" data-a="after"><span class="ico">+</span>Insert '
      + (row ? 'below' : 'to the right') + '</div>'
    + '<div class="sep"></div>'
    // The last one is the table. Offering to delete it would leave a card that
    // is neither empty nor a table, with no way back to either.
    + '<div class="mi' + (n < 2 ? ' off' : '') + '" data-a="drop"><span class="ico">×</span>Delete '
      + (row ? 'this row' : 'this column') + '</div>';
  document.body.appendChild(el);
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(6, Math.min(x, innerWidth - w - 6)) + 'px';
  el.style.top = Math.max(6, Math.min(y, innerHeight - h - 6)) + 'px';

  el.addEventListener('click', e => {
    const mi = e.target.closest('.mi');
    if (!mi || mi.classList.contains('off')) return;
    const a = mi.dataset.a;
    if (a === 'before') dashInsertAt(card, what, i);
    else if (a === 'after') dashInsertAt(card, what, i + 1);
    else if (row) { card.rows.splice(i, 1); dashDropRowStyles(card, i); }
    else {
      card.columns.splice(i, 1);
      (card.rows || []).forEach(r => r.splice(i, 1));
      dashDropColStyles(card, i);
    }
    dashTableSel = null;
    dashSheetMenuClose();
    if (typeof renderDashboard === 'function') renderDashboard();
  });
  _dashSheetMenu = el;
}

let _dashSheetMenu = null;
function dashSheetMenuClose() {
  if (_dashSheetMenu) { _dashSheetMenu.remove(); _dashSheetMenu = null; }
}

(function wireDashSheetMenu() {
  const app = document.getElementById('app');
  if (!app) return;
  app.addEventListener('contextmenu', e => {
    if (!dashEditing) return;
    const tab = e.target.closest('.dc-coltab');
    const rno = e.target.closest('.dc-rowno');
    if (!tab && !rno) return;
    const host = (tab || rno).closest('.dash-card');
    const card = host && typeof dashCardById === 'function' ? dashCardById(host.dataset.card) : null;
    if (!card) return;
    e.preventDefault();
    if (tab) dashSheetMenu(card, 'col', +tab.dataset.col, e.clientX, e.clientY);
    else {
      const r = +rno.dataset.row;
      // The header is not a row you can insert around or delete.
      if (r < 0) return;
      dashSheetMenu(card, 'row', r, e.clientX, e.clientY);
    }
  });
  document.addEventListener('pointerdown', e => {
    if (_dashSheetMenu && !e.target.closest('.dc-sheetmenu')) dashSheetMenuClose();
  }, true);
  window.addEventListener('blur', dashSheetMenuClose);
})();
