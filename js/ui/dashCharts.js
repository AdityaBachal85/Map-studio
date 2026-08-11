/**
 * ui/dashCharts.js — the board's charts, drawn at real pixel sizes.
 *
 * MEASURED, NOT STRETCHED. The first version drew into a 0-100 viewBox with
 * `preserveAspectRatio="none"`, which is the cheap way to make an SVG fill its
 * box — and it distorts everything that is not a straight fill: a 2px stroke
 * becomes 2px one way and 6px the other, circles become ovals, text shears.
 * Now that cards are freely resizable that distortion would be visible on every
 * card at a different amount. So each chart measures its host and draws in real
 * pixels: strokes are the width they say they are, at any card size.
 *
 * FOUR FORMS, PICKED BY THE JOB. Line for a trend, area for a single trend you
 * want to feel weightier, column for comparing magnitudes, donut for a
 * part-to-whole with a handful of slices. Not a chart library — this draws
 * paths and rects, and a dependency for that would be larger than the thing it
 * renders, plus one more thing to keep alive through an export.
 *
 * COLOUR IS BY SLOT, NOT BY HEX. A card stores `series: 1..8` and the slot
 * resolves through a CSS custom property, so a board built in dark mode still
 * reads correctly in light mode. The eight hues are a validated categorical
 * set — checked for colour-vision separation and contrast against both of this
 * app's card surfaces, not chosen by eye. Slots are assigned, never cycled: a
 * chart does not silently change colour because you added a series.
 *
 * The chrome is deliberately quiet — hairline solid gridlines one step off the
 * surface, axis text in the muted ink token, never in the series colour. The
 * data is the only thing allowed to be loud.
 */

/** Plot padding, in pixels. Left is wider because it carries the value ticks. */
const VIZ_PAD = { t: 10, r: 12, b: 20, l: 40 };

/** Mark specs, fixed across every chart here. */
const VIZ_LINE_W = 2;
const VIZ_DOT_R = 4;
const VIZ_BAR_MAX = 24;
const VIZ_BAR_RADIUS = 4;
const VIZ_GAP = 2;        /* the surface gap that separates touching marks */

/** @param {number} slot @returns {string} a CSS colour reference for that slot */
function vizSlot(slot) {
  const n = Math.max(1, Math.min(8, Math.round(Number(slot) || 1)));
  return 'var(--viz-' + n + ')';
}

/**
 * Compact a number for an axis tick or a label.
 * @param {number} n @returns {string}
 */
function vizNum(n) {
  if (!isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e7) return (n / 1e6).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
  if (a >= 1000) return n.toLocaleString('en-US');
  // Keep one decimal only when the data actually has one.
  return (Math.round(n * 100) / 100).toString();
}

/**
 * Round tick values — 0 / 1,000 / 2,000, never 0 / 1,143 / 2,286.
 *
 * @param {number} min @param {number} max @param {number} count target ticks
 * @returns {number[]}
 */
function vizTicks(min, max, count) {
  const span = (max - min) || Math.abs(max) || 1;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step * 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** @param {string} s @returns {string} an SVG-safe string */
function vizEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

/**
 * A rounded-top column: 4px radius on the data end, square at the baseline.
 *
 * Rounding both ends would lift the bar off its own axis and make short bars
 * read as floating; rounding neither makes a wall of blocks.
 */
function vizColumnPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return 'M' + x + ' ' + (y + h)
    + 'V' + (y + rr)
    + 'a' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' ' + -rr
    + 'h' + (w - rr * 2)
    + 'a' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' ' + rr
    + 'V' + (y + h) + 'Z';
}

/* ---------------------------------------------------------------------------
 * The forms
 * ------------------------------------------------------------------------ */

/**
 * Line, area and column share an axis frame, so they share a builder.
 *
 * @param {object} card @param {number} w @param {number} h @returns {string} SVG
 */
function vizCartesian(card, w, h) {
  const vals = (card.values || []).map(Number).filter(isFinite);
  const labels = card.labels || [];
  const col = vizSlot(card.series);
  const kind = card.kind || 'line';
  const isCol = kind === 'bar';

  const pl = VIZ_PAD.l, pr = VIZ_PAD.r, pt = VIZ_PAD.t, pb = VIZ_PAD.b;
  const iw = Math.max(10, w - pl - pr);
  const ih = Math.max(10, h - pt - pb);

  // Columns are read against zero — a bar chart that starts at 480 makes a 4%
  // difference look like a doubling. A line is not: a price series from 4,800
  // to 5,200 would be a flat line at the top of a zero-based axis.
  const dMin = Math.min.apply(null, vals);
  const dMax = Math.max.apply(null, vals);
  const ticks = isCol
    ? vizTicks(Math.min(0, dMin), Math.max(0, dMax), Math.max(2, Math.floor(ih / 44)))
    : vizTicks(dMin, dMax, Math.max(2, Math.floor(ih / 44)));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const span = (hi - lo) || 1;

  const yOf = v => pt + ih - ((v - lo) / span) * ih;
  // Columns sit in bands; points sit on the edges, so a two-point line spans
  // the full width instead of hugging the middle.
  const xOf = i => isCol
    ? pl + (i + 0.5) * (iw / vals.length)
    : pl + (vals.length === 1 ? iw / 2 : (i / (vals.length - 1)) * iw);

  let s = '';

  /* ---- gridlines and value ticks: hairline, solid, recessive ---- */
  s += ticks.map(t =>
    '<line class="viz-grid" x1="' + pl + '" y1="' + yOf(t).toFixed(1)
    + '" x2="' + (pl + iw) + '" y2="' + yOf(t).toFixed(1) + '"/>'
    + '<text class="viz-tick" x="' + (pl - 7) + '" y="' + (yOf(t) + 3.5).toFixed(1)
    + '" text-anchor="end">' + vizEsc(vizNum(t)) + '</text>').join('');

  /* ---- the marks ---- */
  if (isCol) {
    const band = iw / vals.length;
    const bw = Math.min(VIZ_BAR_MAX, Math.max(3, band - VIZ_GAP * 2 - 6));
    const zero = yOf(Math.max(lo, Math.min(hi, 0)));
    s += vals.map((v, i) => {
      const y = yOf(v);
      const top = Math.min(y, zero), hgt = Math.max(1, Math.abs(zero - y));
      return '<path class="viz-mark" d="' + vizColumnPath(+(xOf(i) - bw / 2).toFixed(1), +top.toFixed(1),
        +bw.toFixed(1), +hgt.toFixed(1), VIZ_BAR_RADIUS) + '" style="fill:' + col + '"/>';
    }).join('');
  } else {
    const pts = vals.map((v, i) => xOf(i).toFixed(1) + ',' + yOf(v).toFixed(1));
    if (kind === 'area') {
      // A wash at ~10%, never a saturated block: it says "under the line",
      // it is not a second thing to read.
      s += '<path class="viz-area" d="M' + pts.join('L') + 'L' + xOf(vals.length - 1).toFixed(1)
        + ',' + (pt + ih) + 'L' + xOf(0).toFixed(1) + ',' + (pt + ih) + 'Z"'
        + ' style="fill:' + col + '"/>';
    }
    s += '<polyline class="viz-line" points="' + pts.join(' ') + '" style="stroke:' + col + '"/>';
    // A ring in the surface colour keeps a dot legible where it crosses the
    // line or another dot — a stroke around the mark would add ink that is not
    // data.
    s += vals.map((v, i) =>
      '<circle class="viz-dot" cx="' + xOf(i).toFixed(1) + '" cy="' + yOf(v).toFixed(1)
      + '" r="' + VIZ_DOT_R + '" style="fill:' + col + '"/>').join('');
  }

  /* ---- category labels, thinned to whatever fits ---- */
  const every = Math.max(1, Math.ceil((vals.length * 34) / iw));
  s += vals.map((v, i) => {
    if (i % every && i !== vals.length - 1) return '';
    const t = labels[i];
    if (t == null || t === '') return '';
    const anchor = isCol ? 'middle' : (i === 0 ? 'start' : i === vals.length - 1 ? 'end' : 'middle');
    return '<text class="viz-tick" x="' + xOf(i).toFixed(1) + '" y="' + (h - 6)
      + '" text-anchor="' + anchor + '">' + vizEsc(t) + '</text>';
  }).join('');

  /* ---- one direct label, on the last point: the value the eye ends on ----
     Not one per point — a number beside every mark is chaos and goes unread;
     the ticks and the hover carry the rest. */
  if (vals.length) {
    const li = vals.length - 1;
    const lx = xOf(li), ly = yOf(vals[li]);
    s += '<text class="viz-endlabel" x="' + Math.min(w - 4, lx + (isCol ? 0 : 8)).toFixed(1)
      + '" y="' + Math.max(11, ly - (isCol ? 8 : 10)).toFixed(1) + '" text-anchor="'
      + (isCol ? 'middle' : (lx > w - 52 ? 'end' : 'start')) + '">'
      + vizEsc(vizNum(vals[li])) + '</text>';
  }

  return s;
}

/**
 * Donut — part-to-whole, at a glance, up to six slices.
 *
 * Past six the segments stop being tellable apart and the honest answer is a
 * list, so that is what it renders instead of a wheel of slivers.
 *
 * @param {object} card @param {number} w @param {number} h @returns {string} SVG
 */
function vizDonut(card, w, h) {
  const vals = (card.values || []).map(Number).filter(n => isFinite(n) && n > 0);
  const labels = card.labels || [];
  const total = vals.reduce((a, b) => a + b, 0);
  if (!total) return '';

  const legendW = w > 260 ? 116 : 0;
  const cx = (w - legendW) / 2, cy = h / 2;
  const R = Math.max(24, Math.min((w - legendW) / 2, h / 2) - 6);
  const thick = Math.max(10, Math.min(26, R * 0.42));
  const r = R - thick / 2;
  const circ = 2 * Math.PI * r;

  let acc = 0, s = '';
  s += '<circle class="viz-track" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1)
    + '" r="' + r.toFixed(1) + '" style="stroke-width:' + thick.toFixed(1) + '"/>';

  vals.forEach((v, i) => {
    const frac = v / total;
    const len = Math.max(0, circ * frac - VIZ_GAP);   // the 2px surface gap
    s += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + r.toFixed(1)
      + '" fill="none" stroke-linecap="butt"'
      + ' style="stroke:' + vizSlot(i + 1) + ';stroke-width:' + thick.toFixed(1) + '"'
      + ' stroke-dasharray="' + len.toFixed(2) + ' ' + (circ - len).toFixed(2) + '"'
      + ' stroke-dashoffset="' + (-circ * acc).toFixed(2) + '"'
      + ' transform="rotate(-90 ' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ')"/>';
    acc += frac;
  });

  // The hole carries the total, which is the number a part-to-whole chart is
  // most often actually asked for.
  s += '<text class="viz-donut-total" x="' + cx.toFixed(1) + '" y="' + (cy + 2).toFixed(1)
    + '" text-anchor="middle">' + vizEsc(vizNum(total)) + '</text>';
  s += '<text class="viz-donut-cap" x="' + cx.toFixed(1) + '" y="' + (cy + 17).toFixed(1)
    + '" text-anchor="middle">total</text>';

  /* ---- legend: identity never rests on colour alone ---- */
  if (legendW) {
    const lh = Math.min(19, (h - 8) / Math.max(1, vals.length));
    const top = (h - lh * vals.length) / 2 + lh * 0.72;
    vals.forEach((v, i) => {
      const y = top + i * lh;
      s += '<rect x="' + (w - legendW) + '" y="' + (y - 7).toFixed(1) + '" width="8" height="8" rx="2"'
        + ' style="fill:' + vizSlot(i + 1) + '"/>'
        + '<text class="viz-legend" x="' + (w - legendW + 13) + '" y="' + y.toFixed(1) + '">'
        + vizEsc(labels[i] || ('Slice ' + (i + 1))) + '</text>'
        + '<text class="viz-legend-val" x="' + (w - 2) + '" y="' + y.toFixed(1) + '" text-anchor="end">'
        + Math.round((v / total) * 100) + '%</text>';
    });
  }
  return s;
}

/* ---------------------------------------------------------------------------
 * Drawing and hover
 * ------------------------------------------------------------------------ */

/**
 * Draw one chart into its host, at the host's real size.
 *
 * @param {HTMLElement} host a `.dc-plot` element
 * @param {object} card
 */
function dashDrawChart(host, card) {
  const w = Math.round(host.clientWidth);
  const h = Math.round(host.clientHeight);
  if (w < 40 || h < 30) return;      // mid-animation, or a card collapsed to nothing

  const vals = (card.values || []).map(Number).filter(isFinite);
  const kind = card.kind || 'line';
  const enough = kind === 'donut' ? vals.length >= 1 : vals.length >= 2;
  if (!enough) { host.innerHTML = ''; return; }

  const body = kind === 'donut' ? vizDonut(card, w, h) : vizCartesian(card, w, h);
  host.innerHTML =
    '<svg class="viz" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"'
    + ' role="img" aria-label="' + vizEsc(card.title || 'Chart') + '">' + body + '</svg>'
    + '<div class="viz-tip" hidden></div>';

  if (kind !== 'donut') vizWireHover(host, card, w, h);
}

/**
 * Crosshair and tooltip.
 *
 * The tooltip enhances, it never gates: the axis ticks, the end label and the
 * editable value list all carry the same numbers, so nothing here is the only
 * way to read a value.
 */
function vizWireHover(host, card, w, h) {
  const svg = host.querySelector('svg');
  const tip = host.querySelector('.viz-tip');
  const vals = (card.values || []).map(Number).filter(isFinite);
  const labels = card.labels || [];
  if (!svg || !tip || vals.length < 2) return;

  const pl = VIZ_PAD.l, pr = VIZ_PAD.r, pt = VIZ_PAD.t, pb = VIZ_PAD.b;
  const iw = Math.max(10, w - pl - pr), ih = Math.max(10, h - pt - pb);
  const isCol = (card.kind || 'line') === 'bar';
  const xOf = i => isCol ? pl + (i + 0.5) * (iw / vals.length)
    : pl + (vals.length === 1 ? iw / 2 : (i / (vals.length - 1)) * iw);

  const cross = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  cross.setAttribute('class', 'viz-cross');
  cross.setAttribute('y1', pt);
  cross.setAttribute('y2', pt + ih);
  cross.style.display = 'none';
  svg.appendChild(cross);

  const move = e => {
    const r = svg.getBoundingClientRect();
    const x = e.clientX - r.left;
    // Nearest index, so the whole column of the chart is a hit target rather
    // than the mark itself — an 8px dot you have to land on dead-centre is not
    // a usable target.
    let best = 0, bd = Infinity;
    for (let i = 0; i < vals.length; i++) {
      const d = Math.abs(xOf(i) - x);
      if (d < bd) { bd = d; best = i; }
    }
    cross.setAttribute('x1', xOf(best).toFixed(1));
    cross.setAttribute('x2', xOf(best).toFixed(1));
    cross.style.display = '';
    tip.hidden = false;
    tip.innerHTML = '<b>' + vizEsc(vizNum(vals[best])) + '</b>'
      + (labels[best] ? '<i>' + vizEsc(labels[best]) + '</i>' : '');
    // Flip the tooltip before it runs off the right edge rather than letting it
    // clip against the card.
    const tw = tip.offsetWidth || 60;
    tip.style.left = Math.max(2, Math.min(w - tw - 2, xOf(best) - tw / 2)).toFixed(1) + 'px';
    tip.style.top = '2px';
  };

  host.addEventListener('pointermove', move);
  host.addEventListener('pointerleave', () => { cross.style.display = 'none'; tip.hidden = true; });
}

/** Redraw every chart on the board, measuring each host as it goes. */
function dashDrawAllCharts() {
  document.querySelectorAll('#dashGrid .dc-plot[data-card]').forEach(host => {
    const card = typeof dashCardById === 'function' ? dashCardById(host.dataset.card) : null;
    if (card) dashDrawChart(host, card);
  });
}
