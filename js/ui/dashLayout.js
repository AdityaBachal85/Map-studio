/**
 * ui/dashLayout.js — the board is a canvas, and everything on it is a tile.
 *
 * FREE SIZE, ON A GRID. Every tile carries `{x, y, w, h}` in grid units — 12
 * columns across, 28px rows down — and you move it by dragging its title and
 * resize it from any edge or corner. Pure free-form absolute positioning was
 * the other option and it is what makes most hand-built dashboards look untidy:
 * nothing lines up, every card is three pixels off its neighbour, and the gaps
 * are all slightly different. Snapping to a grid means anything you drag lands
 * aligned with everything else, so the board stays tidy while still being
 * yours to arrange.
 *
 * THE MAP IS A TILE. Not a fixed panel with cards underneath — the same
 * geometry, the same handles, so you can make the map big while you work and
 * small when the numbers matter. It keeps its own reserved id and cannot be
 * deleted, because a dashboard for a map with no map on it is not a thing
 * anyone wants.
 *
 * Moving `.map-wrap` between the canvas and the app shell does not disturb the
 * map: `appendChild` moves a subtree intact, so Leaflet's container, its panes
 * and every layer on them survive the move. (Measured, not assumed — the map
 * was re-parented with pins, shapes and tiles on it and came through with all
 * of them, still pannable. Only its cached size goes stale, which is what
 * `invalidateSize()` is for.)
 *
 * REFLOW, NOT OVERLAP. Drop a tile on top of another and the other moves down,
 * then everything settles upward into the gaps. Allowing overlap would let one
 * card hide another completely, and "where did my chart go" is a bad answer to
 * a dragged mouse.
 */

const DASH_COLS = 12;
const DASH_ROW_H = 28;
const DASH_GAP = 12;

/** The map's tile. A reserved id so it can never collide with a card's. */
const DASH_MAP_ID = '__map';

/** Smallest a tile may be dragged down to, in grid units. */
const DASH_MIN = { w: 2, h: 3 };
const DASH_MAP_MIN = { w: 3, h: 6 };

/** The map tile's geometry. Serialised with the board. */
let dashMapTile = { id: DASH_MAP_ID, x: 0, y: 0, w: 8, h: 14 };

/** Where `.map-wrap` sits when it is not on the canvas, so it can go back. */
let dashMapHome = null;

/** In-flight gesture state, or null. */
let dashDrag = null;

/** @returns {object[]} every tile on the canvas, map included */
function dashTiles() {
  return [dashMapTile].concat(dashCards.filter(c => {
    // A legend that has been moved onto the map is not a tile any more, and
    // leaving its box on the board would be a hole where a card used to be.
    // It stays while the board is being edited, so the way back is visible.
    if (c.type === 'legend' && c.onMap && !dashEditing) return false;
    return true;
  }));
}

/** @param {object} t @returns {object} the minimum size for that tile */
function dashMinOf(t) { return t.id === DASH_MAP_ID ? DASH_MAP_MIN : DASH_MIN; }

/** @param {object} a @param {object} b @returns {boolean} do they intersect? */
function dashHits(a, b) {
  return a !== b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Settle the layout: nothing overlaps, and everything floats up into free space.
 *
 * The tile you are holding is placed FIRST and keeps exactly the position it
 * was given — no push-down, no float-up. It has to be first so everything else
 * flows around it rather than shoving it, and it has to be exempt from both
 * adjustments or the board fights the pointer: pinning it first but still
 * applying gravity meant a card resized halfway down the page shot to row 0,
 * straight through the map, because at that moment nothing had been placed yet
 * for it to collide with. Everything else packs upward, which is what keeps
 * the board tidy without anyone having to align anything.
 *
 * @param {string} [anchorId] the tile the user is holding
 */
function dashSettle(anchorId) {
  const tiles = dashTiles();
  const order = tiles.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const anchor = anchorId ? tiles.find(t => t.id === anchorId) : null;
  if (anchor) { order.splice(order.indexOf(anchor), 1); order.unshift(anchor); }

  const placed = [];
  order.forEach(t => {
    t.x = Math.max(0, Math.min(DASH_COLS - t.w, t.x));
    t.y = Math.max(0, t.y);
    if (t !== anchor) {
      let y = t.y;
      const at = yy => ({ x: t.x, y: yy, w: t.w, h: t.h });
      while (placed.some(p => dashHits(at(y), p))) y++;
      while (y > 0 && !placed.some(p => dashHits(at(y - 1), p))) y--;
      t.y = y;
    }
    placed.push({ x: t.x, y: t.y, w: t.w, h: t.h });
  });
}

/** @returns {{colW:number, stepX:number, stepY:number}} the canvas metrics */
function dashMetrics() {
  const grid = document.getElementById('dashGrid');
  const width = grid ? grid.clientWidth : 1000;
  const colW = (width - DASH_GAP * (DASH_COLS - 1)) / DASH_COLS;
  return { colW, stepX: colW + DASH_GAP, stepY: DASH_ROW_H + DASH_GAP };
}

/** @param {object} t @param {object} m @returns {object} pixel geometry */
function dashPx(t, m) {
  return {
    left: t.x * m.stepX,
    top: t.y * m.stepY,
    width: t.w * m.colW + (t.w - 1) * DASH_GAP,
    height: t.h * DASH_ROW_H + (t.h - 1) * DASH_GAP,
  };
}

/**
 * Write every tile's geometry onto its element.
 *
 * @param {string} [skipId] a tile currently following the pointer in free pixels
 */
function dashLayoutApply(skipId) {
  const grid = document.getElementById('dashGrid');
  if (!grid) return;
  const m = dashMetrics();

  dashTiles().forEach(t => {
    const el = t.id === DASH_MAP_ID
      ? document.getElementById('mapWrap')
      : grid.querySelector('.dash-card[data-card="' + t.id + '"]');
    if (!el || t.id === skipId) return;
    const p = dashPx(t, m);
    el.style.left = p.left.toFixed(1) + 'px';
    el.style.top = p.top.toFixed(1) + 'px';
    el.style.width = p.width.toFixed(1) + 'px';
    el.style.height = p.height.toFixed(1) + 'px';
  });

  // Two spare rows past the last tile, so there is always somewhere to drag to.
  const bottom = dashTiles().reduce((n, t) => Math.max(n, t.y + t.h), 0);
  let height = (bottom + 2) * m.stepY - DASH_GAP;

  // Then room for the gallery, which is absolutely positioned at the bottom of
  // the board. Its height is not a constant: it wraps, so it depends on how
  // many kinds there are and how wide the board is. Two spare rows was a guess
  // that held until the gallery reached three rows, at which point it grew
  // upward over the cards instead of down into empty space.
  //
  // Measured rather than estimated. The gallery's height depends on the board's
  // width and not on its height, so reading it here cannot chase its own tail.
  const add = document.getElementById('dashAdd');
  if (add && add.offsetParent) height += add.offsetHeight + DASH_GAP;

  grid.style.height = height.toFixed(1) + 'px';

  dashMapResized();
}

/**
 * Tell Leaflet its box changed.
 *
 * Leaflet's default is to pan by half the size change so the centre of the map
 * stays the centre of the map, and that is what you want when a tile grows:
 * without it the top-left corner is pinned instead and whatever you were
 * looking at slides off toward the bottom-right as the panel gets bigger.
 */
function dashMapResized() {
  try { map.invalidateSize({ animate: false }); } catch (e) { /* not up yet */ }
}

/** Put `.map-wrap` on the canvas (dashboard) or back in the shell (everything else). */
function dashMapToCanvas(on) {
  const wrap = document.getElementById('mapWrap');
  const grid = document.getElementById('dashGrid');
  if (!wrap || !grid) return;

  if (on) {
    if (!dashMapHome) dashMapHome = { parent: wrap.parentNode, next: wrap.nextSibling };
    if (wrap.parentNode !== grid) grid.appendChild(wrap);
  } else if (dashMapHome && wrap.parentNode !== dashMapHome.parent) {
    dashMapHome.parent.insertBefore(wrap, dashMapHome.next);
    // Inline geometry from the canvas would override the shell's CSS.
    wrap.style.left = wrap.style.top = wrap.style.width = wrap.style.height = '';
  }
  wrap.dataset.card = DASH_MAP_ID;
}

/* ---------------------------------------------------------------------------
 * Move and resize
 * ------------------------------------------------------------------------ */

/** @param {object} t @returns {string} the eight handles plus the move affordance */
function dashHandlesHtml() {
  return ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
    .map(d => '<i class="dc-rz dc-rz-' + d + '" data-rz="' + d + '"></i>').join('');
}

/** The dashed outline showing where a dragged tile will land. */
function dashGhost(show, t, m) {
  let g = document.getElementById('dashGhost');
  const grid = document.getElementById('dashGrid');
  if (!show) { if (g) g.remove(); return; }
  if (!grid) return;
  if (!g) { g = document.createElement('div'); g.id = 'dashGhost'; grid.appendChild(g); }
  const p = dashPx(t, m);
  g.style.cssText = 'left:' + p.left + 'px;top:' + p.top + 'px;width:' + p.width
    + 'px;height:' + p.height + 'px';
}

/**
 * Start a move or a resize.
 *
 * @param {PointerEvent} e
 * @param {object} tile
 * @param {string|null} edge a resize direction, or null to move
 */
function dashGestureStart(e, tile, edge) {
  const grid = document.getElementById('dashGrid');
  if (!grid) return;
  const el = tile.id === DASH_MAP_ID
    ? document.getElementById('mapWrap')
    : grid.querySelector('.dash-card[data-card="' + tile.id + '"]');
  if (!el) return;

  e.preventDefault();
  const m = dashMetrics();
  dashDrag = {
    tile, el, edge, m,
    px: e.clientX, py: e.clientY,
    start: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
    rect: dashPx(tile, m),
    moved: false,
  };
  el.classList.add(edge ? 'resizing' : 'dragging');
  document.body.classList.add('dash-gesture');
  try { el.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
}

/** @param {PointerEvent} e */
function dashGestureMove(e) {
  if (!dashDrag) return;
  const d = dashDrag;
  const dx = e.clientX - d.px, dy = e.clientY - d.py;
  if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;   // a click, not a drag
  d.moved = true;

  const min = dashMinOf(d.tile);
  const snapX = v => Math.round(v / d.m.stepX);
  const snapY = v => Math.round(v / d.m.stepY);

  if (!d.edge) {
    /* ---- move: the tile follows the pointer, the ghost shows the slot ---- */
    d.el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    const nx = Math.max(0, Math.min(DASH_COLS - d.tile.w, d.start.x + snapX(dx)));
    const ny = Math.max(0, d.start.y + snapY(dy));
    if (nx !== d.tile.x || ny !== d.tile.y) {
      d.tile.x = nx; d.tile.y = ny;
      dashSettle(d.tile.id);
      dashLayoutApply(d.tile.id);
    }
    dashGhost(true, d.tile, d.m);
    return;
  }

  /* ---- resize: snapped live, because a box that only settles on release
         makes you guess what you are going to get ---- */
  const s = d.start;
  let x = s.x, y = s.y, w = s.w, h = s.h;
  if (d.edge.indexOf('e') >= 0) w = Math.max(min.w, Math.min(DASH_COLS - s.x, s.w + snapX(dx)));
  if (d.edge.indexOf('s') >= 0) h = Math.max(min.h, s.h + snapY(dy));
  if (d.edge.indexOf('w') >= 0) {
    const nx = Math.max(0, Math.min(s.x + s.w - min.w, s.x + snapX(dx)));
    w = s.w + (s.x - nx); x = nx;
  }
  if (d.edge.indexOf('n') >= 0) {
    const ny = Math.max(0, Math.min(s.y + s.h - min.h, s.y + snapY(dy)));
    h = s.h + (s.y - ny); y = ny;
  }

  if (x !== d.tile.x || y !== d.tile.y || w !== d.tile.w || h !== d.tile.h) {
    Object.assign(d.tile, { x, y, w, h });
    dashSettle(d.tile.id);
    dashLayoutApply();
    // The chart inside a card being resized has to be redrawn at the new size:
    // it is measured pixels, not a stretched viewBox.
    if (d.tile.id !== DASH_MAP_ID && typeof dashDrawAllCharts === 'function') dashDrawAllCharts();
  }
}

/** @param {PointerEvent} e */
function dashGestureEnd() {
  if (!dashDrag) return;
  const d = dashDrag;
  d.el.style.transform = '';
  d.el.classList.remove('dragging', 'resizing');
  document.body.classList.remove('dash-gesture');
  dashGhost(false);
  dashDrag = null;

  dashSettle(d.tile.id);
  dashLayoutApply();
  if (typeof dashDrawAllCharts === 'function') dashDrawAllCharts();
  if (d.moved && typeof pushHistory === 'function') pushHistory();
}

(function wireDashLayout() {
  const app = document.getElementById('app');
  if (!app) return;

  app.addEventListener('pointerdown', e => {
    if (!dashEditing || (typeof appMode === 'function' && appMode() !== 'dashboard')) return;
    const el = e.target.closest && e.target.closest('.dash-card, #mapWrap');
    if (!el || !el.dataset.card) return;
    if (!el.closest('#dashGrid')) return;

    const tile = el.dataset.card === DASH_MAP_ID
      ? dashMapTile
      : (typeof dashCardById === 'function' ? dashCardById(el.dataset.card) : null);
    if (!tile) return;

    const rz = e.target.closest('[data-rz]');
    if (rz) { dashGestureStart(e, tile, rz.dataset.rz); return; }

    // The map is only draggable by its grip: everywhere else on it is the map,
    // and a dashboard that panned the map when you meant to move the tile (or
    // moved the tile when you meant to pan) would be unusable either way.
    if (tile.id === DASH_MAP_ID) {
      if (e.target.closest('.dc-maphead')) dashGestureStart(e, tile, null);
      return;
    }

    // A card is draggable anywhere that is not something you interact with.
    // Restricting it to the title bar sounded tidier and was nearly unusable:
    // the bar is mostly the title, the title is contenteditable, so the actual
    // grabbable area was a 13px dot.
    //
    // THE TABLE'S SHEET FRAME IS SOMETHING YOU INTERACT WITH. Column tabs, row
    // numbers, the corner box, the width and height grips and the cells
    // themselves are all gestures of their own — and none of them is a button
    // or a contenteditable, so without this the whole frame read as "empty card
    // surface" and dragging a column edge picked the CARD up and moved it
    // across the board instead of resizing the column.
    if (e.target.closest('button, [contenteditable="true"], input, select, textarea, a, .dc-plot,'
      + ' .dc-cell, .dc-coltab, .dc-rowno, .dc-corner, [data-wcol], [data-hrow]')) return;
    dashGestureStart(e, tile, null);
  });

  window.addEventListener('pointermove', dashGestureMove);
  window.addEventListener('pointerup', dashGestureEnd);
  window.addEventListener('pointercancel', dashGestureEnd);

  // Column width is a fraction of the canvas, so every tile moves when the
  // window does.
  let t = null;
  window.addEventListener('resize', () => {
    if (typeof appMode === 'function' && appMode() !== 'dashboard') return;
    clearTimeout(t);
    t = setTimeout(() => {
      dashLayoutApply();
      if (typeof dashDrawAllCharts === 'function') dashDrawAllCharts();
    }, 120);
  });
})();
