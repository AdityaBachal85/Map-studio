/**
 * project/geojson.js — GeoJSON import/export for drawn shapes (Draw tab),
 * preserving color, style, label and metadata via each Feature's
 * `properties`. Also used by saveProject.js/openProject.js so shapes travel
 * with the regular .json project file too.
 */

/** One geometry as a GeoJSON Feature, style/metadata folded into `properties`. @param {object} g @returns {object} */
function geomToGeoJSONFeature(g) {
  const geometry = g.layer.toGeoJSON().geometry;
  return {
    type: 'Feature',
    properties: {
      shape: g.shape, name: g.name, description: g.description, notes: g.notes,
      fillColor: g.fillColor, borderColor: g.borderColor, borderWidth: g.borderWidth, fillOpacity: g.fillOpacity,
      lineStyle: g.lineStyle, corner: g.corner, fillPattern: g.fillPattern,
      labelSize: g.labelSize, labelBold: g.labelBold, labelStyle: g.labelStyle, labelAngle: g.labelAngle,
      showLabel: g.showLabel, glow: g.glow,
      createdAt: g.createdAt, modifiedAt: g.modifiedAt,
      radius: g.shape === 'Circle' ? g.layer.getRadius() : undefined,
    },
    geometry,
  };
}

function geoJSONTypeToShape(t) {
  if (t === 'Point') return 'Marker';
  if (t === 'LineString') return 'Line';
  if (t === 'Polygon') return 'Polygon';
  return null;
}

/**
 * Recreate one shape from a GeoJSON Feature (as produced by
 * geomToGeoJSONFeature, or any standard-compliant external GeoJSON).
 * @param {object} feat @returns {boolean} true if a shape was added
 */
function importGeoJSONFeature(feat) {
  if (!feat || !feat.geometry) return false;
  const props = feat.properties || {};
  const shape = props.shape || geoJSONTypeToShape(feat.geometry.type);
  if (!shape || GEOM_SHAPES.indexOf(shape) < 0) return false;
  let layer;
  try {
    if (shape === 'Circle') {
      const [lng, lat] = feat.geometry.coordinates;
      layer = L.circle([lat, lng], { radius: +props.radius || 100 });
    } else if (shape === 'Label') {
      // Blank icon; registerGeom -> applyGeomStyle writes the real one from
      // the text and styling in `properties`.
      const [lng, lat] = feat.geometry.coordinates;
      layer = L.marker([lat, lng], { icon: L.divIcon({ className: 'map-text-wrap', html: '', iconSize: [0, 0] }) });
    } else if (shape === 'CircleMarker') {
      const [lng, lat] = feat.geometry.coordinates;
      layer = L.circleMarker([lat, lng]);
    } else if (shape === 'Rectangle') {
      const ring = feat.geometry.coordinates[0];
      const lats = ring.map(c => c[1]), lngs = ring.map(c => c[0]);
      layer = L.rectangle([[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]]);
    } else {
      layer = L.geoJSON(feat).getLayers()[0];
    }
  } catch (e) { return false; }
  if (!layer) return false;
  registerGeom(layer, shape, {
    name: props.name || undefined, description: props.description || '', notes: props.notes || '',
    fillColor: props.fillColor, borderColor: props.borderColor,
    borderWidth: props.borderWidth != null ? +props.borderWidth : undefined,
    fillOpacity: props.fillOpacity != null ? +props.fillOpacity : undefined,
    lineStyle: props.lineStyle, corner: props.corner, fillPattern: props.fillPattern,
    labelSize: props.labelSize != null ? +props.labelSize : undefined,
    labelBold: props.labelBold != null ? !!props.labelBold : undefined,
    labelStyle: props.labelStyle,
    labelAngle: props.labelAngle != null ? +props.labelAngle : undefined,
    showLabel: props.showLabel != null ? !!props.showLabel : undefined,
    glow: props.glow != null ? !!props.glow : undefined,
    createdAt: props.createdAt, modifiedAt: props.modifiedAt,
  });
  return true;
}

/**
 * Download every drawn shape as a GeoJSON FeatureCollection.
 *
 * Reachable from two places — the Draw tab and the Export dialog — so it's a
 * named function wired to both rather than an inline listener. It used to be
 * inline on `geoExportBtn`, and because both buttons carried that same id,
 * getElementById only ever found the Draw tab's one: the Export dialog's
 * GeoJSON row had no handler at all and did nothing when clicked.
 */
function exportGeoJSON() {
  if (!geometries.length) { status('No shapes to export yet — draw something on the Draw tab first.'); return; }
  const fc = { type: 'FeatureCollection', features: geometries.map(geomToGeoJSONFeature) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' }));
  a.download = 'map-studio-shapes.geojson';
  a.click();
  URL.revokeObjectURL(a.href);
  status(`Exported ${geometries.length} shape${geometries.length > 1 ? 's' : ''} as GeoJSON.`);
}

$('geoExportBtn').addEventListener('click', exportGeoJSON);

$('geoImportBtn').addEventListener('click', () => $('geoImportInput').click());
$('geoImportInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const fc = JSON.parse(rd.result);
      const features = fc.type === 'FeatureCollection' ? (fc.features || []) : (fc.type === 'Feature' ? [fc] : []);
      let count = 0;
      features.forEach(feat => { if (importGeoJSONFeature(feat)) count++; });
      status(count ? `Imported ${count} shape${count !== 1 ? 's' : ''} from GeoJSON.` : 'No importable shapes found in that file.');
    } catch (err) { status('Could not read that file — is it valid GeoJSON?'); }
  };
  rd.readAsText(f);
  e.target.value = '';
});
