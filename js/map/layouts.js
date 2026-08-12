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
 * IT SETS, IT DOES NOT POLICE. Switching the basemap afterwards is allowed and
 * does not kick you out of the layout. The requirement was that a connectivity
 * map *defaults* to OpenStreetMap, not that satellite becomes unreachable —
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
    basemap: 'osm',
    standard: true,
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

  try { setPref('layout', id); } catch (e) { /* prefs unavailable */ }

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

  // The saved preference is the default for a *new* map. A project that
  // carries its own layout overrides this when it loads — see applyProject.
  let saved = MAP_LAYOUT_DEFAULT;
  try { saved = getPref('layout') || MAP_LAYOUT_DEFAULT; } catch (e) { /* ignore */ }
  // Deferred a beat: setBasemap needs the basemap registry built, and the
  // registry is assembled after this file's top-level runs.
  // No keepBasemap here. It used to skip applying the ground whenever the saved
  // layout matched the default — which became "always" the moment the default
  // layout and the default ground were made to agree, so an upgraded install
  // opened in the Connectivity layout on last year's satellite ground: the
  // layout said one thing and the map showed another. Deliberate deviations are
  // now remembered per layout instead, which is what that guard was reaching for.
  setTimeout(() => setMapLayout(saved, { silent: true }), 300);
})();
