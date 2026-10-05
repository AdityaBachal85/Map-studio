/**
 * map/map3d.js — the map, in three dimensions.
 *
 * Leaflet cannot tilt. The "3D tilt" already in this app is a CSS perspective
 * transform on a flat map: convincing at a glance, and still a flat picture
 * leaning backwards — ridges do not stand up and valleys do not cut in. Real
 * relief needs a terrain mesh, so this hands the view to MapLibre, which has
 * one, and which is already vendored for the vector basemap.
 *
 * IT IS A MODE, NOT A FEATURE OF THE CONTOUR MAP. This started life as the
 * oblique view for a contour selection and was gated on having one, which was
 * backwards: the terrain is the whole world, the contour map is one rectangle
 * on it. Switching to 3D now works with nothing on the map at all, and anything
 * that IS on it comes along — see map3dContent.js.
 *
 * WHAT IT BUILDS
 *   - the same DEM the contours use, as a `raster-dem` source in terrarium
 *     encoding, driving `setTerrain`
 *   - the active basemap underneath: raster tiles for a raster ground, or the
 *     vector ground's own style loaded whole
 *   - the contour map, if there is one, draped as a `canvas` source pinned to
 *     the study area's corners — a canvas rather than an image because the
 *     interval or the ramp can change while the view is up
 *   - everything else on the map, re-emitted (map3dContent.js)
 *
 * MOUNTING IS SYMMETRIC. Everything this turns on is turned off again,
 * including what it borrows: the tilt slider it disables, the Leaflet container
 * it hides, the camera it moved. A half-restored map is worse than one that
 * never changed.
 *
 * IN THE legacy/ SNAPSHOTS this declines and says so. Those single-file builds
 * deliberately do not carry MapLibre (see map/vectorBasemap.js), so the loader
 * fails and the view stays flat rather than half-appearing.
 */

const MAP_3D_PITCH = 60;
const MAP_3D_HOST_CLASS = 'map-3d-host';
/**
 * MapLibre's world is 512 px per tile against Leaflet's 256, so its zoom
 * numbers run one lower for the same scale. The vector ground carries the same
 * offset for the same reason; getting it wrong renders the ground at twice the
 * size and looks like a projection bug.
 */
const MAP_3D_ZOOM_OFFSET = -1;

const MAP_3D_DEM_SOURCE = {
  type: 'raster-dem',
  tiles: [TERRAIN_TILE_URL],
  encoding: 'terrarium',
  tileSize: 256,
  maxzoom: TERRAIN_MAX_ZOOM,
  attribution: TERRAIN_CREDIT,
};

let _m3dMap = null;
let _m3dHost = null;
/** Drape canvases by contour-map id — one texture each. */
const _m3dDrapes = new Map();
let _m3dMounting = false;
/**
 * Bumped by every mount and every unmount.
 *
 * Mounting is several awaits long — a renderer to load, a style to parse — and
 * the operator can press 2D in the middle of it. Without a token the abandoned
 * mount carries on after the teardown and reaches for a host that is no longer
 * there. Same guard, and same reason, as contourRun in map/contourMap.js.
 */
let _m3dRun = 0;

/** Is the 3D view up? */
function map3dActive() { return !!_m3dMap; }

/** The live MapLibre map, for the modules that decorate it. @returns {object|null} */
function map3dGl() { return _m3dMap; }

/**
 * What the 3D view is actually doing, for the controls and for diagnostics.
 *
 * Reported rather than assumed: `setTerrain` can be refused — a DEM source that
 * will not load leaves a tilted flat map, which looks enough like the real
 * thing to be believed. Anything asking whether relief is on should ask the
 * renderer, not the button.
 *
 * @returns {{active:boolean, terrain:boolean, exaggeration:number, drape:boolean,
 *            pitch:number, bearing:number, ground:string}}
 */
function map3dStatus() {
  if (!_m3dMap) {
    return { active: false, terrain: false, exaggeration: 0, drape: false, pitch: 0, bearing: 0, ground: '' };
  }
  let terrain = false, exaggeration = 0;
  try {
    const t = _m3dMap.getTerrain && _m3dMap.getTerrain();
    terrain = !!t;
    exaggeration = t ? t.exaggeration : 0;
  } catch (e) { /* older build without the getter */ }
  return {
    active: true,
    terrain,
    exaggeration,
    drape: _m3dDrapes.size > 0,
    pitch: _m3dMap.getPitch ? _m3dMap.getPitch() : 0,
    bearing: _m3dMap.getBearing ? _m3dMap.getBearing() : 0,
    ground: _m3dGroundKind,
  };
}

let _m3dGroundKind = '';

/* ---------------------------------------------------------------------------
 * The ground underneath
 * ------------------------------------------------------------------------- */

/**
 * The active basemap, described for MapLibre.
 *
 * Raster grounds become a `raster` source built from the same tile template
 * Leaflet is using, so the 3D view shows the basemap the operator actually
 * chose rather than a stand-in. Two placeholders need translating: MapLibre has
 * no `{s}` subdomain token, so a template using one is expanded into one URL
 * per subdomain — which is what the placeholder meant anyway — and `{token}`
 * is substituted by the app's own basemapUrl().
 *
 * A vector ground has no tile template at all; its style is loaded whole
 * instead, and this returns `{ styleUrl }` for the caller to hand to MapLibre.
 *
 * @returns {{kind:string, source?:object, styleUrl?:string}|null}
 */
function map3dGroundSource() {
  if (typeof BASEMAPS === 'undefined' || typeof activeKey === 'undefined') return null;
  const entry = BASEMAPS[activeKey];
  const spec = entry && entry.spec;
  if (!spec) return null;

  if (typeof isVectorSpec === 'function' && isVectorSpec(spec)) {
    return { kind: 'vector', styleUrl: spec.styleUrl };
  }
  if (!spec.layers || !spec.layers.length) return null;

  const lyr = spec.layers.find(l => l.role !== 'reference') || spec.layers[0];
  const raw = (typeof basemapUrl === 'function') ? basemapUrl(lyr.url, spec) : lyr.url;
  const subs = lyr.subdomains || 'abc';
  const tiles = raw.indexOf('{s}') >= 0
    ? subs.split('').map(c => raw.replace(/\{s\}/g, c))
    : [raw];

  return {
    kind: 'raster',
    source: {
      type: 'raster', tiles,
      tileSize: lyr.tileSize || 256,
      maxzoom: Math.min(19, lyr.maxNative || 19),
      attribution: spec.credit || '',
    },
  };
}

/* ---------------------------------------------------------------------------
 * Mount / unmount
 * ------------------------------------------------------------------------- */

/**
 * Switch between the flat map and the 3D one.
 * @param {boolean} on
 * @returns {Promise<boolean>} whether 3D is up afterwards
 */
async function setMap3d(on) {
  if (on && !_m3dMap && !_m3dMounting) {
    const ok = await mountMap3d();
    if (typeof syncMap3dControls === 'function') syncMap3dControls();
    return ok;
  }
  if (!on && _m3dMap) {
    await unmountMap3d();
    if (typeof syncMap3dControls === 'function') syncMap3dControls();
  }
  return !!_m3dMap;
}

async function mountMap3d() {
  if (typeof loadMapLibre !== 'function') { status('The 3D view is not available in this build.'); return false; }

  const run = ++_m3dRun;
  _m3dMounting = true;
  status('Loading the 3D view…', true);
  const ready = await loadMapLibre();
  if (run !== _m3dRun) { _m3dMounting = false; return false; }
  if (!ready || typeof maplibregl === 'undefined') {
    _m3dMounting = false;
    status('Could not load the 3D renderer. Staying with the flat map.');
    return false;
  }

  const wrap = $('mapWrap');
  if (!wrap) { _m3dMounting = false; return false; }

  _m3dHost = document.createElement('div');
  _m3dHost.className = MAP_3D_HOST_CLASS;
  // Inline, not from the stylesheet. MapLibre's own CSS is injected into <head>
  // at load time, which puts it AFTER refine.css in the cascade, and
  // `.maplibregl-map { position: relative }` beats a `.map-3d-host` rule of
  // equal specificity that arrived earlier. The host then stopped being
  // absolutely positioned, `inset: 0` no longer stretched it, its height
  // collapsed to zero, and MapLibre sized its canvas to the 300px a <canvas>
  // defaults to — a view that rendered perfectly into a buffer nobody could
  // see. map/vectorBasemap.js styles its host inline for the same reason.
  _m3dHost.style.cssText = 'position:absolute;inset:0;z-index:450;';
  wrap.appendChild(_m3dHost);
  // One switch, and CSS decides what the 3D view is not showing.
  wrap.classList.add('map-3d-on');

  const ground = map3dGroundSource();
  _m3dGroundKind = ground ? ground.kind : 'none';

  // The camera starts exactly where the flat map was looking. Pressing 3D
  // should tilt the place you are looking at, not travel somewhere.
  const centre = (typeof map !== 'undefined') ? map.getCenter() : { lat: 0, lng: 0 };
  const zoom = ((typeof map !== 'undefined') ? map.getZoom() : 13) + MAP_3D_ZOOM_OFFSET;

  const opts = {
    container: _m3dHost,
    center: [centre.lng, centre.lat],
    zoom,
    // Starts FLAT, at the same centre and scale as the map it is replacing, and
    // tilts back once it has drawn. That one movement is the whole explanation
    // of what just happened: the map you were looking at is the map that stood
    // up. Cutting straight to a tilted view of the same place reads as a jump
    // somewhere else. Google Earth does the same thing for the same reason.
    pitch: 0,
    bearing: 0,
    attributionControl: false,
    preserveDrawingBuffer: true,
    fadeDuration: 0,
    maxPitch: 80,
    maxZoom: 21,
  };

  if (ground && ground.kind === 'vector') {
    // The vector ground's style is a whole document with its own sources,
    // layers, glyphs and sprite. Synthesising a style around it would mean
    // reimplementing it; loading it and adding to it is what MapLibre is for.
    opts.style = ground.styleUrl;
  } else {
    const sources = { dem: MAP_3D_DEM_SOURCE };
    const layers = [{ id: 'sky-bg', type: 'background', paint: { 'background-color': '#0d1522' } }];
    if (ground) {
      sources.ground = ground.source;
      layers.push({ id: 'ground', type: 'raster', source: 'ground', paint: { 'raster-opacity': 1 } });
    }
    opts.style = { version: 8, sources, layers };
  }

  _m3dMap = new maplibregl.Map(opts);
  // Faded in rather than swapped: the GL canvas is empty for the first frames,
  // and a hard swap shows a hole where the map was.
  _m3dHost.style.opacity = '0';
  _m3dHost.style.transition = map3dMotionOff() ? '' : 'opacity 220ms ease-out';
  _m3dMap.dragRotate.enable();
  _m3dMap.touchZoomRotate.enableRotation();
  _m3dMap.keyboard.enable();

  // `style.load`, not `load`. `load` waits for the first complete render, which
  // means waiting for TILES — so a slow or unreachable basemap left the view
  // sitting flat and blank for the whole timeout before it tilted. The style
  // being parsed is the only thing setTerrain actually needs, and it arrives in
  // milliseconds regardless of the network.
  const loaded = await new Promise(resolve => {
    let settled = false;
    const done = ok => { if (!settled) { settled = true; resolve(ok); } };
    if (_m3dMap.isStyleLoaded && _m3dMap.isStyleLoaded()) done(true);
    _m3dMap.once('style.load', () => done(true));
    _m3dMap.once('error', () => { /* a failed tile is not a failed mount */ });
    setTimeout(() => done(false), 8000);
  });
  if (run !== _m3dRun) { _m3dMounting = false; return false; }

  // The DEM has to be added by hand when the style came from a URL — it has no
  // idea this app wants terrain.
  if (ground && ground.kind === 'vector') {
    try {
      if (!_m3dMap.getSource('dem')) _m3dMap.addSource('dem', MAP_3D_DEM_SOURCE);
    } catch (e) { /* style still settling */ }
  }

  try {
    _m3dMap.setTerrain({ source: 'dem', exaggeration: map3dExaggeration() });
  } catch (e) {
    status('Terrain mesh unavailable — showing the tilted map without relief.');
  }

  map3dAttachDrape();
  if (typeof map3dAddContent === 'function') map3dAddContent(_m3dMap);

  // `render` rather than `move`: the camera also settles under inertia, and the
  // ground itself shifts as terrain tiles arrive, both of which move where a
  // pin belongs without a move event. scheduleRepaint coalesces to one repaint
  // per frame, so subscribing to every frame costs nothing extra.
  if (typeof scheduleRepaint === 'function') {
    _m3dMap.on('render', scheduleRepaint);
    _m3dMap.on('move', scheduleRepaint);
    scheduleRepaint();
  }

  map3dLockTiltSlider(true);

  _m3dHost.style.opacity = '1';
  if (map3dMotionOff()) {
    _m3dMap.jumpTo({ pitch: MAP_3D_PITCH });
  } else {
    // Long enough to read as the ground tilting, short enough not to be a wait.
    _m3dMap.easeTo({ pitch: MAP_3D_PITCH, duration: 650, easing: t => 1 - Math.pow(1 - t, 3) });
  }
  _m3dMounting = false;

  // Every gesture the camera answers to, named. The view was reported as being
  // stuck at one fixed angle when in fact three separate things could move it —
  // they were simply never said out loud, and "right-drag" alone reads as an
  // afterthought rather than as the way round. The navigator on the right is
  // the visible version of the same two capabilities.
  status(loaded
    ? '3D view: drag to pan \u00b7 Ctrl-drag, right-drag or two fingers to orbit and tilt '
      + '\u00b7 or spin the compass and lean the slider on the right.'
    : '3D view opened, but the ground is still loading.');
  if (typeof syncMap3dControls === 'function') syncMap3dControls();
  return true;
}

/** True when the operator has asked for less motion. */
function map3dMotionOff() {
  return typeof motionReduced === 'function' ? motionReduced() : false;
}

/**
 * Flatten, then tear down.
 *
 * The reverse of the mount, and deliberately quicker: an exit that takes as
 * long as the entrance feels like the interface arguing about whether to let
 * you leave. Roughly two thirds is the usual ratio.
 */
async function unmountMap3d() {
  // Cancels any mount still in flight before anything is torn down.
  _m3dRun++;
  _m3dMounting = false;
  if (_m3dMap && !map3dMotionOff()) {
    try {
      _m3dMap.easeTo({ pitch: 0, bearing: 0, duration: 420, easing: t => t * (2 - t) });
      await new Promise(r => setTimeout(r, 430));
    } catch (e) { /* already gone */ }
  }
  map3dLockTiltSlider(false);

  // Carry the camera back, so pressing 2D leaves you looking at the place you
  // were looking at rather than wherever the flat map was last parked.
  let centre = null, zoom = null;
  if (_m3dMap) {
    try {
      const c = _m3dMap.getCenter();
      centre = [c.lat, c.lng];
      zoom = _m3dMap.getZoom() - MAP_3D_ZOOM_OFFSET;
    } catch (e) { /* already gone */ }
    if (typeof map3dRemoveContent === 'function') map3dRemoveContent(_m3dMap);
    try { _m3dMap.setTerrain(null); } catch (e) { /* already gone */ }
    try { _m3dMap.remove(); } catch (e) { /* already gone */ }
  }
  _m3dMap = null;
  _m3dDrapes.clear();
  _m3dGroundKind = '';

  if (_m3dHost && _m3dHost.parentNode) _m3dHost.parentNode.removeChild(_m3dHost);
  _m3dHost = null;

  const wrap = $('mapWrap');
  if (wrap) wrap.classList.remove('map-3d-on');

  if (typeof scheduleRepaint === 'function') scheduleRepaint();

  if (typeof map !== 'undefined') {
    // Leaflet caches its container size and will have missed being hidden, so
    // the flat map comes back 0x0 without this.
    setTimeout(() => {
      map.invalidateSize({ animate: false });
      if (centre && isFinite(zoom)) map.setView(centre, Math.max(0, Math.min(MAX_MAP_ZOOM, zoom)), { animate: false });
    }, 0);
  }
}

/**
 * The CSS tilt and this cannot both be on: one fakes depth by leaning a flat
 * picture, the other builds the real thing, and together they lean the real
 * one. Disabled with an explanation rather than silently ignored.
 */
function map3dLockTiltSlider(locked) {
  const el = $('tiltRange');
  if (!el) return;
  el.disabled = !!locked;
  el.title = locked
    ? 'Turned off while the 3D view is on — that view has its own camera.'
    : '';
  if (locked && Number(el.value) !== 0) {
    el._map3dPrevTilt = el.value;
    el.value = 0;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (!locked && el._map3dPrevTilt != null) {
    el.value = el._map3dPrevTilt;
    delete el._map3dPrevTilt;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/* ---------------------------------------------------------------------------
 * Camera
 * ------------------------------------------------------------------------- */

/** Point the camera due north, keeping the tilt. The compass control's job. */
function map3dResetNorth() {
  if (!_m3dMap) return;
  _m3dMap.easeTo({ bearing: 0, duration: 300 });
}

/** @param {number} deg absolute pitch, 0 (flat) to 80 */
function map3dSetPitch(deg) {
  if (!_m3dMap) return;
  _m3dMap.easeTo({ pitch: Math.max(0, Math.min(80, deg)), duration: 200 });
}

/** @returns {number} the camera's pitch in degrees, or 0 when 3D is off */
function map3dPitch() {
  return _m3dMap && _m3dMap.getPitch ? _m3dMap.getPitch() : 0;
}

/** @returns {number} the camera's bearing in degrees, or 0 when 3D is off */
function map3dBearing() {
  return _m3dMap && _m3dMap.getBearing ? _m3dMap.getBearing() : 0;
}

/**
 * Point the camera at an absolute bearing.
 *
 * `jumpTo` rather than `easeTo` when live: this is driven by a drag, and easing
 * every pointermove queues a 200ms animation per frame, which fights the next
 * one and turns a smooth spin into a stutter. The widget eases only when it is
 * setting a bearing the user did not drag to.
 *
 * @param {number} deg @param {boolean} [animate]
 */
function map3dSetBearing(deg, animate) {
  if (!_m3dMap) return;
  const b = ((Number(deg) || 0) % 360 + 360) % 360;
  if (animate) _m3dMap.easeTo({ bearing: b, duration: 220 });
  else _m3dMap.jumpTo({ bearing: b });
}

/** Frame a bounding box, solving for the pitch rather than ignoring it. */
function map3dFitBounds(b, padding) {
  if (!_m3dMap || !b) return;
  try {
    _m3dMap.fitBounds([[b.west, b.south], [b.east, b.north]],
      { padding: padding == null ? 40 : padding, pitch: _m3dMap.getPitch(), duration: 0 });
  } catch (e) { /* degenerate box */ }
}

/* ---------------------------------------------------------------------------
 * Where a coordinate lands on screen
 * ------------------------------------------------------------------------- */

/**
 * Project a coordinate through the 3D camera, for the billboard overlay.
 *
 * THE PINS AND LABELS ARE NOT REBUILT FOR 3D. map/billboard.js has always been
 * a screen-space overlay: it asks one function where a coordinate landed and
 * then positions DOM there — pins, label chips, their offsets, the leader lines
 * between them, the drag handling, the hover link to the sidebar card. All of
 * that is projection-independent. So rather than cloning several hundred lines
 * of it into MapLibre markers and losing the leader lines on the way, the
 * projection is swapped and the overlay carries on unchanged.
 *
 * Returns null when 3D is not up, so the caller falls through to Leaflet's own
 * projection.
 *
 * @param {L.LatLng} latlng
 * @returns {{x:number, y:number, s:number}|null}
 */
function map3dProjectPin(latlng) {
  if (!_m3dMap) return null;
  try {
    const lat = latlng.lat, lng = latlng.lng;
    // Behind the camera, `project` returns a point that is mirrored into view —
    // a pin for somewhere behind you, drawn convincingly in front. The visible
    // region is the cheap test that catches it; anything outside is pushed far
    // enough off-screen that #billboardLayer's overflow clips it.
    const b = _m3dMap.getBounds();
    if (!b.contains([lng, lat])) return { x: -9999, y: -9999, s: 1 };
    const p = _m3dMap.project([lng, lat]);
    if (!isFinite(p.x) || !isFinite(p.y)) return { x: -9999, y: -9999, s: 1 };
    // Scale stays 1: a placemark that shrinks with distance is a placemark you
    // cannot read at the back of the view, which is why Google Earth keeps them
    // screen-sized too.
    return { x: p.x, y: p.y, s: 1 };
  } catch (e) {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * The contour drape
 * ------------------------------------------------------------------------- */

/** The exaggeration the contour panel's slider is set to, or a sane default. */
function map3dExaggeration() {
  const v = (typeof contourState !== 'undefined') ? contourState.exaggeration : 1;
  return (v > 0) ? v : 1;
}

/**
 * Put every visible contour map over the terrain.
 *
 * One `canvas` source per contour map, keyed by its id. A canvas rather than an
 * image because the interval or the ramp can change while the view is up, and a
 * canvas source re-reads its pixels without the map being torn down.
 */
function map3dAttachDrape() {
  map3dSyncDrapes();
}

/**
 * Reconcile the drapes against the contour maps that currently exist.
 *
 * Written as a reconcile rather than an add/remove pair because contour maps
 * can appear, be hidden, be rebuilt at a new size and be deleted while the 3D
 * view is up, and every one of those has to end with the GL scene matching the
 * list — not with whatever the last event happened to do.
 */
function map3dSyncDrapes() {
  if (!_m3dMap) return;
  if (typeof contourMaps === 'undefined') return;

  const wanted = new Set();

  contourMaps.forEach(rec => {
    if (!rec.model.ready || rec.settings.visible === false) return;
    if (typeof contourDrapeCanvas !== 'function') return;
    const fresh = contourDrapeCanvas(rec.model);
    const corners = contourDrapeCorners(rec.model);
    if (!fresh || !corners) return;

    const srcId = 'drape-' + rec.id;
    wanted.add(srcId);
    const held = _m3dDrapes.get(srcId);

    if (held && held.width === fresh.width && held.height === fresh.height) {
      // Painted into the SAME canvas element the source is holding. Swapping
      // the element would mean removing and re-adding the source and its layer,
      // which flickers the whole drape; repainting in place is one upload.
      const ctx = held.getContext('2d');
      ctx.clearRect(0, 0, held.width, held.height);
      ctx.drawImage(fresh, 0, 0);
      const src = _m3dMap.getSource(srcId);
      if (src && typeof src.play === 'function') { src.play(); src.pause(); }
      return;
    }

    try {
      if (_m3dMap.getLayer(srcId)) _m3dMap.removeLayer(srcId);
      if (_m3dMap.getSource(srcId)) _m3dMap.removeSource(srcId);
      _m3dMap.addSource(srcId, { type: 'canvas', canvas: fresh, coordinates: corners, animate: false });
      // Under the map's own geometry, which map3dContent.js added: a contour
      // map is ground, and the routes and shapes are drawn on the ground.
      const before = _m3dMap.getLayer('m3d-fill') ? 'm3d-fill' : undefined;
      _m3dMap.addLayer({ id: srcId, type: 'raster', source: srcId, paint: { 'raster-opacity': 1 } }, before);
      _m3dDrapes.set(srcId, fresh);
    } catch (e) { /* style still settling */ }
  });

  // Anything held that is no longer wanted — hidden, deleted, or cleared.
  Array.from(_m3dDrapes.keys()).forEach(srcId => {
    if (wanted.has(srcId)) return;
    try {
      if (_m3dMap.getLayer(srcId)) _m3dMap.removeLayer(srcId);
      if (_m3dMap.getSource(srcId)) _m3dMap.removeSource(srcId);
    } catch (e) { /* mid-teardown */ }
    _m3dDrapes.delete(srcId);
  });

  _m3dMap.triggerRepaint();
}

/** Redraw the drapes after the contours changed. Cheap: no style reload. */
function map3dRedrape() {
  map3dSyncDrapes();
}

/** @param {number} v vertical exaggeration */
function map3dSetExaggeration(v) {
  if (typeof contourState !== 'undefined') contourState.exaggeration = v;
  if (!_m3dMap) return;
  try { _m3dMap.setTerrain({ source: 'dem', exaggeration: v }); } catch (e) { /* no mesh */ }
}

/* ---------------------------------------------------------------------------
 * Export
 * ------------------------------------------------------------------------- */

/**
 * The 3D view as a canvas, for export.
 *
 * The live GL map already has `preserveDrawingBuffer`, so its own canvas can be
 * copied straight out at whatever size the export wants. A second offscreen map
 * is not built: the camera here is something the operator aimed by hand, and
 * recreating it from numbers is how an export stops matching the screen.
 *
 * @param {object} o `{W, H}`
 * @returns {HTMLCanvasElement|null}
 */
function render3dGroundCanvas(o) {
  if (!_m3dMap) return null;
  try {
    _m3dMap.triggerRepaint();
    const src = _m3dMap.getCanvas();
    if (!src || !src.width) return null;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(o.W));
    c.height = Math.max(1, Math.round(o.H));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c;
  } catch (e) {
    return null;
  }
}
