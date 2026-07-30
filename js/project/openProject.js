/**
 * project/openProject.js — restore a previously saved .json project: view,
 * basemap, tilt, chip scale, brand, and every location/route.
 */










/**
 * Load a .kml file into the current map. Additive, unlike a project file: a KML
 * carries places and shapes, not a whole session, so replacing the map with it
 * would throw away work the operator did not ask to lose.
 * @param {File} f
 */
function readKMLFile(f) {
  const rd = new FileReader();
  rd.onload = () => {
    const r = importKML(rd.result);
    if (r.error) { status(r.error); return; }
    if (!r.locations && !r.shapes) { status('No places or shapes found in that KML.'); return; }
    status(`Imported ${r.locations} location(s) and ${r.shapes} shape(s) from KML.`);
    if (typeof fitAll === 'function') fitAll();
  };
  rd.onerror = () => status('Could not read that file.');
  rd.readAsText(f);
}

/**
 * Load a .geojson file — the same importer the Draw tab uses, reachable from
 * the single Open button as well.
 * @param {File} f
 */
function readGeoJSONFile(f) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const fc = JSON.parse(rd.result);
      const features = fc.type === 'FeatureCollection' ? (fc.features || [])
        : (fc.type === 'Feature' ? [fc] : []);
      let n = 0;
      features.forEach(feat => { if (importGeoJSONFeature(feat)) n++; });
      status(n ? `Imported ${n} shape${n !== 1 ? 's' : ''} from GeoJSON.` : 'No importable shapes found in that file.');
      if (n && typeof fitAll === 'function') fitAll();
    } catch (err) { status('Could not read that file — is it valid GeoJSON?'); }
  };
  rd.readAsText(f);
}

/* `clearAll` used to be defined here *and* again inside `wireOpenProject`, and
   the inner one — the one the Open handler actually saw — had no
   `clearAllGeometries`. Loading a project therefore left the previous drawing on
   the map and accumulated shapes. Both are gone; `clearProject()` in
   project/projectState.js is the single definition. */

      function wireOpenProject() {
      $('loadBtn').addEventListener('click', () => $('loadInput').click());
      $('loadInput').addEventListener('change', e => {
        const f = e.target.files[0];
        // One Open button for every format the app can produce. Routing on the
        // extension rather than sniffing content keeps the failure messages
        // specific: "not valid KML" is more use than "could not read that file".
        if (f && /\.kml$/i.test(f.name)) { readKMLFile(f); e.target.value = ''; return; }
        if (f && /\.geojson$/i.test(f.name)) { readGeoJSONFile(f); e.target.value = ''; return; }
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          try {
            applyProject(JSON.parse(rd.result));
          } catch (err) { status('Could not read that file — is it a saved project (.json)?'); }
        };
        rd.readAsText(f);
        e.target.value = '';
      });
      }

