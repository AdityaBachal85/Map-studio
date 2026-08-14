/**
 * map/vectorBasemap.js — the vector ground: a MapLibre GL canvas under Leaflet.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Every other basemap in this app is raster: the client receives a picture, not
 * features. That has one consequence that keeps costing us — we cannot turn
 * anything off. The red hospital and pharmacy crosses on OpenStreetMap are the
 * proof. They are baked into the same PNG as the roads, so removing them meant
 * writing map/tileScrub.js: a pixel scrubber that finds OSM Carto's healthcare
 * red, grows two anti-alias rings and inpaints the holes from the surrounding
 * colour. It works, and it is a workaround for not owning the render. It has
 * already had one near-miss — an early version also ate the Thane–Borivali Twin
 * Tunnel, because OSM Carto draws under-construction highways as pink dashes
 * that a relative "red dominates" test matches exactly.
 *
 * A vector basemap ships the *style* and the *features* and renders them in the
 * browser. "Hide pharmacies but keep hospitals" stops being image processing and
 * becomes a filter on one style layer: instant, exact, no pixels harmed and no
 * road at risk.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is not a renderer swap. Leaflet keeps the DOM, the projection, the
 * interaction model and every vector this app draws — routes, shapes, markers,
 * rings, labels. MapLibre is mounted as the *ground* only, below Leaflet's tile
 * pane, and is told where to look. It is built `interactive: false` precisely so
 * that there is exactly one thing on the page handling a drag; two pan handlers
 * on one element fight, and the map jitters.
 *
 * tileScrub.js is untouched and stays the answer for raster OSM, which remains
 * the default ground. This is an addition, not a replacement.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RENDERER LOADS ON DEMAND
 * ---------------------------------------------------------------------------
 *
 * vendor/maplibre-gl.js is 803 KB — a 29% increase on everything else this app
 * vendors put together, for a feature that is off by default. So it is not a
 * <script> tag in index.html; it is fetched the first time a vector ground is
 * actually asked for.
 *
 * That makes the vector path asynchronous, which sounds like a complication and
 * is in fact the shape mapEngine already has. Google's basemaps must trade an
 * API key for a session token before a single tile URL exists, so setBasemap()
 * already knows how to say "not yet, come back when this resolves": it parks the
 * ground, shows a status line, and re-enters itself when the promise lands. This
 * uses the same door.
 *
 * The URL carries `?v=' + APP_VERSION` by hand. tools/stamp-assets.js only
 * rewrites src/href attributes in the HTML files, so a script loaded from JS is
 * invisible to it — and an unstamped vendor file is exactly the half-updated
 * cache the stamper exists to prevent.
 *
 * One consequence, stated rather than discovered later: the `legacy/` single-file
 * snapshots inline what index.html lists, so they do not carry the renderer.
 * Choosing the vector ground in one of those frozen builds fails the load,
 * reverts to the previous ground and says so, which is the right way for an
 * archival artefact to decline a feature it was not built with.
 *
 * ---------------------------------------------------------------------------
 * ZOOM: WHY THE ANIMATION IS TURNED OFF
 * ---------------------------------------------------------------------------
 *
 * Leaflet animates a zoom by CSS-transforming its map pane and firing `zoomend`
 * when the transition finishes — it does not emit a stream of intermediate zoom
 * levels. A GL canvas driven from those events therefore sits at the old zoom
 * for the whole ~250 ms animation and snaps at the end, so the ground and
 * everything drawn on it visibly disagree on every zoom.
 *
 * Two ways out. The fiddly one is to mirror Leaflet's own transform onto the GL
 * host during `zoomanim` and clear it at `zoomend`. The blunt one is to stop
 * Leaflet animating while a vector ground is mounted, so both step together and
 * are never in disagreement at all. This does the blunt one, because it cannot
 * be wrong, and because the alternative is the kind of thing that has to be
 * watched to be trusted and could not be watched here (see the honesty note at
 * the bottom of this file). Zoom on the vector ground is a crisp step rather
 * than a glide; the transform mirror is the upgrade if anyone dislikes it.
 *
 * ---------------------------------------------------------------------------
 * THE ZOOM LEVELS DO NOT MATCH, AND IT IS INVISIBLE UNTIL YOU MEASURE
 * ---------------------------------------------------------------------------
 *
 * Leaflet lays the world out on a 256-pixel tile: at zoom z the world is
 * `256 · 2^z` pixels around. MapLibre's transform uses a 512-pixel tile, so at
 * the *same numeric zoom* its world is `512 · 2^z` — twice as big. Handing
 * MapLibre Leaflet's zoom therefore renders the ground at double scale.
 *
 * `VECTOR_ZOOM_OFFSET` below is the correction, and the reason it is written
 * down at this length is that nothing about the failure announces itself.
 * `glMap.getCenter()` matches `map.getCenter()` exactly, at every zoom, while
 * the ground is twice the size it should be — so the obvious assertion passes
 * and keeps passing. It was caught by projecting the same latitude and
 * longitude through both maps and comparing the screen points: 204 px apart at
 * z12, 1631 px at z15, growing as `2^Δz` because the error is a scale factor
 * rather than an offset. That comparison is the test worth keeping.
 *
 * (This contradicts docs/OPENFREEMAP-VECTOR-BASEMAP.md, which says the two
 * scales agree and no offset is needed. They do not. The measurement is above.)
 *
 * What differs besides the zoom is the shape of a centre: Leaflet's is
 * `{lat, lng}`, MapLibre's is `[lng, lat]`. Transposing them is the classic
 * first bug here and shows up as a map somewhere in the Gulf of Guinea.
 */

/**
 * Added to a Leaflet zoom to get the MapLibre zoom that draws at the same
 * scale. −1 because MapLibre's world is `512 · 2^z` px and Leaflet's is
 * `256 · 2^z`: halving the scale is one zoom level down.
 */
const VECTOR_ZOOM_OFFSET = -1;

/** @param {number} z A Leaflet zoom. @returns {number} the MapLibre equivalent. */
function vectorZoomFor(z) { return z + VECTOR_ZOOM_OFFSET; }

/* ---------------------------------------------------------------------------
 * The vendored renderer
 * ------------------------------------------------------------------------- */

/** Resolves once maplibre-gl is on the page; rejects if it cannot be loaded. */
let _maplibreLoad = null;

/**
 * Load the vendored MapLibre build, once.
 *
 * Resolves immediately when the global is already there, so callers may await
 * it freely rather than tracking whether they are the first.
 *
 * @returns {Promise<boolean>} true when `maplibregl` is usable.
 */
function loadMapLibre() {
  if (typeof maplibregl !== 'undefined') return Promise.resolve(true);
  if (_maplibreLoad) return _maplibreLoad;

  const v = (typeof APP_VERSION !== 'undefined') ? APP_VERSION : '';
  const stamp = v ? '?v=' + v : '';

  _maplibreLoad = new Promise(resolve => {
    // The stylesheet first, and not awaited: MapLibre positions its own canvas
    // from it, and a canvas that lands before its rules do is a canvas at the
    // wrong size for one frame. Nothing here uses MapLibre's controls, popups
    // or markers, so this is the only part of that sheet that matters.
    if (!document.querySelector('link[data-maplibre]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = './vendor/maplibre-gl.css' + stamp;
      css.setAttribute('data-maplibre', '1');
      document.head.appendChild(css);
    }
    const js = document.createElement('script');
    js.src = './vendor/maplibre-gl.js' + stamp;
    js.async = false;
    js.onload = () => resolve(typeof maplibregl !== 'undefined');
    js.onerror = () => {
      // Reset so a later attempt can retry: a failed load is usually a flaky
      // network, and caching the failure for the session would mean one bad
      // moment disables the feature until reload.
      _maplibreLoad = null;
      console.warn('[vector] MapLibre failed to load from vendor/');
      resolve(false);
    };
    document.head.appendChild(js);
  });
  return _maplibreLoad;
}

/** @returns {boolean} whether the renderer is present right now. */
function maplibreReady() { return typeof maplibregl !== 'undefined'; }

/* ---------------------------------------------------------------------------
 * The live ground
 * ------------------------------------------------------------------------- */

/** The mounted MapLibre map, or null. Module-level so teardown can find it. */
let _glMap = null;
/** Its host element, a direct child of Leaflet's container. */
let _glHost = null;
/** The basemap id it was built for, so a re-entrant setBasemap can skip work. */
let _glSpecId = null;
/** Leaflet's `_zoomAnimated` as we found it, restored on unmount. */
let _leafletZoomAnim = null;
/** Handlers bound to the Leaflet map, kept so unmount can detach exactly these. */
let _syncHandlers = null;

/** @returns {maplibregl.Map|null} the live GL ground. */
function vectorGroundMap() { return _glMap; }
/** @returns {boolean} whether a vector ground is mounted. */
function vectorGroundActive() { return !!_glMap; }
/** @returns {string|null} the basemap id the ground was built for. */
function vectorGroundId() { return _glSpecId; }

/** Is this basemap spec a vector one? @param {object} spec */
function isVectorSpec(spec) { return !!(spec && spec.vector && spec.styleUrl); }

/**
 * The class on the GL host.
 *
 * Also a CSS hook: the export furniture pass hides the tile and overlay panes
 * so it can photograph the cards on transparency, and the GL host is neither of
 * those — left visible it would be photographed into the furniture layer and
 * composited back over the map it is supposed to sit under. See layout.css.
 */
const VECTOR_HOST_CLASS = 'vector-basemap-host';

/**
 * Mount (or re-point) the GL ground for a vector basemap spec.
 *
 * @param {object} spec  A BasemapSpec with `vector: true` and a `styleUrl`.
 * @param {L.Map} lmap   The Leaflet map to follow.
 * @returns {maplibregl.Map|null}
 */
function mountVectorGround(spec, lmap) {
  if (!maplibreReady() || !isVectorSpec(spec) || !lmap) return null;

  // Same style already up: re-point rather than rebuild. Rebuilding on every
  // setBasemap re-entry would re-download the style and flash the ground.
  // The filters are re-applied even so — opening a project is a setBasemap to
  // the ground that is already showing, and its saved filters have to land.
  if (_glMap && _glSpecId === spec.id) {
    syncVectorGround(lmap);
    applyVectorLayerPrefs();
    return _glMap;
  }
  if (_glMap) unmountVectorGround(lmap);

  const container = lmap.getContainer();

  // A direct child of Leaflet's container, NOT of .leaflet-map-pane. The map
  // pane carries Leaflet's pan transform, and a GL canvas inside it would be
  // moved by that transform *and* by its own centre — every drag twice as far
  // as the pointer went. Outside it, the host is a fixed window that the GL map
  // paints the right view into.
  //
  // z-index 0 puts it under every Leaflet pane (the map pane is 400, tiles 200
  // within it), so routes, shapes, markers and the raster overlays all keep
  // drawing on top. It sits inside #tiltStage, so the 3D tilt applies to the
  // vector ground exactly as it does to raster tiles.
  const host = document.createElement('div');
  host.className = VECTOR_HOST_CLASS;
  host.style.cssText = 'position:absolute;inset:0;z-index:0;pointer-events:none;';
  container.insertBefore(host, container.firstChild);

  let gl;
  try {
    gl = new maplibregl.Map({
      container: host,
      style: spec.styleUrl,
      center: [lmap.getCenter().lng, lmap.getCenter().lat],   // [lng, lat] — not Leaflet's order
      zoom: vectorZoomFor(lmap.getZoom()),                    // −1; see the note at the top
      // Leaflet stays the only thing that handles a gesture. Every one of these
      // is a handler that would otherwise fight it.
      interactive: false,
      attributionControl: false,
      // Attribution is rendered by the app's own #mapCredit line from the
      // spec's `credit`, the same as every raster basemap.
      // Without this the canvas reads back blank and every vector export ships
      // an empty ground: WebGL is free to discard the buffer after a frame
      // unless asked not to. It costs a little performance; the export is worth
      // more than the frame rate of a ground nobody is dragging.
      preserveDrawingBuffer: true,
      fadeDuration: 0,
      // Leaflet owns the wrap-around and the zoom limits; matching them keeps
      // the two from disagreeing at the edges of the world.
      // Leaflet's ceiling expressed in MapLibre's scale, or the ground would
      // stop following the map a level before the map stops zooming.
      maxZoom: vectorZoomFor((typeof MAX_MAP_ZOOM !== 'undefined') ? MAX_MAP_ZOOM : 22),
      minZoom: vectorZoomFor(0),
      refreshExpiredTiles: false,
    });
  } catch (e) {
    console.warn('[vector] could not create the GL ground:', e && e.message);
    host.remove();
    return null;
  }

  gl.on('error', e => {
    // A style that will not load is the failure that matters — usually the tile
    // host being unreachable. Reported rather than swallowed, because the map
    // otherwise just sits there empty with nothing said.
    console.warn('[vector] MapLibre:', (e && e.error && e.error.message) || e);
  });

  // Style layers only exist once the style has parsed, so the filter panel is
  // built from the live style rather than from a list written from memory.
  // Liberty's layer names are not guessable and they change between versions.
  gl.on('load', () => {
    if (_glMap !== gl) return;                     // superseded while loading
    applyVectorLayerPrefs();
    if (typeof renderOverlayPanel === 'function') { try { renderOverlayPanel(); } catch (e) { /* no panel */ } }
  });

  _glMap = gl;
  _glHost = host;
  _glSpecId = spec.id;

  attachVectorSync(lmap);
  syncVectorGround(lmap);
  return gl;
}

/**
 * Tear the GL ground down completely.
 *
 * Symmetric with mountVectorGround, and it has to be: setBasemap() removes the
 * old ground and builds the new one, so a vector ground that only *stopped
 * being updated* would leave a dead canvas painted under the live one, and
 * switching twice would leave two.
 *
 * @param {L.Map} [lmap] The Leaflet map to detach handlers from.
 */
function unmountVectorGround(lmap) {
  detachVectorSync(lmap);
  if (_glMap) {
    try { _glMap.remove(); } catch (e) { /* already gone */ }
    _glMap = null;
  }
  if (_glHost) { _glHost.remove(); _glHost = null; }
  _glSpecId = null;
}

/* ---------------------------------------------------------------------------
 * Keeping the two maps looking at the same place
 * ------------------------------------------------------------------------- */

/**
 * Push Leaflet's view onto the GL map.
 *
 * `jumpTo`, never `easeTo`: this is a mirror, and a mirror that animates is a
 * mirror that lags. Leaflet has already decided where the map is.
 *
 * @param {L.Map} lmap
 */
function syncVectorGround(lmap) {
  if (!_glMap || !lmap) return;
  const c = lmap.getCenter();
  try {
    _glMap.jumpTo({ center: [c.lng, c.lat], zoom: vectorZoomFor(lmap.getZoom()) });
  } catch (e) { /* mid-teardown */ }
}

/**
 * Follow the Leaflet map, and stop it animating its zoom while we do.
 *
 * See the note at the top of the file for why the animation goes off: Leaflet
 * emits no intermediate zoom levels during a CSS-transform zoom, so a mirrored
 * canvas would sit a whole animation behind on every zoom.
 *
 * @param {L.Map} lmap
 */
function attachVectorSync(lmap) {
  if (!lmap || _syncHandlers) return;

  if (_leafletZoomAnim === null) {
    _leafletZoomAnim = !!lmap._zoomAnimated;
    lmap._zoomAnimated = false;
  }

  const onView = () => syncVectorGround(lmap);
  const onResize = () => {
    if (!_glMap) return;
    // The canvas is sized from its host, and the host is sized by CSS — but
    // MapLibre only measures on its own resize observer, which does not see a
    // Leaflet invalidateSize() driven by a sidebar opening.
    try { _glMap.resize(); } catch (e) { /* mid-teardown */ }
    syncVectorGround(lmap);
  };

  _syncHandlers = { onView, onResize };
  lmap.on('move zoom moveend zoomend', onView);
  lmap.on('resize', onResize);
}

/** Detach the sync handlers and give Leaflet its zoom animation back. */
function detachVectorSync(lmap) {
  if (lmap && _syncHandlers) {
    lmap.off('move zoom moveend zoomend', _syncHandlers.onView);
    lmap.off('resize', _syncHandlers.onResize);
  }
  _syncHandlers = null;
  if (lmap && _leafletZoomAnim !== null) {
    lmap._zoomAnimated = _leafletZoomAnim;
  }
  _leafletZoomAnim = null;
}

/* ---------------------------------------------------------------------------
 * Per-layer filters — the thing raster cannot do
 * ------------------------------------------------------------------------- */

/**
 * The toggle groups offered for a vector ground.
 *
 * Deliberately a *classification of the live style*, not a list of layer ids.
 * Style layer names are not guessable, they differ between Liberty, Bright and
 * Positron, and they change between versions of each — so every id below is
 * matched against whatever the loaded style actually contains, and a group with
 * no matching layers is simply not shown.
 *
 * `match` is tried against the style layer's id and its `source-layer`, both
 * lower-cased. Order matters: the first group that claims a layer keeps it, so
 * the specific patterns come before the general ones.
 */
const VECTOR_LAYER_GROUPS = [
  {
    id: 'poi',
    label: 'Places & POI symbols',
    hint: 'Shops, clinics, offices and the rest of the point-of-interest icons',
    match: /(^|[-_])poi([-_]|$)|point-of-interest/,
  },
  {
    id: 'labels',
    label: 'Place names',
    hint: 'Country, state, city, suburb and locality names',
    match: /place[-_]?(label|name)?|country|state|continent|city|town|village|suburb/,
    types: ['symbol'],
  },
  {
    id: 'roadLabels',
    label: 'Road names & shields',
    hint: 'Street names and route numbers painted along the roads',
    match: /(road|highway|street|motorway)[-_]?(label|name|shield|number|ref)/,
    types: ['symbol'],
  },
  {
    id: 'roads',
    label: 'Roads',
    hint: 'The basemap’s own road network, underneath the routes this map draws',
    // Worth having on a connectivity map specifically: this app draws its own
    // roads to the connectivity standard, and the ground’s road network
    // underneath them is often the clutter the standard was meant to replace.
    // After roadLabels above, so the names are claimed by that group first.
    match: /road|highway|motorway|street|bridge|tunnel|path|track/,
  },
  {
    id: 'buildings',
    label: 'Buildings',
    hint: 'Building footprints',
    match: /building/,
  },
  {
    id: 'landuse',
    label: 'Land use & parks',
    hint: 'Parks, farmland, residential and industrial ground tints',
    match: /landuse|landcover|park|wood|grass|forest|farmland|cemetery|pitch|sand/,
  },
  {
    id: 'water',
    label: 'Water',
    hint: 'Rivers, lakes, coastline and their names',
    match: /water|river|lake|ocean|sea|waterway/,
  },
  {
    id: 'transit',
    label: 'Rail & transit',
    hint: 'Railways, metro lines and their stations',
    match: /rail|transit|subway|metro|tram|ferry|aeroway|airport/,
  },
  {
    id: 'boundaries',
    label: 'Administrative boundaries',
    hint: 'Country, state and district lines',
    match: /boundary|admin|border/,
  },
];

/**
 * POI sub-toggles that filter on a feature *class* rather than hiding a layer.
 *
 * THIS IS THE POINT OF THE WHOLE FEATURE. tileScrub.js can remove the red
 * medical symbols from a raster OSM tile, but it cannot remove the pharmacies
 * and leave the hospitals, because to a pixel scrubber they are the same shade
 * of red — they are literally the same colour. Here they are different values
 * of one attribute, so "hide the chemists, keep the hospitals" is a filter, not
 * an image-processing problem.
 *
 * This is also the one place a data schema is assumed rather than discovered,
 * and it is assumed because there is nothing in a style JSON to discover it
 * from: class values live in the tiles, not the style. OpenFreeMap serves
 * OpenMapTiles-schema data, whose `poi` layer carries a `class` field with
 * `hospital` and `pharmacy` among its values.
 *
 * If that assumption is wrong the filter matches nothing and the toggle does
 * nothing visible — it cannot delete the wrong features, which is the property
 * that matters most given it could not be checked against live tiles here. The
 * failure mode of tileScrub.js's equivalent guess was eating a tunnel.
 */
const VECTOR_POI_CLASS_TOGGLES = [
  {
    id: 'poiHospital',
    label: 'Hospitals & clinics',
    hint: 'Hospitals, clinics, doctors, dentists and vets',
    classes: ['hospital', 'clinic', 'doctors', 'dentist', 'veterinary'],
  },
  {
    id: 'poiPharmacy',
    label: 'Pharmacies',
    hint: 'Chemists and pharmacies — separately from the hospitals, which a'
      + ' scrubbed raster tile cannot do because both are drawn the same red',
    classes: ['pharmacy', 'chemist'],
  },
];

/**
 * Every style layer id, grouped. Recomputed from the live style each call.
 *
 * Takes the map to read rather than always reading the mounted one, because the
 * export builds its own GL map from the same style and has to apply the same
 * filters to it — an export that shows what the operator switched off is the
 * whole point of switching it off.
 *
 * @param {maplibregl.Map} [gl] Defaults to the mounted ground.
 */
function vectorStyleGroups(gl) {
  gl = gl || _glMap;
  if (!gl) return [];
  let layers = [];
  try { layers = (gl.getStyle() || {}).layers || []; } catch (e) { return []; }
  if (!layers.length) return [];

  const claimed = {};
  return VECTOR_LAYER_GROUPS.map(g => {
    const ids = layers.filter(l => {
      if (claimed[l.id]) return false;
      if (g.types && g.types.indexOf(l.type) < 0) return false;
      const hay = (l.id + ' ' + (l['source-layer'] || '')).toLowerCase();
      return g.match.test(hay);
    }).map(l => l.id);
    ids.forEach(id => { claimed[id] = true; });
    return Object.assign({}, g, { ids });
  }).filter(g => g.ids.length);
}

/** The layer-visibility prefs, as `{groupId: false}` for the ones turned off. */
function vectorLayerPrefs() {
  let saved = null;
  try { saved = getPref('vectorLayers'); } catch (e) { /* ignore */ }
  return (saved && typeof saved === 'object') ? saved : {};
}

/** @param {string} id @returns {boolean} whether a group is shown. */
function vectorGroupOn(id) { return vectorLayerPrefs()[id] !== false; }

/** @param {string} id A VECTOR_POI_CLASS_TOGGLES id. @returns {boolean} */
function vectorPoiClassOn(id) { return vectorLayerPrefs()[id] !== false; }

/** The POI classes to filter out, gathered from whichever sub-toggles are off. */
function vectorHiddenPoiClasses() {
  return VECTOR_POI_CLASS_TOGGLES
    .filter(t => !vectorPoiClassOn(t.id))
    .reduce((all, t) => all.concat(t.classes), []);
}

/**
 * Show or hide one group of style layers.
 *
 * One `setLayoutProperty` per layer, applied instantly and exactly — the whole
 * point of owning the render. Nothing is repainted, reprojected or re-fetched.
 *
 * @param {string} groupId @param {boolean} on
 */
function setVectorLayerGroup(groupId, on) {
  const prefs = Object.assign({}, vectorLayerPrefs());
  if (on) delete prefs[groupId]; else prefs[groupId] = false;
  try { setPref('vectorLayers', prefs); } catch (e) { /* ignore */ }
  applyVectorLayerPrefs();
  if (typeof renderOverlayPanel === 'function') renderOverlayPanel();
  if (typeof markDirty === 'function') markDirty();
}

/**
 * Show or hide one class of POI symbol, leaving every other POI alone.
 * @param {string} id A VECTOR_POI_CLASS_TOGGLES id. @param {boolean} on
 */
function setVectorPoiClass(id, on) { setVectorLayerGroup(id, on); }

/**
 * Push every remembered filter onto the live style.
 *
 * Called on style load and after any toggle, so the same code path serves "the
 * user just clicked" and "a project was opened with these settings saved".
 */
function applyVectorLayerPrefs(gl) {
  gl = gl || _glMap;
  if (!gl) return;
  const groups = vectorStyleGroups(gl);

  groups.forEach(g => {
    const vis = vectorGroupOn(g.id) ? 'visible' : 'none';
    g.ids.forEach(id => {
      try { gl.setLayoutProperty(id, 'visibility', vis); } catch (e) { /* layer went away */ }
    });
  });

  applyVectorPoiClassFilter(groups, gl);
}

/**
 * Filter individual POI classes out of the POI layers.
 *
 * The reason this whole feature was worth building. On raster OSM the same job
 * is tileScrub.js — masking a specific red out of the tile pixels and inpainting
 * the hole — and it cannot separate a pharmacy from a hospital, because they
 * are painted in the same colour. Here they are different values of one
 * attribute, so each gets its own switch.
 *
 * The exclusion is combined with the layer's own filter rather than replacing
 * it, or the layer would start drawing features the style deliberately leaves
 * out. MapLibre refuses a legacy filter and an expression in the same `all`,
 * and this cannot know which kind a given style uses — so the combination is
 * attempted, and a style that rejects it falls back to hiding those POI layers
 * outright. Coarser than asked for, never wrong, and it says so in the console.
 *
 * @param {object[]} [groups] Pre-computed groups, to avoid recomputing them.
 * @param {maplibregl.Map} [gl] Defaults to the mounted ground.
 */
function applyVectorPoiClassFilter(groups, gl) {
  gl = gl || _glMap;
  if (!gl) return;
  const poi = (groups || vectorStyleGroups(gl)).find(g => g.id === 'poi');
  if (!poi) return;
  // Nothing to do while the whole POI group is hidden — and re-filtering it
  // would fight the visibility that is already off.
  if (!vectorGroupOn('poi')) return;

  const hidden = vectorHiddenPoiClasses();

  poi.ids.forEach(id => {
    let original;
    try {
      // Remembered once, on the layer we found it on: after the first filter is
      // applied, getFilter() returns *ours*, and combining ours with ours again
      // on every toggle would nest without end.
      if (!_vectorOriginalFilters.hasOwnProperty(id)) {
        _vectorOriginalFilters[id] = gl.getFilter(id) || null;
      }
      original = _vectorOriginalFilters[id];
    } catch (e) { return; }

    try {
      if (!hidden.length) {
        gl.setFilter(id, original);
        // Undo a previous fallback that hid the layer wholesale.
        gl.setLayoutProperty(id, 'visibility', 'visible');
        return;
      }
      const exclude = ['!', ['in', ['get', 'class'], ['literal', hidden]]];
      gl.setFilter(id, original ? ['all', exclude, original] : exclude);
    } catch (e) {
      console.warn('[vector] "' + id + '" would not take a class filter, hiding the layer instead:',
        e && e.message);
      try {
        gl.setLayoutProperty(id, 'visibility', hidden.length ? 'none' : 'visible');
      } catch (e2) { /* gone */ }
    }
  });
}

/** Each POI layer's filter as the style shipped it, so ours can be undone. */
const _vectorOriginalFilters = {};

/* ---------------------------------------------------------------------------
 * The export ground
 * ------------------------------------------------------------------------- */

/**
 * Render the vector ground offscreen at export resolution.
 *
 * WHY THIS CANNOT REUSE THE RASTER ROUTE. renderGroundPass() builds a second
 * Leaflet map, calls the basemap's `build()` again for a fresh set of tile
 * layers, waits for them, and then walks the DOM for `img.leaflet-tile,
 * canvas.leaflet-tile`. A GL canvas is neither of those selectors and there is
 * no second `build()` to call, so left alone every vector export ships a blank
 * ground.
 *
 * WHY THE ZOOM IS NOT DEEPENED. The raster path renders `log2(scale)` levels
 * deeper than the screen, because more pixels can only come from more tiles.
 * That reflex is wrong here and would produce a different picture: at zoom+2 a
 * vector style draws the detail *and the label sizes* of zoom+2, so the export
 * would carry four times the labels at a quarter of their relative size. What a
 * vector renderer wants instead is the same view at a higher device pixel
 * ratio — identical composition, `scale` times the pixels, text that is
 * genuinely sharper rather than merely smaller. So: same centre, same zoom,
 * `pixelRatio = scale`.
 *
 * WHY `idle` AND NOT `load`. `load` fires when the style has parsed, which is
 * long before the tiles it refers to have arrived and been drawn. Capturing on
 * `load` gives a half-drawn ground. `idle` fires when there is nothing left to
 * draw, which is the actual question being asked.
 *
 * @param {object} spec  The vector BasemapSpec.
 * @param {object} o     `{W, H, scale, center, zoom, budgetMs}`
 * @returns {Promise<{canvas:HTMLCanvasElement|null, complete:boolean}>}
 */
async function renderVectorGroundCanvas(spec, o) {
  if (!maplibreReady()) {
    const ok = await loadMapLibre();
    if (!ok) return { canvas: null, complete: false };
  }
  if (!isVectorSpec(spec)) return { canvas: null, complete: false };

  const W = Math.max(1, Math.round(o.W));
  const H = Math.max(1, Math.round(o.H));
  const scale = o.scale || 1;

  // A drawing buffer bigger than the GPU allows is silently clamped, and the
  // export comes back soft with nothing said about why. Ask the driver rather
  // than guessing, and if the ask is too big, render at the largest ratio that
  // fits and report the pass as incomplete so the user is told the file is not
  // what they asked for.
  let ratio = scale;
  const cap = maxWebglDimension();
  if (Math.max(W, H) > cap) {
    ratio = Math.max(1, scale * cap / Math.max(W, H));
    console.warn('[vector] export asked for ' + W + '×' + H + ' but this GPU caps a drawing buffer at '
      + cap + 'px; rendering the ground at ' + ratio.toFixed(2) + '× instead.');
  }

  // CSS pixels; the device-pixel size is this times `ratio`. Parked off-screen
  // rather than hidden, exactly as the Leaflet export host is: MapLibre needs a
  // laid-out box, and `display:none` would give it a 0×0 viewport.
  const cssW = Math.max(1, Math.round(W / scale));
  const cssH = Math.max(1, Math.round(H / scale));

  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:-' + (cssW + 400) + 'px;top:0;width:' + cssW + 'px;height:' + cssH + 'px;'
    + 'overflow:hidden;pointer-events:none;z-index:-1;';
  document.body.appendChild(host);

  let gl = null;
  try {
    gl = new maplibregl.Map({
      container: host,
      style: spec.styleUrl,
      center: [o.center.lng, o.center.lat],
      zoom: vectorZoomFor(o.zoom),      // `o.zoom` is a Leaflet zoom, like everywhere else
      minZoom: vectorZoomFor(0),
      interactive: false,
      attributionControl: false,
      preserveDrawingBuffer: true,      // without this the canvas reads back blank
      fadeDuration: 0,                  // or symbols are captured mid-fade-in
      pixelRatio: ratio,
      maxZoom: vectorZoomFor(24),
    });
    // Set again through the documented setter as well as the constructor
    // option: which of the two a given MapLibre honours has moved between
    // versions, and getting it wrong is the difference between a 4× export and
    // a 1× one upscaled — a distinction that is invisible in the code and
    // obvious in the file.
    if (typeof gl.setPixelRatio === 'function') { try { gl.setPixelRatio(ratio); } catch (e) { /* older build */ } }

    const complete = await whenVectorIdle(gl, o.budgetMs || (30000 + scale * scale * 15000));

    // The same filters the operator set on screen, so the deliverable matches
    // what they composed. Applied after idle and followed by a second wait,
    // because hiding a layer is a change that has to be drawn like any other.
    try {
      applyVectorLayerPrefs(gl);
      await whenVectorIdle(gl, 8000);
    } catch (e) { /* style not filterable; the ground is still correct */ }

    const src = gl.getCanvas();
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    // Explicit destination dimensions, always. The source is `cssW × cssH ×
    // ratio` device pixels, which is W × H only when nothing was rounded or
    // clamped; drawing it without a destination size is how a vector export
    // comes out half-size or quarter-resolution.
    ctx.drawImage(src, 0, 0, W, H);

    // A ground that drew nothing is a blank export, and shipping one silently
    // is the failure this whole function exists to avoid.
    return { canvas, complete: complete && !canvasLooksBlank(canvas) };
  } catch (e) {
    console.warn('[vector] export ground failed:', e && e.message);
    return { canvas: null, complete: false };
  } finally {
    if (gl) { try { gl.remove(); } catch (e) { /* already gone */ } }
    host.remove();
  }
}

/**
 * Resolve when the GL map has nothing left to draw, or the budget runs out.
 * @param {maplibregl.Map} gl @param {number} budgetMs
 * @returns {Promise<boolean>} false when it timed out with work outstanding.
 */
function whenVectorIdle(gl, budgetMs) {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (done) return; done = true; clearTimeout(timer); resolve(ok); };
    const timer = setTimeout(() => finish(false), budgetMs);
    // `once('idle')` alone would hang forever on a style that never loads, and
    // a tile host that 403s is exactly that case — hence the budget above.
    try { gl.once('idle', () => finish(true)); } catch (e) { finish(false); }
  });
}

/** The largest drawing buffer this GPU will give us, or a safe guess. */
function maxWebglDimension() {
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!ctx) return 4096;
    return Math.min(ctx.getParameter(ctx.MAX_RENDERBUFFER_SIZE) || 8192,
      ctx.getParameter(ctx.MAX_TEXTURE_SIZE) || 8192);
  } catch (e) { return 4096; }
}

/**
 * Is this canvas a single flat colour?
 *
 * Cheap proof that the ground actually drew something. A GL canvas read back
 * without `preserveDrawingBuffer`, or before its first frame, comes back
 * uniformly transparent or uniformly black — and both of those satisfy every
 * structural assertion you can write about a canvas while being exactly the
 * blank export this is guarding against.
 *
 * @param {HTMLCanvasElement} canvas @returns {boolean}
 */
function canvasLooksBlank(canvas) {
  try {
    const s = 24;
    const probe = document.createElement('canvas');
    probe.width = s; probe.height = s;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, s, s);
    const d = ctx.getImageData(0, 0, s, s).data;
    for (let i = 4; i < d.length; i += 4) {
      if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2] || d[i + 3] !== d[3]) return false;
    }
    return true;
  } catch (e) {
    return false;    // unreadable is not the same as blank; do not cry wolf
  }
}

/* ---------------------------------------------------------------------------
 * Honest note on what was verified
 * ---------------------------------------------------------------------------
 *
 * Written and shipped from an environment where `tiles.openfreemap.org` returns
 * 403 through the agent proxy, along with every other CDN and tile host. What
 * was checked here: that the vendored renderer loads and constructs a map, that
 * the host mounts under Leaflet's panes and is torn down symmetrically, that the
 * centre and zoom mirror Leaflet's within tolerance across a pan and three
 * zooms including a fractional one, that a layer toggle reaches
 * setLayoutProperty and survives a reload, and that the raster path is
 * unchanged — all against a local style fixture served from the test server.
 *
 * What was NOT checked, and has to be looked at on a machine that can reach the
 * tiles: that OpenFreeMap's Liberty style draws, that VECTOR_LAYER_GROUPS
 * classifies its real layer names usefully, that VECTOR_MEDICAL_CLASSES matches
 * its POI data, and that the export ground comes back at the right resolution.
 * The feature is off by default for exactly this reason.
 * ------------------------------------------------------------------------- */
