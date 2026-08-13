/**
 * map/mapOverlays.js — decide what the ground shows, not just which ground.
 *
 * THE PROBLEM. On a raster basemap the place names, the road casings and the
 * little POI icons are *painted into the tile*. By the time a PNG reaches the
 * browser they are pixels, so there is no way to hide the names on an OSM tile
 * or to show only the railway: the tile that has the railway also has
 * everything else. Asking for "just roads" of a baked tile is asking it to
 * un-bake.
 *
 * WHAT WORKS INSTEAD. Start from a ground with nothing on it and add the
 * detail back as separate transparent layers, each of which can be turned off
 * because it arrived as its own request. Positron and Light Gray Canvas are
 * already in the catalogue and are exactly that: land, water and nothing else.
 *
 * THE HONEST LIMIT, stated here because it is the first thing anyone will run
 * into: granularity stops at whatever overlay tiles exist. "Names off" and
 * "railway only" are achievable. "Hide the pharmacy icons but keep the hospital
 * ones" is not — that needs a vector basemap, where the client holds the
 * features and the styling instead of a picture of them. This is the useful
 * three-quarters of that job at a fraction of the cost, and it does not pretend
 * to be the rest.
 *
 * TILE PANE, NOT OVERLAY PANE. These are `L.tileLayer`s, so Leaflet puts them
 * in the tile pane, underneath every vector the app draws. Nothing here can
 * ever cover a route, a shape or a marker.
 */

/**
 * The layers that can be added back on top of a plain ground.
 *
 * `needsPlain` marks the ones that only make sense over a label-free ground:
 * adding place names over a basemap that already has them baked in produces
 * every name twice, slightly offset, which looks like a rendering fault.
 */
const MAP_OVERLAYS = [
  {
    id: 'labels',
    label: 'Place names',
    hint: 'Cities, suburbs and localities',
    needsPlain: true,
    url: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
    subdomains: 'abcd', maxNative: 19, zIndex: 6,
    credit: '© OpenStreetMap contributors © CARTO',
  },
  {
    id: 'roads',
    label: 'Roads & transport',
    hint: 'Road network with route numbers',
    needsPlain: true,
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    maxNative: 19, zIndex: 5,
    credit: 'Roads © Esri · TomTom · Garmin',
  },
  {
    id: 'railway',
    label: 'Railways',
    hint: 'Lines, sidings and stations from OpenRailwayMap',
    needsPlain: false,
    url: 'https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png',
    subdomains: 'abc', maxNative: 19, zIndex: 7,
    credit: '© OpenRailwayMap contributors',
  },
  {
    id: 'hillshade',
    label: 'Terrain shading',
    hint: 'Relief, for reading valleys and ridges',
    needsPlain: false,
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
    maxNative: 16, zIndex: 2, opacity: 0.5,
    credit: 'Hillshade © Esri',
  },
];

/** The label-free grounds this feature is designed around. */
const PLAIN_GROUNDS = ['positron', 'lightgray', 'darkgray'];

/** Live layers, by overlay id. */
const _overlayLayers = {};

/** @param {string} id @returns {object|null} */
function mapOverlay(id) { return MAP_OVERLAYS.find(o => o.id === id) || null; }

/** @returns {string[]} the overlay ids currently on */
function activeOverlays() {
  let saved = null;
  try { saved = getPref('mapOverlays'); } catch (e) { /* ignore */ }
  return Array.isArray(saved) ? saved.slice() : [];
}

/** Is the current ground free of baked-in labels and icons? */
function groundIsPlain() {
  return typeof activeKey !== 'undefined' && PLAIN_GROUNDS.indexOf(activeKey) >= 0;
}

/**
 * Add or remove one overlay.
 * @param {string} id @param {boolean} on
 */
function setMapOverlay(id, on) {
  const spec = mapOverlay(id);
  if (!spec || typeof map === 'undefined') return;

  if (on && !_overlayLayers[id]) {
    _overlayLayers[id] = L.tileLayer(spec.url, {
      subdomains: spec.subdomains || 'abc',
      maxNativeZoom: spec.maxNative,
      maxZoom: 22,
      opacity: spec.opacity == null ? 1 : spec.opacity,
      zIndex: spec.zIndex,
      // Overlays are decoration, not the ground. A failed overlay tile must
      // leave the map usable rather than triggering the basemap fallback that
      // mapEngine runs when the *ground* cannot draw.
      errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      attribution: spec.credit,
    }).addTo(map);
  } else if (!on && _overlayLayers[id]) {
    map.removeLayer(_overlayLayers[id]);
    delete _overlayLayers[id];
  }

  const next = MAP_OVERLAYS.map(o => o.id).filter(x => !!_overlayLayers[x]);
  try { setPref('mapOverlays', next); } catch (e) { /* ignore */ }
  renderOverlayPanel();
  if (typeof markDirty === 'function') markDirty();
}

/** Re-add every active overlay — after a basemap swap tears the tile pane down. */
function reapplyMapOverlays() {
  const want = activeOverlays();
  MAP_OVERLAYS.forEach(o => {
    const on = want.indexOf(o.id) >= 0;
    if (on && !_overlayLayers[o.id]) {
      _overlayLayers[o.id] = L.tileLayer(o.url, {
        subdomains: o.subdomains || 'abc',
        maxNativeZoom: o.maxNative, maxZoom: 22,
        opacity: o.opacity == null ? 1 : o.opacity,
        zIndex: o.zIndex,
        errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
        attribution: o.credit,
      }).addTo(map);
    } else if (on && _overlayLayers[o.id] && !map.hasLayer(_overlayLayers[o.id])) {
      _overlayLayers[o.id].addTo(map);
    }
  });
  renderOverlayPanel();
}

/**
 * Switch to a plain ground so the overlays are the only detail on the map.
 *
 * Offered rather than done automatically. Turning on "Roads" should not silently
 * replace somebody's satellite imagery — but leaving them with names printed
 * twice and no explanation is worse, so the panel says what is wrong and this
 * is the one click that fixes it.
 */
function useGroundForOverlays() {
  if (typeof chooseBasemap !== 'function') return;
  if (typeof basemapLocked === 'function' && basemapLocked()) {
    if (typeof status === 'function') {
      status('Connectivity pins the ground to OpenStreetMap. Switch to the Satellite layout'
        + ' to use a plain ground with overlays.');
    }
    return;
  }
  chooseBasemap('positron');
}

/** Draw the overlay checklist inside the basemap panel. */
function renderOverlayPanel() {
  const box = document.getElementById('bmOverlays');
  if (!box) return;
  const on = activeOverlays();
  const plain = groundIsPlain();
  const clash = !plain && on.some(id => (mapOverlay(id) || {}).needsPlain);

  box.innerHTML = '<div class="bm-ov-hd">Show on the ground</div>'
    + MAP_OVERLAYS.map(o =>
      '<label class="chk bm-ov" title="' + esc(o.hint) + '">'
      + '<input type="checkbox" data-overlay="' + o.id + '"' + (on.indexOf(o.id) >= 0 ? ' checked' : '') + '> '
      + esc(o.label) + '</label>').join('')
    + (clash
      ? '<div class="bm-ov-note">This ground already has names and icons painted into it, so they'
        + ' appear twice. <button type="button" id="bmPlainGround">Use a plain ground</button></div>'
      : '')
    + '<div class="bm-ov-note bm-ov-limit">Names and icons are part of the basemap image, so they'
      + ' can be swapped for these layers but not filtered one by one.</div>';
}

(function wireMapOverlays() {
  document.addEventListener('change', e => {
    const cb = e.target.closest && e.target.closest('[data-overlay]');
    if (cb) setMapOverlay(cb.dataset.overlay, cb.checked);
  });
  document.addEventListener('click', e => {
    if (e.target.closest && e.target.closest('#bmPlainGround')) useGroundForOverlays();
  });

  // Deferred: the basemap registry and the map are both built after this file's
  // top level runs, and an overlay added before the ground exists is an overlay
  // Leaflet stacks underneath it.
  setTimeout(() => { try { reapplyMapOverlays(); } catch (e) { /* no map yet */ } }, 700);
})();
