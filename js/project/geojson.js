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
      lineStyle: g.lineStyle, corner: g.corner, showLabel: g.showLabel, glow: g.glow,
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
    lineStyle: props.lineStyle, corner: props.corner,
    showLabel: props.showLabel != null ? !!props.showLabel : undefined,
    glow: props.glow != null ? !!props.glow : undefined,
    createdAt: props.createdAt, modifiedAt: props.modifiedAt,
  });
  return true;
}

$('geoExportBtn').addEventListener('click', () => {
  if (!geometries.length) { status('No shapes to export yet — draw something on the Draw tab first.'); return; }
  const fc = { type: 'FeatureCollection', features: geometries.map(geomToGeoJSONFeature) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' }));
  a.download = 'map-studio-shapes.geojson';
  a.click();
  URL.revokeObjectURL(a.href);
  status(`Exported ${geometries.length} shape${geometries.length > 1 ? 's' : ''} as GeoJSON.`);
});

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
