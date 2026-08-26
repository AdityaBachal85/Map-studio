/**
 * ui/dashFormat.js — the format pane: everything about the selected visual.
 *
 * WHY A PANE AND NOT CONTROLS ON THE CARD. The first version put the chart type
 * switcher, the colour swatches and the two data fields inside the card itself.
 * That works with one chart and falls apart with nine: the controls eat the
 * space the chart needs, every card is a different height in edit mode than out
 * of it, and there is nowhere to put the twentieth setting. A pane costs one
 * click (select the visual) and then has room for the whole model.
 *
 * WHAT IS HERE. Visual type — switching keeps the data, which is the point of a
 * switcher rather than delete-and-re-add. Data: categories and any number of
 * series, each with its own name, values and colour slot. Format: title,
 * legend, data labels, gridlines, axes, smoothing. Layout: the tile's grid
 * position and size as numbers, for when dragging is not precise enough.
 *
 * WHAT IS NOT. There is no query engine and no formula language — data is typed
 * or pasted or read from the map. That is the honest boundary of this tool, and
 * it is stated in the pane rather than hidden behind a disabled button.
 */

/** @returns {object|null} the visual the pane is showing */
function dashFormatTarget() {
  return dashSelectedId ? dashCardById(dashSelectedId) : null;
}

/** @param {string} label @param {string} body @returns {string} a pane section */
/**
 * The ceiling a score is drawn against.
 *
 * Blank is not "no scale" — it is the inferred one, which is ten when every
 * score fits inside ten and a hundred otherwise. The placeholder says which,
 * so an empty field is never a mystery.
 *
 * @param {object} card @returns {string} HTML
 */
function dfScoreCeiling(card) {
  const nums = card.type === 'gauges'
    ? (card.items || []).map(i => Number(i.value)).filter(isFinite)
    : (card.seriesList || []).reduce((a, s) => a.concat((s.values || []).map(Number).filter(isFinite)), []);
  const inferred = typeof vizScoreMax === 'function' ? vizScoreMax({}, nums) : 100;
  return dfRow('Scored out of', '<input type="number" min="1" data-dfnum="max" value="'
    + (card.max == null ? '' : Number(card.max)) + '" placeholder="' + inferred + '">');
}

function dfSection(label, body) {
  return '<section class="df-sec"><h4>' + esc(label) + '</h4>' + body + '</section>';
}

/** @param {string} label @param {string} body @returns {string} a labelled row */
function dfRow(label, body) {
  return '<label class="df-row"><span>' + esc(label) + '</span>' + body + '</label>';
}

/**
 * A segmented control.
 * @param {string} key @param {Array} opts pairs of [value, label] @param {string} now
 */
function dfSeg(key, opts, now) {
  return '<div class="df-seg" role="group">' + opts.map(o =>
    '<button type="button" data-df="' + key + '" data-v="' + esc(o[0]) + '"'
    + (String(o[0]) === String(now) ? ' class="on"' : '') + '>' + esc(o[1]) + '</button>').join('') + '</div>';
}

/** @param {string} key @param {boolean} on @param {string} label */
function dfToggle(key, on, label) {
  return '<button type="button" class="df-tgl' + (on ? ' on' : '') + '" data-df="' + key
    + '" data-v="' + (on ? '0' : '1') + '" role="switch" aria-checked="' + (on ? 'true' : 'false')
    + '"><i></i>' + esc(label) + '</button>';
}

/** The eight colour slots. @param {string} key @param {number} now */
function dfSwatches(key, now) {
  return '<div class="df-sw-row">' + [1, 2, 3, 4, 5, 6, 7, 8].map(n =>
    '<button type="button" class="dc-sw' + (n === now ? ' on' : '') + '" data-df="' + key
    + '" data-v="' + n + '" style="background:var(--viz-' + n + ')" title="Colour ' + n
    + '" aria-label="Colour ' + n + '"></button>').join('') + '</div>';
}

/** Whether the pane had a column last time, so its opening can be noticed. */
let dfWasOpen = false;

/** Build and write the pane. */
function renderDashFormat() {
  const host = document.getElementById('dashFormat');
  if (!host) return;

  const card = dashFormatTarget();
  const app = document.getElementById('app');
  const open = !!(dashEditing && card);
  if (app) app.classList.toggle('df-open', open);

  // Opening the pane takes 268px off the canvas, which changes the column
  // width every tile's pixel geometry is computed from. Without this the tiles
  // keep their old, wider size and lie across the pane. Next frame, so the
  // grid has actually resized before anything is measured.
  if (open !== dfWasOpen) {
    dfWasOpen = open;
    requestAnimationFrame(() => {
      if (typeof dashLayoutApply === 'function') dashLayoutApply();
      if (typeof dashDrawAllCharts === 'function') dashDrawAllCharts();
    });
  }
  if (!dashEditing || !card) {
    host.innerHTML = '<div class="df-empty">'
      + (dashEditing
        ? 'Click a visual to format it.<br><br>Drag any tile by its body to move it, or pull an edge to resize. Use <b>Add a visual</b> at the foot of the board for a new one.'
        : 'Turn on <b>Edit board</b> to move, resize and format the visuals.')
      + '</div>';
    return;
  }

  const isChart = card.type === 'chart';
  const fmt = isChart ? vizFmt(card) : null;
  let html = '<div class="df-head"><b>' + esc(card.title || 'Visual') + '</b>'
    + '<span>' + esc(isChart ? (VIZ_KINDS.find(k => k[0] === card.kind) || ['', card.kind])[1] : card.type) + '</span></div>';

  /* ---- visual type ---- */
  if (isChart) {
    html += dfSection('Visual type',
      '<div class="df-kinds">' + VIZ_KINDS.map(k =>
        '<button type="button" data-df="kind" data-v="' + k[0] + '"'
        + (k[0] === card.kind ? ' class="on"' : '') + '>' + esc(k[1]) + '</button>').join('') + '</div>'
      + '<p class="df-note">Switching keeps the data.</p>');
  }

  /* ---- data ---- */
  if (isChart) {
    const series = card.seriesList || [];
    html += dfSection('Data',
      dfRow('Categories', '<div class="dc-input df-input" data-card="' + card.id
        + '" data-bind="labels" contenteditable="true" spellcheck="false">'
        + esc((card.labels || []).join(', ')) + '</div>')
      + series.map((s, i) =>
        '<div class="df-series">'
        + '<div class="df-series-hd">'
        + '<div class="dc-input df-name" data-card="' + card.id + '" data-bind="seriesList.' + i
        + '.name" contenteditable="true" spellcheck="false">' + esc(s.name || ('Series ' + (i + 1))) + '</div>'
        + (series.length > 1
          ? '<button class="dc-btn danger" data-df="dropSeries" data-v="' + i + '" title="Remove this series">&times;</button>'
          : '') + '</div>'
        + '<div class="dc-input df-input" data-card="' + card.id + '" data-bind="seriesList.' + i
        + '.values" contenteditable="true" spellcheck="false">' + esc((s.values || []).join(', ')) + '</div>'
        + dfSwatches('slot:' + i, s.slot || (i + 1))
        + '</div>').join('')
      + '<button class="df-add" data-df="addSeries" data-v="1">+ Add a series</button>'
      + '<p class="df-note">Comma-separated. Paste a row straight from a spreadsheet.</p>');
  }

  if (card.type === 'slicer') {
    html += dfSection('Values',
      '<div class="dc-input df-input" data-card="' + card.id + '" data-bind="slicerItems"'
      + ' contenteditable="true" spellcheck="false">' + esc((card.items || []).join(', ')) + '</div>'
      + '<p class="df-note">These filter every chart on the board by matching category.</p>');
  }

  /* ---- format ---- */
  let f = '';
  f += dfToggle('title', card.fmt ? card.fmt.title !== false : true, 'Title bar');
  if (isChart) {
    f += dfRow('Legend', dfSeg('legend', [['auto', 'Auto'], ['top', 'Top'], ['right', 'Right'],
      ['bottom', 'Bottom'], ['off', 'Off']], fmt.legend));
    // Only the toggles that do something for this kind. A "Value axis" switch on
    // a gauge is a control that changes nothing, and a panel full of those
    // teaches people to stop reading it.
    const score = VIZ_SCORE_KINDS.indexOf(card.kind) >= 0;
    const share = VIZ_SHARE_KINDS.indexOf(card.kind) >= 0;
    if (!score) f += dfToggle('labels', fmt.labels, 'Data labels');
    if (!share && card.kind !== 'gauge') f += dfToggle('grid', fmt.grid, 'Gridlines');
    if (!share && card.kind !== 'gauge' && card.kind !== 'ring') {
      f += dfToggle('xAxis', fmt.xAxis, card.kind === 'radar' ? 'Axis names' : 'Category axis');
    }
    if (!share && !score) f += dfToggle('yAxis', fmt.yAxis, 'Value axis');
    if (score) f += dfScoreCeiling(card);
    if (card.kind === 'line' || card.kind === 'area' || card.kind === 'combo') {
      f += dfToggle('smooth', fmt.smooth, 'Smooth line');
    }
  }
  // The score-rings card is not a `chart`, so it missed the branch above
  // entirely — and it is the card most likely to be scored out of ten.
  if (card.type === 'gauges') f += dfScoreCeiling(card);

  // Where the legend lives. On the map is the layout every printed connectivity
  // sheet uses — the key sits in a corner of the drawing it explains, not in a
  // panel beside it — and board mode hides the on-map card by default because
  // for a while it was showing the same rows twice.
  // A drive time is traffic on one day; a distance is the road. The minute is
  // opt-in for that reason — see dashAccessHtml().
  if (card.type === 'access') {
    f += dfToggle('time', !!(card.fmt && card.fmt.time), 'Travel time');
  }

  if (card.type === 'legend') {
    f += dfRow('Placement', dfSeg('onMap', [['card', 'A card'], ['map', 'On the map']],
      card.onMap ? 'map' : 'card'));
  }
  f += dfToggle('plain', !!(card.fmt && card.fmt.plain), 'Transparent card');
  html += dfSection('Format', f);

  /* ---- layout ---- */
  html += dfSection('Layout',
    '<div class="df-grid4">'
    + ['x', 'y', 'w', 'h'].map(k =>
      '<label><span>' + k.toUpperCase() + '</span><input type="number" data-dfnum="' + k
      + '" value="' + card[k] + '" min="0" max="' + (k === 'x' || k === 'w' ? 12 : 999) + '"></label>').join('')
    + '</div>'
    + '<div class="df-btns">'
    + '<button class="df-add" data-df="front" data-v="1">Bring to front</button>'
    + '<button class="df-add" data-df="back" data-v="1">Send to back</button>'
    + '</div>');

  host.innerHTML = html;
}

/* ---------------------------------------------------------------------------
 * Applying a change
 * ------------------------------------------------------------------------ */

/** @param {object} card @param {string} key @param {string} v */
function dashFormatApply(card, key, v) {
  card.fmt = card.fmt || {};

  const slot = key.match(/^slot:(\d+)$/);
  if (slot) {
    const s = card.seriesList && card.seriesList[+slot[1]];
    if (s) s.slot = +v;
    return;
  }

  switch (key) {
    case 'kind': card.kind = v; return;
    // Not a fmt flag: it moves the card off the board entirely, so it lives on
    // the card itself and travels with the project.
    case 'onMap':
      if (v === 'map') card.onMap = true; else delete card.onMap;
      return;
    case 'legend': card.fmt.legend = v; return;
    case 'title': card.fmt.title = v === '1'; return;
    case 'labels': card.fmt.labels = v === '1'; return;
    case 'grid': card.fmt.grid = v === '1'; return;
    case 'xAxis': card.fmt.xAxis = v === '1'; return;
    case 'yAxis': card.fmt.yAxis = v === '1'; return;
    case 'time': card.fmt.time = v === '1'; return;
    case 'smooth': card.fmt.smooth = v === '1'; return;
    case 'plain': card.fmt.plain = v === '1'; return;

    case 'addSeries': {
      card.seriesList = card.seriesList || [];
      // The next unused slot, so a new series never takes a colour already on
      // the chart — and never repaints the ones already there.
      const used = new Set(card.seriesList.map(s => s.slot));
      let n = 1;
      while (used.has(n) && n < 8) n++;
      card.seriesList.push({ name: 'Series ' + (card.seriesList.length + 1), values: [], slot: n });
      return;
    }
    case 'dropSeries':
      if (card.seriesList && card.seriesList.length > 1) card.seriesList.splice(+v, 1);
      return;

    // z-order is DOM order, which is array order.
    case 'front': {
      const i = dashCards.indexOf(card);
      if (i >= 0) { dashCards.splice(i, 1); dashCards.push(card); }
      return;
    }
    case 'back': {
      const i = dashCards.indexOf(card);
      if (i >= 0) { dashCards.splice(i, 1); dashCards.unshift(card); }
      return;
    }
  }
}

(function wireDashFormat() {
  const host = document.getElementById('dashFormat');
  if (!host) return;

  host.addEventListener('click', e => {
    const b = e.target.closest('[data-df]');
    if (!b) return;
    const card = dashFormatTarget();
    if (!card) return;
    dashFormatApply(card, b.dataset.df, b.dataset.v);
    renderDashboard();
  });

  host.addEventListener('change', e => {
    const inp = e.target.closest('[data-dfnum]');
    if (!inp) return;
    const card = dashFormatTarget();
    if (!card) return;
    const k = inp.dataset.dfnum;

    // The score ceiling is not geometry. Running it through the layout clamps
    // below would cap it at the column count, and settling the board because
    // somebody typed a scale would move tiles for no reason.
    if (k === 'max') {
      const n = parseFloat(inp.value);
      if (isFinite(n) && n > 0) card.max = n; else delete card.max;
      // A chart redraws into its existing host; the score-rings card IS its
      // markup, so it has to be rebuilt. Redrawing charts alone left the rings
      // showing the old ceiling.
      if (card.type === 'gauges') renderDashboard(); else dashDrawAllCharts();
      renderDashFormat();
      return;
    }

    const min = (k === 'w' || k === 'h') ? (k === 'w' ? DASH_MIN.w : DASH_MIN.h) : 0;
    card[k] = Math.max(min, Math.min(k === 'x' || k === 'w' ? DASH_COLS : 999, +inp.value || 0));
    // Settle with this tile as the anchor, so the number you typed is the one
    // it ends up at and the others move instead.
    dashSettle(card.id);
    dashLayoutApply();
    dashDrawAllCharts();
    renderDashFormat();
  });

  // Clicking the empty canvas deselects — otherwise the pane keeps showing a
  // visual you stopped caring about three clicks ago.
  const grid = document.getElementById('dashGrid');
  if (grid) {
    grid.addEventListener('pointerdown', e => {
      if (!dashEditing) return;
      if (e.target.closest('.dash-card, #mapWrap, #dashAdd')) return;
      dashSelect(null);
    });
  }
})();
