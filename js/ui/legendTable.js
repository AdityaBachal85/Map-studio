/**
 * ui/legendTable.js — the Key Distances card, made editable.
 *
 * The card was a pure read-out of the routes: one row per route, its colour as
 * a dot, its computed distance and drive time, and no way to touch any of it.
 * That is right until the moment it meets a client, and then it is wrong in
 * three ordinary ways.
 *
 * The name is whatever the two locations are called. Routing says 8.6 km when
 * the brochure says 8.5, or gives a drive time from the wrong hour of the day.
 * And a coloured dot is not what a property sheet uses — it uses the mark of
 * the thing: a train for the station, a plane for the airport, a school for the
 * school. Every one of those is a five-second edit that nobody could make.
 *
 * DERIVED IS STILL THE DEFAULT. Nothing here replaces the computed table; it
 * layers over it. A row shows its route's real distance until somebody types
 * a different one, and clearing the cell drops back to the computed value
 * rather than leaving a blank — so the table stays live where it has not been
 * touched, and edits survive the route being recomputed underneath them.
 *
 * TWO STORES, DELIBERATELY. `legendEdits` is keyed by route id and holds only
 * what differs; `legendExtras` holds rows that have no route at all — an
 * airport an hour away that nobody is going to draw a line to. Keeping them
 * apart is what lets an override find its route again after a reload, and what
 * stops a hand-written row disappearing when a route is deleted.
 */

/** routeId -> { name?, km?, min?, color?, iconKey?, iconImage?, hidden? } */
let legendEdits = {};

/** Rows with no route behind them. */
let legendExtras = [];

/**
 * Display order, as row keys ('r:12', 'x:3').
 *
 * Sparse on purpose: it holds only what has been moved. A row nobody has
 * touched is not in here at all and falls in at its natural position — routes
 * in the order they were drawn, then hand-added rows. That is what stops a new
 * route from vanishing off the bottom of a table whose order was fixed months
 * ago, and what lets a saved order survive rows being added and deleted around
 * it without needing to be rewritten each time.
 */
let legendOrder = [];

/**
 * Whether the Time column is drawn.
 *
 * On by default, because that is what the card has always shown. Off gives the
 * two-column shape a printed property sheet uses — one mark, one name, one
 * figure — where the figure is whatever suits the row: "3-5 km" for one,
 * "18-20 min" for another, "Adjacent" for the thing across the road. With free
 * text in the cells, one column carries all three; two columns force every row
 * to answer both questions whether or not it has both answers.
 */
let legendShowTime = true;

/** Whether the card is in edit mode. Not persisted — it is a mode, not data. */
let legendEditing = false;

/** Ids for hand-added rows, unique within a session. */
let legendExtraSeq = 1;

/**
 * True while the table's DOM is being replaced.
 *
 * Clearing the tbody blurs whatever cell has the caret, which fires the commit
 * handler — *after* the rebuild has already read the store. So a value changed
 * programmatically just before a rebuild was written, rebuilt, and then quietly
 * overwritten again by the old text from the element being destroyed. The cell
 * is committed up front instead, and the blur that teardown causes is ignored.
 */
let legendRebuilding = false;

/** @param {object} rt @returns {object} the edit record for a route, created on demand */
function legendEditFor(rt) {
  if (!legendEdits[rt.id]) legendEdits[rt.id] = {};
  return legendEdits[rt.id];
}

/**
 * What a route's row says before anyone edits it.
 * @param {object} rt @returns {object|null}
 */
function legendDerivedRow(rt) {
  const A = locById(rt.fromId), B = locById(rt.toId);
  if (!A || !B || !rt.alts) return null;
  const alt = rt.alts[rt.altIndex];
  if (!alt) return null;
  return {
    color: rt.color,
    name: rt.labelText && rt.labelText.trim() ? rt.labelText
      : (A.type === 'site' ? B.name : A.name + ' → ' + B.name),
    km: (alt.d / 1000).toFixed(1) + ' km',
    min: alt.t ? Math.round(alt.t / 60) + ' min' : '—',
  };
}

/**
 * The rows the card should draw, derived values overlaid with edits.
 *
 * An empty string in an edit is not an override — it is the absence of one.
 * That is what makes "clear the cell to go back to the real number" work, and
 * it is why the check is against '' rather than null: a contenteditable cell
 * that has been emptied reports '', not undefined.
 *
 * @returns {Array<object>}
 */
function legendRows() {
  const out = [];

  routes.forEach(rt => {
    const base = legendDerivedRow(rt);
    if (!base) return;
    const e = legendEdits[rt.id] || {};
    if (e.hidden) return;
    out.push({
      key: 'r:' + rt.id,
      routeId: rt.id,
      // The route's own colour until the row is given one. Overriding here does
      // not touch the route: a legend can want a green train and a blue plane
      // while the lines on the map stay in whatever colours read best over the
      // imagery, and tying the two together would make each unusable for the
      // other's sake.
      color: e.color || base.color,
      name: e.name != null && e.name !== '' ? e.name : base.name,
      km: e.km != null && e.km !== '' ? e.km : base.km,
      min: e.min != null && e.min !== '' ? e.min : base.min,
      iconKey: e.iconKey || null,
      iconImage: e.iconImage || null,
      edited: !!(e.name || e.km || e.min || e.color || e.iconKey || e.iconImage),
    });
  });

  legendExtras.forEach(x => {
    out.push({
      key: 'x:' + x.id, extraId: x.id,
      color: x.color || '#0A1E3C',
      name: x.name || '', km: x.km || '', min: x.min || '',
      iconKey: x.iconKey || null, iconImage: x.iconImage || null,
      extra: true,
    });
  });

  return legendSorted(out);
}

/**
 * Apply the saved order.
 *
 * Rows named in legendOrder come first, in that order; everything else keeps
 * its natural position after them. Sorting by "position in legendOrder, or
 * Infinity" with a stable sort does both in one pass — and the tie-break on
 * the original index is what keeps two unordered rows in the order they were
 * created rather than at the mercy of the engine's sort.
 *
 * @param {Array<object>} rows @returns {Array<object>}
 */
function legendSorted(rows) {
  if (!legendOrder.length) return rows;
  const rank = k => {
    const i = legendOrder.indexOf(k);
    return i === -1 ? Infinity : i;
  };
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (rank(a.r.key) - rank(b.r.key)) || (a.i - b.i))
    .map(x => x.r);
}

/**
 * Move one row up or down by one place.
 *
 * The whole current display order is written back, not just the pair that
 * swapped: legendOrder is otherwise sparse, and moving a row that is not in it
 * yet past one that is would otherwise produce an order that means nothing.
 *
 * @param {string} key @param {number} dir -1 up, +1 down
 */
function legendMoveRow(key, dir) {
  const keys = legendRows().map(r => r.key);
  const i = keys.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= keys.length) return;
  keys.splice(j, 0, keys.splice(i, 1)[0]);
  legendOrder = keys;
  rebuildLegend();
}

/**
 * The cell at the left of a row: an uploaded logo, a library glyph, or the
 * plain colour dot the card has always used.
 * @param {object} r @returns {string} HTML
 */
function legendMarkHtml(r) {
  if (r.iconImage) {
    return '<img class="legend-logo" src="' + esc(r.iconImage) + '" alt="">';
  }
  if (r.iconKey && typeof iconPaths === 'function') {
    return '<svg class="legend-glyph" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">'
      + iconPaths(r.iconKey, r.color) + '</svg>';
  }
  return '<span class="swatch" style="background:' + esc(r.color) + '"></span>';
}

/** Redraw the card from the current routes and edits. */
function rebuildLegend() {
  const body = $('legendBody');
  if (!body) return;

  // Whatever is being typed is committed before the element holding it is
  // destroyed — otherwise a rebuild triggered mid-edit (a route recomputing,
  // say) would throw the half-typed value away.
  const active = document.activeElement;
  if (active && active.isContentEditable && body.contains(active)) legendCommitCell(active);

  legendRebuilding = true;
  body.innerHTML = '';

  const rows = legendRows();
  rows.forEach((r, i) => {
    r.first = i === 0;
    r.last = i === rows.length - 1;
    const tr = document.createElement('tr');
    tr.dataset.key = r.key;
    // contenteditable is applied per cell rather than to the row: the mark cell
    // holds an <img> or an <svg>, and making that editable lets a stray
    // keystroke delete the picture.
    const ed = legendEditing ? ' contenteditable="true" spellcheck="false"' : '';
    tr.innerHTML =
      '<td class="legend-mark"' + (legendEditing ? ' title="Click to choose a logo or icon"' : '') + '>'
        + legendMarkHtml(r) + '</td>'
      + '<td class="legend-name"' + ed + '>' + esc(r.name) + '</td>'
      + '<td class="num legend-km"' + ed + '>' + esc(r.km) + '</td>'
      + (legendShowTime ? '<td class="num legend-min"' + ed + '>' + esc(r.min) + '</td>' : '')
      + (legendEditing
        ? '<td class="legend-actions">'
          // Disabled for an uploaded logo, which carries its own colours — a
          // live control that changes nothing is worse than a greyed-out one.
          + '<input type="color" class="legend-color" value="' + esc(r.color) + '"'
            + (r.iconImage ? ' disabled title="An uploaded logo keeps its own colours"' : ' title="Icon colour for this row"')
            + ' aria-label="Icon colour for this row">'
          + '<button class="legend-x legend-up" title="Move up"' + (r.first ? ' disabled' : '') + '>\u2191</button>'
          + '<button class="legend-x legend-down" title="Move down"' + (r.last ? ' disabled' : '') + '>\u2193</button>'
          + (r.edited ? '<button class="legend-x legend-reset" title="Back to the measured values">↺</button>' : '')
          + '<button class="legend-x legend-hide" title="' + (r.extra ? 'Delete this row' : 'Hide this row') + '">&times;</button>'
          + '</td>'
        : '');
    body.appendChild(tr);
  });
  legendRebuilding = false;

  // The colour key is driven by the same events: anything that changes what is
  // on the map changes what the key should say. Hooking it here rather than at
  // every call site means a new feature cannot forget to update it.
  if (typeof rebuildColorKey === 'function') rebuildColorKey();

  const card = $('legendCard');
  const tgl = $('legendTgl');
  // In edit mode the card stays up even with nothing in it — otherwise adding
  // the first row to an empty table means clicking a button on a card that is
  // not on screen.
  card.style.display = ((!tgl || tgl.checked) && (rows.length || legendEditing)) ? '' : 'none';
  card.classList.toggle('editing', legendEditing);

  const foot = $('legendFoot');
  if (foot) foot.style.display = legendEditing ? '' : 'none';
  const timeTgl = $('legendTimeTgl');
  if (timeTgl) timeTgl.checked = legendShowTime;
  const editBtn = $('legendEditBtn');
  if (editBtn) {
    editBtn.classList.toggle('on', legendEditing);
    editBtn.setAttribute('aria-pressed', String(legendEditing));
    editBtn.title = legendEditing ? 'Done editing' : 'Edit the rows, icons and values';
  }

  // The board and the sheet both show these same rows, and this is the one
  // place that knows they changed. Only the live panels are redrawn — never the
  // whole board or sheet, which would discard anything being typed elsewhere on
  // them at the moment a route finished measuring.
  if (typeof dashRefreshLive === 'function' && typeof appMode === 'function' && appMode() === 'dashboard') {
    dashRefreshLive();
  }
  if (typeof rsRefreshDistances === 'function' && typeof appMode === 'function' && appMode() === 'report') {
    rsRefreshDistances();
  }
}

/**
 * Write one edited cell into its row's record.
 * @param {HTMLElement} cell a contenteditable td
 */
function legendCommitCell(cell) {
  const st = legendRowStore(cell);
  if (!st) return;
  const field = cell.classList.contains('legend-name') ? 'name'
    : cell.classList.contains('legend-km') ? 'km'
    : cell.classList.contains('legend-min') ? 'min' : null;
  if (field) st[field] = cell.textContent.trim();
}

/** @param {HTMLElement} el @returns {object|null} the row record a cell belongs to */
function legendRowStore(el) {
  const tr = el.closest('tr');
  if (!tr) return null;
  const key = tr.dataset.key || '';
  if (key.startsWith('r:')) {
    const rt = routes.find(r => String(r.id) === key.slice(2));
    return rt ? legendEditFor(rt) : null;
  }
  return legendExtras.find(x => 'x:' + x.id === key) || null;
}

/** Turn edit mode on or off. @param {boolean} on */
function setLegendEditing(on) {
  legendEditing = !!on;
  rebuildLegend();
  status(legendEditing
    ? 'Key distances: click a value to retype it, click a dot to pick a logo. Empty a cell to go back to the measured number.'
    : 'Key distances saved.');
}

/** Add a blank row with no route behind it. */
function legendAddExtraRow() {
  legendExtras.push({
    id: legendExtraSeq++,
    name: 'New row', km: '', min: '',
    color: '#0A1E3C', iconKey: null, iconImage: null,
  });
  if (!legendEditing) legendEditing = true;
  rebuildLegend();

  // Straight into the name, the same reasoning as a new text label: a row that
  // says "New row" is never what anyone wanted.
  const last = $('legendBody').lastElementChild;
  const cell = last && last.querySelector('.legend-name');
  if (cell) {
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/** Reset everything to the measured table. */
function legendResetAll() {
  legendEdits = {};
  legendExtras = [];
  legendOrder = [];
  rebuildLegend();
  status('Key distances back to the measured values.');
}

(function wireLegendTable() {
  const body = $('legendBody');
  if (!body) return;

  // One delegated listener for the whole table: rows are rebuilt on every
  // route change, and per-row listeners would be re-attached each time and
  // leak the old ones.
  body.addEventListener('click', e => {
    if (!legendEditing) return;

    const up = e.target.closest('.legend-up');
    const down = e.target.closest('.legend-down');
    if (up || down) {
      const tr = (up || down).closest('tr');
      legendMoveRow(tr.dataset.key, up ? -1 : 1);
      return;
    }

    const hide = e.target.closest('.legend-hide');
    if (hide) {
      const tr = hide.closest('tr');
      const key = tr.dataset.key || '';
      if (key.startsWith('x:')) legendExtras = legendExtras.filter(x => 'x:' + x.id !== key);
      else { const st = legendRowStore(hide); if (st) st.hidden = true; }
      rebuildLegend();
      return;
    }

    const reset = e.target.closest('.legend-reset');
    if (reset) {
      const tr = reset.closest('tr');
      const key = tr.dataset.key || '';
      if (key.startsWith('r:')) delete legendEdits[key.slice(2)];
      rebuildLegend();
      return;
    }

    const mark = e.target.closest('.legend-mark');
    if (mark && typeof openIconPicker === 'function') {
      const st = legendRowStore(mark);
      if (!st) return;
      const tr = mark.closest('tr');
      const row = legendRows().find(r => r.key === tr.dataset.key);
      // The picker wants something location-shaped; it only reads these two.
      openIconPicker({ color: (row && row.color) || '#0A1E3C', iconKey: st.iconKey }, key => {
        st.iconKey = key;
        st.iconImage = null;      // a chosen glyph replaces an uploaded logo
        rebuildLegend();
      });
    }
  });

  // 'input' so the swatch previews live while the OS colour picker is open;
  // one committed colour per pick is what the history watcher records, since it
  // only commits once the value stops changing.
  body.addEventListener('input', e => {
    const inp = e.target.closest && e.target.closest('.legend-color');
    if (!inp || !legendEditing) return;
    const st = legendRowStore(inp);
    if (!st) return;
    st.color = inp.value;
    rebuildLegend();
  });

  // 'blur', not 'input': a contenteditable fires on every keystroke, and
  // rebuilding the table under a caret that is still in it moves the caret to
  // the start of the cell after the first letter.
  body.addEventListener('blur', e => {
    if (legendRebuilding) return;          // our own teardown, not the user leaving
    const cell = e.target.closest && e.target.closest('[contenteditable]');
    if (!cell || !legendEditing) return;
    legendCommitCell(cell);
    rebuildLegend();
  }, true);

  // Enter commits rather than inserting a line break — this is a table cell,
  // not a paragraph, and a second line breaks the row's alignment.
  body.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.closest && e.target.closest('[contenteditable]')) {
      e.preventDefault();
      e.target.blur();
    }
  });

  const editBtn = $('legendEditBtn');
  if (editBtn) editBtn.addEventListener('click', () => setLegendEditing(!legendEditing));
  const addBtn = $('legendAddRow');
  if (addBtn) addBtn.addEventListener('click', legendAddExtraRow);
  const resetBtn = $('legendResetAll');
  if (resetBtn) resetBtn.addEventListener('click', legendResetAll);
  const timeTgl = $('legendTimeTgl');
  if (timeTgl) timeTgl.addEventListener('change', e => { legendShowTime = e.target.checked; rebuildLegend(); });

  // A logo dropped onto a row becomes that row's mark. Images are stored as
  // data URLs so they travel in the project file — an object URL would be dead
  // the moment the tab was reloaded.
  body.addEventListener('dragover', e => { if (legendEditing) e.preventDefault(); });
  body.addEventListener('drop', e => {
    if (!legendEditing) return;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f || !/^image\//.test(f.type)) return;
    e.preventDefault();
    const st = legendRowStore(e.target);
    if (!st) return;
    const rd = new FileReader();
    rd.onload = () => { st.iconImage = String(rd.result); st.iconKey = null; rebuildLegend(); };
    rd.readAsDataURL(f);
  });
})();
