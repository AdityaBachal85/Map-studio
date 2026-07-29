/**
 * project/kml.js — export the whole map as KML.
 *
 * GeoJSON already covers drawn geometry for GIS tools, but it carries only the
 * shapes and none of the styling, and nothing outside a GIS opens it. KML is
 * what Google Earth, Google My Maps and most surveying software accept, and it
 * round-trips colour and line weight, so a shared file looks like the map that
 * was designed rather than a set of grey outlines.
 *
 * Everything on the map goes in: located pins, routed lines with their
 * alternates resolved, radius rings as circles, and drawn geometry.
 */

/** KML wants aabbggrr, not #rrggbb. @param {string} hex @param {number} [alpha] 0–1 */
function kmlColor(hex, alpha) {
  const h = String(hex || '#FF7A1A').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const a = Math.round(Math.max(0, Math.min(1, alpha == null ? 1 : alpha)) * 255);
  const p = n => n.toString(16).padStart(2, '0');
  return p(a) + full.slice(4, 6) + full.slice(2, 4) + full.slice(0, 2);
}

/** Escape text for XML content. @param {*} v */
function kmlEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** `lng,lat,0` tuples — KML is longitude-first, the opposite of Leaflet. */
function kmlCoords(latlngs) {
  return latlngs.map(c => {
    const lat = Array.isArray(c) ? c[0] : (c.lat != null ? c.lat : c[1]);
    const lng = Array.isArray(c) ? c[1] : (c.lng != null ? c.lng : c[0]);
    return `${(+lng).toFixed(7)},${(+lat).toFixed(7)},0`;
  }).join(' ');
}

/**
 * Approximate a geodesic circle as a polygon ring — KML has no circle
 * primitive, so a radius ring has to be drawn as points on its circumference.
 * @param {number} lat @param {number} lng @param {number} radiusM
 * @param {number} [steps]
 * @returns {Array<[number, number]>}
 */
function kmlCircleRing(lat, lng, radiusM, steps) {
  const n = steps || 64;
  const R = 6378137;
  const out = [];
  const latRad = lat * Math.PI / 180;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const dLat = (radiusM * Math.cos(t)) / R * 180 / Math.PI;
    const dLng = (radiusM * Math.sin(t)) / (R * Math.cos(latRad)) * 180 / Math.PI;
    out.push([lat + dLat, lng + dLng]);
  }
  return out;
}

/**
 * Build the KML document for the current map.
 * @returns {{xml:string, counts:{locations:number, routes:number, shapes:number}}}
 */
function buildKML() {
  const styles = [];
  const places = [];
  let styleN = 0;

  /** Register a line/poly style and return its id. */
  const style = (color, weightPx, fillColor, fillOpacity) => {
    const id = 'st' + (++styleN);
    styles.push(
      `<Style id="${id}">` +
      `<LineStyle><color>${kmlColor(color)}</color><width>${Math.max(1, weightPx || 3)}</width></LineStyle>` +
      (fillColor
        ? `<PolyStyle><color>${kmlColor(fillColor, fillOpacity == null ? 0.2 : fillOpacity)}</color><fill>1</fill></PolyStyle>`
        : '<PolyStyle><fill>0</fill></PolyStyle>') +
      '</Style>');
    return id;
  };

  // ---- locations (+ their radius rings) ----
  const locFolder = [];
  (typeof locations !== 'undefined' ? locations : []).forEach(l => {
    locFolder.push(
      '<Placemark>' +
      `<name>${kmlEsc(l.name)}</name>` +
      (l.note ? `<description>${kmlEsc(l.note)}</description>` : '') +
      `<Point><coordinates>${(+l.lng).toFixed(7)},${(+l.lat).toFixed(7)},0</coordinates></Point>` +
      '</Placemark>');
    (l.rings || []).forEach(r => {
      const km = parseFloat(r.km);
      if (!(km > 0)) return;
      const sid = style(r.color, 2, r.color, r.op);
      locFolder.push(
        '<Placemark>' +
        `<name>${kmlEsc(l.name + ' — ' + km + ' km')}</name>` +
        `<styleUrl>#${sid}</styleUrl>` +
        '<Polygon><outerBoundaryIs><LinearRing><coordinates>' +
        kmlCoords(kmlCircleRing(l.lat, l.lng, km * 1000)) +
        '</coordinates></LinearRing></outerBoundaryIs></Polygon>' +
        '</Placemark>');
    });
  });

  // ---- routes (the selected alternative only) ----
  const rtFolder = [];
  (typeof routes !== 'undefined' ? routes : []).forEach(rt => {
    const alt = rt.alts && rt.alts[rt.altIndex];
    if (!alt || !alt.coords || alt.coords.length < 2) return;
    const sid = style(rt.color, rt.weight);
    rtFolder.push(
      '<Placemark>' +
      `<name>${kmlEsc(typeof routeLabelText === 'function' ? routeLabelText(rt) : 'Route')}</name>` +
      `<styleUrl>#${sid}</styleUrl>` +
      `<LineString><tessellate>1</tessellate><coordinates>${kmlCoords(alt.coords)}</coordinates></LineString>` +
      '</Placemark>');
  });

  // ---- drawn geometry ----
  const geoFolder = [];
  (typeof geometries !== 'undefined' ? geometries : []).forEach(g => {
    const layer = g.layer;
    if (!layer) return;
    const o = layer.options || {};
    const sid = style(o.color, o.weight, o.fill ? (o.fillColor || o.color) : null, o.fillOpacity);
    const name = kmlEsc(g.name || g.shape || 'Shape');
    const wrap = body => geoFolder.push(`<Placemark><name>${name}</name><styleUrl>#${sid}</styleUrl>${body}</Placemark>`);

    if (typeof L !== 'undefined' && layer instanceof L.Circle) {
      wrap('<Polygon><outerBoundaryIs><LinearRing><coordinates>' +
        kmlCoords(kmlCircleRing(layer.getLatLng().lat, layer.getLatLng().lng, layer.getRadius())) +
        '</coordinates></LinearRing></outerBoundaryIs></Polygon>');
    } else if (typeof L !== 'undefined' && layer instanceof L.CircleMarker) {
      const c = layer.getLatLng();
      wrap(`<Point><coordinates>${c.lng.toFixed(7)},${c.lat.toFixed(7)},0</coordinates></Point>`);
    } else if (typeof L !== 'undefined' && layer instanceof L.Polygon) {
      const rings = layer.getLatLngs();
      const outer = Array.isArray(rings[0]) ? rings[0] : rings;
      wrap('<Polygon><outerBoundaryIs><LinearRing><coordinates>' +
        kmlCoords(outer.concat([outer[0]])) +
        '</coordinates></LinearRing></outerBoundaryIs></Polygon>');
    } else if (typeof L !== 'undefined' && layer instanceof L.Polyline) {
      wrap(`<LineString><tessellate>1</tessellate><coordinates>${kmlCoords(layer.getLatLngs())}</coordinates></LineString>`);
    } else if (layer.getLatLng) {
      const c = layer.getLatLng();
      wrap(`<Point><coordinates>${c.lng.toFixed(7)},${c.lat.toFixed(7)},0</coordinates></Point>`);
    }
  });

  const folder = (name, items) =>
    items.length ? `<Folder><name>${name}</name>${items.join('')}</Folder>` : '';

  const title = kmlEsc((document.getElementById('titleCard') || {}).textContent || 'Property Map Studio');
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
    `<name>${title.trim()}</name>` +
    styles.join('') +
    folder('Locations', locFolder) +
    folder('Routes', rtFolder) +
    folder('Shapes', geoFolder) +
    '</Document></kml>';

  return {
    xml,
    counts: {
      locations: (typeof locations !== 'undefined' ? locations : []).length,
      routes: rtFolder.length,
      shapes: geoFolder.length,
    },
  };
}

/** Build and download the KML file. */
function exportKML() {
  const { xml, counts } = buildKML();
  const total = counts.locations + counts.routes + counts.shapes;
  if (!total) { status('Nothing on the map to export yet — add a location, route or shape first.'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([xml], { type: 'application/vnd.google-earth.kml+xml' }));
  a.download = 'property-map-studio.kml';
  a.click();
  URL.revokeObjectURL(a.href);
  status(`KML downloaded — ${counts.locations} location(s), ${counts.routes} route(s), ${counts.shapes} shape(s).`);
}

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { kmlColor, kmlEsc, kmlCoords, kmlCircleRing };
}
