/**
 * ui/geomGroups.js — restyle every shape of one colour at once.
 *
 * A plan with forty polygons on it is not forty decisions. It is usually three
 * or four: the acquired plots are one colour, the proposed ones another, the
 * village boundaries a third. But the shape cards only ever offered the first
 * of those — one card, one shape — so changing the border weight on "the
 * orange ones" meant scrolling a list of forty cards, finding the orange ones
 * by eye, and repeating the same three clicks on each. Long enough that people
 * stop tidying up, which is how a deliverable ends up with three different
 * border weights on shapes that mean the same thing.
 *
 * So: group the shapes by the colour you can actually see, show one swatch per
 * group, and edit the whole group through one set of controls.
 *
 * WHICH COLOUR DEFINES A GROUP. The one on screen, not the one in the record.
 * A polygon is known by its fill; a line has a fill in the data model that is
 * never drawn, so grouping lines by it would sort them by an invisible
 * property — two lines that look identical landing in different groups, for a
 * reason nothing on screen could explain. Lines therefore group by their
 * stroke. Change whichever colour defines a group and its shapes move to the
 * group they now belong to, which is the only behaviour that keeps the swatches
 * honest.
 *
 * ONE UNDO, NOT FORTY. A group edit pushes a single `batch` entry, so Undo
 * takes back "made the orange ones heavier" rather than making you press it
 * once per shape and watch the map change forty times.
 */

/** The currently selected group's colour key, or null. */
let geomGroupSelected = null;

/** Border width to restore when the Border toggle is switched back on. */
let geomGroupLastWidth = 3;

/**
 * The colour a shape reads as on the map.
 * @param {object} g @returns {string}
 */
function geomVisibleColor(g) {
  const c = (g.shape === 'Line' || g.shape === 'Label') ? g.borderColor : g.fillColor;
  return String(c || '#FF7A1A').toLowerCase();
}

/**
 * Shapes bucketed by visible colour, biggest group first.
 *
 * Sorted by size rather than by hue or by creation order because the useful
 * question is "what are the big sets here" — and a stable order matters less
 * than the largest group being the one under the pointer.
 *
 * @returns {Array<{key:string, count:number, ids:number[], borders:string[]}>}
 */
function geomColorGroups() {
  const by = new Map();
  geometries.forEach(g => {
    const key = geomVisibleColor(g);
    if (!by.has(key)) by.set(key, { key, count: 0, ids: [], borders: [] });
    const grp = by.get(key);
    grp.count++;
    grp.ids.push(g.id);
    const b = String(g.borderColor || '').toLowerCase();
    if (grp.borders.indexOf(b) === -1) grp.borders.push(b);
  });
  return Array.from(by.values()).sort((a, b) => b.count - a.count);
}

/** @param {string} key @returns {object[]} the geometries in that colour group */
function geomsInGroup(key) {
  return geometries.filter(g => geomVisibleColor(g) === key);
}

/**
 * Apply one change to every shape in a group, as a single undo step.
 *
 * @param {string} key the group's colour
 * @param {function(object):void} mutate called with each geometry
 * @param {string} what a short description for the status line
 */
function geomGroupApply(key, mutate, what) {
  const members = geomsInGroup(key);
  if (!members.length) return;

  const edits = members.map(g => {
    const before = snapshotGeom(g);
    mutate(g);
    applyGeomStyle(g);
    if (g.card) syncGeomCardStyleControls(g);
    touchGeom(g);
    return { id: g.id, before, after: snapshotGeom(g) };
  });

  pushUndo({ type: 'batch', edits });

  // The group may have moved: changing the colour that defines it is exactly
  // what the primary swatch does. Follow it, so the controls stay on the
  // shapes the user is looking at instead of jumping to some other group.
  const moved = geomVisibleColor(members[0]);
  geomGroupSelected = moved;
  renderGeomGroups();
  // Restyling a group is the fastest way to make the legend wrong, so it is
  // also the place that most needs to put it right. touchGeom() schedules this
  // too, but the deferred path is per-shape bookkeeping and this is the whole
  // group changing at once.
  if (typeof rebuildLegend === 'function') rebuildLegend();

  status(`${what} for ${members.length} shape${members.length === 1 ? '' : 's'}.`);
}

/**
 * Delete every shape in a colour group.
 *
 * The whole point of grouping by colour is that a colour means something —
 * "purple is industry, red is residential" — so "get rid of the red ones" is a
 * single intention, and doing it one card at a time is forty deletions of
 * something that was one decision. A ring scan makes this sharper still: it can
 * drop a hundred shapes in one go, and the only practical way back out is by
 * the property they share.
 *
 * NOT GUARDED BY A CONFIRMATION, deliberately, and the reasoning is already
 * written down in ui/notifications.js: a confirmation interrupts every delete
 * including the ones that were meant, and people learn to dismiss it without
 * reading. The whole group goes back with one Undo, and the status line offers
 * that Undo where the eye already is.
 *
 * @param {string} key
 */
function geomGroupDelete(key) {
  const members = geomsInGroup(key);
  if (!members.length) return;

  const name = geomColorLabel(key);
  const n = members.length;
  // Snapshot every member BEFORE removing any of them — removeGeomById drops
  // the layer, and a snapshot taken afterwards has no coordinates to store.
  const snaps = members.map(g => snapshotGeom(g));

  members.forEach(g => {
    if (map.hasLayer(g.layer)) map.removeLayer(g.layer);
    removeGeomById(g.id);
  });

  pushUndo({ type: 'deleteMany', snaps });

  geomGroupSelected = null;
  renderGeomGroups();
  if (typeof rebuildLegend === 'function') rebuildLegend();

  status(`${n} ${name.toLowerCase()} shape${n === 1 ? '' : 's'} deleted.`, false, {
    label: 'Undo',
    onClick: () => { if (typeof doUndo === 'function') doUndo(); },
  });
}

/**
 * Flash the group on the map.
 *
 * Selecting a swatch has to answer "which ones are those?" before any control
 * is touched, and on a busy map a list highlight does not carry — the shapes
 * are the thing being looked at. A brief pulse says which without changing
 * anything, so nothing has to be undone if the answer is "not those".
 *
 * @param {string} key
 */
function geomGroupFlash(key) {
  document.querySelectorAll('.geom-group-flash').forEach(el => el.classList.remove('geom-group-flash'));
  geomsInGroup(key).forEach(g => {
    const path = g.layer && g.layer._path;
    if (!path) return;
    // Restart the animation on a re-click: without the reflow the class is
    // already present and the browser will not replay it.
    path.classList.remove('geom-group-flash');
    void path.getBoundingClientRect();
    path.classList.add('geom-group-flash');
    setTimeout(() => path.classList.remove('geom-group-flash'), 1400);
  });
}

/** Dim the cards that are not in the selected group, so the list agrees with the map. */
function geomGroupMarkCards() {
  const inGroup = new Set(geomGroupSelected ? geomsInGroup(geomGroupSelected).map(g => g.id) : []);
  geometries.forEach(g => {
    if (!g.card) return;
    g.card.classList.toggle('off-group', !!geomGroupSelected && !inGroup.has(g.id));
  });
}

/** @param {object[]} members @returns {*} the value they all share, or null if they differ */
function geomGroupCommon(members, field) {
  if (!members.length) return null;
  const first = members[0][field];
  return members.every(g => g[field] === first) ? first : null;
}

/**
 * A readable name for an arbitrary colour.
 *
 * colorName() answers for the palette presets and hands back the raw hex for
 * anything else, which is fine in a tooltip and useless as a heading — "#9b8ce0
 * · 5 shapes" tells you nothing you could not see. Falling back to a hue name
 * keeps the group's heading in words.
 *
 * @param {string} hex @returns {string}
 */
function geomColorLabel(hex) {
  const named = (typeof colorName === 'function') ? colorName(hex) : hex;
  if (named && named.toLowerCase() !== String(hex).toLowerCase()) return named;

  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return String(hex || 'Colour');
  const r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.08) return max > 0.85 ? 'White' : max < 0.2 ? 'Black' : 'Grey';

  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;

  const names = [[15, 'Red'], [45, 'Orange'], [70, 'Yellow'], [160, 'Green'], [200, 'Teal'],
    [250, 'Blue'], [290, 'Violet'], [335, 'Pink'], [360, 'Red']];
  return (names.find(n => h < n[0]) || names[names.length - 1])[1];
}

/** A tick, as SVG rather than a glyph, so it inherits weight and colour cleanly. */
const GEOM_CHECK_SVG = '<svg class="geom-chip-check" viewBox="0 0 16 16" aria-hidden="true">'
  + '<path d="M3.2 8.4l3.1 3.1 6.5-7.2" fill="none" stroke="currentColor" stroke-width="2.4"'
  + ' stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Rebuild the swatch row and, if a group is selected, its editor. */
function renderGeomGroups() {
  const host = $('geomGroups');
  if (!host) return;

  const groups = geomColorGroups();
  // Below two groups there is nothing to choose between, and the controls would
  // be a second, worse copy of the shape card directly underneath.
  if (groups.length < 2) {
    host.innerHTML = '';
    host.style.display = 'none';
    geomGroupSelected = null;
    geomGroupMarkCards();
    return;
  }
  host.style.display = '';

  if (geomGroupSelected && !groups.some(g => g.key === geomGroupSelected)) geomGroupSelected = null;

  // WHY THE COUNT SITS ON THE PANEL AND NOT ON THE COLOUR. It used to be white
  // text printed straight onto the swatch, propped up with a heavy text-shadow.
  // On a mid-amber that is roughly 2:1 against its background — below the 4.5:1
  // a small bold label needs — and no threshold on luminance fixes it, because
  // for a band of mid-tones neither white nor black reaches 4.5:1 on the colour
  // itself. Splitting the chip solves it outright: the colour is a block, the
  // number is on the panel's own surface, and every hue reads the same.
  const swatches = groups.map(grp => {
    const on = grp.key === geomGroupSelected;
    const name = geomColorLabel(grp.key);
    const shapes = grp.count + ' shape' + (grp.count === 1 ? '' : 's');
    return `<button type="button" class="geom-chip${on ? ' on' : ''}" data-key="${esc(grp.key)}"
      aria-pressed="${on}" aria-label="${esc(name)}, ${shapes}"
      title="${esc(name)} — ${shapes}${grp.borders.length > 1 ? ', mixed border colours' : ''}"
      style="--sw:${esc(grp.key)}"
      ><span class="geom-chip-swatch"></span
      ><span class="geom-chip-tick">${GEOM_CHECK_SVG}</span
      ><span class="geom-chip-n">${grp.count}</span></button>`;
  }).join('');

  let editor = '';
  if (geomGroupSelected) {
    const members = geomsInGroup(geomGroupSelected);
    const width = geomGroupCommon(members, 'borderWidth');
    const op = geomGroupCommon(members, 'fillOpacity');
    const border = geomGroupCommon(members, 'borderColor');
    const ls = geomGroupCommon(members, 'lineStyle');
    const fp = geomGroupCommon(members, 'fillPattern');
    const hasBorder = width === null ? true : width > 0;
    // A group of lines has a fill in the data model that is never drawn, so
    // offering fill controls for it would be offering settings that do nothing.
    const fillable = members.some(g => g.shape !== 'Line' && g.shape !== 'Marker' && g.shape !== 'Label');
    const noFill = fillable ? '' : ' disabled';

    // A mixed value shows as "Mixed" rather than a made-up number. The old "–"
    // in a slider's readout looked like a broken control; this says the group
    // disagrees, and moving the slider is what makes them agree.
    const mixed = v => v == null;

    editor = `
      <div class="geom-group-edit" style="--sw:${esc(geomGroupSelected)}">
        <div class="gg-head">
          <span class="gg-head-dot"></span>
          <span class="gg-head-name">${esc(geomColorLabel(geomGroupSelected))}</span>
          <span class="gg-head-count">${members.length} shape${members.length === 1 ? '' : 's'}</span>
          <button type="button" class="mini-btn gg-zoom" title="Zoom the map to fit this group" aria-label="Zoom to fit this group">⌖</button>
          <button type="button" class="mini-btn gg-del" title="Delete all ${members.length} shape${members.length === 1 ? '' : 's'} in this group — one Undo brings them all back" aria-label="Delete all ${members.length} shapes in this group">&times;</button>
        </div>

        <div class="r">
          <span class="sub gg-lbl">Colour</span>
          <input type="color" class="gg-fill" value="${esc(geomGroupSelected)}" title="Colour for every shape in this group" aria-label="Colour for every shape in this group">
          <span class="sub gg-lbl gg-lbl-2">Border</span>
          <input type="color" class="gg-border" value="${esc(border || '#0A1E3C')}" title="Border colour for every shape in this group" aria-label="Border colour for every shape in this group">
          <span class="grow"></span>
        </div>

        <div class="r">
          <label class="chk gg-lbl"><input type="checkbox" class="gg-hasborder" ${hasBorder ? 'checked' : ''}> Border</label>
          <input type="range" class="gg-width" min="0" max="10" step="1" value="${width == null ? 3 : width}" style="flex:1;" title="Border width for every shape in this group" aria-label="Border width for every shape in this group">
          <span class="pct gg-width-v${mixed(width) ? ' is-mixed' : ''}">${mixed(width) ? 'Mixed' : width}</span>
        </div>

        <div class="r${fillable ? '' : ' is-off'}">
          <span class="sub gg-lbl">Fill</span>
          <select class="gg-pattern" title="Fill pattern for every shape in this group" aria-label="Fill pattern for every shape in this group"${noFill}>${optionList(FILL_PATTERN_OPTS, fp || 'none')}</select>
          <input type="range" class="gg-op" min="0" max="100" step="5" value="${op == null ? 25 : Math.round(op * 100)}" style="flex:1;" title="Fill opacity for every shape in this group" aria-label="Fill opacity for every shape in this group"${noFill}>
          <span class="pct gg-op-v${mixed(op) ? ' is-mixed' : ''}">${mixed(op) ? 'Mixed' : Math.round(op * 100) + '%'}</span>
        </div>

        <div class="r">
          <span class="sub gg-lbl">Line</span>
          <select class="gg-linestyle grow" title="Line style for every shape in this group" aria-label="Line style for every shape in this group">${optionList(LINE_STYLE_OPTS, ls || 'solid')}</select>
        </div>
      </div>`;
  }

  host.innerHTML = `
    <div class="lbl">Style by colour</div>
    <p class="gg-hint">Pick a colour to restyle every shape using it.</p>
    <div class="geom-chips" role="group" aria-label="Colour groups">${swatches}</div>
    ${editor}`;

  // The same swatch treatment the shape cards get, so the two sets of colour
  // controls do not look like they came from different applications. Before
  // wiring: the enhancer wraps each input, and the listeners must go on the
  // element that survives that.
  if (typeof enhanceColorInputs === 'function') enhanceColorInputs(host);
  wireGeomGroups(host);
  geomGroupMarkCards();
}

/** @param {HTMLElement} host */
function wireGeomGroups(host) {
  host.querySelectorAll('.geom-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      geomGroupSelected = (geomGroupSelected === key) ? null : key;
      renderGeomGroups();
      if (geomGroupSelected) geomGroupFlash(geomGroupSelected);
    });
  });

  const key = geomGroupSelected;
  if (!key) return;
  const q = sel => host.querySelector(sel);

  // 'change', not 'input', on the colour pickers: dragging through a colour
  // wheel fires continuously, and each event here restyles every shape in the
  // group and pushes an undo entry. One entry per chosen colour, not per pixel
  // of pointer travel.
  q('.gg-fill').addEventListener('change', e => {
    const v = e.target.value;
    geomGroupApply(key, g => {
      if (g.shape === 'Line') g.borderColor = v; else g.fillColor = v;
    }, 'Recoloured');
  });

  q('.gg-border').addEventListener('change', e => {
    const v = e.target.value;
    geomGroupApply(key, g => { g.borderColor = v; }, 'Set the border colour');
  });

  q('.gg-hasborder').addEventListener('change', e => {
    if (e.target.checked) {
      const w = geomGroupLastWidth || 3;
      geomGroupApply(key, g => { g.borderWidth = w; }, 'Turned the border on');
    } else {
      const cur = geomGroupCommon(geomsInGroup(key), 'borderWidth');
      if (cur) geomGroupLastWidth = cur;      // so switching back restores it
      geomGroupApply(key, g => { g.borderWidth = 0; }, 'Removed the border');
    }
  });

  const width = q('.gg-width');
  width.addEventListener('input', e => {
    const el = q('.gg-width-v');
    el.textContent = e.target.value;
    el.classList.remove('is-mixed');     // dragging is what resolves a mixed group
  });
  width.addEventListener('change', e => {
    const w = +e.target.value;
    if (w) geomGroupLastWidth = w;
    geomGroupApply(key, g => { g.borderWidth = w; }, 'Set the border width');
  });

  const op = q('.gg-op');
  op.addEventListener('input', e => {
    const el = q('.gg-op-v');
    el.textContent = e.target.value + '%';
    el.classList.remove('is-mixed');
  });
  op.addEventListener('change', e => {
    const v = (+e.target.value) / 100;
    geomGroupApply(key, g => { g.fillOpacity = v; }, 'Set the fill opacity');
  });

  q('.gg-pattern').addEventListener('change', e => {
    const v = e.target.value;
    geomGroupApply(key, g => {
      g.fillPattern = v;
      // Same reasoning as the single-shape card: a pattern is mostly gaps and
      // is invisible at the opacity a solid wash wants.
      if (isFillPattern(v)) g.fillOpacity = fillPatternOpacityFor(g.fillOpacity);
    }, 'Set the fill pattern');
  });

  q('.gg-linestyle').addEventListener('change', e => {
    const v = e.target.value;
    geomGroupApply(key, g => { g.lineStyle = v; }, 'Set the line style');
  });

  q('.gg-zoom').addEventListener('click', () => {
    const members = geomsInGroup(key);
    let bounds = null;
    members.forEach(g => {
      const b = g.layer.getBounds ? g.layer.getBounds()
        : (g.layer.getLatLng ? L.latLngBounds([g.layer.getLatLng()]) : null);
      if (!b) return;
      bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
    });
    if (bounds) map.fitBounds(bounds, { padding: [60, 60] });
    geomGroupFlash(key);
  });

  q('.gg-del').addEventListener('click', () => geomGroupDelete(key));
}
