/**
 * ui/dashCards.js — the dashboard's cards: yours to fill in and arrange.
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
 * SEVEN TYPES, NOT SEVENTY. stat, stats, chart, gauges, list, access, text.
 * Between them they cover the whole mockup, and each one is small enough to
 * edit in place with a caret rather than a dialog. A card builder with a
 * property panel per card would be a bigger feature than the dashboard it
 * decorates.
 *
 * EDITING IS A MODE. Off, the board is a board — click anything and nothing
 * happens to it. On, every value carries a caret and the cards grow handles.
 * A dashboard you can retype by mis-clicking is a document, not a dashboard.
 *
 * Everything here serialises into the project, so a board travels with the map
 * it describes.
 */

/** The board. `slot` is 'side' (right rail) or 'grid' (the wall below). */
let dashCards = [];

/** Whether the board is being edited. A mode, not data — never serialised. */
let dashEditing = false;

let dashCardSeq = 1;

/** Column span options a card cycles through, out of twelve. */
const DASH_SPANS = [3, 4, 6, 12];

/** What the "add" bar offers, and what a fresh one of each looks like. */
const DASH_CARD_TYPES = [
  ['stat', 'Number', () => ({ label: 'Metric', value: '0', sub: '' })],
  ['stats', 'Three numbers', () => ({ items: [
    { label: 'Score', value: '0' }, { label: 'Potential', value: '—' }, { label: 'Risk', value: '—' }] })],
  ['chart', 'Chart', () => ({ kind: 'line', color: '#8B7CF0',
    labels: ['2021', '2022', '2023', '2024', '2025'], values: [10, 12, 11, 14, 16] })],
  ['gauges', 'Score rings', () => ({ items: [
    { cap: 'Connectivity', value: 90, color: '#22C55E' },
    { cap: 'Infrastructure', value: 80, color: '#38BDF8' }] })],
  ['list', 'List', () => ({ items: [{ name: 'Item', meta: '' }] })],
  ['access', 'Key access points (live)', () => ({})],
  ['text', 'Text', () => ({ body: 'Type here.' })],
];

/** @param {string} type @returns {object} a new card of that type */
function dashNewCard(type, slot) {
  const def = DASH_CARD_TYPES.find(t => t[0] === type) || DASH_CARD_TYPES[0];
  return Object.assign({
    id: 'c' + (dashCardSeq++),
    type: def[0],
    slot: slot || 'grid',
    span: 3,
    title: def[1],
  }, def[2]());
}

/**
 * The board a new project starts with.
 *
 * Shaped after the mockup, but every figure is a placeholder em-dash rather
 * than a plausible-looking number. A zero reads as measured; "—" reads as
 * "nobody has filled this in", which is the truth on a board that has just
 * been created.
 */
function dashDefaultCards() {
  dashCardSeq = 1;
  const c = (type, over) => Object.assign(dashNewCard(type), over);
  return [
    c('text', { slot: 'side', title: 'Property location & access',
      body: 'Type the address, the coordinates and anything else worth saying up front.' }),
    c('stats', { slot: 'side', title: 'Scores', items: [
      { label: 'Investment', value: '—' }, { label: 'Growth', value: '—' }, { label: 'Risk', value: '—' }] }),
    c('access', { slot: 'side', title: 'Key access points' }),

    // Captions and axis labels are scaffolding — they say what the card is for.
    // The numbers are left empty: a fresh board should not arrive carrying
    // scores and a price line nobody entered.
    c('gauges', { span: 6, title: 'Infrastructure score', items: [
      { cap: 'Connectivity', value: '', color: '#22C55E' },
      { cap: 'Infrastructure', value: '', color: '#38BDF8' },
      { cap: 'Development', value: '', color: '#F5C518' },
      { cap: 'Livability', value: '', color: '#22C55E' }] }),
    c('chart', { span: 6, title: 'Property price trend',
      labels: ['2021', '2022', '2023', '2024', '2025'], values: [] }),
    c('text', { span: 6, title: 'Executive summary',
      body: 'Type the summary that opens the report.' }),
    c('list', { span: 6, title: 'Timeline (development)', items: [
      { name: 'Milestone', meta: 'Year' }] }),
  ];
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
 * A sparkline or bar chart, as inline SVG.
 *
 * No charting library: this draws a polyline and some rectangles, and a
 * dependency for that would be more code than the thing it renders — and one
 * more thing to keep working through an export. Drawn on a 0-100 viewBox with
 * preserveAspectRatio off, so it stretches to whatever the card is wide.
 *
 * @param {object} card @returns {string} HTML
 */
function dashChartHtml(card) {
  const vals = (card.values || []).map(Number).filter(n => isFinite(n));
  const labels = card.labels || [];
  const color = card.color || '#8B7CF0';
  if (vals.length < 2) {
    return '<div class="dc-stat-sub">'
      + (dashEditing
        ? 'Type at least two comma-separated values below and the line draws itself.'
        : 'No values yet — turn on Edit board to type them.')
      + '</div>'
      + (dashEditing
        ? '<div class="dc-stat-sub">Labels ' + dashField(card, 'labels', labels.join(', '), 'dc-row-meta')
          + 'Values ' + dashField(card, 'values', vals.join(', '), 'dc-row-meta') + '</div>'
        : '');
  }

  const max = Math.max.apply(null, vals);
  const min = Math.min.apply(null, vals);
  // A flat series would divide by zero and, worse, draw a line at the top of
  // the box as though it were a maximum.
  const span = (max - min) || 1;
  const x = i => (i / (vals.length - 1)) * 100;
  const y = v => 96 - ((v - min) / span) * 88;

  let body = '';
  if (card.kind === 'bar') {
    const w = 100 / vals.length * 0.62;
    body = vals.map((v, i) =>
      '<rect class="bar" x="' + (x(i) - w / 2).toFixed(2) + '" y="' + y(v).toFixed(2)
      + '" width="' + w.toFixed(2) + '" height="' + Math.max(0.5, 96 - y(v)).toFixed(2)
      + '" fill="' + esc(color) + '"/>').join('');
  } else {
    body = '<polyline class="line" stroke="' + esc(color) + '" points="'
      + vals.map((v, i) => x(i).toFixed(2) + ',' + y(v).toFixed(2)).join(' ') + '"/>'
      + vals.map((v, i) => '<circle class="dot" cx="' + x(i).toFixed(2) + '" cy="' + y(v).toFixed(2)
        + '" r="2.4" fill="' + esc(color) + '"/>').join('');
  }

  return '<svg class="dc-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img"'
    + ' aria-label="' + esc(card.title || 'Chart') + '">'
    + '<line class="grid" x1="0" y1="96" x2="100" y2="96"/>' + body + '</svg>'
    + '<div class="dc-axis"><span>' + esc(labels[0] || '') + '</span>'
    + '<span>' + esc(labels[labels.length - 1] || '') + '</span></div>'
    + (dashEditing
      ? '<div class="dc-stat-sub">Labels ' + dashField(card, 'labels', labels.join(', '), 'dc-row-meta')
        + 'Values ' + dashField(card, 'values', vals.join(', '), 'dc-row-meta') + '</div>'
      : '');
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
      + '<svg viewBox="0 0 60 60" width="66" height="66" role="img" aria-label="'
        + esc(g.cap || '') + ' ' + (set ? v + ' out of 100' : 'not set') + '">'
      + '<circle class="track" cx="30" cy="30" r="' + r + '" stroke-width="5"/>'
      + (set
        ? '<circle class="val" cx="30" cy="30" r="' + r + '" stroke-width="5" stroke="' + esc(g.color || '#22C55E')
          + '" stroke-dasharray="' + (circ * v / 100).toFixed(1) + ' ' + circ.toFixed(1) + '"/>'
        : '')
      + '<text class="dc-gauge-num" x="30" y="35">' + (set ? v : '—') + '</text></svg>'
      + dashField(card, 'items.' + i + '.cap', g.cap, 'dc-gauge-cap')
      + (dashEditing ? dashField(card, 'items.' + i + '.value', set ? String(v) : '', 'dc-row-meta') : '')
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
    return '<div class="dc-stat-sub">' + (drawn
      ? 'Measuring ' + drawn + ' route' + (drawn === 1 ? '' : 's') + '… distances appear here once the routing service answers.'
      : 'No routes yet. Draw one in the Routes tab and it appears here.') + '</div>';
  }
  return '<div class="dc-list">' + rows.slice(0, 8).map(r =>
    '<div class="dc-row">'
    + '<span class="dc-ico">' + (typeof legendMarkHtml === 'function' ? legendMarkHtml(r) : '') + '</span>'
    + '<div class="dc-row-main"><div class="dc-row-name">' + esc(r.name) + '</div>'
    + '<div class="dc-row-meta">' + esc(r.km) + (r.min && r.min !== '—' ? ' · ' + esc(r.min) : '') + '</div></div>'
    + '</div>').join('') + '</div>';
}

/** @param {object} card @returns {string} the card's body HTML */
function dashCardBody(card) {
  switch (card.type) {
    case 'stat':
      return dashField(card, 'label', card.label, 'dc-stat-label')
        + dashField(card, 'value', card.value, 'dc-stat-val')
        + dashField(card, 'sub', card.sub, 'dc-stat-sub');

    case 'stats':
      return '<div style="display:flex;gap:14px;flex-wrap:wrap">'
        + (card.items || []).map((it, i) =>
          '<div style="flex:1;min-width:78px">'
          + dashField(card, 'items.' + i + '.label', it.label, 'dc-stat-label')
          + dashField(card, 'items.' + i + '.value', it.value, 'dc-stat-val')
          + '</div>').join('') + '</div>';

    case 'chart': return dashChartHtml(card);
    case 'gauges': return dashGaugesHtml(card);
    case 'access': return dashAccessHtml();

    case 'list':
      return '<div class="dc-list">' + (card.items || []).map((it, i) =>
        '<div class="dc-row"><div class="dc-row-main">'
        + dashField(card, 'items.' + i + '.name', it.name, 'dc-row-name')
        + dashField(card, 'items.' + i + '.meta', it.meta, 'dc-row-meta')
        + '</div>'
        + (dashEditing ? '<button class="dc-btn danger" data-drop-row="' + i + '" title="Remove this row">&times;</button>' : '')
        + '</div>').join('')
        + (dashEditing ? '<button class="dc-btn" data-add-row="1" style="align-self:flex-start;font-size:11px">+ Row</button>' : '')
        + '</div>';

    case 'text':
    default:
      return dashField(card, 'body', card.body, 'dc-text');
  }
}

/** @param {object} card @returns {HTMLElement} */
function dashCardEl(card) {
  const el = document.createElement('section');
  el.className = 'dash-card';
  el.dataset.card = card.id;
  el.style.setProperty('--span', card.span || 3);
  if (dashEditing) el.draggable = true;

  el.innerHTML =
    '<div class="dc-head">'
    + '<div class="dc-title" data-card="' + card.id + '" data-bind="title"'
      + (dashEditing ? ' contenteditable="true" spellcheck="false"' : '') + '>' + esc(card.title || '') + '</div>'
    + '<div class="dc-tools">'
      + (card.slot === 'grid'
        ? '<button class="dc-btn" data-act="span" title="Change how wide this card is">'
          + '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 7 4 12l4 5M16 7l4 5-4 5"/></svg></button>'
        : '')
      + '<button class="dc-btn danger" data-act="del" title="Remove this card">'
        + '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>'
    + '</div></div>'
    + dashCardBody(card);

  return el;
}

/** Redraw both slots. */
function renderDashboard() {
  const side = document.getElementById('dashSide');
  const grid = document.getElementById('dashGrid');
  if (!side || !grid) return;

  if (!dashCards.length) dashCards = dashDefaultCards();

  side.innerHTML = '';
  grid.innerHTML = '';
  dashCards.forEach(c => (c.slot === 'side' ? side : grid).appendChild(dashCardEl(c)));

  // The add bar lives inside the grid so it flows with the cards rather than
  // sitting in a toolbar somewhere else on the page.
  const add = document.createElement('div');
  add.id = 'dashAdd';
  add.innerHTML = DASH_CARD_TYPES.map(t =>
    '<button type="button" data-add="' + t[0] + '">+ ' + esc(t[1]) + '</button>').join('');
  grid.appendChild(add);

  const app = document.getElementById('app');
  if (app) app.classList.toggle('dash-editing', dashEditing);
  const btn = document.getElementById('dashEditBtn');
  if (btn) {
    btn.classList.toggle('on', dashEditing);
    btn.setAttribute('aria-pressed', String(dashEditing));
  }
}

/** @param {boolean} on */
function setDashEditing(on) {
  dashEditing = !!on;
  renderDashboard();
  if (typeof status === 'function') {
    status(dashEditing
      ? 'Editing the board: click any value to retype it, drag a card by its title to move it.'
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
    card[path] = path === 'values' ? parts.map(Number).map(n => (isFinite(n) ? n : 0)) : parts;
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
  const inBoard = e => e.target.closest && e.target.closest('#dashSide, #dashGrid');

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
      if (act.dataset.act === 'span') {
        card.span = DASH_SPANS[(DASH_SPANS.indexOf(card.span) + 1) % DASH_SPANS.length];
      }
      renderDashboard();
      return;
    }

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

  /* ---- drag to reorder ---- */
  let dragId = null;

  app.addEventListener('dragstart', e => {
    const el = e.target.closest && e.target.closest('.dash-card');
    if (!el || !dashEditing) return;
    dragId = el.dataset.card;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag without data on the transfer.
    try { e.dataTransfer.setData('text/plain', dragId); } catch (err) { /* ignore */ }
  });

  app.addEventListener('dragover', e => {
    if (!dragId) return;
    const el = e.target.closest && e.target.closest('.dash-card');
    if (!el || el.dataset.card === dragId) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const after = (e.clientX - r.left) > r.width / 2;
    el.classList.toggle('drop-after', after);
    el.classList.toggle('drop-before', !after);
  });

  app.addEventListener('dragleave', e => {
    const el = e.target.closest && e.target.closest('.dash-card');
    if (el) el.classList.remove('drop-before', 'drop-after');
  });

  app.addEventListener('drop', e => {
    if (!dragId) return;
    const el = e.target.closest && e.target.closest('.dash-card');
    if (!el) return;
    e.preventDefault();

    const from = dashCards.findIndex(c => c.id === dragId);
    const onto = dashCards.findIndex(c => c.id === el.dataset.card);
    if (from < 0 || onto < 0 || from === onto) { dragId = null; renderDashboard(); return; }

    const r = el.getBoundingClientRect();
    const after = (e.clientX - r.left) > r.width / 2;
    const moved = dashCards.splice(from, 1)[0];
    // A card dragged into the other slot joins it — that is how something moves
    // between the right rail and the wall without a separate control for it.
    moved.slot = dashCards[onto > from ? onto - 1 : onto].slot;
    let at = dashCards.findIndex(c => c.id === el.dataset.card);
    dashCards.splice(at + (after ? 1 : 0), 0, moved);

    dragId = null;
    renderDashboard();
  });

  app.addEventListener('dragend', () => {
    dragId = null;
    document.querySelectorAll('.dragging, .drop-before, .drop-after')
      .forEach(el => el.classList.remove('dragging', 'drop-before', 'drop-after'));
  });
})();
