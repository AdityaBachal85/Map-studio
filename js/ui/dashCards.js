/**
 * ui/dashCards.js — the board's cards: yours to fill in, size and arrange.
 *
 * WHY EVERY NUMBER IS TYPED, NOT COMPUTED. The board shows things this app has
 * no way of knowing — price per square foot, rental yield, demand-supply,
 * market sentiment. There is no source for them here, and a tool that prints a
 * confident price per square foot it invented is worse than one that prints
 * nothing: the number goes into a client document and nobody can tell it was
 * never real. So the cards are containers, and the figures are yours. Where
 * the app *does* know something — the routes, their distances, the Key
 * Distances table — the card reads it live and says so.
 *
 * A fresh board therefore arrives EMPTY, not seeded. Captions and axis labels
 * are scaffolding that says what a card is for; the values are em-dashes until
 * somebody types them. A zero reads as measured.
 *
 * SEVEN TYPES, NOT SEVENTY. stat, stats, chart, gauges, list, access, text.
 * Between them they cover the whole mockup, and each one is small enough to
 * edit in place with a caret rather than a dialog.
 *
 * EDITING IS A MODE. Off, the board is a board — click anything and nothing
 * happens to it, and the tiles have no handles. On, every value carries a caret
 * and every tile can be moved and resized. A dashboard you can retype by
 * mis-clicking is a document, not a dashboard.
 *
 * Geometry lives in ui/dashLayout.js; charts in ui/dashCharts.js. Everything
 * here serialises into the project, so a board travels with the map it
 * describes.
 */

/** The board. Each card carries its own `{x, y, w, h}` on the canvas. */
let dashCards = [];

/** Whether the board is being edited. A mode, not data — never serialised. */
let dashEditing = false;

let dashCardSeq = 1;

/** The chart forms, and what each is for. */
const DASH_CHART_KINDS = [
  ['line', 'Line'],
  ['area', 'Area'],
  ['bar', 'Column'],
  ['donut', 'Donut'],
];

/** What the "add" bar offers, and what a fresh one of each looks like. */
const DASH_CARD_TYPES = [
  ['stat', 'Number', () => ({ label: 'Metric', value: '', sub: '', w: 3, h: 5 })],
  ['stats', 'Three numbers', () => ({ w: 4, h: 5, items: [
    { label: 'Score', value: '' }, { label: 'Potential', value: '' }, { label: 'Risk', value: '' }] })],
  ['chart', 'Chart', () => ({ kind: 'line', series: 1, w: 6, h: 9,
    labels: ['2021', '2022', '2023', '2024', '2025'], values: [] })],
  ['gauges', 'Score rings', () => ({ w: 6, h: 7, items: [
    { cap: 'Connectivity', value: '', color: '#22C55E' },
    { cap: 'Infrastructure', value: '', color: '#38BDF8' }] })],
  ['list', 'List', () => ({ w: 4, h: 7, items: [{ name: 'Item', meta: '' }] })],
  ['access', 'Key access points (live)', () => ({ w: 4, h: 7 })],
  ['text', 'Text', () => ({ body: 'Type here.', w: 4, h: 5 })],
];

/** @param {string} type @returns {object} a new card of that type */
function dashNewCard(type) {
  const def = DASH_CARD_TYPES.find(t => t[0] === type) || DASH_CARD_TYPES[0];
  const card = Object.assign({
    id: 'c' + (dashCardSeq++),
    type: def[0],
    x: 0, y: 9999, w: 4, h: 5,   // y past the end: it lands at the bottom, then settles up
    title: def[1],
  }, def[2]());
  return card;
}

/**
 * The board a new project starts with — the mockup's shape, in tiles.
 *
 * The map takes the left two-thirds with the three context cards beside it,
 * then the charts across the wall below. Every one of these is draggable and
 * resizable from the moment it appears; this is a starting point, not a layout.
 */
function dashDefaultCards() {
  dashCardSeq = 1;
  dashMapTile = { id: DASH_MAP_ID, x: 0, y: 0, w: 8, h: 14 };
  const c = (type, over) => Object.assign(dashNewCard(type), over);
  return [
    c('text', { x: 8, y: 0, w: 4, h: 5, title: 'Property location & access',
      body: 'Type the address, the coordinates and anything else worth saying up front.' }),
    c('stats', { x: 8, y: 5, w: 4, h: 4, title: 'Scores', items: [
      { label: 'Investment', value: '' }, { label: 'Growth', value: '' }, { label: 'Risk', value: '' }] }),
    c('access', { x: 8, y: 9, w: 4, h: 5, title: 'Key access points' }),

    c('gauges', { x: 0, y: 14, w: 6, h: 7, title: 'Infrastructure score', items: [
      { cap: 'Connectivity', value: '', color: '#22C55E' },
      { cap: 'Infrastructure', value: '', color: '#38BDF8' },
      { cap: 'Development', value: '', color: '#F5C518' },
      { cap: 'Livability', value: '', color: '#22C55E' }] }),
    c('chart', { x: 6, y: 14, w: 6, h: 7, title: 'Property price trend', kind: 'area', series: 1,
      labels: ['2021', '2022', '2023', '2024', '2025'], values: [] }),
    c('text', { x: 0, y: 21, w: 6, h: 6, title: 'Executive summary',
      body: 'Type the summary that opens the report.' }),
    c('list', { x: 6, y: 21, w: 6, h: 6, title: 'Timeline (development)', items: [
      { name: 'Milestone', meta: 'Year' }] }),
  ];
}

/**
 * Bring a board saved before the canvas existed up to date.
 *
 * Older boards positioned cards by a `slot` ('side' or 'grid') and a column
 * `span`; there was no y and no height. Rather than drop those boards, lay them
 * out in the order they were saved: the side rail becomes the right column, the
 * grid flows across the rest, and the settle pass tidies the result.
 *
 * @param {object[]} cards
 */
function dashMigrateCards(cards) {
  let sideY = 0, gridY = 0;
  cards.forEach(c => {
    if (typeof c.w === 'number' && typeof c.h === 'number'
      && typeof c.x === 'number' && typeof c.y === 'number') return;
    const h = c.type === 'chart' ? 8 : c.type === 'gauges' ? 7 : c.type === 'stat' ? 5 : 6;
    if (c.slot === 'side') {
      c.x = 8; c.w = 4; c.y = sideY; sideY += h;
    } else {
      const w = Math.max(2, Math.min(12, c.span || 4));
      c.w = w; c.x = (gridY % 2) ? Math.max(0, 12 - w) : 0;
      c.y = 14 + gridY * h; gridY++;
    }
    c.h = h;
    delete c.slot; delete c.span;
  });
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
 * A chart card: a plot host the chart is measured into, plus its controls.
 *
 * The SVG itself is not built here — it is drawn after layout, when the host
 * has a real width and height to measure. See ui/dashCharts.js.
 *
 * @param {object} card @returns {string} HTML
 */
function dashChartHtml(card) {
  const vals = (card.values || []).map(Number).filter(isFinite);
  const labels = card.labels || [];
  const kind = card.kind || 'line';
  const enough = kind === 'donut' ? vals.length >= 1 : vals.length >= 2;

  let s = '<div class="dc-plot" data-card="' + card.id + '"></div>';

  if (!enough) {
    s += '<div class="dc-empty">'
      + (dashEditing
        ? 'Type comma-separated values below — ' + (kind === 'donut' ? 'one per slice' : 'at least two')
          + ' — and the chart draws itself.'
        : 'No values yet — turn on Edit board to type them.')
      + '</div>';
  }

  if (dashEditing) {
    s += '<div class="dc-ctl">'
      + '<div class="dc-seg" role="group" aria-label="Chart type">'
      + DASH_CHART_KINDS.map(k =>
        '<button type="button" data-kind="' + k[0] + '"' + (k[0] === kind ? ' class="on"' : '')
        + '>' + esc(k[1]) + '</button>').join('')
      + '</div>'
      + '<div class="dc-swatches" role="group" aria-label="Chart colour">'
      + [1, 2, 3, 4, 5, 6, 7, 8].map(n =>
        '<button type="button" class="dc-sw' + (n === (card.series || 1) ? ' on' : '')
        + '" data-series="' + n + '" style="background:var(--viz-' + n + ')"'
        + ' title="Colour ' + n + '" aria-label="Colour ' + n + '"></button>').join('')
      + '</div></div>'
      + '<div class="dc-fields">'
      + '<label>Labels' + dashField(card, 'labels', labels.join(', '), 'dc-input') + '</label>'
      + '<label>Values' + dashField(card, 'values', vals.join(', '), 'dc-input') + '</label>'
      + '</div>';
  }
  return s;
}

/** @param {object} card @returns {string} HTML */
function dashGaugesHtml(card) {
  return '<div class="dc-gauges">' + (card.items || []).map((g, i) => {
    // An unset gauge reads "—" with an empty ring, not "0". A zero is a score
    // somebody chose; showing one nobody typed puts a number in a client's
    // report that came from the app rather than from the analyst.
    const raw = g.value;
    const set = raw !== '' && raw != null && isFinite(Number(raw));
    const v = set ? Math.max(0, Math.min(100, Number(raw))) : 0;
    const r = 24, circ = 2 * Math.PI * r;
    return '<div class="dc-gauge">'
      + '<svg viewBox="0 0 60 60" width="62" height="62" role="img" aria-label="'
        + esc(g.cap || '') + ' ' + (set ? v + ' out of 100' : 'not set') + '">'
      + '<circle class="track" cx="30" cy="30" r="' + r + '" stroke-width="5"/>'
      + (set
        ? '<circle class="val" cx="30" cy="30" r="' + r + '" stroke-width="5" stroke="' + esc(g.color || '#22C55E')
          + '" stroke-dasharray="' + (circ * v / 100).toFixed(1) + ' ' + circ.toFixed(1) + '"/>'
        : '')
      + '<text class="dc-gauge-num" x="30" y="35">' + (set ? v : '—') + '</text></svg>'
      + dashField(card, 'items.' + i + '.cap', g.cap, 'dc-gauge-cap')
      + (dashEditing ? dashField(card, 'items.' + i + '.value', set ? String(v) : '', 'dc-input') : '')
      + '</div>';
  }).join('') + '</div>';
}

/**
 * Key access points, read live from the same rows the Key Distances card uses.
 *
 * This one card is not typed in: it is the routes you have actually drawn, so
 * it cannot drift from the map. Editing its values happens where they live —
 * on the Key Distances card — rather than in a second copy here that would
 * disagree with the first.
 *
 * @returns {string} HTML
 */
function dashAccessHtml() {
  const rows = (typeof legendRows === 'function') ? legendRows() : [];
  if (!rows.length) {
    // A drawn route with no distance yet is still measuring (or the routing
    // service is unreachable), which is a different situation from having
    // drawn nothing — and "No routes yet" under three visible routes reads as
    // the card being broken.
    const drawn = (typeof routes !== 'undefined' && routes) ? routes.length : 0;
    return '<div class="dc-empty">' + (drawn
      ? 'Measuring ' + drawn + ' route' + (drawn === 1 ? '' : 's') + '… distances appear here once the routing service answers.'
      : 'No routes yet. Draw one in the Routes tab and it appears here.') + '</div>';
  }
  return '<div class="dc-list">' + rows.map(r =>
    '<div class="dc-row">'
    + '<span class="dc-ico">' + (typeof legendMarkHtml === 'function' ? legendMarkHtml(r) : '') + '</span>'
    + '<div class="dc-row-main"><div class="dc-row-name">' + esc(r.name) + '</div></div>'
    + '<div class="dc-row-meta">' + esc(r.km) + (r.min && r.min !== '—' ? ' · ' + esc(r.min) : '') + '</div>'
    + '</div>').join('') + '</div>';
}

/** @param {object} card @returns {string} the card's body HTML */
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
    case 'access': return dashAccessHtml();

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

    case 'text':
    default:
      return dashField(card, 'body', card.body, 'dc-text');
  }
}

/** @param {object} card @returns {HTMLElement} */
function dashCardEl(card) {
  const el = document.createElement('section');
  el.className = 'dash-card dash-tile dc-type-' + card.type;
  el.dataset.card = card.id;

  el.innerHTML =
    '<div class="dc-head">'
    + (dashEditing ? '<span class="dc-grip" aria-hidden="true"></span>' : '')
    + '<div class="dc-title" data-card="' + card.id + '" data-bind="title"'
      + (dashEditing ? ' contenteditable="true" spellcheck="false"' : '') + '>' + esc(card.title || '') + '</div>'
    + '<div class="dc-tools">'
      + '<button class="dc-btn danger" data-act="del" title="Remove this card" aria-label="Remove this card">'
        + '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>'
    + '</div></div>'
    + '<div class="dc-body">' + dashCardBody(card) + '</div>'
    + (dashEditing ? dashHandlesHtml() : '');

  return el;
}

/** Redraw the canvas. */
function renderDashboard() {
  const grid = document.getElementById('dashGrid');
  if (!grid) return;

  if (!dashCards.length) dashCards = dashDefaultCards();
  dashMigrateCards(dashCards);

  // The map lives on the canvas and must survive the rebuild, so it is lifted
  // out before the wipe rather than being innerHTML'd away.
  const wrap = document.getElementById('mapWrap');
  const mapWasHere = wrap && wrap.parentNode === grid;
  if (mapWasHere) grid.removeChild(wrap);
  grid.innerHTML = '';
  if (mapWasHere) grid.appendChild(wrap);

  dashCards.forEach(c => grid.appendChild(dashCardEl(c)));

  if (dashEditing) {
    const add = document.createElement('div');
    add.id = 'dashAdd';
    add.innerHTML = '<span class="da-cap">Add</span>' + DASH_CARD_TYPES.map(t =>
      '<button type="button" data-add="' + t[0] + '">' + esc(t[1]) + '</button>').join('');
    grid.appendChild(add);
  }

  if (wrap) wrap.classList.toggle('tile-editing', dashEditing);
  if (mapWasHere && dashEditing && !wrap.querySelector('.dc-rz')) {
    const h = document.createElement('div');
    h.className = 'dc-maphandles';
    // Not also `.dc-grip`: that class is the 13px dotted square used inside a
    // card header, and its fixed width squashed this chip to a blob.
    h.innerHTML = '<span class="dc-maphead" title="Drag to move the map tile"></span>' + dashHandlesHtml();
    wrap.appendChild(h);
  } else if (wrap) {
    const h = wrap.querySelector('.dc-maphandles');
    if (h && !dashEditing) h.remove();
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
}

/**
 * Redraw only the cards that read from the map.
 *
 * Called whenever the distances change — routes measure asynchronously, so a
 * board opened straight after drawing one shows "measuring…" and has to catch
 * up on its own. Rebuilding the whole board would do it in one line and would
 * also blow away whatever was being typed into another card at that moment,
 * which is why this touches only the live ones. They contain no editable
 * fields, so there is nothing here to lose.
 */
function dashRefreshLive() {
  dashCards.forEach(c => {
    if (c.type !== 'access') return;
    const body = document.querySelector('#dashGrid .dash-card[data-card="' + c.id + '"] .dc-body');
    if (body) body.innerHTML = dashAccessHtml();
  });
}

/** @param {boolean} on */
function setDashEditing(on) {
  dashEditing = !!on;
  renderDashboard();
  if (typeof status === 'function') {
    status(dashEditing
      ? 'Editing the board: retype any value, drag a card by its title bar, resize from any edge or corner.'
      : 'Board saved.');
  }
}

/* ---------------------------------------------------------------------------
 * Editing
 * ------------------------------------------------------------------------ */

/** @param {string} id @returns {object|undefined} */
function dashCardById(id) { return dashCards.find(c => c.id === id); }

/**
 * Write an edited field back into its card.
 *
 * `labels` and `values` are comma lists rather than a row of inputs: a chart
 * with eight points would otherwise be sixteen tiny fields, and pasting a
 * series from a spreadsheet is the fast path people actually want.
 *
 * @param {HTMLElement} el a [data-bind] element
 */
function dashCommit(el) {
  const card = dashCardById(el.dataset.card);
  if (!card) return;
  const text = el.textContent.trim();
  const path = el.dataset.bind;

  if (path === 'labels' || path === 'values') {
    const parts = text.split(',').map(s => s.trim()).filter(s => s !== '');
    // A non-number in a value list is dropped rather than coerced to zero: a
    // typo should not become a data point sitting on the axis.
    card[path] = path === 'values'
      ? parts.map(Number).filter(isFinite)
      : parts;
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

  // One delegated set of listeners for the whole board: cards are rebuilt on
  // every change, and per-card handlers would be re-attached each time.
  const inBoard = e => e.target.closest && e.target.closest('#dashGrid');

  app.addEventListener('click', e => {
    if (!inBoard(e)) return;

    const add = e.target.closest('[data-add]');
    if (add) { dashCards.push(dashNewCard(add.dataset.add)); renderDashboard(); return; }

    const cardEl = e.target.closest('.dash-card');
    if (!cardEl) return;
    const card = dashCardById(cardEl.dataset.card);
    if (!card) return;

    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'del') dashCards = dashCards.filter(c => c !== card);
      renderDashboard();
      return;
    }

    const kind = e.target.closest('[data-kind]');
    if (kind) { card.kind = kind.dataset.kind; renderDashboard(); return; }

    const series = e.target.closest('[data-series]');
    if (series) { card.series = +series.dataset.series; renderDashboard(); return; }

    const addRow = e.target.closest('[data-add-row]');
    if (addRow) { (card.items = card.items || []).push({ name: 'Item', meta: '' }); renderDashboard(); return; }

    const dropRow = e.target.closest('[data-drop-row]');
    if (dropRow) { card.items.splice(+dropRow.dataset.dropRow, 1); renderDashboard(); return; }
  });

  app.addEventListener('blur', e => {
    const el = e.target.closest && e.target.closest('[data-bind]');
    if (!el || !dashEditing || !inBoard(e)) return;
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
