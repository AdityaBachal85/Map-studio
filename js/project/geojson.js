/**
 * project/geojson.js — GeoJSON import/export for drawn shapes (Draw tab),
 * preserving color, style, label and metadata via each Feature's
 * `properties`. Also used by saveProject.js/openProject.js so shapes travel
 * with the regular .json project file too.
 */

/** One geometry as a GeoJSON Feature, style/metadata folded into `properties`. @param {object} g @returns {object} */
function geomToGeoJSONFeature(g) {
  // A shifted line is DRAWN beside its alignment and IS on it. The file gets
  // the real coordinates plus the shift, so the metro is where the metro is
  // for anything that reads the geometry, and reopening redraws the same
  // separation rather than shifting an already-shifted line again.
  const geometry = (g._baseLatLngs && g.shape === 'Line')
    ? { type: 'LineString', coordinates: g._baseLatLngs.map(c => [c[1], c[0]]) }
    : g.layer.toGeoJSON().geometry;
  return {
    type: 'Feature',
    properties: {
      shape: g.shape, name: g.name, description: g.description, notes: g.notes,
      fillColor: g.fillColor, borderColor: g.borderColor, borderWidth: g.borderWidth, fillOpacity: g.fillOpacity,
      lineStyle: g.lineStyle, corner: g.corner, fillPattern: g.fillPattern,
      labelSize: g.labelSize, labelBold: g.labelBold, labelStyle: g.labelStyle, labelAngle: g.labelAngle,
      showLabel: g.showLabel, glow: g.glow, markerStyle: g.markerStyle, iconKey: g.iconKey,
      captionSize: g.captionSize,
      // Where this line came from. A converted contour has to stay recognisable
      // across a save, or reopening the project turns it back into an ordinary
      // hand-drawn line that "Clear the contour map" can no longer find.
      fromContour: g.fromContour || undefined,
      contourLevel: g.contourLevel,
      contourMapId: g.contourMapId,
      createdAt: g.createdAt, modifiedAt: g.modifiedAt,
      // The connectivity class. Without it a reopened project has shapes that
      // still LOOK right — the colours are saved separately — but belong to no
      // class, so the standard cannot restyle them and the colour key silently
      // loses its rows. The look survives and the meaning does not, which is
      // the worst of the two to lose.
      cls: g.cls || undefined, proposed: g.proposed || undefined, fromRing: g.fromRing || undefined,
      // A metro drawn dashed because it flies over a road. Without this a
      // reopened project restyles it solid from its class and it goes back to
      // hiding the road — the look survives nothing and the reason survives
      // less, which is the pair that makes a bug hard to find.
      overRoad: g.overRoad || undefined,
      shiftPx: g.shiftPx || undefined,
      radius: g.shape === 'Circle' ? g.layer.getRadius() : undefined,
    },
    geometry,
  };
}

function geoJSONTypeToShape(t) {
  if (t === 'Point') return 'Marker';
  if (t === 'LineString') return 'Line';
  if (t === 'Polygon') return 'Polygon';
  // Merged buildings and any forest with detached parts are MultiPolygons.
  // Unmapped, every one of them failed the shape check and vanished on load
  // without a word.
  if (t === 'MultiPolygon') return 'Polygon';
  if (t === 'MultiLineString') return 'Line';
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
    // `pin` was the field for about an hour before three marker kinds were
    // needed; anything exported in that window still opens correctly.
    markerStyle: props.markerStyle || (props.pin ? 'pin' : undefined),
    fromContour: props.fromContour ? true : undefined,
    contourLevel: props.contourLevel != null ? +props.contourLevel : undefined,
    contourMapId: props.contourMapId || undefined,
    iconKey: props.iconKey || undefined,
    captionSize: props.captionSize != null ? +props.captionSize : undefined,
    createdAt: props.createdAt, modifiedAt: props.modifiedAt,
    cls: props.cls || undefined,
    proposed: props.proposed != null ? !!props.proposed : undefined,
    fromRing: props.fromRing != null ? !!props.fromRing : undefined,
    overRoad: props.overRoad != null ? !!props.overRoad : undefined,
    shiftPx: props.shiftPx != null ? +props.shiftPx : undefined,
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
