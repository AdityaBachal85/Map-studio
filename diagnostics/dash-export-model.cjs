/**
 * What the board IS, proved without a browser.
 *
 * The board's export was one html2canvas pass — a bitmap, which is why nothing
 * downstream could tell a filled card from an empty one, or a chart's colour
 * slot from a colour. dashExportModel() is what the PDF, PPTX and DOCX writers
 * all read instead, so a fault here is a fault in three files at once, and it
 * is worth catching where there is no browser to hide it.
 *
 * Two failures this pins in particular:
 *   - a colour slot reaching a writer as the literal string "var(--viz-3)",
 *     which is correct on a page and meaningless in a file;
 *   - "empty" being decided by whether a card exists rather than whether
 *     anybody typed into it, which is what put four blank boxes and an
 *     editor prompt into a client's PDF.
 *
 *   node diagnostics/dash-export-model.cjs
 *
 * No server and no network: it requires the app's own file directly.
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const M = require(path.join(REPO, 'js/export/dashExportModel.js'));

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

/** The theme's eight slots, as the browser would resolve them. */
const VIZ = {
  '--viz-1': '#3987e5', '--viz-2': '#d95926', '--viz-3': '#199e70', '--viz-4': '#c98500',
  '--viz-5': '#d55181', '--viz-6': '#008300', '--viz-7': '#9085e9', '--viz-8': '#7a8899',
};
const resolveColor = name => VIZ[name] || '';

/* ---- colour resolution ---------------------------------------------------- */

ck('a slot number resolves to a hex',
  M.dashModelColor(3, resolveColor) === '#199e70', M.dashModelColor(3, resolveColor));
ck('a var() reference resolves to a hex',
  M.dashModelColor('var(--viz-2)', resolveColor) === '#d95926', M.dashModelColor('var(--viz-2)', resolveColor));
ck('whitespace inside var() is tolerated',
  M.dashModelColor('var( --viz-1 )', resolveColor) === '#3987e5');
ck('a literal hex passes through untouched',
  M.dashModelColor('#22C55E', resolveColor) === '#22C55E');
ck('an unresolvable custom property falls back to grey rather than a wrong colour',
  M.dashModelColor('var(--viz-99)', resolveColor) === M.DASH_MODEL_FALLBACK,
  M.dashModelColor('var(--viz-99)', resolveColor));
ck('a missing colour falls back rather than throwing',
  M.dashModelColor(null, resolveColor) === M.DASH_MODEL_FALLBACK);
ck('no var() survives resolution — the defect that reached the writers',
  !/var\(/.test(M.dashModelColor(1, resolveColor) + M.dashModelColor('var(--viz-4)', resolveColor)));

/* ---- emptiness, per type -------------------------------------------------- */

const empties = [
  ['chart', { type: 'chart', kind: 'area', labels: ['2021', '2022'], seriesList: [{ name: 'Rs / sq ft', values: [], slot: 1 }] }],
  ['stat', { type: 'stat', label: 'Metric', value: '' }],
  ['stats', { type: 'stats', items: [{ label: 'Investment', value: '' }, { label: 'Growth', value: '' }] }],
  ['gauges', { type: 'gauges', items: [{ cap: 'Connectivity', value: '' }, { cap: 'Livability', value: '' }] }],
  ['table', { type: 'table', columns: ['Item', 'Value'], rows: [['', ''], ['', '']] }],
  ['list', { type: 'list', items: [{ name: '', meta: '' }] }],
  ['text', { type: 'text', body: '   ' }],
  ['access', { type: 'access', _rows: [] }],
  ['legend', { type: 'legend', _rows: [] }],
];
empties.forEach(([name, card]) =>
  ck('an untouched ' + name + ' card counts as empty', M.dashModelCardEmpty(card) === true));

const filled = [
  ['chart', { type: 'chart', labels: ['2021'], seriesList: [{ values: [1200], slot: 1 }] }],
  ['stat', { type: 'stat', value: '18,500' }],
  ['stats', { type: 'stats', items: [{ label: 'Investment', value: '8' }] }],
  ['gauges', { type: 'gauges', items: [{ cap: 'Connectivity', value: '72' }] }],
  ['table', { type: 'table', columns: ['Item', 'Value'], rows: [['Carpet', '1140']] }],
  ['list', { type: 'list', items: [{ name: 'Metro phase 2', meta: '2027' }] }],
  ['text', { type: 'text', body: 'A well-connected site.' }],
  ['access', { type: 'access', _rows: [{ name: 'SVPN Police Academy', km: '0.6 km', min: '2 min' }] }],
  ['legend', { type: 'legend', _rows: [{ label: 'SVPN Police Academy', kind: 'line', color: '#8B5CF6' }] }],
];
filled.forEach(([name, card]) =>
  ck('a filled ' + name + ' card does not', M.dashModelCardEmpty(card) === false));

// A text card ships with its own prompt as its body — content on screen,
// an instruction to the reader in a file. This is what printed "Type the
// summary that opens the report." into a client's PDF.
ck('a text card still showing its seeded prompt counts as empty',
  M.dashModelCardEmpty({ type: 'text', body: 'Type the summary that opens the report.' }) === true);
ck('and the prompt is withheld from the writers, not merely flagged',
  M.dashModelData({ type: 'text', body: 'Type the summary that opens the report.' }).body === '');
ck('matching ignores case and surrounding space',
  M.dashModelCardEmpty({ type: 'text', body: '  TYPE HERE.  ' }) === true);
ck('but one edited word makes it the author\'s text again',
  M.dashModelCardEmpty({ type: 'text', body: 'Type the summary that opens the brief.' }) === false);
ck('and a real summary is never mistaken for a prompt',
  M.dashModelTyped('Shivarampalli sits inside the Outer Ring Road.') === true);

// A zero is a value. Falsy-checking the number instead of asking whether one
// was typed would call a real measurement of 0 an empty card.
ck('a typed zero is a value, not an absence',
  M.dashModelCardEmpty({ type: 'stat', value: 0 }) === false);
ck('and a chart carrying a zero is not empty either',
  M.dashModelCardEmpty({ type: 'chart', seriesList: [{ values: [0], slot: 1 }] }) === false);
// Default labels are not data: five year headings nobody chose is the state
// every new chart starts in, and it is exactly what shipped blank in the PDF.
ck('default category labels alone do not make a chart non-empty',
  M.dashModelCardEmpty({ type: 'chart', labels: ['2021', '2022', '2023'], seriesList: [{ values: [null, null], slot: 1 }] }) === true);

/* ---- the whole board ------------------------------------------------------ */

const board = M.dashExportModel({
  title: 'Ashoka Hyderabad',
  now: new Date('2026-08-25T10:00:00Z'),
  resolveColor,
  cards: [
    { id: 'c1', type: 'text', title: 'Property location & access', x: 8, y: 0, w: 4, h: 5, body: '' },
    { id: 'c2', type: 'stats', title: 'Scores', x: 8, y: 5, w: 4, h: 4, items: [{ label: 'Investment', value: '' }] },
    { id: 'c3', type: 'access', title: 'Key access points', x: 8, y: 9, w: 4, h: 5 },
    { id: 'c4', type: 'gauges', title: 'Infrastructure score', x: 0, y: 14, w: 5, h: 7, items: [{ cap: 'Connectivity', value: '', color: '#22C55E' }] },
    { id: 'c5', type: 'chart', title: 'Property price trend', x: 5, y: 14, w: 4, h: 7, kind: 'area', labels: ['2021', '2022'], seriesList: [{ name: 'Rs / sq ft', values: [], slot: 2 }] },
    { id: 'c6', type: 'legend', title: 'Legend', x: 9, y: 14, w: 3, h: 7 },
  ],
  mapTile: { id: '__map', x: 0, y: 0, w: 8, h: 14 },
  liveRows: {
    access: [
      { name: 'SVPN Police Academy', km: '0.6 km', min: '2 min', color: '#8B5CF6' },
      { name: 'Shivarampalli Railway Station', km: '0.8 km', min: '6 min', color: '#EF4444' },
    ],
    legend: [
      { label: 'Site / subject property', kind: 'mark', color: '#0a1e3c' },
      { label: 'SVPN Police Academy', kind: 'line', color: '#8B5CF6' },
    ],
  },
});

ck('the model carries the project title for the page header', board.title === 'Ashoka Hyderabad');
ck('one entry per card', board.cards.length === 6, board.cards.length + ' cards');
ck('the map is described separately from the cards',
  !!board.map && board.map.type === 'map' && !board.cards.some(c => c.type === 'map'));
ck('the board\'s height is the deepest tile, not the card count',
  board.rows === 21, 'rows=' + board.rows);
// Read against the real declaration, not a number copied into this test.
// dashExportModel restates the grid so a writer can lay out a page without
// measuring the screen, and a restated constant is one that silently drifts.
const layoutCols = (() => {
  const src = fs.readFileSync(path.join(REPO, 'js/ui/dashLayout.js'), 'utf8');
  const m = src.match(/const\s+DASH_COLS\s*=\s*(\d+)/);
  return m ? Number(m[1]) : null;
})();
ck('the model\'s column count is dashLayout\'s own, not a copy that drifted',
  layoutCols !== null && board.cols === layoutCols && M.DASH_MODEL_COLS === layoutCols,
  'model=' + board.cols + ' dashLayout=' + layoutCols);

ck('reading order is top-to-bottom then left-to-right, not creation order',
  board.ordered.map(t => t.id).join(',') === '__map,c1,c2,c3,c4,c5,c6',
  board.ordered.map(t => t.id).join(','));

ck('the live access card was filled from the map, not from stored values',
  board.cards.find(c => c.id === 'c3').data.rows.length === 2);

// A column of nothing takes width from the place names, which then get cut
// short — the defect that printed "SVPN Police Acad…" beside a column of
// em-dashes. Dropped in the model so all three writers agree about it.
{
  const untimed = M.dashExportModel({
    cards: [{ id: 'a', type: 'access', title: 'Key access', x: 0, y: 0, w: 4, h: 5 }],
    mapTile: null, resolveColor,
    liveRows: { access: [{ name: 'SVPN Police Academy', km: '0.6 km', min: '—' }] },
  }).cards[0].data;
  ck('a column that is empty all the way down is dropped',
    untimed.columns.join(',') === 'Place,Distance', untimed.columns.join(','));
  ck('and its cells go with it, so rows still match the header',
    untimed.rows[0].length === untimed.columns.length, JSON.stringify(untimed.rows[0]));

  // Time is opt-in now. A drive time is traffic on the day the router was
  // asked and goes stale; a distance does not, so the kilometre is what
  // survives into a document and the minute is asked for.
  const noTime = M.dashExportModel({
    cards: [{ id: 'a', type: 'access', title: 'Key access', x: 0, y: 0, w: 4, h: 5 }],
    mapTile: null, resolveColor,
    liveRows: { access: [{ name: 'SVPN Police Academy', km: '0.6 km', min: '2 min' }] },
  }).cards[0].data;
  ck('a timed route still prints kilometres only until the time is asked for',
    noTime.columns.join(',') === 'Place,Distance', noTime.columns.join(','));

  const timed = M.dashExportModel({
    cards: [{ id: 'a', type: 'access', title: 'Key access', x: 0, y: 0, w: 4, h: 5,
      fmt: { time: true } }],
    mapTile: null, resolveColor,
    liveRows: { access: [{ name: 'SVPN Police Academy', km: '0.6 km', min: '2 min' }] },
  }).cards[0].data;
  ck('and once it is, a column with even one real value is kept',
    timed.columns.join(',') === 'Place,Distance,Time', timed.columns.join(','));
}

// The operator's own table is theirs. Withdrawing a column they made would be
// editing their work, not tidying ours.
ck('a typed table keeps every column, empty or not',
  M.dashModelData({ type: 'table', columns: ['Item', 'Value', 'Note'], rows: [['Carpet', '1140', '']] })
    .columns.join(',') === 'Item,Value,Note');
ck('and it is therefore not empty', board.cards.find(c => c.id === 'c3').isEmpty === false);
ck('the live legend card too', board.cards.find(c => c.id === 'c6').data.rows.length === 2);

ck('the four untouched cards are counted as empty', board.emptyCount === 4, 'emptyCount=' + board.emptyCount);
ck('and are named, so the warning can say which',
  board.emptyTitles.join(' | ') === 'Property location & access | Scores | Infrastructure score | Property price trend',
  board.emptyTitles.join(' | '));

const chart = board.cards.find(c => c.id === 'c5');
ck('a chart series carries a resolved colour, not a slot',
  chart.data.series[0].color === '#d95926', chart.data.series[0].color);
ck('a gauge carries its own hex through unchanged',
  board.cards.find(c => c.id === 'c4').data.items[0].color === '#22C55E');

// A gauge with no stored colour takes the slot its POSITION gives it, which is
// the rule dashGaugesHtml() draws by. Reading only the stored colour sent every
// ring to the unresolvable fallback: four grey rings in the file while the
// screen showed four different ones.
{
  const rings = M.dashModelData({
    type: 'gauges',
    items: [{ cap: 'Connectivity', value: '60' }, { cap: 'Infrastructure', value: '69' },
      { cap: 'Development', value: '78' }],
  }, resolveColor).items.map(i => i.color);
  ck('an uncoloured gauge takes the slot its position gives it',
    rings.join(',') === '#3987e5,#d95926,#199e70', rings.join(','));
  ck('and none of them falls back to grey',
    !rings.some(c => c === M.DASH_MODEL_FALLBACK), rings.join(','));
}

// The whole point: nothing anywhere in the model is still a CSS reference.
const json = JSON.stringify(board);
ck('no var() reference survives anywhere in the model', !/var\(/.test(json));

/* ---- how a number prints travels with the card ----------------------------- */

{
  // A chart drawn in rupees to one decimal, with a table of bare integers under
  // it in the Word file, is two different answers to the same question on one
  // page. The rule is carried as data because this file runs under Node with no
  // chart engine — a writer that re-derived it would drift from the picture.
  const d = M.dashModelData({
    type: 'chart', kind: 'column', labels: ['2021', '2022'],
    seriesList: [{ name: 'Rent', values: [62000, 138000], slot: 1 }],
    fmt: { decimals: 0, numPrefix: '\u20b9', xTitle: 'Year', yTitle: 'Rent per month' },
  }, resolveColor);
  ck('a chart carries its number format into the model',
    d.numFmt && d.numFmt.decimals === 0 && d.numFmt.prefix === '\u20b9' && d.numFmt.suffix === '',
    JSON.stringify(d.numFmt));
  ck('and both axis titles', d.xTitle === 'Year' && d.yTitle === 'Rent per month',
    JSON.stringify([d.xTitle, d.yTitle]));

  const plain = M.dashModelData({
    type: 'chart', kind: 'column', labels: ['2021'],
    seriesList: [{ name: 'Rent', values: [62000], slot: 1 }],
  }, resolveColor);
  ck('a card nobody formatted carries no format at all, rather than an empty one',
    plain.numFmt === undefined && plain.xTitle === undefined, JSON.stringify(plain.numFmt));

  ck('a writer prints a formatted number the way the chart drew it',
    M.dashModelNum(62000, { decimals: 0, prefix: '\u20b9', suffix: '' }) === '\u20b962,000',
    M.dashModelNum(62000, { decimals: 0, prefix: '\u20b9', suffix: '' }));
  ck('and an unformatted one compactly, as the chart also does',
    M.dashModelNum(27500, null) === '27.5K' && M.dashModelNum(1200, null) === '1,200',
    M.dashModelNum(27500, null) + ' / ' + M.dashModelNum(1200, null));
  ck('a suffix rides along without a decimal count',
    M.dashModelNum(4.2, { decimals: null, prefix: '', suffix: ' km' }) === '4.2 km',
    M.dashModelNum(4.2, { decimals: null, prefix: '', suffix: ' km' }));
  ck('and a gap in the data prints as a dash, not as NaN',
    M.dashModelNum(null, null) === '\u2014' && M.dashModelNum(undefined, { decimals: 2 }) === '\u2014');
}

/* ---- it must not need a browser, or the globals ---------------------------- */

ck('an empty board is describable rather than a crash',
  (() => { const b = M.dashExportModel({ cards: [], mapTile: null }); return b.cards.length === 0 && b.rows === 0 && b.emptyCount === 0; })());
ck('live rows absent (as under Node) leaves the live cards empty, not broken',
  (() => {
    const b = M.dashExportModel({ cards: [{ id: 'a', type: 'access', title: 'Key access', x: 0, y: 0, w: 4, h: 5 }], mapTile: null });
    return b.cards[0].isEmpty === true && b.cards[0].data.rows.length === 0;
  })());

console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
process.exit(R.every(Boolean) ? 0 : 1);
