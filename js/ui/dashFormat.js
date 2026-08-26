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
    : card.type === 'rating'
      ? [Number(card.value)].filter(isFinite)
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

/**
 * The alignment glyphs — the four every editor draws, as four stacked rules
 * whose lengths say which edge is flush.
 *
 * Words in a segmented control cost the width of the words; "Left / Centre /
 * Right / Justify" does not fit a 268px pane and wraps. The glyph is also the
 * thing people already recognise from every other editor they use, so it is
 * read faster than the word it replaces.
 */
const DF_ALIGN_GLYPH = {
  left: 'M3 5h14M3 9h9M3 13h14M3 17h9',
  center: 'M3 5h14M5.5 9h9M3 13h14M5.5 17h9',
  right: 'M3 5h14M8 9h9M3 13h14M8 17h9',
  justify: 'M3 5h14M3 9h14M3 13h14M3 17h14',
};

/**
 * A segmented control of icons rather than words.
 * @param {string} key @param {Array} opts pairs of [value, accessible label]
 * @param {string} now
 */
function dfSegIcons(key, opts, now) {
  return '<div class="df-seg df-seg-icons" role="group">' + opts.map(o =>
    '<button type="button" data-df="' + key + '" data-v="' + esc(o[0]) + '"'
    + (String(o[0]) === String(now) ? ' class="on"' : '')
    + ' title="' + esc(o[1]) + '" aria-label="' + esc(o[1]) + '">'
    + '<svg viewBox="0 0 20 22" width="15" height="16" fill="none" stroke="currentColor"'
    + ' stroke-width="1.8" stroke-linecap="round"><path d="'
    + (DF_ALIGN_GLYPH[o[0]] || DF_ALIGN_GLYPH.left) + '"/></svg></button>').join('') + '</div>';
}

/** @param {string} key @param {boolean} on @param {string} label */
function dfToggle(key, on, label) {
  return '<button type="button" class="df-tgl' + (on ? ' on' : '') + '" data-df="' + key
    + '" data-v="' + (on ? '0' : '1') + '" role="switch" aria-checked="' + (on ? 'true' : 'false')
    + '"><i></i>' + esc(label) + '</button>';
}

/**
 * Resolve whatever a card stored into a literal colour.
 *
 * @param {number|string} now a slot number or a hex
 * @returns {string} a hex
 */
function dfResolveColour(now) {
  if (/^#[0-9a-f]{6}$/i.test(String(now))) return String(now).toLowerCase();
  const n = Math.max(1, Math.min(8, Math.round(Number(now) || 1)));
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue('--viz-' + n).trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  } catch (e) { /* fall through */ }
  return '#3987e5';
}

/**
 * The colour control: one swatch that opens the app's own picker.
 *
 * IT USED TO BE NINE SWATCHES IN A ROW, AND THAT DOES NOT SCALE. A score card
 * with four rings meant four rows of nine, which is thirty-six squares and most
 * of the pane, to say four things. It also asked people to learn a second
 * colour interface: the map has had a proper picker for a long time — presets,
 * then a full gradient area with a hue slider, hex and RGB fields and an
 * eyedropper — and the board was offering a strip of eight instead.
 *
 * So this is that picker, anchored to a swatch. One control, the same gesture
 * everywhere in the app, and the whole palette plus any colour at all behind
 * one click rather than a row that could only ever hold the eight.
 *
 * @param {string} key @param {number|string} now a slot number, or a hex
 * @returns {string} HTML
 */
function dfSwatches(key, now) {
  const hex = dfResolveColour(now);
  const custom = /^#[0-9a-f]{6}$/i.test(String(now));
  return '<button type="button" class="df-sw-btn" data-dfpick="' + esc(key) + '"'
    + ' aria-haspopup="dialog" aria-expanded="false"'
    + ' title="' + esc(hex) + (custom ? ' \u2014 a chosen colour, fixed in both themes' : ' \u2014 a palette colour, which adapts to the theme') + '">'
    + '<i style="background:' + esc(hex) + '"></i>'
    + '<span>' + esc(custom ? hex : 'Colour ' + Math.max(1, Math.min(8, Math.round(Number(now) || 1)))) + '</span>'
    + '</button>';
}

/**
 * What the card currently holds for one colour key.
 *
 * The keys are the same strings dashFormatApply() writes back through, so the
 * read and the write cannot drift apart into two different ideas of where a
 * series' colour lives.
 *
 * @param {object} card @param {string} key @returns {number|string}
 */
function dfCurrentColour(card, key) {
  const ser = key.match(/^slot:(\d+)$/);
  if (ser) {
    const s = (card.seriesList || [])[+ser[1]];
    return s ? (s.hex || s.slot || (+ser[1] + 1)) : 1;
  }
  const pt = key.match(/^pt:(\d+):(\d+)$/);
  if (pt) {
    const ser = (card.seriesList || [])[+pt[1]];
    if (!ser) return 1;
    return (ser.points && ser.points[+pt[2]]) || ser.hex || ser.slot || (+pt[1] + 1);
  }
  if (key === 'headTone') {
    const t = card.fmt && card.fmt.headTone;
    return (t == null || t === 'navy') ? 1 : t;
  }
  const ring = key.match(/^gslot:(\d+)$/);
  if (ring) {
    const g = (card.items || [])[+ring[1]];
    return g ? (g.color || g.slot || (+ring[1] + 1)) : 1;
  }
  return 1;
}

/**
 * A colour per bar, the way a spreadsheet does it.
 *
 * The series colour answers "which series is this"; a point colour answers
 * "look at this one" — the year that matters, the outlier, the site being sold.
 * They are different questions and a chart that can only answer the first makes
 * people rebuild the chart in Excel to answer the second.
 *
 * Sparse, so a chart with one point coloured stores one point. Clearing a point
 * removes the key rather than writing the series colour into it, or the series
 * colour would stop following the series.
 *
 * @param {object} card @param {object} ser @param {number} si series index
 * @returns {string} HTML
 */
function dfPointColours(card, ser, si) {
  const cats = card.labels || [];
  if (!cats.length) return '';
  // Behind a disclosure: most charts never want this, and eight more swatches
  // per series would undo the tidying the single trigger just bought.
  const pts = ser.points || {};
  const set = Object.keys(pts).filter(k => pts[k]).length;
  return '<details class="df-points"' + (set ? ' open' : '') + '>'
    + '<summary>Individual bars' + (set ? ' \u00b7 ' + set : '') + '</summary>'
    + cats.map((c, i) =>
      dfRow(String(c || ('Point ' + (i + 1))),
        '<div class="df-point-row">'
        + dfSwatches('pt:' + si + ':' + i, pts[i] || ser.hex || ser.slot || (si + 1))
        + (pts[i] ? '<button type="button" class="df-clear" data-df="ptclear:' + si + ':' + i
          + '" data-v="1" title="Back to the series colour">&times;</button>' : '')
        + '</div>')).join('')
    + '</details>';
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
        + dfSwatches('slot:' + i, s.hex || s.slot || (i + 1))
        + dfPointColours(card, s, i)
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

  // How the title reads. A quiet caption is right for a screen you are working
  // in; a filled bar is what separates one block from the next on a sheet read
  // at arm's length. Both tones are white on dark and both clear AA.
  if (!card.fmt || card.fmt.title !== false) {
    f += dfRow('Header', dfSeg('head', [['plain', 'Quiet'], ['bar', 'Bar']],
      (card.fmt && card.fmt.head) === 'bar' ? 'bar' : 'plain'));
    if (card.fmt && card.fmt.head === 'bar') {
      // Navy first because it is the default and the one most bars want, then
      // the same eight slots every other colour on this board is chosen from.
      // The ink on the bar follows its luminance, so a light slot is a usable
      // choice rather than an unreadable one.
      const tone = card.fmt.headTone == null ? 'navy' : String(card.fmt.headTone);
      // Navy stays a named choice — it is the default and the one most bars
      // want — and everything else goes through the same picker as every other
      // colour on the board.
      f += dfRow('Bar colour',
        '<div class="df-bar-tone">'
        + '<button type="button" class="df-sw-btn' + (tone === 'navy' ? ' on' : '')
        + '" data-df="headTone" data-v="navy" title="Navy">'
        + '<i style="background:var(--navy)"></i><span>Navy</span></button>'
        + dfSwatches('headTone', /^[1-8]$/.test(tone) ? Number(tone) : 1)
        + '</div>');
    }
  }
  if (isChart) {
    f += dfRow('Legend', dfSeg('legend', [['auto', 'Auto'], ['top', 'Top'], ['right', 'Right'],
      ['bottom', 'Bottom'], ['off', 'Off']], fmt.legend));
    // Only the toggles that do something for this kind. A "Value axis" switch on
    // a gauge is a control that changes nothing, and a panel full of those
    // teaches people to stop reading it.
    const score = VIZ_SCORE_KINDS.indexOf(card.kind) >= 0;
    const share = VIZ_SHARE_KINDS.indexOf(card.kind) >= 0;
    // A radar's rings carry no numbers, so it wants labels as much as any
    // cartesian chart does. A ring prints its value in the legend and a gauge
    // prints it in the middle of its own dial, so those two do not.
    if (!score || card.kind === 'radar') f += dfToggle('labels', fmt.labels, 'Data labels');
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
  if (card.type === 'gauges') {
    f += dfScoreCeiling(card);
    // The rings had no colour control at all: they took the slot their position
    // gave them and that was the end of it, while every chart series beside
    // them had swatches. Same control, same eight slots.
    (card.items || []).forEach((g, i) => {
      f += dfRow(g.cap || ('Ring ' + (i + 1)), dfSwatches('gslot:' + i, g.color || g.slot || (i + 1)));
    });
  }

  // Two settings, not one: a centred header bar over a left-read paragraph is a
  // real layout, and coupling them made it impossible. Justify is offered on the
  // body only and only where there is prose to justify — on a list of place
  // names it would space four words across a card and call it typography.
  {
    const three = [['left', 'Align left'], ['center', 'Align centre'], ['right', 'Align right']];
    if (!card.fmt || card.fmt.title !== false) {
      f += dfRow('Title', dfSegIcons('align', three, (card.fmt && card.fmt.align) || 'left'));
    }
    const bodyOpts = (card.type === 'text' || card.type === 'comment')
      ? three.concat([['justify', 'Justify']]) : three;
    f += dfRow('Text', dfSegIcons('alignBody', bodyOpts, (card.fmt && card.fmt.alignBody) || 'left'));
  }

  // Where the legend lives. On the map is the layout every printed connectivity
  // sheet uses — the key sits in a corner of the drawing it explains, not in a
  // panel beside it — and board mode hides the on-map card by default because
  // for a while it was showing the same rows twice.
  // A drive time is traffic on one day; a distance is the road. The minute is
  // opt-in for that reason — see dashAccessHtml().
  if (card.type === 'access') {
    // Both readings are kept: a list is scanned, a table is compared. The table
    // is also the accessible one — real headers a screen reader can announce.
    f += dfRow('Read as', dfSeg('asTable', [['list', 'List'], ['table', 'Table']],
      (card.fmt && card.fmt.asTable) ? 'table' : 'list'));
    f += dfToggle('time', !!(card.fmt && card.fmt.time), 'Travel time');
  }

  if (card.type === 'rating') f += dfScoreCeiling(card);

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

  const isHex = /^#[0-9a-f]{6}$/i.test(String(v));

  const pt = key.match(/^pt:(\d+):(\d+)$/);
  if (pt) {
    const ser = (card.seriesList || [])[+pt[1]];
    if (!ser) return;
    ser.points = ser.points || {};
    // A slot number here would have to be resolved every time it was read, in
    // both themes, for one bar. A point colour is a literal.
    ser.points[+pt[2]] = isHex ? String(v).toLowerCase() : dfResolveColour(v);
    return;
  }
  const ptc = key.match(/^ptclear:(\d+):(\d+)$/);
  if (ptc) {
    const ser = (card.seriesList || [])[+ptc[1]];
    if (ser && ser.points) {
      delete ser.points[+ptc[2]];
      if (!Object.keys(ser.points).length) delete ser.points;
    }
    return;
  }

  const slot = key.match(/^slot:(\d+)$/);
  if (slot) {
    const s = card.seriesList && card.seriesList[+slot[1]];
    if (!s) return;
    // One or the other, never both: a stored hex wins over a slot wherever it
    // is read, so leaving one behind makes the swatches look broken.
    if (isHex) { s.hex = String(v).toLowerCase(); } else { s.slot = +v; delete s.hex; }
    return;
  }

  const gslot = key.match(/^gslot:(\d+)$/);
  if (gslot) {
    const g = card.items && card.items[+gslot[1]];
    if (!g) return;
    if (isHex) { g.color = String(v).toLowerCase(); } else { g.slot = +v; delete g.color; }
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
    case 'align':
      if (v === 'left') delete card.fmt.align; else card.fmt.align = v;
      return;
    case 'alignBody':
      if (v === 'left') delete card.fmt.alignBody; else card.fmt.alignBody = v;
      return;
    case 'head': card.fmt.head = v === 'bar' ? 'bar' : 'plain'; return;
    case 'headTone':
      // 'green' is the old two-tone spelling; slot six is the same green. A hex
      // from the picker is kept as-is — the bar deepens it in CSS either way.
      card.fmt.headTone = v === 'green' ? '6'
        : (/^#[0-9a-f]{6}$/i.test(v) ? String(v).toLowerCase()
          : (/^[1-8]$/.test(v) ? v : 'navy'));
      return;
    case 'asTable':
      if (v === 'table') card.fmt.asTable = true; else delete card.fmt.asTable;
      return;
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
    // The colour swatch opens the app's own picker rather than applying
    // anything itself — same component, same gesture, as the map.
    const pick = e.target.closest('[data-dfpick]');
    if (pick) {
      e.preventDefault();
      const card = dashFormatTarget();
      if (!card || typeof openColorPresets !== 'function') return;
      const key = pick.dataset.dfpick;
      openColorPresets(pick, dfResolveColour(dfCurrentColour(card, key)), hex => {
        dashFormatApply(card, key, hex);
        renderDashboard();
        renderDashFormat();
      });
      return;
    }

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
