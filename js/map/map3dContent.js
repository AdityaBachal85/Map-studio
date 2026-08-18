/**
 * map/map3dContent.js — the map's own geometry, in the 3D scene.
 *
 * Routes, rings, drawn shapes, measurements and boundaries are Leaflet paths.
 * Leaflet is not running in 3D, so they have to be re-emitted — unlike the pins
 * and labels, which are screen-space DOM and only needed a different projection
 * (see map3dProjectPin in map/map3d.js).
 *
 * ONE SOURCE, DATA-DRIVEN PAINT. Every path becomes a feature in a single
 * GeoJSON source carrying its own colour, width and opacity as properties, and
 * a handful of layers read those properties. The alternative — a source and a
 * layer per shape — is hundreds of style objects for a busy map and a style
 * recompile every time one of them changes.
 *
 * The one thing MapLibre will not take from a property is `line-dasharray`, so
 * there is a line layer per dash pattern instead, filtered on a `dash`
 * property. Three layers, not three hundred.
 *
 * WHAT IS NOT HERE. Fill patterns (hatching), glow halos and text labels on
 * shapes: each is a canvas trick in the 2D renderer with no MapLibre
 * equivalent that would look the same, and a 3D view that renders half of a
 * hatch is worse than one that renders a clean fill. They come back the moment
 * you press 2D.
 */

const M3D_SRC = 'm3d-content';
const M3D_LAYERS = ['m3d-fill', 'm3d-line-solid', 'm3d-line-dash', 'm3d-line-dot', 'm3d-point'];
/** Points on a circle's ring. Enough that a 5 km ring has no visible corners. */
const M3D_CIRCLE_STEPS = 72;

/* ---------------------------------------------------------------------------
 * Leaflet paths -> GeoJSON
 * ------------------------------------------------------------------------- */

/**
 * Which dash layer a path belongs in.
 *
 * Leaflet's dashArray is a free-form string, so this buckets rather than
 * reproduces: a reader tells a dashed line from a dotted one, and not one
 * dash pattern from a slightly different one.
 */
function m3dDashKind(dashArray) {
  if (!dashArray) return 'solid';
  const parts = String(dashArray).split(/[\s,]+/).map(parseFloat).filter(v => v > 0);
  if (!parts.length) return 'solid';
  return parts[0] <= 2.5 ? 'dot' : 'dash';
}

/** A geographic circle as a ring of coordinates, since MapLibre has no such shape. */
function m3dCircleRing(centre, radiusM) {
  const out = [];
  const latPerM = 1 / 110574;
  const lngPerM = 1 / (111320 * Math.cos(centre.lat * Math.PI / 180) || 1);
  for (let i = 0; i <= M3D_CIRCLE_STEPS; i++) {
    const a = i / M3D_CIRCLE_STEPS * Math.PI * 2;
    out.push([centre.lng + Math.cos(a) * radiusM * lngPerM,
      centre.lat + Math.sin(a) * radiusM * latPerM]);
  }
  return out;
}

/** Leaflet allows nested rings (polygons with holes, multi-parts). */
function m3dRings(latlngs) {
  if (!latlngs || !latlngs.length) return [];
  if (Array.isArray(latlngs[0])) {
    return latlngs.map(m3dRings).reduce((a, b) => a.concat(b), []);
  }
  return [latlngs.map(p => [p.lng, p.lat])];
}

/** The style properties a feature carries into the paint expressions. */
function m3dProps(o) {
  return {
    color: o.color || '#3388ff',
    weight: o.weight == null ? 3 : o.weight,
    opacity: o.opacity == null ? 1 : o.opacity,
    fillColor: o.fillColor || o.color || '#3388ff',
    fillOpacity: o.fill === false ? 0 : (o.fillOpacity == null ? 0.2 : o.fillOpacity),
    dash: m3dDashKind(o.dashArray),
  };
}

/**
 * Every vector path on the flat map, as GeoJSON.
 * @returns {object} a FeatureCollection
 */
function map3dPathFeatures() {
  const features = [];
  if (typeof map === 'undefined' || typeof collectMapPaths !== 'function') {
    return { type: 'FeatureCollection', features };
  }

  collectMapPaths(map).forEach(layer => {
    const o = layer.options || {};
    // A path the operator has hidden on the flat map must not reappear here.
    if (o.opacity === 0 && (o.fillOpacity === 0 || o.fill === false)) return;
    const props = m3dProps(o);

    // Order matters: Circle extends CircleMarker, and Rectangle/Polygon extend
    // Polyline, so the most specific test has to come first.
    if (layer instanceof L.Circle) {
      features.push({
        type: 'Feature', properties: props,
        geometry: { type: 'Polygon', coordinates: [m3dCircleRing(layer.getLatLng(), layer.getRadius())] },
      });
      return;
    }
    if (layer instanceof L.CircleMarker) {
      const c = layer.getLatLng();
      features.push({
        type: 'Feature',
        properties: Object.assign({ radius: layer.getRadius() || 8 }, props),
        geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      });
      return;
    }
    if (layer instanceof L.Polygon) {
      const rings = m3dRings(layer.getLatLngs());
      if (!rings.length) return;
      features.push({
        type: 'Feature', properties: props,
        geometry: { type: 'Polygon', coordinates: rings },
      });
      return;
    }
    if (layer instanceof L.Polyline) {
      m3dRings(layer.getLatLngs()).forEach(line => {
        if (line.length < 2) return;
        features.push({
          type: 'Feature', properties: props,
          geometry: { type: 'LineString', coordinates: line },
        });
      });
    }
  });

  return { type: 'FeatureCollection', features };
}

/* ---------------------------------------------------------------------------
 * Mount into a GL map
 * ------------------------------------------------------------------------- */

/** Paint expressions shared by the three dash layers. */
function m3dLinePaint(dash) {
  const paint = {
    'line-color': ['get', 'color'],
    'line-width': ['get', 'weight'],
    'line-opacity': ['get', 'opacity'],
  };
  // Dash lengths are in line-widths, so these stay proportional as a route's
  // weight changes rather than turning into a solid line on a thick one.
  if (dash === 'dash') paint['line-dasharray'] = [2.2, 1.6];
  if (dash === 'dot') paint['line-dasharray'] = [0.1, 2];
  return paint;
}

/**
 * Add the flat map's geometry to a GL map.
 * @param {object} gl a maplibregl.Map
 */
function map3dAddContent(gl) {
  if (!gl) return;
  try {
    if (gl.getSource(M3D_SRC)) { map3dRefreshContent(); return; }
    gl.addSource(M3D_SRC, { type: 'geojson', data: map3dPathFeatures() });

    gl.addLayer({
      id: 'm3d-fill', type: 'fill', source: M3D_SRC,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': ['get', 'fillColor'], 'fill-opacity': ['get', 'fillOpacity'] },
    });

    ['solid', 'dash', 'dot'].forEach(dash => {
      gl.addLayer({
        id: 'm3d-line-' + dash, type: 'line', source: M3D_SRC,
        filter: ['all', ['!=', ['geometry-type'], 'Point'], ['==', ['get', 'dash'], dash]],
        layout: { 'line-cap': dash === 'dot' ? 'round' : 'butt', 'line-join': 'round' },
        paint: m3dLinePaint(dash),
      });
    });

    gl.addLayer({
      id: 'm3d-point', type: 'circle', source: M3D_SRC,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'fillColor'],
        'circle-opacity': ['get', 'fillOpacity'],
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': ['get', 'weight'],
        'circle-stroke-opacity': ['get', 'opacity'],
      },
    });
  } catch (e) {
    // A style that has not finished loading is the usual cause, and the mount
    // retries through map3dRefreshContent on the next change.
  }
}

/** Rebuild the geometry from the flat map. Cheap: one setData. */
function map3dRefreshContent() {
  const gl = (typeof map3dGl === 'function') ? map3dGl() : null;
  if (!gl) return;
  try {
    const src = gl.getSource(M3D_SRC);
    if (src) src.setData(map3dPathFeatures());
    else map3dAddContent(gl);
  } catch (e) { /* mid-teardown */ }
}

/** @param {object} gl */
function map3dRemoveContent(gl) {
  if (!gl) return;
  try {
    M3D_LAYERS.forEach(id => { if (gl.getLayer(id)) gl.removeLayer(id); });
    if (gl.getSource(M3D_SRC)) gl.removeSource(M3D_SRC);
  } catch (e) { /* the whole map is going anyway */ }
}
