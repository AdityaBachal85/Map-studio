/**
 * project/openProject.js — restore a previously saved .json project: view,
 * basemap, tilt, chip scale, brand, and every location/route.
 */










/** Remove every route and location (used before loading a saved project). */
function clearAll() {
  routes.slice().forEach(deleteRoute);
  locations.slice().forEach(deleteLocation);
}

      function wireOpenProject() {
      $('loadBtn').addEventListener('click', () => $('loadInput').click());
      $('loadInput').addEventListener('change', e => {
        const f = e.target.files[0];
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

