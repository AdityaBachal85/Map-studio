/**
 * ui/locGroups.js — restyle every location of one colour at once.
 *
 * The same argument as ui/geomGroups.js makes for shapes, and it bites harder
 * here. A connectivity map carries a dozen or more locations, and they are
 * never a dozen decisions: the colleges are one colour, the stations another,
 * the employment hubs a third. Colour is how the reader is told which is which,
 * so colour is also the unit somebody wants to edit — "give all the purple ones
 * the college symbol and a smaller caption" is one intention, and doing it card
 * by card is a dozen repeats of the same three clicks.
 *
 * WHY A SECOND MODULE AND NOT A SHARED ONE. Locations and shapes look alike on
 * screen and are nothing alike underneath. A shape carries `fillColor`,
 * `borderColor` and `borderWidth`, and its marker is a Leaflet divIcon rebuilt
 * by applyGeomStyle(). A location carries `color`, `iconKey` and a whole family
 * of `icon*` fields, is drawn by the billboard overlay, and is repainted by
 * renderLocPin(). The overlap is the *idea* — group by the colour you can see,
 * edit the group as one, one undo — not the code. Merging them would mean a
 * module full of "if this is a location" branches, which is how both halves end
 * up subtly wrong.
 *
 * WHAT IT DELIBERATELY DOES NOT OFFER. Names, coordinates and rings. Those are
 * per-location facts rather than styling, and a bulk control that overwrote a
 * dozen names with one would be a way to lose work rather than to save time.
 * propertyPanel.js's "Apply this style to all locations" stays as it is: it
 * pushes one card's frame and finish onto *every* location regardless of
 * colour, which is the blunt instrument this is the precise version of.
 */

/** The currently selected group's colour key, or null. */
let locGroupSelected = null;

/**
 * The colour a location reads as on the map.
 *
 * `color` and not `iconBg`: the body of a teardrop takes the colour, and the
 * background only applies to a framed icon. Grouping by a property that is
 * invisible on most pins would put two identical-looking markers in different
 * groups for a reason nothing on screen could explain.
 *
 * @param {object} l @returns {string}
 */
function locVisibleColor(l) {
  return String(l.color || '#FF7A1A').toLowerCase();
}

/** Every location that is really a location — route anchors are plumbing. */
function locGroupPool() {
  return (typeof realLocations === 'function') ? realLocations() : (locations || []);
}

/**
 * Locations bucketed by visible colour, biggest group first.
 * @returns {Array<{key:string, count:number}>}
 */
function locColorGroups() {
  const by = new Map();
  locGroupPool().forEach(l => {
    const key = locVisibleColor(l);
    if (!by.has(key)) by.set(key, { key, count: 0 });
    by.get(key).count++;
  });
  return Array.from(by.values()).sort((a, b) => b.count - a.count);
}

/** @param {string} key @returns {object[]} */
function locsInGroup(key) {
  return locGroupPool().filter(l => locVisibleColor(l) === key);
}

/** @param {object[]} members @param {string} field @returns {*} shared value, or null */
function locGroupCommon(members, field) {
  if (!members.length) return null;
  const first = members[0][field];
  return members.every(l => l[field] === first) ? first : null;
}

/**
 * Apply one change to every location in a group, as a single undo step.
 *
 * pushHistory() once at the end, not per location: somebody pressed one
 * control, so Undo should take back one thing. This is the same reasoning
 * geomGroups.js writes down for its `batch` entry — locations ride the
 * whole-map history in project/history.js rather than the geometry-specific
 * stack, so here it is simply a matter of when the snapshot is taken.
 *
 * @param {string} key @param {function(object):void} mutate @param {string} what
 */
function locGroupApply(key, mutate, what) {
  const members = locsInGroup(key);
  if (!members.length) return;

  members.forEach(l => {
    mutate(l);
    // Rebuild the pin, then re-sync its card — without the second half the
    // panel keeps the old numbers and the next drag of a slider snaps back to
    // them. applyIconStyleToAll() learned this the same way.
    if (typeof renderLocPin === 'function') renderLocPin(l);
    if (typeof syncLocCardStyle === 'function') syncLocCardStyle(l);
  });

  // Changing the colour that defines the group moves it; follow it so the
  // controls stay on the locations the user is looking at.
  locGroupSelected = locVisibleColor(members[0]);
  renderLocGroups();
  if (typeof rebuildLegend === 'function') rebuildLegend();
  if (typeof markDirty === 'function') markDirty();
  if (typeof pushHistory === 'function') pushHistory();

  status(`${what} for ${members.length} location${members.length === 1 ? '' : 's'}.`);
}

/** Pulse the group's pins so "which ones are those?" is answered before anything changes. */
function locGroupFlash(key) {
  locsInGroup(key).forEach(l => {
    // billboard.js keeps the pin element on `_pinEl`.
    const el = l._pinEl;
    if (!el) return;
    el.classList.remove('geom-group-flash');
    void el.getBoundingClientRect();
    el.classList.add('geom-group-flash');
    setTimeout(() => el.classList.remove('geom-group-flash'), 1400);
  });
}

/** Dim the cards outside the selected group, so the list agrees with the map. */
function locGroupMarkCards() {
  const inGroup = new Set(locGroupSelected ? locsInGroup(locGroupSelected).map(l => l.id) : []);
  locGroupPool().forEach(l => {
    if (!l.card) return;
    l.card.classList.toggle('off-group', !!locGroupSelected && !inGroup.has(l.id));
  });
}

/** Draw the swatches and, when one is picked, the group's controls. */
function renderLocGroups() {
  const host = document.getElementById('locGroups');
  if (!host) return;

  const groups = locColorGroups();
  // Below two there is nothing to choose between, and the controls would be a
  // second, worse copy of the card directly underneath.
  if (groups.length < 2) {
    host.innerHTML = '';
    host.style.display = 'none';
    locGroupSelected = null;
    locGroupMarkCards();
    return;
  }
  host.style.display = '';

  if (locGroupSelected && !groups.some(g => g.key === locGroupSelected)) locGroupSelected = null;

  const swatches = groups.map(grp => {
    const on = grp.key === locGroupSelected;
    const name = (typeof geomColorLabel === 'function') ? geomColorLabel(grp.key) : grp.key;
    const n = grp.count + ' location' + (grp.count === 1 ? '' : 's');
    return `<button type="button" class="geom-chip${on ? ' on' : ''}" data-key="${esc(grp.key)}"
      aria-pressed="${on}" aria-label="${esc(name)}, ${n}" title="${esc(name)} — ${n}"
      style="--sw:${esc(grp.key)}"
      ><span class="geom-chip-swatch"></span
      ><span class="geom-chip-tick">${GEOM_CHECK_SVG}</span
      ><span class="geom-chip-n">${grp.count}</span></button>`;
  }).join('');

  let editor = '';
  if (locGroupSelected) {
    const members = locsInGroup(locGroupSelected);
    const frame = locGroupCommon(members, 'iconFrame');
    const size = locGroupCommon(members, 'iconSize');
    const bw = locGroupCommon(members, 'iconBorder');
    const bc = locGroupCommon(members, 'iconBorderColor');
    const labelOn = locGroupCommon(members, 'showLabel');
    // An unset scale draws at 100, so a group nobody has touched agrees at 100
    // rather than reporting "Mixed" — the same trap the shape panel fell into.
    const scales = members.map(l => (l.labelScale == null ? 100 : +l.labelScale));
    const scale = scales.every(v => v === scales[0]) ? scales[0] : null;
    const mixed = v => v == null;

    editor = `
      <div class="geom-group-edit" style="--sw:${esc(locGroupSelected)}">
        <div class="gg-head">
          <span class="gg-head-dot"></span>
          <span class="gg-head-name">${esc(typeof geomColorLabel === 'function' ? geomColorLabel(locGroupSelected) : locGroupSelected)}</span>
          <span class="gg-head-count">${members.length} location${members.length === 1 ? '' : 's'}</span>
          <button type="button" class="mini-btn lg-zoom" title="Zoom the map to fit this group" aria-label="Zoom to fit this group">⌖</button>
        </div>

        <div class="r">
          <span class="sub gg-lbl">Colour</span>
          <input type="color" class="lg-color" value="${esc(locGroupSelected)}" title="Marker colour for every location in this group" aria-label="Marker colour for every location in this group">
          <span class="sub gg-lbl gg-lbl-2">Border</span>
          <input type="color" class="lg-bcolor" value="${esc(bc || '#FFFFFF')}" title="Border colour for every location in this group" aria-label="Border colour for every location in this group">
          <span class="grow"></span>
        </div>

        <div class="r">
          <span class="sub gg-lbl">Symbol</span>
          <button type="button" class="mini-btn lg-icon" style="flex:1" title="Pick one symbol for every location in this group" aria-label="Symbol for every location in this group">◈ Choose symbol</button>
        </div>

        <div class="r">
          <span class="sub gg-lbl">Frame</span>
          <select class="lg-frame" style="flex:1;min-width:0" title="Icon frame for every location in this group" aria-label="Icon frame for every location in this group">${optionList(LOC_FRAME_OPTS, frame || 'pin')}</select>
        </div>

        <div class="r">
          <span class="sub gg-lbl">Size</span>
          <input type="range" class="lg-size" min="18" max="72" step="1" value="${size == null ? 34 : size}" style="flex:1;" title="Marker size for every location in this group" aria-label="Marker size for every location in this group">
          <span class="pct lg-size-v${mixed(size) ? ' is-mixed' : ''}">${mixed(size) ? 'Mixed' : size}</span>
        </div>

        <div class="r">
          <span class="sub gg-lbl">Edge</span>
          <input type="range" class="lg-bw" min="0" max="8" step="1" value="${bw == null ? 2 : bw}" style="flex:1;" title="Border width for every location in this group" aria-label="Border width for every location in this group">
          <span class="pct lg-bw-v${mixed(bw) ? ' is-mixed' : ''}">${mixed(bw) ? 'Mixed' : bw}</span>
        </div>

        <div class="r">
          <label class="chk gg-lbl"><input type="checkbox" class="lg-label" ${labelOn ? 'checked' : ''}> Label</label>
          <input type="range" class="lg-scale" min="50" max="220" step="5" value="${scale == null ? 100 : scale}" style="flex:1;" title="Label size for every location in this group" aria-label="Label size for every location in this group">
          <span class="pct lg-scale-v${mixed(scale) ? ' is-mixed' : ''}">${mixed(scale) ? 'Mixed' : scale + '%'}</span>
        </div>
      </div>`;
  }

  host.innerHTML = `
    <div class="lbl">Style by colour</div>
    <p class="gg-hint">Pick a colour to restyle every location using it.</p>
    <div class="geom-chips" role="group" aria-label="Colour groups">${swatches}</div>
    ${editor}`;

  if (typeof enhanceColorInputs === 'function') enhanceColorInputs(host);
  wireLocGroups(host);
  locGroupMarkCards();
}

/** Frames a location marker can take. Mirrors the card's own Frame select. */
const LOC_FRAME_OPTS = [['pin', 'Pin'], ['circle', 'Circle'], ['rounded', 'Rounded'],
  ['square', 'Square'], ['none', 'No frame']];

/** @param {HTMLElement} host */
function wireLocGroups(host) {
  host.querySelectorAll('.geom-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      locGroupSelected = (locGroupSelected === key) ? null : key;
      renderLocGroups();
      if (locGroupSelected) locGroupFlash(locGroupSelected);
    });
  });

  const key = locGroupSelected;
  if (!key) return;
  const q = sel => host.querySelector(sel);

  // `change`, not `input`: the picker commits live while dragging, and a
  // callback that rebuilds this panel would destroy the popover's own anchor
  // mid-drag. The shape panel learned this the hard way.
  q('.lg-color').addEventListener('change', e => {
    const v = e.target.value;
    locGroupApply(key, l => { l.color = v; }, 'Set the colour');
  });
  q('.lg-bcolor').addEventListener('change', e => {
    const v = e.target.value;
    locGroupApply(key, l => { l.iconBorderColor = v; }, 'Set the border colour');
  });

  q('.lg-icon').addEventListener('click', () => {
    const members = locsInGroup(key);
    const first = members[0];
    openIconPicker({ iconKey: first ? first.iconKey : null, color: key },
      iconKey => locGroupApply(key, l => { l.iconKey = iconKey; }, 'Set the symbol'));
  });

  q('.lg-frame').addEventListener('change', e => {
    const v = e.target.value;
    locGroupApply(key, l => { l.iconFrame = v; }, 'Set the frame');
  });

  q('.lg-size').addEventListener('change', e => {
    const v = +e.target.value;
    locGroupApply(key, l => { l.iconSize = v; }, 'Set the marker size');
  });
  q('.lg-size').addEventListener('input', e => {
    const out = q('.lg-size-v');
    if (out) { out.textContent = e.target.value; out.classList.remove('is-mixed'); }
  });

  q('.lg-bw').addEventListener('change', e => {
    const v = +e.target.value;
    locGroupApply(key, l => { l.iconBorder = v; }, 'Set the border width');
  });
  q('.lg-bw').addEventListener('input', e => {
    const out = q('.lg-bw-v');
    if (out) { out.textContent = e.target.value; out.classList.remove('is-mixed'); }
  });

  q('.lg-label').addEventListener('change', e => {
    const on = e.target.checked;
    locGroupApply(key, l => { l.showLabel = on; }, on ? 'Labels on' : 'Labels off');
  });

  q('.lg-scale').addEventListener('change', e => {
    const v = +e.target.value;
    locGroupApply(key, l => { l.labelScale = v; }, 'Set the label size');
  });
  q('.lg-scale').addEventListener('input', e => {
    const out = q('.lg-scale-v');
    if (out) { out.textContent = e.target.value + '%'; out.classList.remove('is-mixed'); }
  });

  q('.lg-zoom').addEventListener('click', () => {
    const pts = locsInGroup(key).map(l => [l.lat, l.lng]).filter(c => isFinite(c[0]) && isFinite(c[1]));
    if (pts.length) map.fitBounds(pts, { padding: [70, 70] });
    locGroupFlash(key);
  });
}

/** Coalesce swatch rebuilds, the same way the shape panel does. */
let _locGroupsTimer = null;
function scheduleLocGroups() {
  if (_locGroupsTimer) return;
  _locGroupsTimer = setTimeout(() => {
    _locGroupsTimer = null;
    renderLocGroups();
  }, 60);
}
