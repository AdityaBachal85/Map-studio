/**
 * ui/dashCards.js — the board's visuals: yours to fill in, size and arrange.
 *
 * WHY EVERY NUMBER IS TYPED, NOT COMPUTED. The board shows things this app has
 * no way of knowing — price per square foot, rental yield, demand-supply,
 * market sentiment. There is no source for them here, and a tool that prints a
 * confident price per square foot it invented is worse than one that prints
 * nothing: the number goes into a client document and nobody can tell it was
 * never real. So the visuals are containers, and the figures are yours. Where
 * the app *does* know something — the routes, their distances, the Key
 * Distances table — the visual reads it live and says so.
 *
 * This is the part a spreadsheet-driven tool gets from its query engine. There
 * is no Power Query here and no formula language: data is typed, or pasted as a
 * comma list, or read from the map. Everything downstream of the data — the
 * visual gallery, multiple series, the formatting, cross-filtering, the layout
 * — is here.
 *
 * A fresh board arrives EMPTY, not seeded. Captions and axis labels are
 * scaffolding that says what a visual is for; the values are em-dashes until
 * somebody types them. A zero reads as measured.
 *
 * EDITING IS A MODE. Off, the board is a board — click anything and nothing
 * happens to it, and the tiles have no handles. On, every value carries a caret,
 * every tile can be moved and resized, and the selected one opens its format
 * pane. A dashboard you can retype by mis-clicking is a document, not a board.
 *
 * Geometry lives in ui/dashLayout.js, drawing in ui/dashCharts.js, the format
 * pane in ui/dashFormat.js.
 */

/** The board. Each visual carries its own `{x, y, w, h}` on the canvas. */
let dashCards = [];

/** Whether the board is being edited. A mode, not data — never serialised. */
let dashEditing = false;

/** The visual whose settings the format pane is showing. */
let dashSelectedId = null;

let dashCardSeq = 1;

/**
 * The gallery. `group` only sorts the picker; `make` is the fresh shape.
 *
 * Charts are all one card type with a `kind`, so switching a column chart to a
 * line chart keeps its data — which is the whole reason Power BI's visual
 * switcher is useful and a "delete it and add another" flow is not.
 */
const DASH_GALLERY = [
  ['column', 'Column', 'Compare', () => dashChartShape('column')],
  ['bar', 'Bar', 'Compare', () => dashChartShape('bar')],
  ['stackedColumn', 'Stacked column', 'Compare', () => dashChartShape('stackedColumn')],
  ['stackedBar', 'Stacked bar', 'Compare', () => dashChartShape('stackedBar')],
  ['line', 'Line', 'Trend', () => dashChartShape('line')],
  ['area', 'Area', 'Trend', () => dashChartShape('area')],
  ['combo', 'Combo', 'Trend', () => dashChartShape('combo')],
  ['scatter', 'Scatter', 'Trend', () => dashChartShape('scatter')],
  ['pie', 'Pie', 'Share', () => dashChartShape('pie')],
  ['donut', 'Donut', 'Share', () => dashChartShape('donut')],
  ['funnel', 'Funnel', 'Share', () => dashChartShape('funnel')],
  ['treemap', 'Treemap', 'Share', () => dashChartShape('treemap')],
  ['ring', 'Rings', 'Scores', () => dashChartShape('ring')],
  ['gauge', 'Gauge', 'Scores', () => dashChartShape('gauge')],
  ['radar', 'Radar', 'Scores', () => dashChartShape('radar')],
  ['stat', 'KPI number', 'Figures', () => ({ type: 'stat', title: 'Metric', label: 'Metric', value: '', sub: '', w: 3, h: 5 })],
  ['stats', 'Multi KPI', 'Figures', () => ({ type: 'stats', title: 'Scores', w: 4, h: 5, items: [
    { label: 'Score', value: '' }, { label: 'Potential', value: '' }, { label: 'Risk', value: '' }] })],
  ['gauges', 'Score rings', 'Figures', () => ({ type: 'gauges', title: 'Scores', w: 6, h: 7, items: [
    { cap: 'Connectivity', value: '' },
    { cap: 'Infrastructure', value: '' }] })],
  ['table', 'Table', 'Text', () => ({ type: 'table', title: 'Table', w: 5, h: 8,
    columns: ['Item', 'Value'], rows: [['', ''], ['', '']] })],
  ['list', 'List', 'Text', () => ({ type: 'list', title: 'List', w: 4, h: 7, items: [{ name: 'Item', meta: '' }] })],
  ['text', 'Text', 'Text', () => ({ type: 'text', title: 'Notes', body: 'Type here.', w: 4, h: 5 })],
  ['slicer', 'Slicer', 'Filter', () => ({ type: 'slicer', title: 'Filter', w: 3, h: 7,
    items: ['2021', '2022', '2023'], picked: [] })],
  ['access', 'Key access (live)', 'From the map', () => ({ type: 'access', title: 'Key access points', w: 4, h: 7 })],
  ['legend', 'Legend (live)', 'From the map', () => ({ type: 'legend', title: 'Legend', w: 4, h: 6 })],
  ['comment', 'Location comment', 'Text', () => ({ type: 'comment', title: 'Location comment',
    body: 'Type the closing read on the location.', w: 8, h: 5,
    fmt: { head: 'bar', headTone: 'green' } })],
  ['rating', 'Overall rating', 'Figures', () => ({ type: 'rating', title: 'Overall rating',
    label: 'Villa funding (location perspective)', value: '', body: '', w: 4, h: 5,
    fmt: { head: 'bar', headTone: 'navy' } })],
];

/** @param {string} kind @returns {object} a fresh chart of that kind */
function dashChartShape(kind) {
  return {
    type: 'chart',
    kind,
    title: 'Chart',
    w: 6, h: 8,
    labels: ['2021', '2022', '2023', '2024', '2025'],
    seriesList: [{ name: 'Series 1', values: [], slot: 1 }],
    fmt: { legend: 'auto', labels: false, grid: true, xAxis: true, yAxis: true, smooth: false },
  };
}

/** @param {string} key a gallery key @returns {object} a new visual */
function dashNewCard(key) {
  const def = DASH_GALLERY.find(t => t[0] === key) || DASH_GALLERY[0];
  return Object.assign({
    id: 'c' + (dashCardSeq++),
    x: 0, y: 9999, w: 4, h: 5,   // y past the end: it lands at the bottom, then settles up
  }, def[3]());
}

/**
 * The board a new project starts with — the mockup's shape, in tiles.
 *
 * A starting point, not a layout: every one of these is draggable and resizable
 * from the moment it appears.
 */
function dashDefaultCards() {
  dashCardSeq = 1;
  dashMapTile = { id: DASH_MAP_ID, x: 0, y: 0, w: 8, h: 14 };
  const c = (key, over) => Object.assign(dashNewCard(key), over);
  return [
    c('text', { x: 8, y: 0, w: 4, h: 5, title: 'Property location & access',
      body: 'Type the address, the coordinates and anything else worth saying up front.' }),
    c('stats', { x: 8, y: 5, w: 4, h: 4, title: 'Scores', items: [
      { label: 'Investment', value: '' }, { label: 'Growth', value: '' }, { label: 'Risk', value: '' }] }),
    c('access', { x: 8, y: 9, w: 4, h: 5, title: 'Key access points' }),

    // No colours here: each ring takes the next viz slot, which is what keeps
    // the board readable in both themes. Four rings on two repeated hexes also
    // made Connectivity and Livability look like the same measurement.
    c('gauges', { x: 0, y: 14, w: 5, h: 7, title: 'Infrastructure score', items: [
      { cap: 'Connectivity', value: '' },
      { cap: 'Infrastructure', value: '' },
      { cap: 'Development', value: '' },
      { cap: 'Livability', value: '' }] }),
    c('area', { x: 5, y: 14, w: 4, h: 7, title: 'Property price trend',
      labels: ['2021', '2022', '2023', '2024', '2025'],
      seriesList: [{ name: 'Rs / sq ft', values: [], slot: 1 }] }),
    // The colour key the map tile no longer carries. Live, like Key access
    // points — it fills itself the moment anything on the map has a colour,
    // which is what earns it a place on a default board where most cards are
    // waiting to be typed into.
    c('legend', { x: 9, y: 14, w: 3, h: 7, title: 'Legend' }),
    c('text', { x: 0, y: 21, w: 6, h: 6, title: 'Executive summary',
      body: 'Type the summary that opens the report.' }),
    c('list', { x: 6, y: 21, w: 6, h: 6, title: 'Timeline (development)', items: [
      { name: 'Milestone', meta: 'Year' }] }),
  ];
}

/**
 * Bring a board saved by an older build up to date.
 *
 * Two generations to handle: boards laid out by `slot`/`span` before the canvas
 * existed, and charts that stored one flat `values` array with `series` holding
 * a colour number. Both are converted rather than dropped — somebody's board is
 * not an acceptable casualty of a refactor.
 *
 * @param {object[]} cards
 */
function dashMigrateCards(cards) {
  let sideY = 0, gridY = 0;
  cards.forEach(c => {
    /* ---- geometry ---- */
    if (!(typeof c.w === 'number' && typeof c.h === 'number'
      && typeof c.x === 'number' && typeof c.y === 'number')) {
      const h = c.type === 'chart' ? 8 : c.type === 'gauges' ? 7 : c.type === 'stat' ? 5 : 6;
      if (c.slot === 'side') { c.x = 8; c.w = 4; c.y = sideY; sideY += h; }
      else {
        const w = Math.max(2, Math.min(12, c.span || 4));
        c.w = w; c.x = (gridY % 2) ? Math.max(0, 12 - w) : 0;
        c.y = 14 + gridY * h; gridY++;
      }
      c.h = h;
    }
    delete c.slot; delete c.span;

    /* ---- chart data ---- */
    if (c.type === 'chart') {
      if (!Array.isArray(c.seriesList) || !c.seriesList.length) {
        c.seriesList = [{
          name: c.seriesName || 'Series 1',
          values: Array.isArray(c.values) ? c.values.map(Number).filter(isFinite) : [],
          slot: typeof c.series === 'number' ? c.series : 1,
        }];
      }
      delete c.values; delete c.series; delete c.seriesName;
      if (!c.fmt) c.fmt = { legend: 'auto', labels: false, grid: true, xAxis: true, yAxis: true, smooth: false };
      if (!c.kind) c.kind = 'column';
    }
  });
}

/* ---------------------------------------------------------------------------
 * Cross-filtering
 * ------------------------------------------------------------------------ */

/**
 * The categories every visual is currently limited to, or null.
 *
 * A slicer that narrowed some visuals and not others would mislead worse than
 * no slicer at all, so this is board-wide and every chart consults it.
 *
 * @returns {Set<string>|null}
 */
function dashFilter() {
  const picked = new Set();
  dashCards.forEach(c => {
    if (c.type !== 'slicer') return;
    (c.picked || []).forEach(v => picked.add(String(v)));
  });
  return picked.size ? picked : null;
}

/* ---------------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------------ */

/** @param {string} v @returns {string} escaped, with a visible placeholder for empties */
function dashText(v) {
  const s = String(v == null ? '' : v);
  return s === '' ? '—' : esc(s);
}

/** @param {object} card @param {string} path @param {string} v @param {string} cls */
function dashField(card, path, v, cls) {
  return '<div class="' + cls + '" data-card="' + card.id + '" data-bind="' + path + '"'
    + (dashEditing ? ' contenteditable="true" spellcheck="false"' : '') + '>' + dashText(v) + '</div>';
}

/**
 * A chart: its legend, and the host its SVG is measured into.
 *
 * The SVG is not built here — it is drawn after layout, when the host has a
 * real width and height. See ui/dashCharts.js.
 *
 * @param {object} card @returns {string} HTML
 */
function dashChartHtml(card) {
  const fmt = vizFmt(card);
  const kind = card.kind || 'column';
  const series = vizSeries(card);
  const share = VIZ_SHARE_KINDS.indexOf(kind) >= 0;
  const byCategory = VIZ_CATEGORY_KEYED.indexOf(kind) >= 0;
  const flat = series.reduce((a, s) => a.concat(s.values.filter(isFinite)), []);
  const enough = vizEnough(kind, flat, vizCategories(card));

  // A legend is the dependable identity channel — never make the reader
  // match colours by eye. One series needs none: the title already names it.
  //
  // A funnel needs none either, and gets it wrong if it has one: its stages are
  // already named down the left, and the only percentage that means anything on
  // a funnel is the share of the *first* stage, which is what the bars carry. A
  // legend showing share-of-total put two different percentages for the same
  // stage on one card.
  //
  // A gauge needs none for the same reason: it is one number, and it is printed
  // in the middle of its own dial at four times the legend's size.
  let legend = '';
  const wantLegend = fmt.legend !== 'off' && enough && kind !== 'funnel' && kind !== 'gauge'
    && (byCategory ? true : series.length > 1);
  if (wantLegend) {
    // A series carries its own colour when one was chosen, so the swatch beside
    // the name matches the line on the chart. Without this the legend went on
    // showing the palette slot underneath a custom colour.
    const keys = byCategory
      ? vizCategories(card).map((c, i) => [c, i + 1])
      : series.map(s => [s.name, s.hex || s.slot]);
    const vals = byCategory && series[0] ? series[0].values.map(Number) : null;
    // Only a share kind may print a percentage: on a ring the arc is a fraction
    // of the scale, not of the total, so share-of-total beside it would be a
    // second, different percentage for the same category. Rings show the score
    // itself, which is the number somebody typed.
    const sum = share && vals ? vals.reduce((a, b) => a + (isFinite(b) && b > 0 ? b : 0), 0) : 0;
    legend = '<div class="dc-legend dc-legend-' + (fmt.legend === 'auto' ? (byCategory ? 'right' : 'top') : fmt.legend) + '">'
      + keys.map(([name, slot], i) =>
        '<span class="dc-key"><i style="background:'
        + (/^#[0-9a-f]{6}$/i.test(String(slot)) ? esc(String(slot)) : vizSlot(slot))
        + '"></i>' + esc(String(name || '—'))
        + (sum ? '<b>' + Math.round(((vals[i] > 0 ? vals[i] : 0) / sum) * 100) + '%</b>'
          : (kind === 'ring' && vals && isFinite(vals[i]) ? '<b>' + esc(vizNum(vals[i])) + '</b>' : ''))
        + '</span>').join('')
      + '</div>';
  }

  // Two halves, because they have two audiences. The state ("No data yet") is
  // true for anybody; the instruction after it is addressed to whoever is
  // building the board, and printing it into a client's PDF tells the reader
  // to turn on a control they do not have. `.dc-hint` is dropped from every
  // export by #dashGrid.exporting — see css/dashboard.css.
  const empty = enough ? '' : '<div class="dc-empty">No data yet<span class="dc-hint"> — '
    + (dashEditing
      ? 'type values in the Format pane on the right.'
      : 'turn on Edit board to type them.')
    + '</span></div>';

  return legend + '<div class="dc-plot" data-card="' + card.id + '"></div>' + empty;
}

/**
 * @param {object} card @returns {string} HTML
 *
 * THE CEILING IS NOT 100 UNLESS SOMEBODY SAYS SO. This card used to divide
 * every score by a hardcoded hundred, so a site rated 8, 9 and 10 — which is
 * how these are rated — drew three rings each about a tenth full, under three
 * large correct-looking numbers. The number said 10 and the ring said 10%.
 *
 * The ceiling now comes from vizScoreMax(), the same rule the ring, gauge and
 * radar chart kinds are drawn by, so one card cannot disagree with another
 * about what a score is out of.
 */
function dashGaugesHtml(card) {
  const items = card.items || [];
  const nums = items.map(g => Number(g.value)).filter(isFinite);
  const max = (typeof vizScoreMax === 'function' ? vizScoreMax(card, nums) : 100) || 1;

  return '<div class="dc-gauges">' + items.map((g, i) => {
    // An unset gauge reads "—" with an empty ring, not "0". A zero is a score
    // somebody chose; showing one nobody typed puts a number in a client's
    // report that came from the app rather than from the analyst.
    const raw = g.value;
    const set = raw !== '' && raw != null && isFinite(Number(raw));
    const v = set ? Number(raw) : 0;
    // The arc is clamped; the number is not. A score typed above the ceiling is
    // a full ring and the figure somebody actually typed — silently rewriting
    // it to the ceiling would hide the mistake rather than show it.
    const frac = set ? Math.max(0, Math.min(1, v / max)) : 0;
    const r = 24, circ = 2 * Math.PI * r;
    return '<div class="dc-gauge">'
      + '<svg viewBox="0 0 60 60" width="62" height="62" role="img" aria-label="'
        + esc(g.cap || '') + ' ' + (set ? v + ' out of ' + max : 'not set') + '">'
      + '<circle class="track" cx="30" cy="30" r="' + r + '" stroke-width="5"/>'
      + (set
        // vizSlot() rather than a literal, so a ring drawn in one theme still
        // reads in the other — the rule every other visual on this board
        // already follows, and the reason a card stores a slot number and never
        // a hex. A gauge that carries its own hex from an older board keeps it.
        // --len is the full circumference, which is what the enter animation
        // sweeps the arc in from. Emitted here because the geometry is here;
        // the stylesheet has no way to know a ring's radius.
        ? '<circle class="val" cx="30" cy="30" r="' + r + '" stroke-width="5" style="--len:'
          + circ.toFixed(1) + ';--i:' + i + '" stroke="'
          // A stored hex from an older board wins; then a slot the operator
          // picked; then the slot this ring's position gives it.
          + esc(g.color || (typeof vizSlot === 'function' ? vizSlot(g.slot || (i + 1)) : '#22C55E'))
          + '" stroke-dasharray="' + (circ * frac).toFixed(1) + ' ' + circ.toFixed(1) + '"/>'
        : '')
      + '<text class="dc-gauge-num" x="30" y="35">' + (set ? vizNum(v) : '—') + '</text></svg>'
      + dashField(card, 'items.' + i + '.cap', g.cap, 'dc-gauge-cap')
      + (dashEditing ? dashField(card, 'items.' + i + '.value', set ? String(v) : '', 'dc-input') : '')
      + '</div>';
  }).join('') + '</div>';
}

/** A plain editable table. @param {object} card @returns {string} HTML */
function dashTableHtml(card) {
  const cols = card.columns || [];
  const rows = card.rows || [];
  return '<div class="dc-tablewrap"><table class="dc-table"><thead><tr>'
    + cols.map((c, i) => '<th>' + dashField(card, 'columns.' + i, c, 'dc-th') + '</th>').join('')
    + (dashEditing ? '<th class="dc-tw"></th>' : '')
    + '</tr></thead><tbody>'
    + rows.map((r, ri) => '<tr>'
      + cols.map((c, ci) => '<td>' + dashField(card, 'rows.' + ri + '.' + ci, r[ci], 'dc-td') + '</td>').join('')
      + (dashEditing ? '<td class="dc-tw"><button class="dc-btn danger" data-drop-row="' + ri + '" title="Remove this row">&times;</button></td>' : '')
      + '</tr>').join('')
    + '</tbody></table>'
    + (dashEditing
      ? '<div class="dc-tblbtns"><button class="dc-btn dc-addrow" data-add-row="1">+ Row</button>'
        + '<button class="dc-btn dc-addrow" data-add-col="1">+ Column</button></div>'
      : '')
    + '</div>';
}

/**
 * A slicer: click values to limit every chart on the board to them.
 *
 * Works out of edit mode as well as in it — filtering is reading, not editing,
 * and a filter you have to unlock the board to use would never get used.
 */
function dashSlicerHtml(card) {
  const items = card.items || [];
  const picked = new Set((card.picked || []).map(String));
  return '<div class="dc-slicer">'
    + items.map((v, i) =>
      '<button type="button" class="dc-chip' + (picked.has(String(v)) ? ' on' : '')
      + '" data-slice="' + esc(String(v)) + '">' + esc(String(v)) + '</button>').join('')
    + '</div>'
    + (picked.size
      ? '<button type="button" class="dc-btn dc-addrow dc-clear" data-slice-clear="1">Clear filter</button>'
      : '<div class="dc-empty"><span class="dc-hint">Click a value to filter every chart on the board.</span></div>');
}

/**
 * Key access points, read live from the same rows the Key Distances card uses.
 *
 * This one visual is not typed in: it is the routes you have actually drawn, so
 * it cannot drift from the map. Editing its values happens where they live —
 * on the Key Distances card — rather than in a second copy here that would
 * disagree with the first.
 *
 * @returns {string} HTML
 */
function dashAccessHtml(card) {
  // Distance only, unless somebody asks for the time.
  //
  // A drive time is a measurement of traffic on the day the router was asked,
  // and it goes stale in a way a distance does not — 17 min is true at 11am and
  // wrong at 6pm, while 1.1 km is true for as long as the road exists. So the
  // column that survives in a document handed to a client is the kilometre, and
  // the minute is opt-in.
  const showTime = !!(card && card.fmt && card.fmt.time);
  const rows = (typeof legendRows === 'function') ? legendRows() : [];
  if (!rows.length) {
    // A drawn route with no distance yet is still measuring (or the routing
    // service is unreachable), which is a different situation from having
    // drawn nothing — and "No routes yet" under three visible routes reads as
    // the card being broken.
    const drawn = (typeof routes !== 'undefined' && routes) ? routes.length : 0;
    return '<div class="dc-empty">' + (drawn
      ? 'Measuring ' + drawn + ' route' + (drawn === 1 ? '' : 's') + '…<span class="dc-hint"> distances appear here once the routing service answers.</span>'
      : 'No routes yet.<span class="dc-hint"> Draw one in the Routes tab and it appears here.</span>') + '</div>';
  }
  // Two readings of the same rows, and both are kept because they answer
  // different questions. The list is scanned — "is the station near?" — and the
  // table is compared, column against column, which is what a printed sheet of
  // approximate distances is for. It is also the accessible reading: a real
  // table has headers a screen reader can announce.
  if (card && card.fmt && card.fmt.asTable) {
    return '<div class="dc-tbl-wrap"><table class="dc-tbl"><thead><tr>'
      + '<th scope="col">Place</th><th scope="col" class="num">Distance</th>'
      + (showTime ? '<th scope="col" class="num">Time</th>' : '')
      + '</tr></thead><tbody>'
      + rows.map(r => '<tr>'
        + '<th scope="row"><span class="dc-ico">'
        + (typeof legendMarkHtml === 'function' ? legendMarkHtml(r) : '') + '</span>'
        + esc(r.name) + '</th>'
        + '<td class="num">' + esc(r.km) + '</td>'
        + (showTime ? '<td class="num">' + esc(r.min && r.min !== '\u2014' ? r.min : '') + '</td>' : '')
        + '</tr>').join('')
      + '</tbody></table></div>';
  }

  return '<div class="dc-list">' + rows.map(r =>
    '<div class="dc-row">'
    + '<span class="dc-ico">' + (typeof legendMarkHtml === 'function' ? legendMarkHtml(r) : '') + '</span>'
    + '<div class="dc-row-main"><div class="dc-row-name">' + esc(r.name) + '</div></div>'
    + '<div class="dc-row-meta">' + esc(r.km)
      + (showTime && r.min && r.min !== '\u2014' ? ' \u00b7 ' + esc(r.min) : '') + '</div>'
    + '</div>').join('') + '</div>';
}

/**
 * The colour key, read live from the same rows the on-map Legend card uses.
 *
 * Sibling of dashAccessHtml() above and typed in no more than that one is.
 *
 * WHY BOTH THIS AND KEY ACCESS POINTS. They answer different questions and
 * overlap only on a map that has nothing but routes. Key access points is the
 * measured list — what is near, how far, how long — and it only knows about
 * routes. This is what the colours MEAN, which on a working map also covers
 * drawn areas, marked points and contour bands, none of which legendRows()
 * has ever seen. On a routes-only map the two do read similarly; that is the
 * cost of having a legend at all, and it is the map that is simple, not the
 * cards that are wrong.
 *
 * @returns {string} HTML
 */
function dashLegendHtml(card) {
  // Placed on the map instead. The tile is dropped from the layout when the
  // board is not being edited — see dashTiles() — so this is only ever read by
  // whoever is building the board, and it exists so the switch back is where
  // the switch away was.
  if (card && card.onMap) {
    return '<div class="dc-empty">On the map.'
      + '<span class="dc-hint"> Move it back with Placement in the Format pane.</span></div>';
  }
  const rows = (typeof colorKeyRows === 'function') ? colorKeyRows() : [];
  const shown = rows.filter(r => !r.hidden);
  if (!shown.length) {
    return '<div class="dc-empty">Nothing on the map has a colour yet.'
      + '<span class="dc-hint"> Draw a route or a shape and its key appears here.</span></div>';
  }
  return '<div class="dc-list">' + shown.map(r =>
    '<div class="dc-row">'
    + '<span class="dc-ico">' + (typeof colorKeyMark === 'function' ? colorKeyMark(r) : '') + '</span>'
    + '<div class="dc-row-main"><div class="dc-row-name">' + esc(r.label) + '</div></div>'
    + '</div>').join('') + '</div>';
}

/** @param {object} card @returns {string} the visual's body HTML */
function dashCardBody(card) {
  switch (card.type) {
    case 'stat':
      return '<div class="dc-stat">'
        + dashField(card, 'value', card.value, 'dc-stat-val')
        + dashField(card, 'label', card.label, 'dc-stat-label')
        + dashField(card, 'sub', card.sub, 'dc-stat-sub') + '</div>';

    case 'stats':
      return '<div class="dc-stats">'
        + (card.items || []).map((it, i) =>
          '<div class="dc-stats-cell">'
          + dashField(card, 'items.' + i + '.value', it.value, 'dc-stat-val')
          + dashField(card, 'items.' + i + '.label', it.label, 'dc-stat-label')
          + '</div>').join('') + '</div>';

    case 'chart': return dashChartHtml(card);
    case 'gauges': return dashGaugesHtml(card);
    case 'table': return dashTableHtml(card);
    case 'slicer': return dashSlicerHtml(card);
    case 'access': return dashAccessHtml(card);
    case 'legend': return dashLegendHtml(card);

    case 'list':
      return '<div class="dc-list">' + (card.items || []).map((it, i) =>
        '<div class="dc-row"><div class="dc-row-main">'
        + dashField(card, 'items.' + i + '.name', it.name, 'dc-row-name')
        + '</div>'
        + dashField(card, 'items.' + i + '.meta', it.meta, 'dc-row-meta')
        + (dashEditing ? '<button class="dc-btn danger" data-drop-row="' + i + '" title="Remove this row">&times;</button>' : '')
        + '</div>').join('')
        + (dashEditing ? '<button class="dc-btn dc-addrow" data-add-row="1">+ Row</button>' : '')
        + '</div>';

    case 'comment':
      // Icon, label, paragraph — the block that closes a connectivity sheet.
      // The label is fixed rather than editable: it is the thing that makes the
      // block recognisable across every report, and a card whose label can say
      // anything is just a text card.
      return '<div class="dc-comment">'
        + '<div class="dc-comment-mark" aria-hidden="true">'
        + '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"'
        + ' stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>'
        + '</svg><span>Location comment</span></div>'
        + dashField(card, 'body', card.body, 'dc-text') + '</div>';

    case 'rating': {
      // One number, large, against its ceiling — the "8/10" that closes the
      // sheet. Read from the same vizScoreMax() every other score on the board
      // uses, so the rating and the rings cannot disagree about what ten means.
      const raw = card.value;
      const set = raw !== '' && raw != null && isFinite(Number(raw));
      const v = set ? Number(raw) : null;
      const max = (typeof vizScoreMax === 'function'
        ? vizScoreMax(card, set ? [v] : []) : 10) || 10;
      return '<div class="dc-rating">'
        + '<div class="dc-rating-main">'
        + dashField(card, 'label', card.label, 'dc-rating-cap')
        + dashField(card, 'body', card.body, 'dc-rating-note')
        + '</div>'
        + '<div class="dc-rating-badge' + (set ? '' : ' empty') + '">'
        + '<b>' + (set ? esc(vizNum(v)) : '\u2014') + '</b>'
        + '<span>/' + max + '</span>'
        + '</div>'
        + (dashEditing ? dashField(card, 'value', set ? String(v) : '', 'dc-input dc-rating-in') : '')
        + '</div>';
    }

    case 'text':
    default:
      return dashField(card, 'body', card.body, 'dc-text');
  }
}

/** @param {object} card @returns {HTMLElement} */
function dashCardEl(card) {
  const el = document.createElement('section');
  el.className = 'dash-card dash-tile dc-type-' + card.type
    + (card.id === dashSelectedId && dashEditing ? ' selected' : '');
  el.dataset.card = card.id;
  if (card.fmt && card.fmt.plain) el.classList.add('plain');
  // A filled header bar rather than a quiet caption. On a printed sheet the
  // bar is what separates one block from the next at arm's length, where a
  // 9.5px uppercase label in muted ink is invisible. Two tones only, both of
  // them white on dark and both clearing AA, so the bar can carry a title
  // without the title carrying the meaning of the colour on its own.
  // Left, centred or right — for the title and the body together, because a
  // centred heading over left-ragged text reads as a mistake rather than as two
  // decisions.
  const align = card.fmt && card.fmt.align;
  if (align === 'center' || align === 'right' || align === 'justify') {
    el.classList.add('align-' + align);
  }

  if (card.fmt && card.fmt.head === 'bar') {
    el.classList.add('headed');
    const tone = card.fmt.headTone == null ? 'navy' : String(card.fmt.headTone);
    el.classList.add(/^[1-8]$/.test(tone) ? 'head-slot-' + tone : 'head-navy');
  }

  const titleOn = !card.fmt || card.fmt.title !== false;

  el.innerHTML =
    (titleOn
      ? '<div class="dc-head">'
        + (dashEditing ? '<span class="dc-grip" aria-hidden="true"></span>' : '')
        + '<div class="dc-title" data-card="' + card.id + '" data-bind="title"'
          + (dashEditing ? ' contenteditable="true" spellcheck="false"' : '') + '>' + esc(card.title || '') + '</div>'
        + '<div class="dc-tools">'
          + '<button class="dc-btn" data-act="dup" title="Duplicate" aria-label="Duplicate this visual">'
            + '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>'
          + '<button class="dc-btn danger" data-act="del" title="Remove" aria-label="Remove this visual">'
            + '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>'
        + '</div></div>'
      : (dashEditing ? '<span class="dc-grip dc-grip-float" aria-hidden="true"></span>' : ''))
    + '<div class="dc-body">' + dashCardBody(card) + '</div>'
    + (dashEditing ? dashHandlesHtml() : '');

  return el;
}

/**
 * The on-map legend's size, and the handle that changes it.
 *
 * A legend that cannot be resized is a legend that either crowds the map or
 * cannot fit its own longest name. CSS `resize` gives a real grip for nothing,
 * but the browser forgets the size the moment the element is rebuilt — so the
 * result is written back onto the card, where it travels with the project.
 *
 * The observer is bound once and re-pointed, rather than one per render: a new
 * ResizeObserver per rebuild is a leak, and this element is rebuilt on every
 * board change.
 *
 * @param {?object} card the legend card that is on the map, or null
 */
let _dashLegendRo = null;
function dashSizeMapLegend(card) {
  const key = document.getElementById('colorKeyCard');
  if (!key) return;

  if (!card) {
    if (_dashLegendRo) _dashLegendRo.disconnect();
    key.style.width = '';
    key.style.height = '';
    return;
  }

  if (card.mapW) key.style.width = card.mapW + 'px';
  if (card.mapH) key.style.height = card.mapH + 'px';

  if (typeof ResizeObserver !== 'function') return;
  if (!_dashLegendRo) {
    _dashLegendRo = new ResizeObserver(entries => {
      const e = entries[0];
      if (!e || !_dashLegendRo._card) return;
      // Only what the grip actually produced. Writing back a size the
      // stylesheet chose would freeze the card at its own default the first
      // time the board rendered.
      if (!e.target.style.width && !e.target.style.height) return;
      _dashLegendRo._card.mapW = Math.round(e.contentRect.width);
      _dashLegendRo._card.mapH = Math.round(e.contentRect.height);
    });
  }
  _dashLegendRo._card = card;
  _dashLegendRo.disconnect();
  _dashLegendRo.observe(key);
}

/** Redraw the canvas. */
function renderDashboard() {
  const grid = document.getElementById('dashGrid');
  if (!grid) return;

  if (!dashCards.length) dashCards = dashDefaultCards();
  dashMigrateCards(dashCards);

  // The on-map legend is #colorKeyCard, which board mode hides by default —
  // the whole point of hiding it was that the same rows were printed twice, in
  // a box over the map and in a card beside it. One class turns that off for
  // the one case where it was asked for, and it is set from the cards rather
  // than from a preference so a project carries its own answer.
  const onMapLegend = dashCards.find(c => c.type === 'legend' && c.onMap);
  const shell = document.querySelector('.app');
  if (shell) shell.classList.toggle('legend-on-map', !!onMapLegend);
  // The class alone is not enough: the card's visibility is written inline by
  // rebuildColorKey(), so it has to be asked again now the answer has changed.
  if (typeof rebuildColorKey === 'function') rebuildColorKey();
  dashSizeMapLegend(onMapLegend || null);

  // The map lives on the canvas and must survive the rebuild, so it is lifted
  // out before the wipe rather than being innerHTML'd away.
  const wrap = document.getElementById('mapWrap');
  const mapWasHere = wrap && wrap.parentNode === grid;
  if (mapWasHere) grid.removeChild(wrap);
  grid.innerHTML = '';
  if (mapWasHere) grid.appendChild(wrap);

  // dashTiles(), not dashCards: a legend that has moved onto the map is not a
  // tile any more, and rendering its box anyway left an empty card sitting
  // where the layout engine had already stopped positioning one.
  const placed = new Set(dashTiles().map(t => t.id));
  dashCards.forEach(c => { if (placed.has(c.id)) grid.appendChild(dashCardEl(c)); });

  if (dashEditing) {
    const add = document.createElement('div');
    add.id = 'dashAdd';
    add.innerHTML = '<span class="da-cap">Add a visual</span>'
      + DASH_GALLERY.map(t => '<button type="button" data-add="' + t[0] + '" title="'
        + esc(t[2]) + '">' + esc(t[1]) + '</button>').join('');
    grid.appendChild(add);
  }

  if (wrap) {
    wrap.classList.toggle('tile-editing', dashEditing);
    const old = wrap.querySelector('.dc-maphandles');
    if (old) old.remove();
    if (mapWasHere && dashEditing) {
      const h = document.createElement('div');
      h.className = 'dc-maphandles';
      // Not also `.dc-grip`: that class is the 13px dotted square used inside a
      // card header, and its fixed width squashed this chip to a blob.
      h.innerHTML = '<span class="dc-maphead" title="Drag to move the map tile"></span>' + dashHandlesHtml();
      wrap.appendChild(h);
    }
  }

  const app = document.getElementById('app');
  if (app) app.classList.toggle('dash-editing', dashEditing);
  const btn = document.getElementById('dashEditBtn');
  if (btn) {
    btn.classList.toggle('on', dashEditing);
    btn.setAttribute('aria-pressed', String(dashEditing));
  }

  dashSettle();
  dashLayoutApply();
  // Charts measure their host, so they are drawn after the layout has given
  // every host a size — and once more next frame, because a card that has just
  // been inserted has not had its transition settle yet.
  dashDrawAllCharts();
  requestAnimationFrame(dashDrawAllCharts);
  if (typeof renderDashFormat === 'function') renderDashFormat();
}

/** @param {boolean} on */
function setDashEditing(on) {
  dashEditing = !!on;
  if (!dashEditing) dashSelectedId = null;
  renderDashboard();
  if (typeof status === 'function') {
    status(dashEditing
      ? 'Editing the board: click a visual to format it, drag to move, resize from any edge.'
      : 'Board saved.');
  }
}

/**
 * Redraw only the visuals that read from the map.
 *
 * Called whenever the distances change — routes measure asynchronously, so a
 * board opened straight after drawing one shows "measuring…" and has to catch
 * up on its own. Rebuilding the whole board would do it in one line and would
 * also blow away whatever was being typed into another visual at that moment,
 * which is why this touches only the live ones. They contain no editable
 * fields, so there is nothing here to lose.
 */
function dashRefreshLive() {
  dashCards.forEach(c => {
    const html = c.type === 'access' ? dashAccessHtml(c)
      : c.type === 'legend' ? dashLegendHtml(c)
        : null;
    if (html === null) return;
    const body = document.querySelector('#dashGrid .dash-card[data-card="' + c.id + '"] .dc-body');
    if (body) body.innerHTML = html;
  });
}

/* ---------------------------------------------------------------------------
 * Editing
 * ------------------------------------------------------------------------ */

/** @param {string} id @returns {object|undefined} */
function dashCardById(id) { return dashCards.find(c => c.id === id); }

/** @param {string|null} id */
function dashSelect(id) {
  if (dashSelectedId === id) return;
  dashSelectedId = id;
  document.querySelectorAll('#dashGrid .dash-card').forEach(el =>
    el.classList.toggle('selected', dashEditing && el.dataset.card === id));
  if (typeof renderDashFormat === 'function') renderDashFormat();
}

/**
 * Write an edited field back into its visual.
 *
 * `labels` and series values are comma lists rather than a row of inputs: a
 * chart with eight points would otherwise be sixteen tiny fields, and pasting
 * a series from a spreadsheet is the fast path people actually want.
 *
 * @param {HTMLElement} el a [data-bind] element
 */
function dashCommit(el) {
  const card = dashCardById(el.dataset.card);
  if (!card) return;
  const text = el.textContent.trim();
  const path = el.dataset.bind;

  if (path === 'labels' || path === 'slicerItems') {
    const parts = text.split(',').map(s => s.trim()).filter(s => s !== '');
    if (path === 'labels') card.labels = parts;
    else { card.items = parts; card.picked = (card.picked || []).filter(v => parts.indexOf(String(v)) >= 0); }
    return;
  }
  // seriesList.<i>.values — a comma list of numbers. A non-number is dropped
  // rather than coerced to zero: a typo should not become a data point.
  const sv = path.match(/^seriesList\.(\d+)\.values$/);
  if (sv) {
    const s = card.seriesList && card.seriesList[+sv[1]];
    if (s) s.values = text.split(',').map(x => Number(x.trim())).filter(isFinite);
    return;
  }

  const keys = path.split('.');
  let node = card;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node[keys[i]] == null) node[keys[i]] = {};
    node = node[keys[i]];
  }
  const last = keys[keys.length - 1];
  // An em-dash is what an empty field is *shown* as; storing it back would turn
  // the placeholder into content, and the next edit would start by deleting a
  // character nobody typed.
  node[last] = text === '—' ? '' : text;
}

(function wireDashboard() {
  const app = document.getElementById('app');
  if (!app) return;

  // One delegated set of listeners for the whole board: visuals are rebuilt on
  // every change, and per-card handlers would be re-attached each time.
  const inBoard = e => e.target.closest && e.target.closest('#dashGrid');

  app.addEventListener('click', e => {
    if (!inBoard(e)) return;

    const add = e.target.closest('[data-add]');
    if (add) {
      const card = dashNewCard(add.dataset.add);
      dashCards.push(card);
      dashSelectedId = card.id;
      renderDashboard();
      return;
    }

    const cardEl = e.target.closest('.dash-card');
    if (!cardEl) return;
    const card = dashCardById(cardEl.dataset.card);
    if (!card) return;

    // Slicers work whether or not the board is unlocked: filtering is reading.
    const slice = e.target.closest('[data-slice]');
    if (slice) {
      const v = slice.dataset.slice;
      const set = new Set((card.picked || []).map(String));
      if (set.has(v)) set.delete(v); else set.add(v);
      card.picked = [...set];
      renderDashboard();
      return;
    }
    if (e.target.closest('[data-slice-clear]')) { card.picked = []; renderDashboard(); return; }

    if (!dashEditing) return;
    dashSelect(card.id);

    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'del') {
        dashCards = dashCards.filter(c => c !== card);
        if (dashSelectedId === card.id) dashSelectedId = null;
      }
      if (act.dataset.act === 'dup') {
        const copy = JSON.parse(JSON.stringify(card));
        copy.id = 'c' + (dashCardSeq++);
        copy.y = card.y + card.h;
        dashCards.push(copy);
        dashSelectedId = copy.id;
      }
      renderDashboard();
      return;
    }

    const addRow = e.target.closest('[data-add-row]');
    if (addRow) {
      if (card.type === 'table') (card.rows = card.rows || []).push((card.columns || []).map(() => ''));
      else (card.items = card.items || []).push({ name: 'Item', meta: '' });
      renderDashboard();
      return;
    }
    const addCol = e.target.closest('[data-add-col]');
    if (addCol) {
      (card.columns = card.columns || []).push('Column');
      (card.rows || []).forEach(r => r.push(''));
      renderDashboard();
      return;
    }
    const dropRow = e.target.closest('[data-drop-row]');
    if (dropRow) {
      const i = +dropRow.dataset.dropRow;
      if (card.type === 'table') card.rows.splice(i, 1); else card.items.splice(i, 1);
      renderDashboard();
      return;
    }
  });

  app.addEventListener('blur', e => {
    const el = e.target.closest && e.target.closest('[data-bind]');
    if (!el || !dashEditing) return;
    if (!inBoard(e) && !e.target.closest('#dashFormat')) return;
    dashCommit(el);
    // Charts and gauges have to redraw from the new numbers; text does not, but
    // rebuilding uniformly is one code path instead of a list of exceptions.
    renderDashboard();
  }, true);

  app.addEventListener('keydown', e => {
    // Enter commits in a single-line field. The text card is the exception —
    // a summary paragraph wants its line breaks.
    const el = e.target.closest && e.target.closest('[data-bind]');
    if (e.key === 'Enter' && el && !el.classList.contains('dc-text') && !e.shiftKey) {
      e.preventDefault();
      el.blur();
    }
  });
})();
