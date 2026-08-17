/**
 * map/layouts.js — the two kinds of map this tool makes.
 *
 * A **Connectivity** map is a line diagram: roads, rail, metro and water, on a
 * plain street ground, in fixed colours so every one of them reads the same
 * way. A **Satellite** map is a photograph of a place with things marked on it.
 * They want opposite grounds — a line diagram on satellite imagery is a mess of
 * colours competing with the picture underneath, and a site photo on a flat
 * street map has thrown away the thing it was for.
 *
 * So the layout is a named starting point: which ground, and whether the
 * connectivity standard applies. Picking one is a decision about what this map
 * IS, made once, rather than eight separate settings remembered by hand.
 *
 * CONNECTIVITY HOLDS ITS GROUND; SATELLITE DOES NOT CARE.
 *
 * Connectivity is pinned to OpenStreetMap and the basemap picker is disabled
 * while it is on. I originally built this as a default you could talk out of,
 * and argued that a mode which fights you gets switched off. That was wrong for
 * the same reason the free colour picker was wrong: the whole value is that
 * every connectivity map in the company looks like every other one, and a
 * ground that drifts per map costs exactly what a colour that drifts per map
 * costs. Satellite is the escape hatch and it is one click away, which is what
 * keeps the lock from being a trap.
 *
 * Satellite is deliberately the opposite — any ground, any colour — because
 * imagery maps are one-offs by nature. Its ground is remembered between
 * sessions; Connectivity's needs no memory because it has no choice.
 *
 * The historical note, since the code reads oddly without it: this used to be —
 * and a mode that fights you when you deviate gets turned off entirely, taking
 * the standard with it.
 *
 * REMEMBERED TWICE, ON PURPOSE. In the project, so a map opens as whatever it
 * was saved as and a colleague sees what you saw. And as a preference, so new
 * maps start in whichever layout this office mostly makes. Those are different
 * questions and one value cannot answer both.
 */

const MAP_LAYOUTS = {
  connectivity: {
    label: 'Connectivity',
    hint: 'Street ground, standard road colours',
    // The real OSM map, scrubbed. Positron was tried here (6.0074) and
    // rejected by the user for the right reason: it removes the crosses by
    // replacing the whole cartography, and the beige buildings, yellow roads
    // and green parks ARE the map they asked for. tileScrub.js cleans the
    // medical red out of the genuine OSM tiles instead, so this pin now means
    // exactly what its caption says: OpenStreetMap ground, standard colours.
    basemap: 'osm',
    standard: true,
    lockBasemap: true,
  },
  satellite: {
    label: 'Satellite',
    hint: 'Imagery ground, free colours',
    basemap: 'hybrid',
    standard: false,
  },
};

/**
 * A new map starts as a connectivity diagram on the OpenStreetMap ground.
 *
 * Read from prefs rather than hardcoded, so the Preferences dialog genuinely
 * sets the default for new maps instead of being overridden on load — and
 * falls back to the same value prefs declares, so the two cannot drift apart.
 */
const MAP_LAYOUT_DEFAULT = (typeof getPref === 'function' && getPref('layout')) || 'connectivity';

/** The active layout id. Not the basemap — you may change that within a layout. */
let mapLayoutId = MAP_LAYOUT_DEFAULT;

/** @returns {string} the current layout id */
function mapLayout() { return mapLayoutId; }

/**
 * The ground a layout should open on: whatever it was last left on, else the
 * layout's own default.
 * @param {string} id @returns {string}
 */
function layoutBasemap(id) {
  const spec = MAP_LAYOUTS[id];
  // A pinned layout has one ground and no memory of anything else. Consulting a
  // remembered value here would let a ground chosen before the pin existed
  // outlive it, which is the bug this whole area keeps producing.
  if (spec && spec.lockBasemap) return spec.basemap;
  let byLayout = null;
  try { byLayout = getPref('basemapByLayout'); } catch (e) { /* ignore */ }
  const saved = byLayout && byLayout[id];
  return (saved && (typeof BASEMAPS === 'undefined' || BASEMAPS[saved])) ? saved : (spec ? spec.basemap : 'osm');
}

/**
 * Remember that this layout is being used with this ground.
 *
 * Called when a basemap actually renders, not when it is picked — the same
 * rule mapEngine already applies to the plain `basemap` pref, so a provider
 * that cannot draw is never remembered as a preference.
 *
 * @param {string} key
 */
function rememberLayoutBasemap(key) {
  try {
    const cur = getPref('basemapByLayout') || {};
    if (cur[mapLayoutId] === key) return;
    const next = Object.assign({}, cur);
    next[mapLayoutId] = key;
    setPref('basemapByLayout', next);
  } catch (e) { /* prefs unavailable */ }
}

/** @returns {boolean} whether the active layout pins its ground */
function basemapLocked() {
  const spec = MAP_LAYOUTS[mapLayoutId];
  return !!(spec && spec.lockBasemap);
}

/**
 * Disable the basemap picker while the layout pins its ground.
 *
 * Disabled and explained, not hidden. A control that vanishes reads as a broken
 * build; one that is greyed with "Connectivity is pinned to OpenStreetMap —
 * switch to Satellite to change the ground" tells you both the rule and the way
 * out in the place you went looking for it.
 */
function syncBasemapLock() {
  const locked = basemapLocked();
  const why = locked
    ? 'Connectivity is pinned to OpenStreetMap so every map reads the same.'
      + ' Switch to Satellite to choose a ground.'
    : 'Basemap';
  document.body.classList.toggle('basemap-locked', locked);
  const tgl = document.getElementById('bmToggle');
  if (tgl) { tgl.disabled = locked; tgl.title = why; }
  const sel = document.getElementById('basemapSel');
  if (sel) { sel.disabled = locked; sel.title = why; }
  const panel = document.getElementById('bmPanel');
  if (locked && panel) panel.hidden = true;
}

/** @returns {boolean} whether classed objects should take their class colours */
function connStandardOn() {
  const spec = MAP_LAYOUTS[mapLayoutId];
  return !!(spec && spec.standard);
}

/**
 * Switch layout.
 *
 * @param {string} id one of MAP_LAYOUTS
 * @param {object} [opts] `{silent}` no status line, `{keepBasemap}` don't touch
 *   the ground (used when restoring a project that saved its own basemap)
 */
function setMapLayout(id, opts) {
  opts = opts || {};
  const spec = MAP_LAYOUTS[id];
  if (!spec) return;
  const changed = mapLayoutId !== id;
  mapLayoutId = id;

  if (!opts.keepBasemap && typeof setBasemap === 'function') {
    // The ground this layout was last left on, else the layout's own. A layout
    // that does not set its ground is not a layout, it is a checkbox.
    const ground = layoutBasemap(id);
    // Only when it is not already right: setBasemap tears down and rebuilds the
    // tile layers, which is a visible flash for no reason if nothing moved.
    if (typeof activeKey === 'undefined' || activeKey !== ground) {
      const sel = document.getElementById('basemapSel');
      if (sel) sel.value = ground;
      try { setBasemap(ground); } catch (e) { /* provider gone; keep the old ground */ }
    }
  }

  // A layout can ask for ground overlays. Applied only when the user has not
  // made their own choice — once they have ticked something, that is theirs and
  // switching layout must not silently retick it.
  if (spec.overlays && typeof reapplyMapOverlays === 'function') {
    let chosen = null;
    try { chosen = getPref('mapOverlays'); } catch (e) { /* ignore */ }
    if (chosen == null) {
      try { setPref('mapOverlays', spec.overlays.slice()); } catch (e) { /* ignore */ }
    }
    setTimeout(() => { try { reapplyMapOverlays(); } catch (e) { } }, 60);
  }

  // Entering the standard restyles what is already there. Leaving it does NOT
  // restyle anything back: the colours on the map are what somebody handed to a
  // client, and silently repainting them because a mode changed would be the
  // worst kind of surprise.
  if (spec.standard && typeof connApplyAll === 'function') connApplyAll();

  // The route cards carry the colour lock, so they have to be rebuilt when the
  // layout changes — otherwise the pickers keep whatever enabled state they had
  // when they were drawn, and a locked route sits there with a live colour
  // picker on it.
  if (changed && typeof routes !== 'undefined') {
    routes.forEach(rt => { if (rt.card && rt.card._syncStandard) rt.card._syncStandard(); });
  }

  document.querySelectorAll('[data-layout-btn]').forEach(b => {
    const on = b.dataset.layoutBtn === id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  document.body.classList.toggle('layout-connectivity', !!spec.standard);
  syncBasemapLock();

  // NOT written to prefs. This used to do `setPref('layout', id)`, which made
  // one slot mean two different things: prefs.js calls `layout` "the default for
  // a NEW map", and this made it "the last layout I happened to be in". The
  // second always wins, because it is written far more often — so opening
  // Satellite once to check an aerial meant every map from then on opened in
  // Satellite, and the default in Preferences never applied again.
  //
  // The same collision was already found and fixed once for the basemap: see
  // `basemapByLayout` in prefs.js, and the note there about one key not being
  // able to express two intentions.
  //
  // So the layout is now a per-session choice. Preferences owns the pref and is
  // its only writer; a saved project carries its own layout and applyProject()
  // restores it without changing what anyone else's maps open as.

  if (changed && !opts.silent && typeof status === 'function') {
    status(spec.standard
      ? 'Connectivity layout. Roads, rail and water take their standard colours; the ground is OpenStreetMap.'
      : 'Satellite layout. Colours are yours to choose.');
  }
}

(function wireMapLayouts() {
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-layout-btn]');
    if (b) setMapLayout(b.dataset.layoutBtn);
  });

  // The preference, which is now only ever what somebody chose in the
  // Preferences dialog — nothing else writes it. A project that carries its own
  // layout overrides this when it loads; see applyProject.
  let wanted = MAP_LAYOUT_DEFAULT;
  try { wanted = getPref('layout') || MAP_LAYOUT_DEFAULT; } catch (e) { /* ignore */ }
  // Deferred a beat: setBasemap needs the basemap registry built, and the
  // registry is assembled after this file's top-level runs.
  // No keepBasemap here. It used to skip applying the ground whenever the saved
  // layout matched the default — which became "always" the moment the default
  // layout and the default ground were made to agree, so an upgraded install
  // opened in the Connectivity layout on last year's satellite ground: the
  // layout said one thing and the map showed another. Deliberate deviations are
  // now remembered per layout instead, which is what that guard was reaching for.
  setTimeout(() => setMapLayout(wanted, { silent: true }), 300);
})();
