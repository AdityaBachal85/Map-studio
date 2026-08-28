/**
 * The table's spreadsheet behaviour: selection, formatting, paste, sizing.
 *
 * WHY THIS SUITE EXISTS. Every control here acts on a selection rather than on
 * a fixed target, which means each one has four ways to be wrong: it can miss
 * the selection, hit more than the selection, fail to survive the redraw, or
 * store something the export cannot read. So each assertion drives the real
 * gesture — clicking a column letter, a row number, the corner box — and then
 * reads the COMPUTED style off the cells, not the model it just wrote.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/dash-sheet.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8000';
const REPO = path.join(__dirname, '..');
const localAuthConfig = () => fs.readFileSync(path.join(REPO, 'js', 'config.js'), 'utf8')
  .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = '';")
  .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = '';");

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

/** The text alignment of every body cell, row by row. */
const alignGrid = p => p.evaluate(() =>
  Array.from(document.querySelectorAll('#dashGrid tbody tr'))
    .map(tr => Array.from(tr.querySelectorAll('.dc-cell')).map(c => getComputedStyle(c).textAlign)));

(async () => {
  const b = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const p = await (await b.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3200);

  const build = () => p.evaluate(() => {
    setAppMode('dashboard');
    dashEditing = true;
    dashTableSel = null;
    dashCards = [Object.assign(dashNewCard('table'), {
      id: 't1', title: 'Key distances', x: 0, y: 0, w: 12, h: 10,
      columns: ['CONNECTIVITY', 'DISTANCE (KM)', 'TIME'],
      rows: [['mumbai - nashik road', '2.0', '8 min'],
        ['KALYAN PADGHA ROAD', '2.4', '9 min'],
        ['Kalyan Station', '24.9', '41 min'],
        ["o'brien navi-mumbai", '6.7', '16 min']],
    })];
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    renderDashboard();
    dashSelect('t1');
  });
  await build();
  await p.waitForTimeout(800);

  /* ---- the frame ---------------------------------------------------------- */

  const frame = await p.evaluate(() => ({
    tabs: Array.from(document.querySelectorAll('#dashGrid .dc-coltab')).map(t => t.textContent.replace(/\s/g, '')),
    nums: Array.from(document.querySelectorAll('#dashGrid .dc-rowno')).map(t => t.textContent.replace(/\s/g, '')),
    corner: !!document.querySelector('#dashGrid .dc-selall'),
  }));
  ck('the table wears a spreadsheet frame: lettered columns', frame.tabs.join('') === 'ABC',
    JSON.stringify(frame.tabs));
  ck('numbered rows, starting at one rather than at zero',
    frame.nums.join(',') === ',1,2,3,4', JSON.stringify(frame.nums));
  ck('and the corner box that selects everything', frame.corner);

  const readOnly = await p.evaluate(() => {
    dashEditing = false; renderDashboard();
    const n = document.querySelectorAll('#dashGrid .dc-coltab, #dashGrid .dc-rowno, #dashGrid .dc-selall').length;
    dashEditing = true; renderDashboard(); dashSelect('t1');
    return n;
  });
  // The frame is a tool, not part of the card. A client looking at a finished
  // board — or any export, which renders out of edit mode — must never see it.
  ck('none of which is there once the board is not being edited', readOnly === 0, String(readOnly));

  /* ---- selecting ---------------------------------------------------------- */

  await p.click('#dashGrid .dc-coltab[data-col="1"]');
  await p.waitForTimeout(300);
  const col = await p.evaluate(() => ({
    box: dashSelBox(dashCardById('t1')),
    lit: document.querySelectorAll('#dashGrid .dc-cell.dc-sel').length,
    what: (document.querySelector('#dashFormat .df-selwhat') || {}).textContent,
  }));
  ck('clicking a column letter selects the column, header included',
    col.box && col.box.left === 1 && col.box.right === 1 && col.box.top === -1 && col.box.bottom === 3,
    JSON.stringify(col.box));
  ck('and every cell in it is lit', col.lit === 5, String(col.lit));
  ck('the pane names what is selected rather than guessing',
    /B/.test(col.what || '') && /5 cells/.test(col.what || ''), col.what);

  await p.click('#dashGrid .dc-rowno[data-row="2"]');
  await p.waitForTimeout(300);
  const row = await p.evaluate(() => dashSelBox(dashCardById('t1')));
  ck('clicking a row number selects that row across every column',
    row && row.top === 2 && row.bottom === 2 && row.left === 0 && row.right === 2, JSON.stringify(row));

  await p.click('#dashGrid .dc-selall');
  await p.waitForTimeout(300);
  const all = await p.evaluate(() => dashSelBox(dashCardById('t1')));
  ck('the corner box selects the whole sheet',
    all && all.top === -1 && all.bottom === 3 && all.left === 0 && all.right === 2, JSON.stringify(all));

  const ctrlA = await p.evaluate(() => {
    dashTableSel = { id: 't1', r0: 0, c0: 0, r1: 0, c1: 0 };
    const cell = document.querySelector('#dashGrid .dc-cell[data-r="0"][data-c="0"]');
    cell.focus();
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
    return dashSelBox(dashCardById('t1'));
  });
  ck('and so does ctrl-A from inside a cell, as in a sheet',
    ctrlA && ctrlA.top === -1 && ctrlA.right === 2, JSON.stringify(ctrlA));

  /* ---- formatting what is selected ---------------------------------------- */

  await p.click('#dashGrid .dc-coltab[data-col="1"]');
  await p.waitForTimeout(250);
  await p.click('#dashFormat [data-df="selalign"][data-v="right"]');
  await p.waitForTimeout(400);
  const a1 = await alignGrid(p);
  ck('aligning a selected column moves that column and no other',
    a1.every(r => r[0] === 'left' && r[1] === 'right' && r[2] === 'left'), JSON.stringify(a1[0]));

  await p.click('#dashGrid .dc-rowno[data-row="1"]');
  await p.waitForTimeout(250);
  await p.click('#dashFormat [data-df="selalign"][data-v="center"]');
  await p.waitForTimeout(400);
  const a2 = await alignGrid(p);
  ck('aligning ONE row moves only that row — the complaint this replaced',
    a2[1].every(x => x === 'center') && a2[0][0] === 'left' && a2[2][0] === 'left',
    JSON.stringify(a2));
  // A statement about a cell is more specific than one about its column, so it
  // wins — otherwise "centre this row" could never override "right-align this
  // column" and the two controls would fight.
  ck('and a cell beats the column it sits in', a2[1][1] === 'center', a2[1][1]);

  const stored = await p.evaluate(() => ({
    col: JSON.parse(JSON.stringify(dashCardById('t1').colStyle || {})),
    cells: Object.keys(dashCardById('t1').cellStyle || {}).length,
  }));
  // A whole-column statement is stored ON the column, so a row added tomorrow
  // inherits it — writing four identical cell entries would not.
  ck('a whole-column choice is stored once on the column, not per cell',
    stored.col['1'] && stored.col['1'].align === 'right', JSON.stringify(stored.col));

  const grew = await p.evaluate(() => {
    const c = dashCardById('t1');
    c.rows.push(['new row', '9.9', '20 min']);
    renderDashboard();
    return Array.from(document.querySelectorAll('#dashGrid tbody tr'))
      .map(tr => getComputedStyle(tr.querySelectorAll('.dc-cell')[1]).textAlign);
  });
  ck('so a row added later inherits it', grew[grew.length - 1] === 'right', JSON.stringify(grew));

  /* ---- font size ---------------------------------------------------------- */

  const sized = await p.evaluate(() => {
    dashTableSel = { id: 't1', r0: -1, c0: 0, r1: -1, c1: 2 };
    dashSelApply(dashCardById('t1'), 'size', 18);
    renderDashboard();
    return {
      head: Array.from(document.querySelectorAll('#dashGrid .dc-cell[data-r="-1"]'))
        .map(c => getComputedStyle(c).fontSize),
      body: getComputedStyle(document.querySelector('#dashGrid .dc-cell[data-r="0"][data-c="0"]')).fontSize,
    };
  });
  ck('a font size applies to the cells that were selected', sized.head.every(s => s === '18px'),
    JSON.stringify(sized.head));
  ck('and leaves the rest of the table alone', sized.body !== '18px', sized.body);

  /* ---- case --------------------------------------------------------------- */

  await p.evaluate(() => { dashTableSel = { id: 't1', r0: 0, c0: 0, r1: 3, c1: 0 }; renderDashFormat(); });
  await p.click('#dashFormat [data-dfcase="proper"]');
  await p.waitForTimeout(400);
  const cased = await p.evaluate(() => dashCardById('t1').rows.slice(0, 4).map(r => r[0]));
  ck('Proper case turns a shouted cell into a titled one',
    cased[1] === 'Kalyan Padgha Road', cased[1]);
  ck('and capitalises a lower-case one without shouting the rest',
    cased[0] === 'Mumbai - Nashik Road', cased[0]);
  // The naive implementation uppercases the first letter of each space-run and
  // stops, so O'BRIEN comes back as O'brien and NAVI-MUMBAI as Navi-mumbai.
  ck('an apostrophe and a hyphen each start a new word',
    cased[3] === "O'Brien Navi-Mumbai", cased[3]);

  await p.click('#dashFormat [data-dfcase="upper"]');
  await p.waitForTimeout(400);
  const upper = await p.evaluate(() => dashCardById('t1').rows[0][0]);
  ck('and UPPER shouts it back', upper === 'MUMBAI - NASHIK ROAD', upper);

  // Stored, not styled: a text-transform looks right on screen and puts the
  // original casing in the exported file.
  const notCss = await p.evaluate(() =>
    getComputedStyle(document.querySelector('#dashGrid .dc-cell[data-r="0"][data-c="0"]')).textTransform);
  ck('the case is in the text, not a CSS transform an export would drop',
    notCss === 'none', notCss);

  /* ---- pasting out of a spreadsheet --------------------------------------- */

  await build();
  await p.waitForTimeout(600);
  const tsv = ['Place\tKm\tMin']
    .concat(Array.from({ length: 10 }, (_, i) => 'Location ' + (i + 1) + '\t' + (i * 1.7 + 2).toFixed(1) + '\t' + (i * 3 + 5)))
    .join('\n');
  const pasted = await p.evaluate(t => {
    const cell = document.querySelector('#dashGrid .dc-cell[data-r="-1"][data-c="0"]');
    cell.focus();
    dashTableSel = { id: 't1', r0: -1, c0: 0, r1: -1, c1: 0 };
    const dt = new DataTransfer(); dt.setData('text/plain', t);
    cell.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    const c = dashCardById('t1');
    return { cols: c.columns, n: c.rows.length, first: c.rows[0], last: c.rows[9] };
  }, tsv);
  ck('ten rows copied out of a spreadsheet arrive as ten rows', pasted.n === 10, String(pasted.n));
  ck('the first line becomes the header, since that is where it was dropped',
    pasted.cols.join('|') === 'Place|Km|Min', pasted.cols.join('|'));
  ck('and the values land in the right cells',
    pasted.first.join('|') === 'Location 1|2.0|5' && pasted.last.join('|') === 'Location 10|17.3|32',
    JSON.stringify([pasted.first, pasted.last]));

  const wider = await p.evaluate(() => {
    const c = dashCardById('t1');
    c.columns = ['A', 'B']; c.rows = [['', '']];
    renderDashboard();
    dashTableSel = { id: 't1', r0: 0, c0: 0, r1: 0, c1: 0 };
    dashPasteGrid(c, dashParseTsv('1\t2\t3\t4\n5\t6\t7\t8'));
    return { cols: c.columns.length, rows: c.rows.length, row2: c.rows[1] };
  });
  // Clipping instead would silently drop most of what was pasted, and nobody
  // would know which part they lost.
  ck('a block wider than the table grows the table rather than being clipped',
    wider.cols === 4 && wider.rows === 2 && wider.row2.join('') === '5678', JSON.stringify(wider));

  const quoted = await p.evaluate(() => dashParseTsv('a\tb\n"two\nlines"\tz\n'));
  // A cell somebody wrote two lines in comes off the clipboard quoted, and a
  // split on newline turns that one row into three.
  ck('a quoted cell holding a newline stays one cell',
    quoted.length === 2 && quoted[1][0] === 'two\nlines', JSON.stringify(quoted));

  const doubled = await p.evaluate(() => dashParseTsv('"say ""hi"""\tx'));
  ck('and a doubled quote inside one is a single quote',
    doubled[0][0] === 'say "hi"', JSON.stringify(doubled[0]));

  const back = await p.evaluate(() => {
    const c = dashCardById('t1');
    c.columns = ['A', 'B']; c.rows = [['one', 'two'], ['three', 'fo\tur']];
    dashTableSel = { id: 't1', r0: 0, c0: 0, r1: 1, c1: 1 };
    return dashSelTsv(c);
  });
  ck('a selection copies back out as something a spreadsheet will take',
    back === 'one\ttwo\nthree\t"fo\tur"', JSON.stringify(back));

  /* ---- borders ------------------------------------------------------------ */

  const bord = await p.evaluate(() => {
    const c = dashCardById('t1');
    c.columns = ['A', 'B', 'C']; c.rows = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']];
    c.cellStyle = {};
    renderDashboard();
    dashTableSel = { id: 't1', r0: 0, c0: 0, r1: 2, c1: 2 };
    dashFormatApply(c, 'selbd:out', '1');
    renderDashboard();
    const w = (r, cc, side) => getComputedStyle(
      document.querySelector('#dashGrid .dc-cell[data-r="' + r + '"][data-c="' + cc + '"]'))['border' + side + 'Width'];
    return {
      cornerTop: w(0, 0, 'Top'), cornerLeft: w(0, 0, 'Left'),
      middleTop: w(1, 1, 'Top'), middleLeft: w(1, 1, 'Left'),
      bottomRight: w(2, 2, 'Bottom'),
    };
  });
  // Outline is the whole point of a border tool: every edge of every cell is
  // what "All" means, and a per-cell toggle cannot express the difference.
  ck('an outline draws the outside of the block', bord.cornerTop === '2px' && bord.cornerLeft === '2px',
    JSON.stringify(bord));
  ck('and leaves the inside of it alone', bord.middleTop !== '2px' && bord.middleLeft !== '2px',
    bord.middleTop + '/' + bord.middleLeft);

  const bAll = await p.evaluate(() => {
    dashFormatApply(dashCardById('t1'), 'selbd:all', '1');
    renderDashboard();
    return getComputedStyle(document.querySelector('#dashGrid .dc-cell[data-r="1"][data-c="1"]')).borderTopWidth;
  });
  ck('All reaches the cells in the middle too', bAll === '2px', bAll);

  const bNone = await p.evaluate(() => {
    dashFormatApply(dashCardById('t1'), 'selbd:none', '1');
    renderDashboard();
    const c = dashCardById('t1');
    return Object.keys(c.cellStyle || {}).filter(k => (c.cellStyle[k] || {}).bd).length;
  });
  ck('and None takes them all off', bNone === 0, String(bNone));

  /* ---- widths and heights -------------------------------------------------- */

  const sizes = await p.evaluate(() => {
    const c = dashCardById('t1');
    c.colW = { 0: 220 }; c.rowH = { 1: 70 };
    renderDashboard();
    return {
      w: Math.round(document.querySelector('#dashGrid .dc-cell[data-r="0"][data-c="0"]').getBoundingClientRect().width),
      h: Math.round(document.querySelectorAll('#dashGrid tbody tr')[1].getBoundingClientRect().height),
      grips: document.querySelectorAll('#dashGrid [data-wcol]').length,
      rgrips: document.querySelectorAll('#dashGrid [data-hrow]').length,
    };
  });
  ck('a column takes the width it was given', sizes.w === 220, String(sizes.w));
  ck('and a row the height', sizes.h === 70, String(sizes.h));
  ck('every column tab and row number carries a drag handle',
    sizes.grips === 3 && sizes.rgrips === 4, JSON.stringify([sizes.grips, sizes.rgrips]));

  /* ---- the gestures a real mouse makes ------------------------------------ */

  // SYNTHETIC POINTER EVENTS ARE NOT ENOUGH HERE. Dragging from a cell used to
  // pick the CARD up and slide it across the board — the card-drag handler
  // starts from anywhere that is not a button or a contenteditable, and the
  // sheet frame is neither. Driven with the real mouse, because that is the
  // gesture that was broken and dispatched events did not reproduce it.
  await build();
  await p.waitForTimeout(500);
  const at = async sel => p.evaluate(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel);
  const mouseDrag = async (from, to) => {
    const a = await at(from), c = await at(to);
    await p.mouse.move(a.x, a.y);
    await p.mouse.down();
    await p.mouse.move((a.x + c.x) / 2, (a.y + c.y) / 2, { steps: 5 });
    await p.mouse.move(c.x, c.y, { steps: 5 });
    await p.mouse.up();
    await p.waitForTimeout(220);
    return p.evaluate(() => dashSelBox(dashCardById('t1')));
  };

  const cardBefore = await p.evaluate(() => {
    const c = dashCardById('t1'); return { x: c.x, y: c.y, w: c.w, h: c.h };
  });
  const dragCells = await mouseDrag('#dashGrid .dc-cell[data-r="0"][data-c="0"]',
    '#dashGrid .dc-cell[data-r="2"][data-c="2"]');
  ck('dragging across cells selects the block they span',
    dragCells && dragCells.top === 0 && dragCells.left === 0
    && dragCells.bottom === 2 && dragCells.right === 2, JSON.stringify(dragCells));
  const cardAfter = await p.evaluate(() => {
    const c = dashCardById('t1'); return { x: c.x, y: c.y, w: c.w, h: c.h };
  });
  ck('and does not pick the card up and move it across the board',
    JSON.stringify(cardBefore) === JSON.stringify(cardAfter),
    JSON.stringify(cardBefore) + ' -> ' + JSON.stringify(cardAfter));

  await p.evaluate(() => { dashTableSel = null; });
  const dragCols = await mouseDrag('#dashGrid .dc-coltab[data-col="0"]',
    '#dashGrid .dc-coltab[data-col="2"]');
  ck('dragging across the column letters selects those columns',
    dragCols && dragCols.left === 0 && dragCols.right === 2 && dragCols.top === -1,
    JSON.stringify(dragCols));

  await p.evaluate(() => { dashTableSel = null; });
  const dragRows = await mouseDrag('#dashGrid .dc-rowno[data-row="0"]',
    '#dashGrid .dc-rowno[data-row="3"]');
  ck('and across the row numbers selects those rows',
    dragRows && dragRows.top === 0 && dragRows.bottom === 3, JSON.stringify(dragRows));

  const widthDrag = await p.evaluate(async () => {
    const c0 = dashCardById('t1');
    const before = { x: c0.x, y: c0.y, w: c0.w, h: c0.h };
    return { before, grip: !!document.querySelector('#dashGrid [data-wcol="0"]') };
  });
  const grip = await at('#dashGrid [data-wcol="0"]');
  await p.mouse.move(grip.x, grip.y);
  await p.mouse.down();
  await p.mouse.move(grip.x + 90, grip.y, { steps: 8 });
  await p.mouse.up();
  await p.waitForTimeout(250);
  const widthAfter = await p.evaluate(() => {
    const c = dashCardById('t1');
    return { x: c.x, y: c.y, w: c.w, h: c.h, colW: (c.colW || {})[0] };
  });
  ck('dragging a column edge sizes the column',
    widthAfter.colW > 0, 'colW ' + widthAfter.colW);
  ck('and leaves the card exactly where it was',
    widthAfter.x === widthDrag.before.x && widthAfter.y === widthDrag.before.y
    && widthAfter.w === widthDrag.before.w && widthAfter.h === widthDrag.before.h,
    JSON.stringify(widthDrag.before) + ' -> ' + JSON.stringify(widthAfter));

  /* ---- leaving a cell must not eat the click that left it ----------------- */

  // THE BUG THIS ANSWERS. Clicking a cell focuses it; clicking a pane button
  // then blurs it, and the blur handler rebuilt the whole board — between the
  // pointer going down on that button and coming up. The button moved out from
  // under the pointer, no click was ever delivered, and Align, the row's × and
  // every other control in reach "did nothing" until you pressed twice.
  await build();
  await p.waitForTimeout(500);
  await p.click('#dashGrid .dc-coltab[data-col="0"]');
  await p.waitForTimeout(200);
  await p.click('#dashFormat [data-df="selalign"][data-v="center"]');
  await p.waitForTimeout(350);
  await p.click('#dashGrid .dc-cell[data-r="1"][data-c="0"]');
  await p.waitForTimeout(250);
  await p.click('#dashFormat [data-df="selalign"][data-v="left"]');
  await p.waitForTimeout(400);
  const oneClick = await alignGrid(p);
  ck('Left takes on the FIRST press after clicking in a cell',
    oneClick[1][0] === 'left', JSON.stringify(oneClick.map(r => r[0])));
  // Left has to be a choice, not the absence of one: cleared rather than
  // written, it fell back to the column, which was still centred.
  ck('and it beats the centred column it sits in, rather than clearing to it',
    oneClick[0][0] === 'center' && oneClick[2][0] === 'center',
    JSON.stringify(oneClick.map(r => r[0])));

  const rowsBefore = await p.evaluate(() => dashCardById('t1').rows.length);
  await p.click('#dashGrid .dc-cell[data-r="0"][data-c="0"]');
  await p.waitForTimeout(200);
  await p.click('#dashGrid [data-drop-row="1"]');
  await p.waitForTimeout(350);
  const rowsAfter = await p.evaluate(() => ({
    n: dashCardById('t1').rows.length, first: dashCardById('t1').rows.map(r => r[0]),
  }));
  ck('and a row deletes on the first press too, having just touched a cell',
    rowsAfter.n === rowsBefore - 1, rowsBefore + ' -> ' + rowsAfter.n);
  ck('the row that goes is the one whose button was pressed',
    rowsAfter.first.indexOf('KALYAN PADGHA ROAD') < 0, JSON.stringify(rowsAfter.first));

  /* ---- the selection belongs to editing ----------------------------------- */

  const leftEdit = await p.evaluate(() => {
    dashTableSel = { id: 't1', r0: 0, c0: 1, r1: 2, c1: 1 };
    renderDashboard();
    const on = document.querySelectorAll('#dashGrid .dc-cell.dc-sel').length;
    setDashEditing(false);
    const off = document.querySelectorAll('#dashGrid .dc-sel').length;
    const rings = Array.from(document.querySelectorAll('#dashGrid td'))
      .filter(td => getComputedStyle(td).boxShadow !== 'none').length;
    const held = dashTableSel;
    setDashEditing(true);
    return { on, off, rings, held };
  });
  ck('a selection is lit while the board is being edited', leftEdit.on === 3, String(leftEdit.on));
  // It was not: the ring and the orange tint went on painting the table for a
  // client to read, and into the export, which renders out of edit mode.
  ck('and gone the moment it is not — no ring left on a finished card',
    leftEdit.off === 0 && leftEdit.rings === 0, JSON.stringify(leftEdit));
  ck('the selection itself is dropped, not just hidden', leftEdit.held === null,
    JSON.stringify(leftEdit.held));

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');

  await p.screenshot({ path: path.join(REPO, 'diagnostics', 'shot-dash-sheet.png') });
  await b.close();
  const pass = R.filter(Boolean).length;
  console.log('\n' + pass + '/' + R.length + ' passed');
  process.exit(pass === R.length ? 0 : 1);
})();
