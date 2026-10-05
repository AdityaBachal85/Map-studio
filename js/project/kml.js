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

/**
 * Icon hrefs for Google Earth, keyed by our own icon keys.
 *
 * These are Google's hosted KML icons rather than anything from this repo, and
 * that is the point: a .kml is a file people email around, and Earth fetches
 * `<IconStyle><href>` over the network when it opens one. An href pointing at
 * a GitHub Pages path would break the moment the site moved, was made private,
 * or was opened by someone offline from a copy on their desktop. Google's set
 * has been at these URLs for the better part of two decades.
 *
 * The `-blank`/white variants are chosen deliberately: `<IconStyle><color>`
 * multiplies, so tinting only preserves hue against a white base.
 *
 * Keys not listed fall back to KML_ICON_DEFAULT — the map only has to be
 * roughly right, and a paddle in the correct colour beats an exact glyph.
 */
const KML_ICON_BASE = 'https://maps.google.com/mapfiles/kml/';
const KML_ICON_DEFAULT = KML_ICON_BASE + 'paddle/wht-blank.png';
const KML_ICON_FOR_KEY = {
  star: KML_ICON_BASE + 'paddle/wht-stars.png',
  home: KML_ICON_BASE + 'shapes/homegardenbusiness.png',
  villa: KML_ICON_BASE + 'shapes/homegardenbusiness.png',
  apartment: KML_ICON_BASE + 'shapes/homegardenbusiness.png',
  building: KML_ICON_BASE + 'shapes/square.png',
  school: KML_ICON_BASE + 'shapes/schools.png',
  college: KML_ICON_BASE + 'shapes/schools.png',
  hospital: KML_ICON_BASE + 'shapes/hospitals.png',
  pharmacy: KML_ICON_BASE + 'shapes/hospitals.png',
  airport: KML_ICON_BASE + 'shapes/airports.png',
  railway: KML_ICON_BASE + 'shapes/rail.png',
  metro: KML_ICON_BASE + 'shapes/rail.png',
  bus: KML_ICON_BASE + 'shapes/bus.png',
  car: KML_ICON_BASE + 'shapes/car.png',
  taxi: KML_ICON_BASE + 'shapes/cabs.png',
  parking: KML_ICON_BASE + 'shapes/parking_lot.png',
  fuel: KML_ICON_BASE + 'shapes/gas_stations.png',
  bank: KML_ICON_BASE + 'shapes/euro.png',
  mall: KML_ICON_BASE + 'shapes/shopping.png',
  shop: KML_ICON_BASE + 'shapes/shopping.png',
  market: KML_ICON_BASE + 'shapes/convenience.png',
  restaurant: KML_ICON_BASE + 'shapes/dining.png',
  cafe: KML_ICON_BASE + 'shapes/coffee.png',
  hotel: KML_ICON_BASE + 'shapes/lodging.png',
  gym: KML_ICON_BASE + 'shapes/sportvenue.png',
  stadium: KML_ICON_BASE + 'shapes/stadium.png',
  golf: KML_ICON_BASE + 'shapes/golf.png',
  pool: KML_ICON_BASE + 'shapes/swimming.png',
  tree: KML_ICON_BASE + 'shapes/parks.png',
  garden: KML_ICON_BASE + 'shapes/parks.png',
  playground: KML_ICON_BASE + 'shapes/play.png',
  camp: KML_ICON_BASE + 'shapes/campground.png',
  beach: KML_ICON_BASE + 'shapes/beach.png',
  mountain: KML_ICON_BASE + 'shapes/mountains.png',
  water: KML_ICON_BASE + 'shapes/water.png',
  police: KML_ICON_BASE + 'shapes/police.png',
  fire: KML_ICON_BASE + 'shapes/firedept.png',
  post: KML_ICON_BASE + 'shapes/post_office.png',
  library: KML_ICON_BASE + 'shapes/library_maps.png',
  museum: KML_ICON_BASE + 'shapes/museum.png',
  cinema: KML_ICON_BASE + 'shapes/movies.png',
  temple: KML_ICON_BASE + 'shapes/placeofworship.png',
  church: KML_ICON_BASE + 'shapes/placeofworship.png',
  mosque: KML_ICON_BASE + 'shapes/placeofworship.png',
  industry: KML_ICON_BASE + 'shapes/mechanic.png',
  factory: KML_ICON_BASE + 'shapes/mechanic.png',
  warehouse: KML_ICON_BASE + 'shapes/mechanic.png',
  construction: KML_ICON_BASE + 'shapes/construction.png',
  crane: KML_ICON_BASE + 'shapes/construction.png',
  port: KML_ICON_BASE + 'shapes/marina.png',
  bike: KML_ICON_BASE + 'shapes/cycling.png',
  walk: KML_ICON_BASE + 'shapes/hiker.png',
  flag: KML_ICON_BASE + 'shapes/flag.png',
  info: KML_ICON_BASE + 'shapes/info-i_maps.png',
  alert: KML_ICON_BASE + 'shapes/caution.png',
};

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

  /**
   * Register an icon style for one location and return its id.
   *
   * KML cannot carry an inline SVG — `<IconStyle>` takes an `<href>`, and
   * Google Earth fetches it over the network. A relative path or a data: URI
   * would leave every placemark as the default yellow pushpin on someone
   * else's machine, which is what this export used to do by having no
   * IconStyle at all.
   *
   * So the href points at Google's own icon set, which is already online,
   * already whitelisted by Earth, and needs nothing hosted by us — this file
   * has to work when a .kml is emailed to someone who has never heard of Map
   * Studio. `<color>` tints the white base icon with the location's own
   * colour, so a map's palette survives the trip.
   */
  const iconStyle = l => {
    const id = 'ic' + (++styleN);
    const href = KML_ICON_FOR_KEY[l.iconKey] || KML_ICON_DEFAULT;
    styles.push(
      `<Style id="${id}">` +
      '<IconStyle>' +
      // Multiplied against a white base icon, so this reads as a tint.
      `<color>${kmlColor(l.color || '#FF7A1A')}</color>` +
      `<scale>${(Math.max(22, l.iconSize || 36) / 36).toFixed(2)}</scale>` +
      `<Icon><href>${href}</href></Icon>` +
      // Paddle icons point at their bottom tip, not their centre.
      '<hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/>' +
      '</IconStyle>' +
      `<LabelStyle><color>${kmlColor(l.color || '#FFFFFF')}</color><scale>0.9</scale></LabelStyle>` +
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
      `<styleUrl>#${iconStyle(l)}</styleUrl>` +
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

/* ---------------------------------------------------------------------------
 * Import
 * ------------------------------------------------------------------------- */

/**
 * Parse a KML coordinate list into Leaflet `[lat, lng]` pairs.
 * KML writes `lng,lat[,alt]` separated by any whitespace, and real files are
 * generous with line breaks and indentation inside the element.
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
function parseKmlCoords(text) {
  return String(text || '').trim().split(/\s+/).map(t => {
    const [lng, lat] = t.split(',').map(Number);
    return (isFinite(lat) && isFinite(lng)) ? [lat, lng] : null;
  }).filter(Boolean);
}

/** `aabbggrr` back to `#rrggbb`. @param {string} kml */
function kmlColorToHex(kml) {
  const h = String(kml || '').trim();
  if (h.length !== 8) return null;
  return '#' + h.slice(6, 8) + h.slice(4, 6) + h.slice(2, 4);
}

/**
 * Collect `<Style>` definitions so a Placemark's `styleUrl` can be resolved.
 * `<StyleMap>` is followed to its `normal` pair, which is how Google Earth
 * writes most styles — ignoring it would drop the colour on the majority of
 * real-world files.
 * @param {Document} doc
 * @returns {Object<string, {color:string|null, weight:number|null}>}
 */
function collectKmlStyles(doc) {
  const out = {};
  const text = (el, tag) => {
    const n = el.getElementsByTagName(tag)[0];
    return n && n.textContent ? n.textContent.trim() : null;
  };

  Array.from(doc.getElementsByTagName('Style')).forEach(st => {
    const id = st.getAttribute('id');
    if (!id) return;
    const line = st.getElementsByTagName('LineStyle')[0];
    out['#' + id] = {
      color: line ? kmlColorToHex(text(line, 'color')) : null,
      weight: line && text(line, 'width') ? parseFloat(text(line, 'width')) : null,
    };
  });

  Array.from(doc.getElementsByTagName('StyleMap')).forEach(sm => {
    const id = sm.getAttribute('id');
    if (!id) return;
    const pair = Array.from(sm.getElementsByTagName('Pair'))
      .find(p => (text(p, 'key') || '') === 'normal') || sm.getElementsByTagName('Pair')[0];
    const ref = pair && text(pair, 'styleUrl');
    if (ref && out[ref]) out['#' + id] = out[ref];
  });

  return out;
}

/**
 * Import a KML document into the map.
 *
 * Points become locations rather than marker shapes: a named point in a KML is
 * almost always a place — a site, a landmark, a competitor — and locations are
 * what the rest of the app reasons about (routes connect them, the legend lists
 * them, exports label them). Lines and polygons become drawn geometry through
 * the same registerGeom() path the GeoJSON importer uses, so they arrive with
 * cards, styling and edit handles already wired.
 *
 * @param {string} text Raw KML.
 * @returns {{locations:number, shapes:number, error?:string}}
 */
function importKML(text) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch (e) {
    return { locations: 0, shapes: 0, error: 'That file could not be parsed as XML.' };
  }
  if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagName('kml').length) {
    return { locations: 0, shapes: 0, error: 'That does not look like a KML file.' };
  }

  const styles = collectKmlStyles(doc);
  let nLoc = 0, nShape = 0;

  Array.from(doc.getElementsByTagName('Placemark')).forEach(pm => {
    const nameEl = pm.getElementsByTagName('name')[0];
    const name = nameEl && nameEl.textContent ? nameEl.textContent.trim() : '';
    const refEl = pm.getElementsByTagName('styleUrl')[0];
    const st = (refEl && styles[refEl.textContent.trim()]) || {};

    const point = pm.getElementsByTagName('Point')[0];
    const line = pm.getElementsByTagName('LineString')[0];
    const poly = pm.getElementsByTagName('Polygon')[0];

    const coordsOf = el => {
      const c = el && el.getElementsByTagName('coordinates')[0];
      return c ? parseKmlCoords(c.textContent) : [];
    };

    if (point) {
      const pts = coordsOf(point);
      if (!pts.length) return;
      addLocation({ lat: pts[0][0], lng: pts[0][1], name: name || undefined });
      nLoc++;
      return;
    }

    let layer = null, shape = null;
    if (line) {
      const pts = coordsOf(line);
      if (pts.length < 2) return;
      layer = L.polyline(pts);
      shape = 'Line';
    } else if (poly) {
      const ring = poly.getElementsByTagName('outerBoundaryIs')[0] || poly;
      const pts = coordsOf(ring);
      if (pts.length < 3) return;
      layer = L.polygon(pts);
      shape = 'Polygon';
    }
    if (!layer) return;

    // borderColor / borderWidth are the fields the geometry style system
    // actually reads (see defaultGeomStyle in map/drawing.js); a plain `color`
    // would be stored and then ignored, leaving every import at the default.
    registerGeom(layer, shape, {
      name: name || undefined,
      borderColor: st.color || undefined,
      borderWidth: st.weight || undefined,
    });
    nShape++;
  });

  return { locations: nLoc, shapes: nShape };
}
