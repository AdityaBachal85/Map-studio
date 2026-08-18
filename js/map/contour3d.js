/**
 * map/contour3d.js — the oblique relief view.
 *
 * Leaflet cannot tilt. The "3D tilt" already in the app is a CSS perspective
 * transform on a flat map: convincing at a glance, and still a flat picture
 * leaning backwards — ridges do not stand up and valleys do not cut in. Real
 * relief needs a terrain mesh, so this hands the view to MapLibre, which has
 * one, and which is already vendored for the vector basemap.
 *
 * WHAT IT BUILDS. The same DEM the contours came from, declared as a
 * `raster-dem` source in terrarium encoding, driving `setTerrain`. The active
 * basemap goes underneath as ordinary raster tiles. The contour map itself is
 * draped over the top as a `canvas` source pinned to the study area's four
 * corners — a canvas rather than an image because the operator can change the
 * interval or the ramp while the 3D view is up, and a canvas source re-reads
 * its pixels without the map being torn down and rebuilt.
 *
 * MOUNTING IS SYMMETRIC. Everything this turns on is turned off again in
 * unmountContour3d, including the things it borrows from elsewhere — the tilt
 * slider it disables, the Leaflet container it hides. The vector ground learnt
 * that lesson the hard way; a half-restored map is worse than one that never
 * changed.
 *
 * IN THE legacy/ SNAPSHOTS this declines and says so. Those single-file builds
 * deliberately do not carry MapLibre (see map/vectorBasemap.js), so the loader
 * fails and the view stays 2D rather than half-appearing.
 */

const CONTOUR_3D_PITCH = 62;
const CONTOUR_3D_HOST_CLASS = 'contour-3d-host';
const CONTOUR_DEM_SOURCE = {
  type: 'raster-dem',
  tiles: [TERRAIN_TILE_URL],
  encoding: 'terrarium',
  tileSize: 256,
  maxzoom: TERRAIN_MAX_ZOOM,
  attribution: TERRAIN_CREDIT,
};

let _c3dMap = null;
let _c3dHost = null;
let _c3dCanvas = null;

/** Is the oblique view up? */
function contour3dActive() { return !!_c3dMap; }

/**
 * What the oblique view is actually doing, for the panel and for diagnostics.
 *
 * Reported rather than assumed: `setTerrain` can be refused — a DEM source that
 * will not load leaves a tilted flat map, which looks enough like the real
 * thing to be believed. Anything asking whether relief is on should ask the
 * renderer, not the checkbox.
 *
 * @returns {{active:boolean, terrain:boolean, exaggeration:number, drape:boolean, pitch:number}}
 */
function contour3dStatus() {
  if (!_c3dMap) return { active: false, terrain: false, exaggeration: 0, drape: false, pitch: 0 };
  let terrain = false, exaggeration = 0;
  try {
    const t = _c3dMap.getTerrain && _c3dMap.getTerrain();
    terrain = !!t;
    exaggeration = t ? t.exaggeration : 0;
  } catch (e) { /* older build without the getter */ }
  return {
    active: true,
    terrain,
    exaggeration,
    drape: !!(_c3dMap.getSource && _c3dMap.getSource('drape')),
    pitch: _c3dMap.getPitch ? _c3dMap.getPitch() : 0,
  };
}

/* ---------------------------------------------------------------------------
 * The basemap underneath
 * ------------------------------------------------------------------------- */

/**
 * The active raster basemap, as a MapLibre source.
 *
 * MapLibre has no `{s}` subdomain placeholder, so a template that uses one is
 * expanded into one tile URL per subdomain — which is what the placeholder
 * meant anyway. A vector ground has no tile template at all; there, the style
 * is loaded whole and this returns null.
 */
function contour3dGroundSource() {
  if (typeof BASEMAPS === 'undefined' || typeof activeKey === 'undefined') return null;
  const entry = BASEMAPS[activeKey];
  const spec = entry && entry.spec;
  if (!spec || !spec.layers || !spec.layers.length) return null;

  const lyr = spec.layers.find(l => l.role !== 'reference') || spec.layers[0];
  const raw = (typeof basemapUrl === 'function') ? basemapUrl(lyr.url, spec) : lyr.url;
  const subs = lyr.subdomains || 'abc';
  const tiles = raw.indexOf('{s}') >= 0
    ? subs.split('').map(c => raw.replace(/\{s\}/g, c))
    : [raw];

  return {
    source: {
      type: 'raster', tiles,
      tileSize: lyr.tileSize || 256,
      maxzoom: Math.min(19, lyr.maxNative || 19),
      attribution: spec.credit || '',
    },
    // A ground the export cannot legally or technically reproduce is still
    // fine to look at here — this view is for the screen.
    ok: true,
  };
}

/* ---------------------------------------------------------------------------
 * Mount / unmount
 * ------------------------------------------------------------------------- */

/** Turn the oblique view on or off. @param {boolean} on */
async function setContour3d(on) {
  if (on && !_c3dMap) {
    const ok = await mountContour3d();
    const tgl = $('contour3dTgl');
    if (tgl) tgl.checked = ok;
    contourState.mode = ok ? '3d' : '2d';
    return ok;
  }
  if (!on && _c3dMap) { unmountContour3d(); contourState.mode = '2d'; }
  return false;
}

async function mountContour3d() {
  if (!contourModel.ready) {
    status('Generate a contour map first — the 3D view needs one to drape.');
    return false;
  }
  if (typeof loadMapLibre !== 'function') { status('The 3D view is not available in this build.'); return false; }

  const ready = await loadMapLibre();
  if (!ready || typeof maplibregl === 'undefined') {
    status('Could not load the 3D renderer. Staying with the flat map.');
    return false;
  }

  const wrap = $('mapWrap');
  if (!wrap) return false;

  _c3dHost = document.createElement('div');
  _c3dHost.className = CONTOUR_3D_HOST_CLASS;
  // Inline, not from the stylesheet. MapLibre's own CSS is injected into <head>
  // at load time, which puts it AFTER refine.css in the cascade, and
  // `.maplibregl-map { position: relative }` beats a `.contour-3d-host` rule of
  // equal specificity that arrived earlier. The host then stopped being
  // absolutely positioned, `inset: 0` no longer stretched it, its height
  // collapsed to zero, and MapLibre sized its canvas to the 300px a <canvas>
  // defaults to — a view that rendered perfectly into a buffer nobody could
  // see. map/vectorBasemap.js styles its host inline for the same reason.
  _c3dHost.style.cssText = 'position:absolute;inset:0;z-index:450;';
  wrap.appendChild(_c3dHost);
  // The class is what hides the Leaflet map, the billboard pins and the tilt
  // stage — one switch, and CSS decides what a 3D view is not showing.
  wrap.classList.add('contour-3d-on');

  const ground = contour3dGroundSource();
  const corners = contourDrapeCorners();
  _c3dCanvas = contourDrapeCanvas();

  const sources = { dem: CONTOUR_DEM_SOURCE };
  const layers = [{ id: 'sky-bg', type: 'background', paint: { 'background-color': '#0d1522' } }];
  if (ground) {
    sources.ground = ground.source;
    layers.push({ id: 'ground', type: 'raster', source: 'ground', paint: { 'raster-opacity': 1 } });
  }
  if (_c3dCanvas && corners) {
    sources.drape = { type: 'canvas', canvas: _c3dCanvas, coordinates: corners, animate: false };
    layers.push({ id: 'drape', type: 'raster', source: 'drape', paint: { 'raster-opacity': 1 } });
  }

  const centre = contour3dCentre();
  _c3dMap = new maplibregl.Map({
    container: _c3dHost,
    style: { version: 8, sources, layers },
    center: [centre.lng, centre.lat],
    // MapLibre's world is 512px per tile against Leaflet's 256, so its zoom
    // numbers run one lower for the same scale — the same offset the vector
    // ground carries, and for the same reason.
    zoom: (typeof map !== 'undefined' ? map.getZoom() : 13) - 1,
    pitch: CONTOUR_3D_PITCH,
    bearing: 0,
    attributionControl: false,
    preserveDrawingBuffer: true,
    fadeDuration: 0,
    maxPitch: 80,
  });

  _c3dMap.dragRotate.enable();
  _c3dMap.touchZoomRotate.enableRotation();

  await new Promise(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    _c3dMap.once('load', done);
    setTimeout(done, 12000);
  });

  // Framed to the study area rather than centred on it. A pitched camera looks
  // along the ground rather than down at it, so a centre that is correct on a
  // flat map puts the area in the bottom third of a tilted one — fitBounds
  // solves for the pitch instead of ignoring it.
  const fit = contourBounds();
  if (fit) {
    try {
      _c3dMap.fitBounds(
        [[fit.west, fit.south], [fit.east, fit.north]],
        { padding: 40, pitch: CONTOUR_3D_PITCH, bearing: 0, duration: 0 });
    } catch (e) { /* keep the constructor's camera */ }
  }

  try {
    _c3dMap.setTerrain({ source: 'dem', exaggeration: contourState.exaggeration });
  } catch (e) {
    // The mesh is the point, but a view without it is still a tilted map with
    // the contours on it, which beats refusing to open.
    status('Terrain mesh unavailable — showing the tilted map without relief.');
  }

  contour3dLockTiltSlider(true);
  status('3D relief: drag to orbit, right-drag to tilt. Turn it off to go back to the flat map.');
  return true;
}

function unmountContour3d() {
  contour3dLockTiltSlider(false);
  if (_c3dMap) {
    try { _c3dMap.setTerrain(null); } catch (e) { /* already gone */ }
    try { _c3dMap.remove(); } catch (e) { /* already gone */ }
  }
  _c3dMap = null;
  if (_c3dHost && _c3dHost.parentNode) _c3dHost.parentNode.removeChild(_c3dHost);
  _c3dHost = null;
  _c3dCanvas = null;

  const wrap = $('mapWrap');
  if (wrap) wrap.classList.remove('contour-3d-on');
  // Leaflet caches its container size and will have missed being hidden.
  if (typeof map !== 'undefined') setTimeout(() => map.invalidateSize({ animate: false }), 0);
}

/**
 * The CSS tilt and this cannot both be on: one fakes depth by leaning a flat
 * picture, the other builds the real thing, and together they lean the real
 * one. Disabled with an explanation rather than silently ignored.
 */
function contour3dLockTiltSlider(locked) {
  const el = $('tiltRange');
  if (!el) return;
  el.disabled = !!locked;
  el.title = locked
    ? 'Turned off while the 3D relief view is on — that view has its own camera.'
    : '';
  if (locked && Number(el.value) !== 0) {
    el._contourPrevTilt = el.value;
    el.value = 0;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (!locked && el._contourPrevTilt != null) {
    el.value = el._contourPrevTilt;
    delete el._contourPrevTilt;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** Centre the camera on the study area rather than on the old map centre. */
function contour3dCentre() {
  const b = contourBounds();
  if (b) return { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 };
  if (typeof map !== 'undefined') return map.getCenter();
  return { lat: 0, lng: 0 };
}

/* ---------------------------------------------------------------------------
 * Live updates
 * ------------------------------------------------------------------------- */

/** Redraw the drape after the contours changed. Cheap: no style reload. */
function contour3dRedrape() {
  if (!_c3dMap || !_c3dCanvas) return;
  const fresh = contourDrapeCanvas();
  if (!fresh) return;
  const ctx = _c3dCanvas.getContext('2d');
  // Painted into the SAME canvas element the source is holding. Swapping the
  // element would mean removing and re-adding the source and its layer, which
  // flickers the whole drape; repainting in place is one texture upload.
  if (fresh.width === _c3dCanvas.width && fresh.height === _c3dCanvas.height) {
    ctx.clearRect(0, 0, _c3dCanvas.width, _c3dCanvas.height);
    ctx.drawImage(fresh, 0, 0);
    const src = _c3dMap.getSource('drape');
    if (src && typeof src.play === 'function') { src.play(); src.pause(); }
    _c3dMap.triggerRepaint();
    return;
  }
  // A new grid is a new size, so the source has to be rebuilt.
  _c3dCanvas = fresh;
  const corners = contourDrapeCorners();
  try {
    if (_c3dMap.getLayer('drape')) _c3dMap.removeLayer('drape');
    if (_c3dMap.getSource('drape')) _c3dMap.removeSource('drape');
    _c3dMap.addSource('drape', { type: 'canvas', canvas: fresh, coordinates: corners, animate: false });
    _c3dMap.addLayer({ id: 'drape', type: 'raster', source: 'drape', paint: { 'raster-opacity': 1 } });
  } catch (e) { /* mid-teardown */ }
}

/** @param {number} v vertical exaggeration */
function contour3dSetExaggeration(v) {
  contourState.exaggeration = v;
  if (!_c3dMap) return;
  try { _c3dMap.setTerrain({ source: 'dem', exaggeration: v }); } catch (e) { /* no mesh */ }
}

/**
 * The oblique view as a canvas, for export.
 *
 * Same approach as renderVectorGroundCanvas: the live GL map already has
 * `preserveDrawingBuffer`, so its own canvas can be copied straight out at
 * whatever size the export wants. A second offscreen map is not built — the
 * camera here is something the operator aimed by hand, and recreating it from
 * numbers is how an export stops matching the screen.
 *
 * @param {object} o `{W, H}`
 * @returns {HTMLCanvasElement|null}
 */
function renderContour3dCanvas(o) {
  if (!_c3dMap) return null;
  try {
    _c3dMap.triggerRepaint();
    const src = _c3dMap.getCanvas();
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
