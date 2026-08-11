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
];

/** Kinds that are part-to-whole: one series, one slice per category. */
const VIZ_SHARE_KINDS = ['pie', 'donut', 'funnel', 'treemap'];

/** Kinds drawn along a horizontal value axis. */
const VIZ_HORIZONTAL = ['bar', 'stackedBar'];

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
    labels: !!f.labels,
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
    series: series.map(s => ({ name: s.name, slot: s.slot, values: idx.map(i => s.values[i]) })),
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

/* ---------------------------------------------------------------------------
 * Cartesian forms
 * ------------------------------------------------------------------------ */

/**
 * Column, bar, line, area, both stacks, combo and scatter.
 *
 * @param {object} card @param {number} w @param {number} h @returns {string} SVG
 */
function vizCartesian(card, w, h) {
  const kind = card.kind || 'column';
  const fmt = vizFmt(card);
  const f = vizFiltered(vizCategories(card), vizSeries(card));
  const cats = f.cats;
  const series = f.series.filter(s => s.values.some(isFinite));
  if (!series.length || !cats.length) return '';

  const horiz = VIZ_HORIZONTAL.indexOf(kind) >= 0;
  const stacked = kind === 'stackedColumn' || kind === 'stackedBar';
  const n = cats.length;

  const pl = fmt.yAxis ? (horiz ? 74 : VIZ_PAD.l) : 10;
  const pb = fmt.xAxis ? VIZ_PAD.b : 8;
  const iw = Math.max(10, w - pl - VIZ_PAD.r);
  const ih = Math.max(10, h - VIZ_PAD.t - pb);
  const x0 = pl, y0 = VIZ_PAD.t;

  /* ---- the value scale ---- */
  let lo, hi;
  if (stacked) {
    const totals = cats.map((c, i) => series.reduce((a, s) => a + (isFinite(s.values[i]) ? s.values[i] : 0), 0));
    const t = vizTicks(Math.min(0, Math.min.apply(null, totals)), Math.max.apply(null, totals),
      Math.max(2, Math.floor((horiz ? iw : ih) / 46)));
    lo = t[0]; hi = t[t.length - 1];
  } else {
    const all = series.reduce((a, s) => a.concat(s.values.filter(isFinite)), []);
    // Bars and columns are read against zero — one that starts at 480 makes a
    // 4% difference look like a doubling. A line is not: a price series from
    // 4,800 to 5,200 would be a flat line at the top of a zero-based axis.
    const zeroBased = kind !== 'line' && kind !== 'area' && kind !== 'scatter';
    const t = vizTicks(zeroBased ? Math.min(0, Math.min.apply(null, all)) : Math.min.apply(null, all),
      Math.max.apply(null, all), Math.max(2, Math.floor((horiz ? iw : ih) / 46)));
    lo = t[0]; hi = t[t.length - 1];
  }
  const span = (hi - lo) || 1;
  const ticks = vizTicks(lo, hi, Math.max(2, Math.floor((horiz ? iw : ih) / 46)));

  /** value → pixel along the value axis */
  const vOf = v => horiz ? x0 + ((v - lo) / span) * iw : y0 + ih - ((v - lo) / span) * ih;
  /** category index → pixel along the category axis */
  const band = (horiz ? ih : iw) / n;
  const cOf = i => (horiz ? y0 : x0) + (i + 0.5) * band;

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
          +bw.toFixed(1), +hgt.toFixed(1), VIZ_BAR_RADIUS, 'top') + '" style="fill:' + vizSlot(series[0].slot) + '"/>';
      }).join('');
    }

    lineSeries.forEach(ser => {
      const pts = ser.values.map((v, i) => (isFinite(v) ? [cOf(i), vOf(v)] : null)).filter(Boolean);
      if (!pts.length) return;
      const col = vizSlot(ser.slot);
      if (kind !== 'scatter' && pts.length > 1) {
        const d = fmt.smooth ? vizSmoothPath(pts) : 'M' + pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
        if (kind === 'area') {
          // A wash at ~12%, never a saturated block: it says "under the line",
          // it is not a second thing to read.
          s += '<path class="viz-area" d="' + d + 'L' + pts[pts.length - 1][0].toFixed(1) + ',' + (y0 + ih)
            + 'L' + pts[0][0].toFixed(1) + ',' + (y0 + ih) + 'Z" style="fill:' + col + '"/>';
        }
        s += '<path class="viz-line" d="' + d + '" style="stroke:' + col + '"/>';
      }
      // A ring in the surface colour keeps a dot legible where it crosses the
      // line or another dot — a stroke around the mark would be ink that is
      // not data.
      s += pts.map(p => '<circle class="viz-dot" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1)
        + '" r="' + VIZ_DOT_R + '" style="fill:' + col + '"/>').join('');
      if (fmt.labels) {
        ser.values.forEach((v, i) => {
          if (!isFinite(v)) return;
          labelBits.push('<text class="viz-label" x="' + cOf(i).toFixed(1) + '" y="'
            + (vOf(v) - 9).toFixed(1) + '" text-anchor="middle">' + vizEsc(vizNum(v)) + '</text>');
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
        const col = vizSlot(ser.slot);
        // The 2px gap is what separates one segment from the next — negative
        // space, not a border drawn around the mark.
        if (horiz) {
          const left = Math.min(a, b), width = Math.max(1, Math.abs(b - a) - VIZ_GAP);
          s += '<rect class="viz-mark" x="' + left.toFixed(1) + '" y="' + (cOf(i) - bw / 2).toFixed(1)
            + '" width="' + width.toFixed(1) + '" height="' + bw.toFixed(1) + '" style="fill:' + col + '"/>';
        } else {
          const top = Math.min(a, b), hgt = Math.max(1, Math.abs(b - a) - VIZ_GAP);
          s += '<rect class="viz-mark" x="' + (cOf(i) - bw / 2).toFixed(1) + '" y="' + top.toFixed(1)
            + '" width="' + bw.toFixed(1) + '" height="' + hgt.toFixed(1) + '" style="fill:' + col + '"/>';
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
            +width.toFixed(1), +bw.toFixed(1), VIZ_BAR_RADIUS, 'right') + '" style="fill:' + vizSlot(ser.slot) + '"/>';
        }
        const top = Math.min(p, zero), hgt = Math.max(1, Math.abs(zero - p));
        return '<path class="viz-mark" d="' + vizBarPath(+(cOf(i) + off - bw / 2).toFixed(1), +top.toFixed(1),
          +bw.toFixed(1), +hgt.toFixed(1), VIZ_BAR_RADIUS, 'top') + '" style="fill:' + vizSlot(ser.slot) + '"/>';
      }).join('');

      if (fmt.labels) {
        ser.values.forEach((v, i) => {
          if (!isFinite(v)) return;
          const p = vOf(v);
          labelBits.push(horiz
            ? '<text class="viz-label" x="' + (p + 5).toFixed(1) + '" y="' + (cOf(i) + off + 3.5).toFixed(1) + '">' + vizEsc(vizNum(v)) + '</text>'
            : '<text class="viz-label" x="' + (cOf(i) + off).toFixed(1) + '" y="' + (p - 6).toFixed(1) + '" text-anchor="middle">' + vizEsc(vizNum(v)) + '</text>');
        });
      }
    });
  }

  s += labelBits.join('');

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
      s += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + r.toFixed(1)
        + '" fill="none" stroke-linecap="butt" style="stroke:' + vizSlot(i + 1)
        + ';stroke-width:' + thick.toFixed(1) + '" stroke-dasharray="' + len.toFixed(2) + ' '
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
        + 'Z" style="fill:' + vizSlot(i + 1) + '"/>';
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
  const vals = (f.series[0] ? f.series[0].values : []).map(Number).filter(isFinite);
  if (!vals.length) return '';
  const max = Math.max.apply(null, vals) || 1;
  const rowH = Math.min(46, h / vals.length);
  const top = (h - rowH * vals.length) / 2;
  const labelW = 92;
  const iw = Math.max(20, w - labelW - 46);

  return vals.map((v, i) => {
    const bw = Math.max(2, (v / max) * iw);
    const y = top + i * rowH;
    return '<rect class="viz-mark" x="' + labelW + '" y="' + (y + 5).toFixed(1) + '" width="' + bw.toFixed(1)
      + '" height="' + Math.max(6, rowH - 12).toFixed(1) + '" rx="4" style="fill:' + vizSlot(i + 1) + '"/>'
      + '<text class="viz-tick" x="' + (labelW - 8) + '" y="' + (y + rowH / 2 + 3.5).toFixed(1)
      + '" text-anchor="end">' + vizEsc(String(f.cats[i] || '')) + '</text>'
      + '<text class="viz-label" x="' + (labelW + bw + 6).toFixed(1) + '" y="'
      + (y + rowH / 2 + 3.5).toFixed(1) + '">' + vizEsc(vizNum(v))
      + (i ? ' · ' + Math.round((v / vals[0]) * 100) + '%' : '') + '</text>';
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

  let s = '';
  let x = 0, y = 0, availW = w, availH = h, rest = total;

  items.forEach((it, i) => {
    const last = i === items.length - 1;
    const frac = it.v / rest;
    const horiz = availW >= availH;
    const bw = last ? availW : (horiz ? availW * frac : availW);
    const bh = last ? availH : (horiz ? availH : availH * frac);

    s += '<rect class="viz-tm" x="' + (x + VIZ_GAP / 2).toFixed(1) + '" y="' + (y + VIZ_GAP / 2).toFixed(1)
      + '" width="' + Math.max(0, bw - VIZ_GAP).toFixed(1) + '" height="' + Math.max(0, bh - VIZ_GAP).toFixed(1)
      + '" rx="4" style="fill:' + vizSlot(it.slot) + '"/>';

    // Only label a tile the text actually fits in: a clipped label that loses
    // its first and last characters is worse than no label.
    if (bw > 58 && bh > 30) {
      s += '<text class="viz-tm-name" x="' + (x + 8).toFixed(1) + '" y="' + (y + 18).toFixed(1) + '">'
        + vizEsc(it.name.length > 14 ? it.name.slice(0, 13) + '…' : it.name) + '</text>'
        + '<text class="viz-tm-val" x="' + (x + 8).toFixed(1) + '" y="' + (y + 33).toFixed(1) + '">'
        + vizEsc(vizNum(it.v)) + '</text>';
    }

    if (horiz) { x += bw; availW -= bw; } else { y += bh; availH -= bh; }
    rest -= it.v;
  });
  return s;
}

/* ---------------------------------------------------------------------------
 * Drawing and hover
 * ------------------------------------------------------------------------ */

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
  const enough = VIZ_SHARE_KINDS.indexOf(kind) >= 0 ? flat.length >= 1 : flat.length >= 2;
  if (!enough) { host.innerHTML = ''; return; }

  let body;
  if (kind === 'pie' || kind === 'donut') body = vizPie(card, w, h);
  else if (kind === 'funnel') body = vizFunnel(card, w, h);
  else if (kind === 'treemap') body = vizTreemap(card, w, h);
  else body = vizCartesian(card, w, h);

  host.innerHTML =
    '<svg class="viz" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"'
    + ' role="img" aria-label="' + vizEsc(card.title || 'Chart') + '">' + body + '</svg>'
    + '<div class="viz-tip" hidden></div>';

  if (VIZ_SHARE_KINDS.indexOf(kind) < 0) vizWireHover(host, card, w, h);
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
  const fmt = vizFmt(card);
  const f = vizFiltered(vizCategories(card), vizSeries(card));
  const cats = f.cats;
  const series = f.series.filter(s => s.values.some(isFinite));
  if (!svg || !tip || !series.length || cats.length < 2) return;

  const kind = card.kind || 'column';
  const horiz = VIZ_HORIZONTAL.indexOf(kind) >= 0;
  const pl = fmt.yAxis ? (horiz ? 74 : VIZ_PAD.l) : 10;
  const pb = fmt.xAxis ? VIZ_PAD.b : 8;
  const iw = Math.max(10, w - pl - VIZ_PAD.r), ih = Math.max(10, h - VIZ_PAD.t - pb);
  const band = (horiz ? ih : iw) / cats.length;
  const cOf = i => (horiz ? VIZ_PAD.t : pl) + (i + 0.5) * band;

  const cross = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  cross.setAttribute('class', 'viz-cross');
  cross.style.display = 'none';
  svg.appendChild(cross);

  const move = e => {
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
      cross.setAttribute('y1', VIZ_PAD.t); cross.setAttribute('y2', VIZ_PAD.t + ih);
      cross.setAttribute('x1', p); cross.setAttribute('x2', p);
    }
    cross.style.display = '';

    tip.hidden = false;
    tip.innerHTML = '<em>' + vizEsc(cats[best]) + '</em>' + series.map(s =>
      '<span><i style="background:' + vizSlot(s.slot) + '"></i>'
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
