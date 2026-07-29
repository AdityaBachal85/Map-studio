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

/** Remove every route and location (used before loading a saved project). */
function clearAll() {
  routes.slice().forEach(deleteRoute);
  locations.slice().forEach(deleteLocation);
  if (typeof clearAllGeometries === 'function') clearAllGeometries();
}

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
            const proj = JSON.parse(rd.result);
            clearAll();
            if (proj.title) $('titleCard').textContent = proj.title;
            if (proj.legendTitle) $('legendTitle').textContent = proj.legendTitle;
            if (proj.hd !== undefined) $('hdTgl').checked = !!proj.hd;
            if (proj.basemap && BASEMAPS[proj.basemap]) { $('basemapSel').value = proj.basemap; }
            if (proj.imageryLook) setImageryLook(proj.imageryLook);
            if (proj.roadLook) setRoadLook(proj.roadLook);
            setBasemap($('basemapSel').value);
            if (proj.tilt !== undefined) { setTiltDeg(+proj.tilt || 0); $('tiltRange').value = tiltDeg; applyTilt(); }
            if (proj.hill) { $('hillTgl').checked = true; hillshade.addTo(map); }
            if (proj.chipPct) { setChipPct(+proj.chipPct); }
            else if (proj.chipFont) { setChipPct(Math.round(+proj.chipFont / 11.5 * 100)); }
            else { applyChipScale(); }
            if (proj.brand !== undefined) { $('brandTgl').checked = !!proj.brand; document.body.classList.toggle('no-brand', !proj.brand); }
            if (proj.north !== undefined) { $('northTgl').checked = !!proj.north; document.body.classList.toggle('no-north', !proj.north); }
            if (proj.projectLogo) { setProjectLogo(proj.projectLogo); }
            if (proj.siteUsesProjLogo) { brand.siteUsesProjLogo = true; $('siteUsesProjLogo').checked = true; }
            (proj.locations || []).forEach(l => addLocation(l));
            (proj.routes || []).forEach(r => addRoute(r));
            (proj.geometries || []).forEach(f => importGeoJSONFeature(f));
            if (proj.view) map.setView(proj.view.c, proj.view.z); else fitAll();
            status('Project loaded.');
          } catch (err) { status('Could not read that file — is it a saved project (.json)?'); }
        };
        rd.readAsText(f);
        e.target.value = '';
      });
      function clearAll() {
        routes.slice().forEach(deleteRoute);
        locations.slice().forEach(deleteLocation);
      }
      }

