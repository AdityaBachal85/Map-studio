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
  const c = (g.shape === 'Line') ? g.borderColor : g.fillColor;
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

  status(`${what} for ${members.length} shape${members.length === 1 ? '' : 's'}.`);
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

  const swatches = groups.map(grp => {
    const on = grp.key === geomGroupSelected;
    // The ring shows the border colour when the group agrees on one, so a set
    // that is already consistent looks different from one that is not.
    const ring = grp.borders.length === 1 ? grp.borders[0] : 'transparent';
    return `<button class="geom-swatch${on ? ' on' : ''}" data-key="${esc(grp.key)}"
      title="${grp.count} shape${grp.count === 1 ? '' : 's'} in ${esc(grp.key)}${grp.borders.length > 1 ? ' — mixed border colours' : ''}"
      style="--sw:${esc(grp.key)};--sw-ring:${esc(ring)}"><span>${grp.count}</span></button>`;
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
    const fillable = members.some(g => g.shape !== 'Line' && g.shape !== 'Marker');
    const noFill = fillable ? '' : ' disabled';

    editor = `
      <div class="geom-group-edit">
        <div class="r">
          <span class="sub" style="width:52px;">All ${members.length}</span>
          <input type="color" class="gg-fill" value="${esc(geomGroupSelected)}" title="Colour for every shape in this group">
          <input type="color" class="gg-border" value="${esc(border || '#0A1E3C')}" title="Border colour for every shape in this group">
          <span class="grow"></span>
          <button class="mini-btn gg-zoom" title="Zoom to fit this group">⌖</button>
        </div>
        <div class="r">
          <label class="chk"><input type="checkbox" class="gg-hasborder" ${hasBorder ? 'checked' : ''}> Border</label>
          <input type="range" class="gg-width" min="0" max="10" step="1" value="${width == null ? 3 : width}" style="flex:1;" title="Border width for every shape in this group">
          <span class="pct gg-width-v" style="width:22px;">${width == null ? '–' : width}</span>
        </div>
        <div class="r"${fillable ? '' : ' style="opacity:.5"'}>
          <span class="sub" style="width:52px;">Fill</span>
          <select class="gg-pattern" style="flex:0 0 94px;" title="Fill pattern for every shape in this group"${noFill}>${optionList(FILL_PATTERN_OPTS, fp || 'none')}</select>
          <input type="range" class="gg-op" min="0" max="100" step="5" value="${op == null ? 25 : Math.round(op * 100)}" style="flex:1;" title="Fill opacity for every shape in this group"${noFill}>
          <span class="pct gg-op-v" style="width:32px;">${op == null ? '–' : Math.round(op * 100) + '%'}</span>
        </div>
        <div class="r">
          <span class="sub" style="width:52px;">Line</span>
          <select class="gg-linestyle grow" title="Line style for every shape in this group">${optionList(LINE_STYLE_OPTS, ls || 'solid')}</select>
        </div>
      </div>`;
  }

  host.innerHTML = `
    <div class="lbl">Style by colour
      <span class="sub" style="font-weight:400;text-transform:none;letter-spacing:0;">
        — pick a colour to edit every shape that uses it</span>
    </div>
    <div class="geom-swatches">${swatches}</div>
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
  host.querySelectorAll('.geom-swatch').forEach(btn => {
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
  width.addEventListener('input', e => { q('.gg-width-v').textContent = e.target.value; });
  width.addEventListener('change', e => {
    const w = +e.target.value;
    if (w) geomGroupLastWidth = w;
    geomGroupApply(key, g => { g.borderWidth = w; }, 'Set the border width');
  });

  const op = q('.gg-op');
  op.addEventListener('input', e => { q('.gg-op-v').textContent = e.target.value + '%'; });
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
}
