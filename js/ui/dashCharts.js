/**
 * ui/dashCharts.js — the board's visuals, drawn at real pixel sizes.
 *
 * MEASURED, NOT STRETCHED. An earlier version drew into a 0-100 viewBox with
 * `preserveAspectRatio="none"`, which is the cheap way to make an SVG fill its
 * box and distorts everything that is not a straight fill: a 2px stroke becomes
 * 2px one way and 6px the other, circles become ovals, text shears. With tiles
 * freely resizable that distortion would be different on every card. Each
 * visual measures its host and draws in real pixels.
 *
 * TWELVE FORMS, ONE FRAME. Column, bar, line, area, stacked column, stacked
 * bar, combo, pie, donut, scatter, funnel and treemap. The nine that have axes
 * share one frame builder, so the gridlines, the round-numbered ticks and the
 * category labels are identical across all of them — which is the actual reason
 * a set of charts reads as one dashboard rather than nine widgets.
 *
 * COLOUR IS BY SLOT, NOT BY HEX. Each series stores `slot: 1..8` and resolves
 * through a CSS custom property, so a board built in dark mode still reads
 * correctly in light. The eight hues are a validated categorical set — checked
 * for colour-vision separation and contrast against both of this app's card
 * surfaces, not chosen by eye. Slots are assigned, never cycled: adding a
 * series never repaints the ones already there.
 *
 * The chrome is deliberately quiet — hairline solid gridlines one step off the
 * surface, axis text in the muted ink token, never in a series colour. The data
 * is the only thing allowed to be loud.
 */

/**
 * The enter animation's budget, in milliseconds.
 *
 * A chart arrives rather than appearing: marks grow from the axis they are
 * measured against, staggered across the categories, and the line reveals left
 * to right the way it is read. The window is the reveal plus the longest
 * stagger plus the dots and labels that settle after it.
 */
const VIZ_ENTER_MS = 1100;
const VIZ_STAGGER_MS = 45;
const VIZ_ENTER_TOTAL = 1700;

/** Plot padding, in pixels. Left carries the value ticks, bottom the categories. */
const VIZ_PAD = { t: 12, r: 14, b: 22, l: 42 };

/** Mark specs, fixed across every chart here. */
const VIZ_LINE_W = 2;
const VIZ_DOT_R = 4;
const VIZ_BAR_MAX = 24;
const VIZ_BAR_RADIUS = 4;
const VIZ_GAP = 2;        /* the surface gap that separates touching marks */

/** Which kinds this module knows how to draw. */
const VIZ_KINDS = [
  ['column', 'Column'], ['bar', 'Bar'], ['line', 'Line'], ['area', 'Area'],
  ['stackedColumn', 'Stacked column'], ['stackedBar', 'Stacked bar'], ['combo', 'Combo'],
  ['pie', 'Pie'], ['donut', 'Donut'], ['scatter', 'Scatter'],
  ['funnel', 'Funnel'], ['treemap', 'Treemap'],
  ['ring', 'Rings'], ['gauge', 'Gauge'], ['radar', 'Radar'],
];

/** Kinds that are part-to-whole: one series, one slice per category. */
const VIZ_SHARE_KINDS = ['pie', 'donut', 'funnel', 'treemap'];

/**
 * TWO FORMS ARE DELIBERATELY ABSENT.
 *
 * A candlestick needs four coupled numbers per category in a fixed order —
 * open, high, low, close — and a sankey needs a table of from/to/value links.
 * This board's editor offers categories and series, and neither shape can be
 * said in it. A candlestick could be faked by reading four series positionally,
 * which means every four-series board on the app would silently become an
 * OHLC chart the moment somebody picked the wrong kind: worse than not offering
 * it. Both are additions to the data model first and drawings second, and
 * neither answers a question a property connectivity board asks.
 */

/**
 * Kinds read against a fixed ceiling rather than as a share of a total.
 *
 * The distinction decides what the legend is allowed to say. A share kind can
 * print a percentage beside each name because the arc IS that percentage; a
 * score kind cannot, because its arc is a fraction of the scale, and printing
 * share-of-total beside it puts two different percentages for the same category
 * on one card. The funnel already taught this lesson once.
 */
const VIZ_SCORE_KINDS = ['ring', 'gauge', 'radar'];

/** Kinds whose colours belong to the categories rather than to the series. */
const VIZ_CATEGORY_KEYED = ['pie', 'donut', 'funnel', 'treemap', 'ring'];

/**
 * Kinds that have always printed their numbers, whatever the toggle said.
 *
 * A funnel is a list of stages with a value against each and a treemap writes
 * its value under the name inside the tile — both drew that text unconditionally
 * while the panel showed them a "Data labels" switch, so the switch was a
 * control that did nothing. Rather than take the numbers away by default, the
 * default follows the drawing: on for these two, off everywhere else, and the
 * switch is live either way.
 */
const VIZ_SELF_LABEL_KINDS = ['funnel', 'treemap'];

/** Kinds that need only one number to say anything. */
const VIZ_SINGLE_KINDS = ['pie', 'donut', 'funnel', 'treemap', 'ring', 'gauge'];

/**
 * Whether a card has enough numbers to be worth drawing.
 *
 * @param {string} kind @param {number[]} flat every finite value on the card
 * @param {string[]} [cats]
 * @returns {boolean}
 */
function vizEnough(kind, flat, cats) {
  // Three axes is the minimum that encloses an area; two draw a line, and a
  // radar of one axis is a dot.
  if (kind === 'radar') return flat.length >= 3 && (cats || []).length >= 3;
  return VIZ_SINGLE_KINDS.indexOf(kind) >= 0 ? flat.length >= 1 : flat.length >= 2;
}

/**
 * The ceiling a score is read against.
 *
 * Scores on a board like this are out of 100 far more often than not, so that
 * is the default whenever the numbers fit inside it — a connectivity score of
 * 82 drawn as 82% of 100 is the reading everybody expects, and drawing it as
 * 82% of a tick-rounded 90 would be both true and useless. Above 100 the scale
 * comes from the same tick maths every axis on the board uses, so a gauge and a
 * column of the same data agree about where the top is.
 *
 * @param {object} card @param {number[]} vals @returns {number}
 */
function vizScoreMax(card, vals) {
  const asked = Number(card && card.max);
  if (isFinite(asked) && asked > 0) return asked;
  const nums = (vals || []).filter(isFinite);
  const top = Math.max.apply(null, nums.concat([0]));
  // Ten first. A site is scored out of ten far more often than out of a
  // hundred on a board like this — "8/10" is how the rating reads on every
  // deck these end up in — and a hidden ceiling of 100 drew a 10 as a tenth of
  // a ring, which is what the report showed.
  //
  // Inferred rather than fixed, because a hundred-point card must still work.
  // The inference can be wrong in exactly one case: every score on a
  // hundred-point card happens to be ten or less, which means every one of them
  // is terrible. `card.max` is the way out of it, and it is a field on the
  // card, not a hidden rule.
  if (nums.length && top <= 10) return 10;
  if (top <= 100) return 100;
  const t = vizTicks(0, top, 4);
  return t[t.length - 1] || top;
}

/**
 * A circular arc as a path, drawn clockwise from `a0` to `a1` in degrees.
 *
 * Degrees are measured from twelve o'clock, because that is where every dial
 * anybody has ever read starts.
 *
 * @param {number} cx @param {number} cy @param {number} r
 * @param {number} a0 @param {number} a1
 * @returns {string}
 */
function vizArcPath(cx, cy, r, a0, a1) {
  const rad = d => (d - 90) * Math.PI / 180;
  const x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0));
  const x1 = cx + r * Math.cos(rad(a1)), y1 = cy + r * Math.sin(rad(a1));
  const big = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return 'M' + x0.toFixed(1) + ' ' + y0.toFixed(1) + 'A' + r.toFixed(1) + ' ' + r.toFixed(1)
    + ' 0 ' + big + ' 1 ' + x1.toFixed(1) + ' ' + y1.toFixed(1);
}

/** Kinds drawn along a horizontal value axis. */
const VIZ_HORIZONTAL = ['bar', 'stackedBar'];

/**
 * Unique per drawn SVG.
 *
 * Gradients are referenced by id, ids are document-wide, and a board carries
 * several charts at once — so without this, one card's area fill would be
 * painted by whichever chart happened to be earlier in the DOM, and would
 * vanish when that chart was deleted.
 */
let _vizUid = 0;

/** @param {number} slot @returns {string} the gradient id for that slot, in this SVG */
function vizGradId(slot) {
  return 'vg' + _vizUid + '-' + Math.max(1, Math.min(8, Math.round(Number(slot) || 1)));
}

/**
 * One vertical fade per slot, from the series colour down to nothing.
 *
 * A flat wash under a line ends in a hard horizontal edge along the axis, which
 * reads as a second series. A fade ends where the data ends.
 *
 * @returns {string} an SVG `<defs>` block
 */
function vizDefs() {
  let d = '';
  for (let n = 1; n <= 8; n++) {
    const c = vizSlot(n);
    // `style`, not the `stop-color` attribute: var() resolves in a CSS
    // declaration and is invalid in a presentation attribute.
    d += '<linearGradient id="' + vizGradId(n) + '" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" style="stop-color:' + c + ';stop-opacity:.30"/>'
      + '<stop offset="1" style="stop-color:' + c + ';stop-opacity:.02"/>'
      + '</linearGradient>';
  }
  return '<defs>' + d + '</defs>';
}

/**
 * The length of a polyline, padded.
 *
 * Used as the dash length that draws a line in from the left. A smoothed path
 * is longer than the polyline through the same points, so the figure is padded
 * rather than measured — a dash longer than the path is a solid line, a dash
 * shorter than it leaves a visible gap at the end.
 *
 * @param {number[][]} pts @returns {number}
 */
function vizPathLen(pts) {
  let n = 0;
  for (let i = 1; i < pts.length; i++) {
    n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return n * 1.15 + 8;
}

/** @param {number} slot @returns {string} a CSS colour reference for that slot */
function vizSlot(slot) {
  const n = Math.max(1, Math.min(8, Math.round(Number(slot) || 1)));
  return 'var(--viz-' + n + ')';
}

/**
 * What to paint one series with.
 *
 * A custom hex wins over the slot, because that is what choosing one means.
 * Everything downstream — marks, dots, gradients, the legend swatch, the export
 * model — goes through here, so there is one answer to "what colour is this
 * series" rather than eight places that each decide.
 *
 * @param {object} ser a series from vizSeries()
 * @returns {string} a CSS colour
 */
function vizColour(ser, i) {
  if (ser && ser.points && i != null) {
    const p = ser.points[i];
    if (/^#[0-9a-f]{6}$/i.test(String(p || ''))) return String(p);
  }
  return (ser && ser.hex) ? ser.hex : vizSlot(ser && ser.slot);
}

/**
 * What colour is THIS SLICE — for the forms whose colours belong to the
 * categories rather than to the series.
 *
 * A pie, a donut, a ring stack, a funnel and a treemap all draw one mark per
 * category out of a single series, so "the series colour" is not a thing any of
 * them can use: five slices cannot all be blue. Every one of them therefore
 * took `vizSlot(i + 1)` — the palette slot its POSITION happened to land on —
 * and there was no way to change it. Worse, the panel still offered them the
 * series swatch beside the numbers, so the one colour control those five charts
 * had was a control that did nothing at all.
 *
 * Same storage as a bar's own colour: the sparse `points` map on the first
 * series, keyed by category index. One mechanism, one setter, one path into the
 * export — a second parallel one would be two things to keep in step.
 *
 * @param {object} ser the series the marks come from
 * @param {number} i the category's index, AFTER any slicer filtering
 * @returns {string} a CSS colour
 */
function vizCatColour(ser, i) {
  if (ser && ser.points) {
    const p = ser.points[i];
    if (/^#[0-9a-f]{6}$/i.test(String(p || ''))) return String(p);
  }
  return vizSlot(i + 1);
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
 * The card's formatting, with every default filled in.
 * @param {object} card @returns {object}
 */
function vizFmt(card) {
  const f = (card && card.fmt) || {};
  return {
    legend: f.legend || 'auto',
    labels: f.labels === undefined
      ? VIZ_SELF_LABEL_KINDS.indexOf(card && card.kind) >= 0
      : !!f.labels,
    grid: f.grid !== false,
    xAxis: f.xAxis !== false,
    yAxis: f.yAxis !== false,
    smooth: !!f.smooth,
  };
}

/**
 * A card's series, normalised.
 *
 * Older cards stored one flat `values` array and used `series` for the colour
 * slot. Both shapes are read here rather than migrated in place, so a project
 * saved by an older build opens without a conversion step that could fail
 * halfway.
 *
 * @param {object} card @returns {{name:string, values:number[], slot:number}[]}
 */
function vizSeries(card) {
  if (Array.isArray(card.seriesList) && card.seriesList.length) {
    return card.seriesList.map((s, i) => ({
      name: s.name || ('Series ' + (i + 1)),
      values: (s.values || []).map(Number),
      slot: s.slot || (i + 1),
      // A colour chosen outside the palette. Carried separately from the slot
      // so the slot survives untouched underneath it — clearing the custom
      // colour puts the series back where it was rather than at slot one.
      hex: /^#[0-9a-f]{6}$/i.test(String(s.hex || '')) ? String(s.hex) : '',
      // And per-point overrides, sparse: `{2: '#e03131'}` colours the third bar
      // and leaves the rest on the series colour. This is what "highlight the
      // one year that matters" needs, and it is how every spreadsheet does it.
      points: (s.points && typeof s.points === 'object') ? s.points : null,
    }));
  }
  const legacySlot = typeof card.series === 'number' ? card.series : 1;
  return [{
    name: card.seriesName || card.title || 'Series 1',
    values: (card.values || []).map(Number),
    slot: legacySlot,
  }];
}

/** @param {object} card @returns {string[]} the category labels */
function vizCategories(card) {
  return (card.labels || []).map(String);
}

/**
 * Apply the board's slicer, if one is filtering.
 *
 * A slicer that narrowed some visuals and not others would be worse than none
 * at all, so every chart runs its categories through here.
 *
 * @param {string[]} cats @param {object[]} series
 * @returns {{cats:string[], series:object[]}}
 */
function vizFiltered(cats, series) {
  const keep = (typeof dashFilter === 'function') ? dashFilter() : null;
  if (!keep || !keep.size) return { cats, series };
  const idx = cats.map((c, i) => (keep.has(c) ? i : -1)).filter(i => i >= 0);
  if (!idx.length) return { cats, series };
  return {
    cats: idx.map(i => cats[i]),
    // REBUILT, NOT COPIED — so everything the series carries has to be carried
    // over by hand, and anything forgotten here silently disappears the moment
    // a slicer is switched on. `hex` and `points` were forgotten: filtering a
    // board reverted every custom colour on it to the palette slot, which reads
    // as the colours being lost rather than as the filter doing it.
    //
    // The per-point colours are remapped to their new positions rather than
    // passed through, because after a filter the third category is no longer at
    // index three — passing them through would repaint the wrong bar.
    series: series.map(s => {
      const pts = {};
      if (s.points) idx.forEach((from, to) => { if (s.points[from]) pts[to] = s.points[from]; });
      return { name: s.name, slot: s.slot, hex: s.hex,
        values: idx.map(i => s.values[i]), points: pts };
    }),
  };
}

/**
 * A rounded-end column: 4px radius on the data end, square at the baseline.
 *
 * Rounding both ends would lift the bar off its own axis and make short bars
 * read as floating; rounding neither makes a wall of blocks.
 *
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {number} r @param {string} side which end is the data end
 */
function vizBarPath(x, y, w, h, r, side) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (side === 'right') {
    return 'M' + x + ' ' + y + 'h' + (w - rr) + 'a' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' ' + rr
      + 'v' + (h - rr * 2) + 'a' + rr + ' ' + rr + ' 0 0 1 ' + -rr + ' ' + rr + 'h' + -(w - rr) + 'Z';
  }
  return 'M' + x + ' ' + (y + h) + 'V' + (y + rr)
    + 'a' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' ' + -rr
    + 'h' + (w - rr * 2) + 'a' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' ' + rr
    + 'V' + (y + h) + 'Z';
}

/** A Catmull-Rom-ish smoothed path through points, for `smooth` lines. */
function vizSmoothPath(pts) {
  if (pts.length < 3) return 'M' + pts.map(p => p[0] + ' ' + p[1]).join('L');
  let d = 'M' + pts[0][0] + ' ' + pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += 'C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ',' + c2x.toFixed(1) + ' ' + c2y.toFixed(1)
      + ',' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
  }
  return d;
}

/**
 * A value label on a bar, placed where it can actually be read.
 *
 * OUTSIDE THE END IF IT FITS, INSIDE IT IF IT DOES NOT. The axis is scaled to
 * the data, so the largest bar always reaches the plot's edge — which means the
 * one label people most want to read was the one always falling off the side.
 * On a five-bar chart of 10/20/15/25/30 the 30 simply was not there.
 *
 * Inside, the label sits on the bar's own colour, so it is white. That is the
 * one place text in this module leaves the ink tokens, for the same reason the
 * treemap's labels do: white clears every hue in the palette and a dark label
 * disappears into half of them.
 *
 * @param {number} v the value @param {number} end pixel of the bar's data end
 * @param {number} zero pixel of its baseline @param {number} mid across the bar
 * @param {boolean} horiz @param {object} box plot bounds {x0,y0,iw,ih}
 * @returns {string} one SVG <text>
 */
function vizBarLabel(v, end, zero, mid, horiz, box) {
  const txt = vizNum(v);
  // How much of the plot the label needs beyond the bar's end, along the axis
  // the bar grows on: a string's width across, one line's height up.
  const room = horiz ? (txt.length * 5.6 + 7) : 16;

  // WHICH WAY IS OUT, IN SCREEN PIXELS — not which way is up in the data. A
  // column that grows upward has its end ABOVE its baseline, so `end - zero` is
  // negative for a positive value; reading that as "a bar pointing backwards"
  // put every column's label on the wrong side of its own bar end, and sent the
  // tallest one clean off the top of the drawing at y = -10. A bar of exactly
  // zero has no direction of its own, so it takes the chart's: right, or up.
  const out = end === zero ? (horiz ? 1 : -1) : (end > zero ? 1 : -1);
  const limit = horiz
    ? (out > 0 ? box.x0 + box.iw : box.x0)
    : (out > 0 ? box.y0 + box.ih : box.y0);
  const fits = Math.abs(limit - end) >= room;
  const cls = fits ? 'viz-label' : 'viz-label viz-label-in';

  if (horiz) {
    // Anchored at the end it is written from, so the string grows away from the
    // bar when it is outside and back along it when it is in.
    return { txt: txt, cls: cls, x: end + room * 0.55 * (fits ? 1 : -1) * out, y: mid + 3.5,
      anchor: (fits ? out : -out) > 0 ? 'start' : 'end',
      // A crowded horizontal label has nowhere to go along its own bar, so it
      // steps across the bars instead.
      px: 0, py: fits ? -1 : 0 };
  }
  // Text hangs from its baseline, so the two cases are not one number negated:
  // clearing a bar end upward needs 6px, sitting inside it below needs 13.
  const dy = fits ? (out < 0 ? -6 : 15) : (out < 0 ? 13 : -5);
  return { txt: txt, cls: cls, x: mid, y: end + dy, anchor: 'middle',
    px: 0, py: fits ? (out < 0 ? -1 : 1) : 0 };
}

/**
 * Lay the data labels down, and move the ones that land on each other.
 *
 * WITHOUT THIS THE LABELS WERE THE DEFECT THEY WERE MEANT TO CURE. Two lines
 * running close together printed both numbers in the same few pixels; a combo's
 * bar label and its line label met above the bar; a radar of small numbers piled
 * every series into a knot. Each of those was read as "the labels are broken",
 * and each of them is one problem: two marks near each other, two numbers in one
 * place.
 *
 * Not a solver — placed in order, and anything overlapping something already
 * down steps along its own escape direction and tries again. A label that still
 * collides after two steps is drawn anyway: overlapping is bad, and silently
 * dropping a number off a chart is worse.
 *
 * @param {object[]} bits placements from vizBarLabel and the series passes
 * @returns {string} SVG
 */
function vizLabelLayer(bits) {
  const boxOf = b => {
    const w = String(b.txt).length * 5.6 + 2;
    const x0 = b.anchor === 'start' ? b.x : (b.anchor === 'end' ? b.x - w : b.x - w / 2);
    return [x0, b.y - 9.5, x0 + w, b.y + 2.5];
  };
  const hits = (a, c) => a[0] < c[2] - 1 && c[0] < a[2] - 1 && a[1] < c[3] - 1 && c[1] < a[3] - 1;

  const down = [];
  return bits.map(b => {
    let box = boxOf(b);
    for (let n = 0; n < 2 && down.some(d => hits(box, d)); n++) {
      if (!b.px && !b.py) break;                 // pinned — a stack segment
      b = Object.assign({}, b, { x: b.x + b.px * 12, y: b.y + b.py * 12 });
      box = boxOf(b);
    }
    down.push(box);
    return '<text class="' + b.cls + '" x="' + b.x.toFixed(1) + '" y="' + b.y.toFixed(1)
      + '" text-anchor="' + b.anchor + '">' + vizEsc(b.txt) + '</text>';
  }).join('');
}

/* ---------------------------------------------------------------------------
 * Cartesian forms
 * ------------------------------------------------------------------------ */

/**
 * The plot's geometry and scales — everything a mark needs to know where it goes.
 *
 * Extracted because two places need it and only one used to have it: the marks
 * were placed by vizCartesian and the crosshair recomputed its own copy of the
 * padding and the band width. That worked only as long as the two copies agreed,
 * and nothing made them agree; the hover dots added here would have landed on a
 * second, slightly different chart.
 *
 * @param {object} card @param {number} w @param {number} h
 * @returns {?object} null when there is nothing to draw
 */
function vizFrame(card, w, h) {
  const kind = card.kind || 'column';
  const fmt = vizFmt(card);
  const f = vizFiltered(vizCategories(card), vizSeries(card));
  const cats = f.cats;
  const series = f.series.filter(s => s.values.some(isFinite));
  if (!series.length || !cats.length) return null;

  const horiz = VIZ_HORIZONTAL.indexOf(kind) >= 0;
  const stacked = kind === 'stackedColumn' || kind === 'stackedBar';
  const n = cats.length;

  const pl = fmt.yAxis ? (horiz ? 74 : VIZ_PAD.l) : 10;
  const pb = fmt.xAxis ? VIZ_PAD.b : 8;
  const iw = Math.max(10, w - pl - VIZ_PAD.r);
  const ih = Math.max(10, h - VIZ_PAD.t - pb);
  const x0 = pl, y0 = VIZ_PAD.t;
  const tickCount = Math.max(2, Math.floor((horiz ? iw : ih) / 46));

  let lo, hi;
  if (stacked) {
    const totals = cats.map((c, i) => series.reduce((a, s) => a + (isFinite(s.values[i]) ? s.values[i] : 0), 0));
    const t = vizTicks(Math.min(0, Math.min.apply(null, totals)), Math.max.apply(null, totals), tickCount);
    lo = t[0]; hi = t[t.length - 1];
  } else {
    const all = series.reduce((a, s) => a.concat(s.values.filter(isFinite)), []);
    // Bars and columns are read against zero — one that starts at 480 makes a
    // 4% difference look like a doubling. A line is not: a price series from
    // 4,800 to 5,200 would be a flat line at the top of a zero-based axis.
    const zeroBased = kind !== 'line' && kind !== 'area' && kind !== 'scatter';
    const t = vizTicks(zeroBased ? Math.min(0, Math.min.apply(null, all)) : Math.min.apply(null, all),
      Math.max.apply(null, all), tickCount);
    lo = t[0]; hi = t[t.length - 1];
  }
  const span = (hi - lo) || 1;
  const band = (horiz ? ih : iw) / n;

  return {
    kind, fmt, cats, series, horiz, stacked, n,
    x0, y0, iw, ih, lo, hi, span, band,
    ticks: vizTicks(lo, hi, tickCount),
    /** value → pixel along the value axis */
    vOf: v => (horiz ? x0 + ((v - lo) / span) * iw : y0 + ih - ((v - lo) / span) * ih),
    /** category index → pixel along the category axis */
    cOf: i => (horiz ? y0 : x0) + (i + 0.5) * band,
  };
}

/**
 * Column, bar, line, area, both stacks, combo and scatter.
 *
 * @param {object} card @param {number} w @param {number} h @returns {string} SVG
 */
function vizCartesian(card, w, h) {
  const fr = vizFrame(card, w, h);
  if (!fr) return '';
  const kind = fr.kind, fmt = fr.fmt, cats = fr.cats, series = fr.series;
  const horiz = fr.horiz, stacked = fr.stacked, n = fr.n;
  const x0 = fr.x0, y0 = fr.y0, iw = fr.iw, ih = fr.ih;
  const lo = fr.lo, hi = fr.hi, ticks = fr.ticks, band = fr.band;
  const vOf = fr.vOf, cOf = fr.cOf;

  let s = '';

  /* ---- gridlines and value ticks ---- */
  if (fmt.grid || fmt.yAxis) {
    s += ticks.map(t => {
      const p = vOf(t).toFixed(1);
      const line = fmt.grid
        ? (horiz
          ? '<line class="viz-grid" x1="' + p + '" y1="' + y0 + '" x2="' + p + '" y2="' + (y0 + ih) + '"/>'
          : '<line class="viz-grid" x1="' + x0 + '" y1="' + p + '" x2="' + (x0 + iw) + '" y2="' + p + '"/>')
        : '';
      const label = fmt.yAxis
        ? (horiz
          ? '<text class="viz-tick" x="' + p + '" y="' + (h - 6) + '" text-anchor="middle">' + vizEsc(vizNum(t)) + '</text>'
          : '<text class="viz-tick" x="' + (x0 - 7) + '" y="' + (vOf(t) + 3.5).toFixed(1) + '" text-anchor="end">' + vizEsc(vizNum(t)) + '</text>')
        : '';
      return line + label;
    }).join('');
  }

  /* ---- the marks ---- */
  const zero = vOf(Math.max(lo, Math.min(hi, 0)));
  const labelBits = [];

  if (kind === 'line' || kind === 'area' || kind === 'scatter' || kind === 'combo') {
    const lineSeries = kind === 'combo' ? series.slice(1) : series;

    if (kind === 'combo' && series[0]) {
      const bw = Math.min(VIZ_BAR_MAX, Math.max(3, band - VIZ_GAP * 2 - 8));
      s += series[0].values.map((v, i) => {
        if (!isFinite(v)) return '';
        const y = vOf(v), top = Math.min(y, zero), hgt = Math.max(1, Math.abs(zero - y));
        return '<path class="viz-mark" d="' + vizBarPath(+(cOf(i) - bw / 2).toFixed(1), +top.toFixed(1),
          +bw.toFixed(1), +hgt.toFixed(1), VIZ_BAR_RADIUS, 'top') + '" style="fill:' + vizColour(series[0], i)
          + ';--i:' + i + '"/>';
      }).join('');
      // The combo's bar series had no labels at all: the label pass below runs
      // over `lineSeries`, which is every series EXCEPT this one.
      if (fmt.labels) {
        series[0].values.forEach((v, i) => {
          if (!isFinite(v)) return;
          labelBits.push(vizBarLabel(v, vOf(v), zero, cOf(i), horiz,
            { x0: x0, y0: y0, iw: iw, ih: ih }));
        });
      }
    }

    lineSeries.forEach((ser, li) => {
      const pts = ser.values.map((v, i) => (isFinite(v) ? [cOf(i), vOf(v)] : null)).filter(Boolean);
      if (!pts.length) return;
      const col = vizColour(ser);
      if (kind !== 'scatter' && pts.length > 1) {
        const d = fmt.smooth ? vizSmoothPath(pts) : 'M' + pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
        if (kind === 'area') {
          // A wash at ~12%, never a saturated block: it says "under the line",
          // it is not a second thing to read. It fades from the line down to
          // nothing at the axis, so the eye is held by the series and not by a
          // hard edge along the bottom of the plot.
          s += '<path class="viz-area" d="' + d + 'L' + pts[pts.length - 1][0].toFixed(1) + ',' + (y0 + ih)
            + 'L' + pts[0][0].toFixed(1) + ',' + (y0 + ih) + 'Z" fill="url(#' + vizGradId(ser.slot) + ')"/>';
        }
        s += '<path class="viz-line" d="' + d + '" style="stroke:' + col
          + ';--len:' + vizPathLen(pts).toFixed(0) + '"/>';
      }
      // A ring in the surface colour keeps a dot legible where it crosses the
      // line or another dot — a stroke around the mark would be ink that is
      // not data.
      // The dots take a per-point colour where one was set; the line itself
      // cannot — a line is one stroke and colouring "point three" of it would
      // mean choosing which of its two segments changed.
      s += pts.map((p, i) => '<circle class="viz-dot" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1)
        + '" r="' + VIZ_DOT_R + '" style="fill:' + vizColour(ser, i) + ';--i:' + i + '"/>').join('');
      if (fmt.labels) {
        // ABOVE, THEN BELOW, THEN ABOVE. Every series labelled above its own
        // point, so wherever two lines ran close together their numbers printed
        // on top of each other — and lines run close together for a living.
        // Alternating by series separates the two-line case, which is the one
        // that actually arises, without a collision solver.
        //
        // Then clamped: a point sitting on the axis has nothing below it and a
        // point at the top of the plot has nothing above, so a label that would
        // leave the drawing goes to the other side of its dot instead.
        ser.values.forEach((v, i) => {
          if (!isFinite(v)) return;
          // The higher point takes the space above, the lower one the space
          // below. Alternating by series index instead put the label of the
          // LOW point above it and the label of the HIGH point below it, which
          // is the one arrangement guaranteed to meet in the middle.
          const others = lineSeries.map(o => o.values[i]).filter(isFinite);
          const up = !others.length || v >= Math.max.apply(null, others) || v > Math.min.apply(null, others);
          const py = vOf(v);
          let y = py + (up ? -9 : 15);
          if (y - 9.5 < y0) y = py + 15;
          if (y + 2.5 > y0 + ih) y = py - 9;
          labelBits.push({ txt: vizNum(v), cls: 'viz-label', x: cOf(i), y: y,
            anchor: 'middle', px: 0, py: up ? -1 : 1 });
        });
      }
    });

  } else if (stacked) {
    const bw = Math.min(VIZ_BAR_MAX * 1.6, Math.max(4, band - VIZ_GAP * 2 - 8));
    cats.forEach((c, i) => {
      let acc = 0;
      series.forEach(ser => {
        const v = isFinite(ser.values[i]) ? ser.values[i] : 0;
        if (!v) return;
        const a = vOf(acc), b = vOf(acc + v);
        acc += v;
        const col = vizColour(ser, i);

        // A stack's label goes in the middle of its own segment, not at the end
        // of the bar — the end is the total, and a number there would be read as
        // this segment's. Only where the segment is thick enough to hold it: a
        // 6px sliver with a number half outside it is worse than no number.
        if (fmt.labels) {
          const span = Math.abs(b - a);
          if (span > 15) {
            labelBits.push({ txt: vizNum(v), cls: 'viz-label viz-label-in',
              x: horiz ? (a + b) / 2 : cOf(i),
              y: (horiz ? cOf(i) : (a + b) / 2) + 3.5,
              // Pinned: a stack's label means "this segment", so moving it off
              // the segment would be moving it onto a neighbour's.
              anchor: 'middle', px: 0, py: 0 });
          }
        }
        // The 2px gap is what separates one segment from the next — negative
        // space, not a border drawn around the mark.
        if (horiz) {
          const left = Math.min(a, b), width = Math.max(1, Math.abs(b - a) - VIZ_GAP);
          s += '<rect class="viz-mark" x="' + left.toFixed(1) + '" y="' + (cOf(i) - bw / 2).toFixed(1)
            + '" width="' + width.toFixed(1) + '" height="' + bw.toFixed(1)
            + '" style="fill:' + col + ';--i:' + i + '"/>';
        } else {
          const top = Math.min(a, b), hgt = Math.max(1, Math.abs(b - a) - VIZ_GAP);
          s += '<rect class="viz-mark" x="' + (cOf(i) - bw / 2).toFixed(1) + '" y="' + top.toFixed(1)
            + '" width="' + bw.toFixed(1) + '" height="' + hgt.toFixed(1)
            + '" style="fill:' + col + ';--i:' + i + '"/>';
        }
      });
    });

  } else {
    /* grouped column or bar */
    const per = Math.max(2, (band - VIZ_GAP * 2 - 8) / series.length);
    const bw = Math.min(VIZ_BAR_MAX, Math.max(2, per - VIZ_GAP));
    series.forEach((ser, si) => {
      const off = (si - (series.length - 1) / 2) * (bw + VIZ_GAP);
      s += ser.values.map((v, i) => {
        if (!isFinite(v)) return '';
        const p = vOf(v);
        if (horiz) {
          const left = Math.min(p, zero), width = Math.max(1, Math.abs(zero - p));
          return '<path class="viz-mark" d="' + vizBarPath(+left.toFixed(1), +(cOf(i) + off - bw / 2).toFixed(1),
            +width.toFixed(1), +bw.toFixed(1), VIZ_BAR_RADIUS, 'right') + '" style="fill:' + vizColour(ser, i)
            + ';--i:' + i + '"/>';
        }
        const top = Math.min(p, zero), hgt = Math.max(1, Math.abs(zero - p));
        return '<path class="viz-mark" d="' + vizBarPath(+(cOf(i) + off - bw / 2).toFixed(1), +top.toFixed(1),
          +bw.toFixed(1), +hgt.toFixed(1), VIZ_BAR_RADIUS, 'top') + '" style="fill:' + vizColour(ser, i)
          + ';--i:' + i + '"/>';
      }).join('');

      if (fmt.labels) {
        ser.values.forEach((v, i) => {
          if (!isFinite(v)) return;
          labelBits.push(vizBarLabel(v, vOf(v), zero, cOf(i) + off, horiz,
            { x0: x0, y0: y0, iw: iw, ih: ih }));
        });
      }
    });
  }

  s += vizLabelLayer(labelBits);

  /* ---- category labels, thinned to whatever fits ---- */
  if (fmt.xAxis) {
    if (horiz) {
      s += cats.map((c, i) =>
        '<text class="viz-tick" x="' + (x0 - 8) + '" y="' + (cOf(i) + 3.5).toFixed(1)
        + '" text-anchor="end">' + vizEsc(c.length > 12 ? c.slice(0, 11) + '…' : c) + '</text>').join('');
    } else {
      const every = Math.max(1, Math.ceil((n * 38) / iw));
      s += cats.map((c, i) => {
        if (i % every && i !== n - 1) return '';
        return '<text class="viz-tick" x="' + cOf(i).toFixed(1) + '" y="' + (h - 6)
          + '" text-anchor="middle">' + vizEsc(c.length > 10 ? c.slice(0, 9) + '…' : c) + '</text>';
      }).join('');
    }
  }

  /* ---- one direct end label on a single line series: the value the eye ends
         on. Not one per point unless data labels are asked for. ---- */
  if (!fmt.labels && series.length === 1 && (kind === 'line' || kind === 'area')) {
    const v = series[0].values.filter(isFinite);
    if (v.length) {
      const li = series[0].values.length - 1;
      const lx = cOf(li), ly = vOf(series[0].values[li]);
      s += '<text class="viz-endlabel" x="' + Math.min(w - 4, lx + 8).toFixed(1)
        + '" y="' + Math.max(12, ly - 10).toFixed(1) + '" text-anchor="'
        + (lx > w - 56 ? 'end' : 'start') + '">' + vizEsc(vizNum(series[0].values[li])) + '</text>';
    }
  }

  return s;
}

/* ---------------------------------------------------------------------------
 * Part-to-whole forms
 * ------------------------------------------------------------------------ */

/** Pie and donut. @param {object} card @param {number} w @param {number} h */
function vizPie(card, w, h) {
  const f = vizFiltered(vizCategories(card), vizSeries(card));
  const vals = (f.series[0] ? f.series[0].values : []).map(Number).map(v => (isFinite(v) && v > 0 ? v : 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (!total) return '';

  const ser = f.series[0];
  const donut = (card.kind || 'donut') === 'donut';
  const cx = w / 2, cy = h / 2;
  const R = Math.max(20, Math.min(w, h) / 2 - 8);
  let acc = 0, s = '';

  if (donut) {
    const thick = Math.max(12, Math.min(30, R * 0.42));
    const r = R - thick / 2;
    const circ = 2 * Math.PI * r;
    s += '<circle class="viz-track" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1)
      + '" r="' + r.toFixed(1) + '" style="stroke-width:' + thick.toFixed(1) + '"/>';
    vals.forEach((v, i) => {
      const frac = v / total;
      const len = Math.max(0, circ * frac - VIZ_GAP);
      s += '<circle class="viz-arc" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + r.toFixed(1)
        + '" fill="none" stroke-linecap="butt" style="stroke:' + vizCatColour(ser, i)
        + ';stroke-width:' + thick.toFixed(1) + ';--i:' + i + '" stroke-dasharray="' + len.toFixed(2) + ' '
        + (circ - len).toFixed(2) + '" stroke-dashoffset="' + (-circ * acc).toFixed(2)
        + '" transform="rotate(-90 ' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ')"/>';
      acc += frac;
    });
    s += '<text class="viz-donut-total" x="' + cx.toFixed(1) + '" y="' + (cy + 2).toFixed(1)
      + '" text-anchor="middle">' + vizEsc(vizNum(total)) + '</text>'
      + '<text class="viz-donut-cap" x="' + cx.toFixed(1) + '" y="' + (cy + 17).toFixed(1)
      + '" text-anchor="middle">total</text>';
  } else {
    vals.forEach((v, i) => {
      const a0 = acc * 2 * Math.PI - Math.PI / 2;
      acc += v / total;
      const a1 = acc * 2 * Math.PI - Math.PI / 2;
      const big = (a1 - a0) > Math.PI ? 1 : 0;
      s += '<path class="viz-slice" d="M' + cx.toFixed(1) + ' ' + cy.toFixed(1)
        + 'L' + (cx + R * Math.cos(a0)).toFixed(1) + ' ' + (cy + R * Math.sin(a0)).toFixed(1)
        + 'A' + R.toFixed(1) + ' ' + R.toFixed(1) + ' 0 ' + big + ' 1 '
        + (cx + R * Math.cos(a1)).toFixed(1) + ' ' + (cy + R * Math.sin(a1)).toFixed(1)
        + 'Z" style="fill:' + vizCatColour(ser, i) + ';--i:' + i + '"/>';
    });
  }

  if (vizFmt(card).labels) {
    acc = 0;
    const lr = donut ? R - Math.max(12, Math.min(30, R * 0.42)) / 2 : R * 0.66;
    vals.forEach(v => {
      const mid = (acc + v / total / 2) * 2 * Math.PI - Math.PI / 2;
      acc += v / total;
      const pct = Math.round((v / total) * 100);
      if (pct < 6) return;    // no room; the legend carries it
      s += '<text class="viz-inlabel" x="' + (cx + lr * Math.cos(mid)).toFixed(1)
        + '" y="' + (cy + lr * Math.sin(mid) + 3.5).toFixed(1) + '" text-anchor="middle">' + pct + '%</text>';
    });
  }
  return s;
}

/** Funnel — stages down the page, each a share of the first. */
function vizFunnel(card, w, h) {
  const f = vizFiltered(vizCategories(card), vizSeries(card));
  const ser = f.series[0];
  const vals = (ser ? ser.values : []).map(Number).filter(isFinite);
  if (!vals.length) return '';
  const n = vals.length;
  const max = Math.max.apply(null, vals) || 1;
  const labels = vizFmt(card).labels;

  const rowH = Math.min(54, h / n);
  const top = (h - rowH * n) / 2;
  const labelW = 92;
  // Room on the right for any number that will not fit inside its own stage.
  const wide = vals.reduce((m, v, i) => Math.max(m,
    (vizNum(v) + (i ? ' \u00b7 ' + Math.round((v / vals[0]) * 100) + '%' : '')).length), 0);
  const iw = Math.max(24, w - labelW - (labels ? wide * 5.6 + 14 : 12));
  const cx = labelW + iw / 2;

  const halfOf = v => Math.max(1.5, (v / max) * iw / 2);
  const gap = Math.min(5, rowH * 0.13);

  return vals.map((v, i) => {
    const a = halfOf(v);
    // The stage below is what this one narrows TO. The last has nothing under
    // it, so it keeps its own width and comes out square — tapering it to a
    // neck would draw a value that is not in the data.
    const b = halfOf(i < n - 1 ? vals[i + 1] : v);

    const y0 = top + i * rowH, y1 = y0 + rowH;
    // The gap is cut out of the row, so the widths are read at the edges the
    // shape actually has rather than at the row's — otherwise every stage is
    // drawn a little wider than its value.
    const t = (gap / 2) / rowH;
    const hTop = a + (b - a) * t;
    const hBot = a + (b - a) * (1 - t);
    const yTop = y0 + gap / 2, yBot = y1 - gap / 2;

    const d = 'M' + (cx - hTop).toFixed(1) + ' ' + yTop.toFixed(1)
      + 'L' + (cx + hTop).toFixed(1) + ' ' + yTop.toFixed(1)
      + 'L' + (cx + hBot).toFixed(1) + ' ' + yBot.toFixed(1)
      + 'L' + (cx - hBot).toFixed(1) + ' ' + yBot.toFixed(1) + 'Z';

    const mid = (y0 + y1) / 2;
    let out = '<path class="viz-mark viz-mark-c" d="' + d + '" style="fill:'
      + vizCatColour(ser, i) + ';--i:' + i + '"/>'
      + '<text class="viz-tick" x="' + (labelW - 8) + '" y="' + (mid + 3.5).toFixed(1)
      + '" text-anchor="end">' + vizEsc(String(f.cats[i] || '')) + '</text>';

    if (labels) {
      // Inside the stage where the stage can hold it, and out to the right where
      // it cannot — the same rule the bars follow. A narrow stage with a number
      // half outside it is worse than a number beside it.
      const txt = vizNum(v) + (i ? ' \u00b7 ' + Math.round((v / vals[0]) * 100) + '%' : '');
      const room = txt.length * 5.6 + 14;
      const fits = Math.min(hTop, hBot) * 2 >= room;
      out += fits
        ? '<text class="viz-label viz-label-in" x="' + cx.toFixed(1) + '" y="' + (mid + 3.5).toFixed(1)
          + '" text-anchor="middle">' + vizEsc(txt) + '</text>'
        : '<text class="viz-label" x="' + (cx + Math.max(hTop, hBot) + 7).toFixed(1) + '" y="'
          + (mid + 3.5).toFixed(1) + '">' + vizEsc(txt) + '</text>';
    }
    return out;
  }).join('');
}

/**
 * Treemap — area is the value, laid out in slices.
 *
 * A simple slice-and-dice rather than a squarified layout: with the handful of
 * categories a board like this carries, the aspect ratios stay reasonable, and
 * the squarified algorithm is a lot of code for a case that does not arise.
 */
function vizTreemap(card, w, h) {
  const f = vizFiltered(vizCategories(card), vizSeries(card));
  const raw = (f.series[0] ? f.series[0].values : []).map(Number);
  const items = raw.map((v, i) => ({ v: isFinite(v) && v > 0 ? v : 0, name: f.cats[i] || '', slot: i + 1 }))
    .filter(it => it.v > 0)
    .sort((a, b) => b.v - a.v);
  const total = items.reduce((a, b) => a + b.v, 0);
  if (!total) return '';

  const ser = f.series[0];
  let s = '';
  let x = 0, y = 0, availW = w, availH = h, rest = total;
  // The tile's name is what tells you which rectangle you are looking at; the
  // number under it is the data label, and that is the half the switch owns.
  const labels = vizFmt(card).labels;

  items.forEach((it, i) => {
    const last = i === items.length - 1;
    const frac = it.v / rest;
    const horiz = availW >= availH;
    const bw = last ? availW : (horiz ? availW * frac : availW);
    const bh = last ? availH : (horiz ? availH : availH * frac);

    s += '<rect class="viz-tm" x="' + (x + VIZ_GAP / 2).toFixed(1) + '" y="' + (y + VIZ_GAP / 2).toFixed(1)
      + '" width="' + Math.max(0, bw - VIZ_GAP).toFixed(1) + '" height="' + Math.max(0, bh - VIZ_GAP).toFixed(1)
      + '" rx="4" style="fill:' + vizCatColour(ser, it.slot - 1) + ';--i:' + i + '"/>';

    // Only label a tile the text actually fits in: a clipped label that loses
    // its first and last characters is worse than no label.
    if (bw > 58 && bh > 30) {
      s += '<text class="viz-tm-name" x="' + (x + 8).toFixed(1) + '" y="' + (y + 18).toFixed(1) + '">'
        + vizEsc(it.name.length > 14 ? it.name.slice(0, 13) + '…' : it.name) + '</text>'
        + (labels
          ? '<text class="viz-tm-val" x="' + (x + 8).toFixed(1) + '" y="' + (y + 33).toFixed(1) + '">'
            + vizEsc(vizNum(it.v)) + '</text>'
          : '');
    }

    if (horiz) { x += bw; availW -= bw; } else { y += bh; availH -= bh; }
    rest -= it.v;
  });
  return s;
}

/* ---------------------------------------------------------------------------
 * Score forms — read against a ceiling, not against a total
 * ------------------------------------------------------------------------ */

/**
 * Concentric rings, one per category, each a fraction of the same ceiling.
 *
 * NOT a donut wearing a different hat. A donut divides one quantity between
 * categories and its arcs necessarily sum to the circle; these are independent
 * scores that happen to be drawn together, and any one of them can be full
 * while the others are empty. That is the reading a set of site scores wants —
 * "connectivity 82, infrastructure 64" — and the one a donut cannot give,
 * because a donut would show 82 and 64 as 56% and 44% of each other.
 *
 * Every ring shares the ceiling, so the same score is the same sweep on any
 * ring — otherwise the outer ring's greater circumference would make equal
 * numbers look unequal, which is the failure mode this form is known for.
 *
 * @param {object} card @param {number} w @param {number} h @returns {string} SVG
 */
function vizRing(card, w, h) {
  const f = vizFiltered(vizCategories(card), vizSeries(card));
  const vals = (f.series[0] ? f.series[0].values : []).map(Number);
  if (!vals.some(isFinite)) return '';
  const max = vizScoreMax(card, vals) || 1;

  const ser = f.series[0];
  const cx = w / 2, cy = h / 2;
  const outer = Math.max(18, Math.min(w, h) / 2 - 6);
  const n = Math.min(vals.length, 6);          // beyond six the innermost is a dot
  // THE GAP IS WHAT MAKES THEM RINGS. At a flat 4px against a 17px band the
  // rings covered 81% of the radius they were spread over, so five of them
  // merged into one grey disc with the data sitting on it as short coloured
  // commas — the whole reason this read as a stack of nested brackets instead
  // of a chart. Half the band, so the negative space scales with them:
  //   n * (thick + gap) = budget,  gap = thick / 2  ->  thick = budget / (n * 1.5)
  const budget = outer * 0.78;
  const thick = Math.max(5, Math.min(17, budget / (n * 1.5)));
  const gap = thick / 2;

  let s = '';
  for (let i = 0; i < n; i++) {
    const r = outer - thick / 2 - i * (thick + gap);
    if (r < thick) break;
    const circ = 2 * Math.PI * r;
    const frac = Math.max(0, Math.min(1, (isFinite(vals[i]) ? vals[i] : 0) / max));
    s += '<circle class="viz-track" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1)
      + '" r="' + r.toFixed(1) + '" style="stroke-width:' + thick.toFixed(1) + '"/>'
      // Round caps, so a ring that is barely filled is still a mark rather than
      // a hairline, and a full one closes on itself cleanly.
      + '<circle class="viz-arc" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1)
      + '" r="' + r.toFixed(1) + '" fill="none" stroke-linecap="round" style="stroke:'
      + vizCatColour(ser, i) + ';stroke-width:' + thick.toFixed(1) + ';--i:' + i + '"'
      + ' stroke-dasharray="' + (circ * frac).toFixed(2) + ' ' + (circ * (1 - frac) + 1).toFixed(2) + '"'
      + ' transform="rotate(-90 ' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ')"/>';
  }

  // THE HOLE WAS DEAD SPACE, and that is most of what made this read as a set
  // of nested brackets rather than as a chart. Every ring form worth copying
  // puts the one-number summary in the middle — the donut beside it already
  // does — and on a card of scores that number is the average of them, read
  // against the same ceiling every ring on the card is drawn against.
  //
  // Only when the hole can actually hold it: an innermost ring at six
  // categories leaves a gap a two-digit number would sit outside.
  const scored = vals.filter(isFinite);
  const hole = outer - thick / 2 - (n - 1) * (thick + gap) - thick / 2;
  if (scored.length > 1 && hole >= 26) {
    const avg = scored.reduce((a, b) => a + b, 0) / scored.length;
    s += '<text class="viz-donut-total" x="' + cx.toFixed(1) + '" y="' + (cy + 1).toFixed(1)
      + '" text-anchor="middle">' + vizEsc(vizNum(Math.round(avg * 10) / 10)) + '</text>'
      + '<text class="viz-donut-cap" x="' + cx.toFixed(1) + '" y="' + (cy + 16).toFixed(1)
      + '" text-anchor="middle">avg of ' + vizEsc(vizNum(max)) + '</text>';
  }
  return s;
}

/**
 * One number on a dial.
 *
 * 240 degrees rather than a full circle: a ring that closes has no beginning,
 * so the eye cannot tell 0% from 100%. An open dial has a floor on the left and
 * a ceiling on the right and reads at a glance, which is the entire job.
 *
 * @param {object} card @param {number} w @param {number} h @returns {string} SVG
 */
function vizGauge(card, w, h) {
  const f = vizFiltered(vizCategories(card), vizSeries(card));
  const ser = f.series[0];
  const vals = (ser ? ser.values : []).map(Number).filter(isFinite);
  if (!vals.length) return '';
  const v = vals[0];
  const max = vizScoreMax(card, vals) || 1;
  const frac = Math.max(0, Math.min(1, v / max));

  const A0 = -120, A1 = 120;                   // from twelve o'clock, clockwise
  const cx = w / 2;
  // Pushed below centre: the dial's own mass sits in the upper two thirds, so
  // centring the circle leaves the caption crowded and the top bare.
  const cy = h / 2 + Math.min(18, h * 0.06);
  const r = Math.max(16, Math.min(w / 2 - 10, (h - 30) / 1.55));
  const thick = Math.max(7, Math.min(18, r * 0.24));

  const label = (f.cats[0] || (ser && ser.name) || '').toString();
  return '<path class="viz-track" d="' + vizArcPath(cx, cy, r, A0, A1)
    + '" fill="none" stroke-linecap="round" style="stroke-width:' + thick.toFixed(1) + '"/>'
    // Its own class, not .viz-arc: a ring's enter animation turns the whole
    // circle about its centre, which for a circle is also its bounding box's
    // centre. An arc's is not, so the same rotation would swing the needle out
    // of the dial. This one sweeps along itself instead, which is what a dial
    // does anyway.
    + '<path class="viz-dial" d="' + vizArcPath(cx, cy, r, A0, A0 + (A1 - A0) * frac)
    + '" fill="none" stroke-linecap="round" style="stroke:' + vizColour(ser)
    + ';stroke-width:' + thick.toFixed(1)
    + ';--len:' + (r * (A1 - A0) * Math.PI / 180 * frac + thick).toFixed(0) + '"/>'
    + '<text class="viz-donut-total" x="' + cx.toFixed(1) + '" y="' + (cy + 2).toFixed(1)
    + '" text-anchor="middle">' + vizEsc(vizNum(v)) + '</text>'
    + '<text class="viz-donut-cap" x="' + cx.toFixed(1) + '" y="' + (cy + 18).toFixed(1)
    + '" text-anchor="middle">' + vizEsc(label ? label : 'of ' + vizNum(max)) + '</text>'
    // The floor and the ceiling, at the two ends of the arc. Without them the
    // big number in the middle is just a number: 74 on a dial that is most of
    // the way round says one thing out of 100 and quite another out of 80.
    + '<text class="viz-tick" x="' + (cx + (r + thick * 0.9) * Math.cos((A0 - 90) * Math.PI / 180)).toFixed(1)
    + '" y="' + (cy + (r + thick * 0.9) * Math.sin((A0 - 90) * Math.PI / 180) + 10).toFixed(1)
    + '" text-anchor="middle">0</text>'
    + '<text class="viz-tick" x="' + (cx + (r + thick * 0.9) * Math.cos((A1 - 90) * Math.PI / 180)).toFixed(1)
    + '" y="' + (cy + (r + thick * 0.9) * Math.sin((A1 - 90) * Math.PI / 180) + 10).toFixed(1)
    + '" text-anchor="middle">' + vizEsc(vizNum(max)) + '</text>';
}

/**
 * One axis per category, one closed shape per series.
 *
 * The web is drawn at quarters of the same ceiling every score form on this
 * board uses, so a point half way out is half the score — the one question a
 * radar is read for.
 *
 * @param {object} card @param {number} w @param {number} h @returns {string} SVG
 */
function vizRadar(card, w, h) {
  const fmt = vizFmt(card);
  const f = vizFiltered(vizCategories(card), vizSeries(card));
  const cats = f.cats;
  const series = f.series.filter(s => s.values.some(isFinite));
  if (cats.length < 3 || !series.length) return '';

  const all = series.reduce((a, s) => a.concat(s.values.filter(isFinite)), []);
  const max = vizScoreMax(card, all) || 1;
  const n = cats.length;

  const cx = w / 2, cy = h / 2 + 2;
  // Room for the axis names, which sit outside the web and are the widest thing
  // on the card.
  const pad = fmt.xAxis ? Math.min(52, Math.max(26, w * 0.12)) : 10;
  const R = Math.max(20, Math.min(w / 2 - pad, h / 2 - 14));

  const at = (i, frac) => {
    const a = (i / n) * 2 * Math.PI - Math.PI / 2;
    return [cx + R * frac * Math.cos(a), cy + R * frac * Math.sin(a)];
  };
  const poly = frac => cats.map((c, i) => at(i, frac).map(v => v.toFixed(1)).join(' ')).join('L');

  let s = '';

  if (fmt.grid) {
    // Polygons, not circles. A circular web says the space between axes is
    // measured, and it is not — there is nothing between one category and the
    // next.
    //
    // Quarters rather than the tick values every other chart uses, because a
    // radar carries no numbers on its rings: nothing here would say "50". The
    // rings are only there to judge how far out a point sits, and the round
    // tick maths collapsed a 0-100 scale to a single ring at half way.
    [0.25, 0.5, 0.75, 1].forEach(t => {
      s += '<path class="viz-grid" d="M' + poly(t) + 'Z" fill="none"/>';
    });
    s += cats.map((c, i) => '<line class="viz-grid" x1="' + cx.toFixed(1) + '" y1="' + cy.toFixed(1)
      + '" x2="' + at(i, 1)[0].toFixed(1) + '" y2="' + at(i, 1)[1].toFixed(1) + '"/>').join('');
  }

  series.forEach((ser, si) => {
    const pts = cats.map((c, i) => at(i, Math.max(0, Math.min(1,
      (isFinite(ser.values[i]) ? ser.values[i] : 0) / max))));
    const d = 'M' + pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L') + 'Z';
    const col = vizColour(ser);
    s += '<path class="viz-web" d="' + d + '" style="fill:' + col + ';stroke:' + col + '"/>'
      + pts.map((p, i) => '<circle class="viz-dot" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1)
        + '" r="' + (VIZ_DOT_R - 1) + '" style="fill:' + col + ';--i:' + i + '"/>').join('');

    // A radar's rings carry no numbers, so without labels the only way to read
    // a point is to judge how far out it sits — which is fine for comparing two
    // shapes and useless for reading one value.
    if (fmt.labels) {
      s += cats.map((c, i) => {
        const v = ser.values[i];
        if (!isFinite(v)) return '';
        // PUSHED OUT BY PIXELS, NOT BY A FRACTION OF THE RADIUS. A fixed
        // fraction is a shrinking gap: near the middle of the web 0.07 of R is
        // a few pixels, so a card of small numbers piled every label from every
        // series into one knot at the centre — the point at 2.4 and the point
        // at 6 printed over each other. A pixel offset is the same gap wherever
        // the vertex lands, and each series takes its own step out along the
        // spoke, so two series meeting on one axis stack instead of collide.
        const frac = Math.max(0, Math.min(1, v / max));
        const a = (i / n) * 2 * Math.PI - Math.PI / 2;
        const d = R * frac + 13 + si * 13;
        return '<text class="viz-label" x="' + (cx + d * Math.cos(a)).toFixed(1)
          + '" y="' + (cy + d * Math.sin(a) + 3.5).toFixed(1)
          + '" text-anchor="middle">' + vizEsc(vizNum(v)) + '</text>';
      }).join('');
    }
  });

  if (fmt.xAxis) {
    s += cats.map((c, i) => {
      const p = at(i, 1.13);
      // Anchored by which side of the web the axis is on, so a name on the left
      // runs away from the shape rather than across it.
      const dx = p[0] - cx;
      const anchor = Math.abs(dx) < R * 0.2 ? 'middle' : (dx > 0 ? 'start' : 'end');
      return '<text class="viz-tick" x="' + p[0].toFixed(1) + '" y="' + (p[1] + 3.5).toFixed(1)
        + '" text-anchor="' + anchor + '">'
        + vizEsc(c.length > 12 ? c.slice(0, 11) + '\u2026' : c) + '</text>';
    }).join('');
  }
  return s;
}

/* ---------------------------------------------------------------------------
 * Drawing and hover
 * ------------------------------------------------------------------------ */

/**
 * What the marks are made of, as one string.
 *
 * The enter animation replays when this changes and not otherwise, which is the
 * whole reason it exists: `dashDrawAllCharts()` also runs on every drag, resize
 * and tile move, and a chart that re-animates each time a neighbouring card is
 * nudged is a chart nobody can read. Geometry is deliberately absent from the
 * signature — a wider card is the same data.
 *
 * @param {object} card @returns {string}
 */
function vizRevealSignature(card) {
  const f = vizFiltered(vizCategories(card), vizSeries(card));
  return (card.kind || 'column') + '|' + f.cats.join('\u001f') + '|'
    + f.series.map(s => s.slot + ':' + s.values.join(',')).join(';');
}

/**
 * Draw one visual into its host, at the host's real size.
 *
 * @param {HTMLElement} host a `.dc-plot` element
 * @param {object} card
 */
function dashDrawChart(host, card) {
  const w = Math.round(host.clientWidth);
  const h = Math.round(host.clientHeight);
  if (w < 40 || h < 30) return;      // mid-animation, or a card collapsed to nothing

  const kind = card.kind || 'column';
  const series = vizSeries(card);
  const flat = series.reduce((a, s) => a.concat(s.values.filter(isFinite)), []);
  if (!vizEnough(kind, flat, vizCategories(card))) {
    host.innerHTML = ''; host.dataset.viz = ''; return;
  }

  _vizUid++;
  let body;
  if (kind === 'pie' || kind === 'donut') body = vizPie(card, w, h);
  else if (kind === 'funnel') body = vizFunnel(card, w, h);
  else if (kind === 'treemap') body = vizTreemap(card, w, h);
  else if (kind === 'ring') body = vizRing(card, w, h);
  else if (kind === 'gauge') body = vizGauge(card, w, h);
  else if (kind === 'radar') body = vizRadar(card, w, h);
  else body = vizCartesian(card, w, h);

  const sig = vizRevealSignature(card);
  const fresh = host.dataset.viz !== sig;
  host.dataset.viz = sig;

  host.innerHTML =
    '<svg class="viz' + (fresh && !vizMotionOff() ? ' viz-enter' : '') + '"'
    + (VIZ_HORIZONTAL.indexOf(kind) >= 0 ? ' data-horiz' : '')
    + ' width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"'
    + ' role="img" aria-label="' + vizEsc(card.title || 'Chart') + '">'
    + vizDefs() + body + '</svg>'
    + '<div class="viz-tip" hidden></div>';

  // The class is what runs the animation, so it is taken off once it has run.
  // Everything the enter animation touches is drawn in its final state and
  // animated `from` — so with the class gone, or an export freezing it, or
  // reduced motion on, the chart is simply already there.
  if (fresh && !vizMotionOff()) {
    const svg = host.querySelector('svg');
    setTimeout(() => { if (svg && svg.isConnected) svg.classList.remove('viz-enter'); }, VIZ_ENTER_TOTAL);
  }

  if (VIZ_SHARE_KINDS.indexOf(kind) < 0 && VIZ_SCORE_KINDS.indexOf(kind) < 0) {
    vizWireHover(host, card, w, h);
  }
}

/** @returns {boolean} true when the operator has asked for less motion */
function vizMotionOff() {
  return typeof motionReduced === 'function' ? motionReduced() : false;
}

/**
 * Crosshair and tooltip.
 *
 * The tooltip enhances, it never gates: the axis ticks, the end label and the
 * editable value list all carry the same numbers, so nothing here is the only
 * way to read a value.
 */
function vizWireHover(host, card, w, h) {
  // The host outlives its contents — a redraw replaces the SVG inside it, not
  // the element itself — so listeners bound to the host stack up one per
  // redraw, each of them writing into a crosshair and a tooltip that were
  // detached several redraws ago. With the size observer redrawing on every
  // tile move that goes from a slow leak to a fast one.
  if (host._vizOff) { host._vizOff(); host._vizOff = null; }

  const svg = host.querySelector('svg');
  const tip = host.querySelector('.viz-tip');
  const fr = vizFrame(card, w, h);
  if (!svg || !tip || !fr || fr.cats.length < 2) return;
  const cats = fr.cats, series = fr.series, horiz = fr.horiz;
  const kind = fr.kind, pl = fr.x0, iw = fr.iw, ih = fr.ih, cOf = fr.cOf;

  const cross = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  cross.setAttribute('class', 'viz-cross');
  cross.style.display = 'none';
  svg.appendChild(cross);

  // A dot per series on the category being read. The crosshair says which
  // category; on a chart with three lines in it, that leaves the actual
  // question — which value belongs to which series — to be answered by
  // matching colours in a tooltip. These answer it on the chart.
  const hits = series.map(ser => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('class', 'viz-hit');
    c.setAttribute('r', String(VIZ_DOT_R + 1));
    c.style.fill = vizColour(ser);
    c.style.display = 'none';
    svg.appendChild(c);
    return c;
  });

  // The same scale the marks were drawn with, rebuilt so the dots land on them
  // rather than near them. Bars are read at their end, not their middle, so
  // only the point forms get a dot.
  const dotted = kind === 'line' || kind === 'area' || kind === 'scatter';

  const move = e => {
    host._vizAt = { clientX: e.clientX, clientY: e.clientY };
    const r = svg.getBoundingClientRect();
    const along = horiz ? e.clientY - r.top : e.clientX - r.left;
    // Nearest index, so the whole band is the hit target rather than the mark
    // itself — an 8px dot you have to land on dead-centre is not a target.
    let best = 0, bd = Infinity;
    for (let i = 0; i < cats.length; i++) {
      const d = Math.abs(cOf(i) - along);
      if (d < bd) { bd = d; best = i; }
    }
    const p = cOf(best).toFixed(1);
    if (horiz) {
      cross.setAttribute('x1', pl); cross.setAttribute('x2', pl + iw);
      cross.setAttribute('y1', p); cross.setAttribute('y2', p);
    } else {
      cross.setAttribute('y1', fr.y0); cross.setAttribute('y2', fr.y0 + ih);
      cross.setAttribute('x1', p); cross.setAttribute('x2', p);
    }
    cross.style.display = '';

    hits.forEach((c, si) => {
      const v = series[si].values[best];
      if (!dotted || !isFinite(v)) { c.style.display = 'none'; return; }
      c.setAttribute('cx', horiz ? fr.vOf(v).toFixed(1) : cOf(best).toFixed(1));
      c.setAttribute('cy', horiz ? p : fr.vOf(v).toFixed(1));
      c.style.display = '';
    });

    tip.hidden = false;
    tip.innerHTML = '<em>' + vizEsc(cats[best]) + '</em>' + series.map(s =>
      '<span><i style="background:' + vizColour(s) + '"></i>'
      + (series.length > 1 ? vizEsc(s.name) + ' ' : '')
      + '<b>' + vizEsc(vizNum(s.values[best])) + '</b></span>').join('');

    const tw = tip.offsetWidth || 70, th = tip.offsetHeight || 24;
    if (horiz) {
      tip.style.left = Math.min(w - tw - 2, pl + iw / 2) + 'px';
      tip.style.top = Math.max(2, Math.min(h - th - 2, cOf(best) - th / 2)).toFixed(1) + 'px';
    } else {
      tip.style.left = Math.max(2, Math.min(w - tw - 2, cOf(best) - tw / 2)).toFixed(1) + 'px';
      tip.style.top = '2px';
    }
  };

  const leave = () => {
    cross.style.display = 'none';
    hits.forEach(c => { c.style.display = 'none'; });
    tip.hidden = true;
    host._vizAt = null;
  };
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerleave', leave);
  host._vizOff = () => {
    host.removeEventListener('pointermove', move);
    host.removeEventListener('pointerleave', leave);
  };

  // A chart can be redrawn while the pointer is sitting on it — a neighbouring
  // tile is dragged, the window is resized — and the new crosshair would then
  // wait for a movement that never comes, because the pointer has not moved.
  // Replaying the last position puts it back where the reader left it.
  //
  // BUT ONLY IF THE POINTER IS STILL THERE. `_vizAt` is cleared by `leave`, and
  // between the pointer physically leaving and the browser dispatching
  // pointerleave there is a window in which it is still set. A redraw landing in
  // that window tears down the listener the pending leave was queued against —
  // so the leave is never delivered — and then replays the stale position onto
  // the fresh marks. The crosshair sticks to the chart for good: no further
  // movement over that host is coming to clear it, and an export taken
  // afterwards has a crosshair frozen across the picture. Asking the document
  // what is actually under that point costs one hit test and closes the window.
  //
  // The question is WHERE THE POINTER IS NOW, and `_vizAt` cannot answer it —
  // it is the position the pointer was at when it was last over this chart, so
  // hit-testing that point always lands back inside this chart and always says
  // yes. Hence the one document-level tracker: it is the only thing on the page
  // that knows where the pointer actually is.
  vizTrackPointer();
  if (host._vizAt && VIZ_POINTER.x >= 0) {
    const under = document.elementFromPoint(VIZ_POINTER.x, VIZ_POINTER.y);
    // Replayed at the live position rather than the stored one, so a redraw
    // while the reader is moving along the chart puts the crosshair where they
    // are rather than where they were a frame ago.
    if (under && host.contains(under)) move({ clientX: VIZ_POINTER.x, clientY: VIZ_POINTER.y });
    else { host._vizAt = null; leave(); }
  }
}

/** Where the pointer is, for the replay above. -1 until it first moves. */
const VIZ_POINTER = { x: -1, y: -1 };
let _vizPointerOn = false;

/**
 * Follow the pointer at the document, once.
 *
 * A chart only hears about the pointer while it is over that chart, which is
 * exactly the wrong window: the case that matters is a redraw landing just
 * after the pointer has left, in the gap before `pointerleave` is delivered.
 * The redraw removes the listener that leave was queued against — so it never
 * arrives — and the chart is left with its crosshair on. Nothing is coming to
 * clear it, and an export taken afterwards has one frozen across the picture.
 *
 * Capture phase, so it is seen wherever it happens; passive, so it never holds
 * up a scroll.
 */
function vizTrackPointer() {
  if (_vizPointerOn) return;
  _vizPointerOn = true;
  document.addEventListener('pointermove', e => {
    VIZ_POINTER.x = e.clientX; VIZ_POINTER.y = e.clientY;
  }, { passive: true, capture: true });
}

/** Redraw every chart on the board, measuring each host as it goes. */
function dashDrawAllCharts() {
  document.querySelectorAll('#dashGrid .dc-plot[data-card]').forEach(host => {
    const card = typeof dashCardById === 'function' ? dashCardById(host.dataset.card) : null;
    if (card) dashDrawChart(host, card);
  });
  vizObserveSizes();
}

/** The one observer, rebound to whatever plots are on the board. */
let _vizRo = null;
let _vizRoPending = null;
let _vizRoRaf = 0;

/**
 * Redraw a chart when its own box changes, whatever changed it.
 *
 * Charts are drawn in real pixels against `host.clientWidth`, so a chart is
 * only correct for the size it was measured at. The board used to redraw them
 * from the window's resize handler, in the same tick as the relayout — but
 * tiles transition their width over 160ms, so every chart was measured at the
 * width it was LEAVING and then left that way until something unrelated
 * redrew it. Dragging a tile wider and watching the chart inside stay narrow
 * is the visible version of that.
 *
 * Observing the box removes the guess. It fires when the width actually
 * arrives, once per frame however many tiles moved, and it covers the cases
 * nobody enumerated — the sidebar opening, a font loading, a card being
 * resized by its own handle.
 *
 * Redrawing does not resize the host, so this cannot drive itself.
 */
function vizObserveSizes() {
  if (typeof ResizeObserver !== 'function') return;
  if (!_vizRo) {
    _vizRoPending = new Set();
    _vizRo = new ResizeObserver(entries => {
      entries.forEach(e => _vizRoPending.add(e.target));
      if (_vizRoRaf) return;
      _vizRoRaf = requestAnimationFrame(() => {
        _vizRoRaf = 0;
        const hosts = Array.from(_vizRoPending);
        _vizRoPending.clear();
        hosts.forEach(host => {
          if (!host.isConnected) return;
          const card = typeof dashCardById === 'function' ? dashCardById(host.dataset.card) : null;
          if (card) dashDrawChart(host, card);
        });
      });
    });
  }
  _vizRo.disconnect();
  document.querySelectorAll('#dashGrid .dc-plot[data-card]').forEach(h => _vizRo.observe(h));
}

/* Node/test interop — harmless in the browser. Only the pure parts: the scale
   rules are shared with the export model, and a rule with two definitions is a
   rule that will disagree with itself. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VIZ_KINDS, VIZ_SHARE_KINDS, VIZ_SCORE_KINDS, VIZ_CATEGORY_KEYED, VIZ_SINGLE_KINDS,
    vizTicks, vizNum, vizEnough, vizScoreMax, vizArcPath, vizPathLen,
  };
}
