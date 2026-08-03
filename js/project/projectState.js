/**
 * project/projectState.js — the one definition of "what a project is".
 *
 * WHY THIS FILE EXISTS
 *
 * Serialising and restoring used to live inside the Save button's click handler
 * and the Open button's FileReader callback. That was fine while a file download
 * was the only consumer. It stopped being fine the moment anything else needed
 * the same state — autosave, session restore, a project library, a thumbnail —
 * because two copies of "what a project is" drift, and the failure mode is
 * silent: your autosave restores a slightly different map from the one your
 * .json file would.
 *
 * So there is exactly one `serialiseProject()` and one `applyProject()`, and
 * everything else calls them. If a field is missing from a save, it is missing
 * from all of them, which is a bug you can find.
 */

/**
 * Snapshot the whole editable state as a plain object.
 *
 * Plain data only: no DOM nodes, no Leaflet layers, no functions. That is what
 * lets the same object be JSON.stringify'd to a file, handed to IndexedDB's
 * structured clone, or hashed to see whether anything changed.
 *
 * @returns {object}
 */
function serialiseProject() {
  return {
    v: 4.96,
    appVersion: APP_VERSION,
    savedAt: new Date().toISOString(),
    title: $('titleCard').textContent,
    legendTitle: $('legendTitle').textContent,
    view: { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() },
    basemap: activeKey,
    imageryLook: getImageryLook(),
    roadLook: getRoadLook(),
    tilt: tiltDeg,
    hill: $('hillTgl').checked,
    chipPct: chipPct,
    hd: $('hdTgl').checked,
    brand: $('brandTgl').checked,
    north: $('northTgl').checked,
    projectLogo: brand.projectLogo,
    siteUsesProjLogo: brand.siteUsesProjLogo,
    locations: locations.map(l => ({
      id: l.id, name: l.name, lat: l.lat, lng: l.lng, color: l.color, type: l.type,
      badgeText: l.badgeText,
      showLabel: l.showLabel, labelOffset: l.labelOffset, labelPinned: l.labelPinned,
      // labelShowIcon is deliberately not saved: labels carry the name only
      // (see map/markers.js). Writing it back would keep resurrecting the
      // setting in files long after nothing reads it.
      labelBg: l.labelBg,
      iconKey: l.iconKey, iconImage: l.iconImage, iconUseProjectLogo: l.iconUseProjectLogo,
      iconSize: l.iconSize, iconFrame: l.iconFrame, iconBg: l.iconBg,
      iconBorder: l.iconBorder, iconBorderColor: l.iconBorderColor,
      iconShadow: l.iconShadow, iconGlow: l.iconGlow,
      hideMarker: l.hideMarker,
      rings: l.rings,
      // `photo` was missing from the original serialiser, so a location's photo
      // survived only until the tab closed — it was dropped by Save and never
      // came back from Open. Autosave would have inherited exactly that hole.
      photo: l.photo || null,
    })),
    routes: routes.map(r => {
      const alt = r.alts && r.alts[r.altIndex];
      return {
        id: r.id, fromId: r.fromId, toId: r.toId, mode: r.mode, color: r.color,
        weight: r.weight, dash: r.dash, offsetPx: r.offsetPx, labelText: r.labelText,
        showLabel: r.showLabel, labelOffset: r.labelOffset, labelBg: r.labelBg,
        viaPoints: (r.viaPoints || []).map(v => ({ lat: v.lat, lng: v.lng })),
        // The computed geometry travels with the route so reopening a project
        // does not re-spend a routing request per route.
        saved: alt ? { d: alt.d, t: alt.t, coords: alt.coords, approx: r.approx } : null,
      };
    }),
    geometries: geometries.map(geomToGeoJSONFeature),
  };
}

/**
 * Remove every location, route and drawn shape.
 *
 * There used to be two of these — one here and one shadowing it inside
 * `wireOpenProject`, and the inner one had no `clearAllGeometries`. Since the
 * inner definition is the one the Open handler saw, loading a project left the
 * previous drawing on the map and quietly accumulated shapes. That mattered
 * little when loading was a rare manual act; with session restore it would
 * duplicate every shape on every reload.
 */
function clearProject() {
  routes.slice().forEach(deleteRoute);
  locations.slice().forEach(deleteLocation);
  if (typeof clearAllGeometries === 'function') clearAllGeometries();
}

/**
 * Restore a snapshot produced by `serialiseProject()`.
 *
 * @param {object} proj
 * @param {{silent?:boolean}} [opts] `silent` suppresses the status line, for
 *        session restore where the caller says its own thing.
 * @returns {boolean} whether it applied
 */
function applyProject(proj, opts) {
  if (!proj || typeof proj !== 'object') return false;
  const silent = opts && opts.silent;
  clearProject();

  if (proj.title) $('titleCard').textContent = proj.title;
  if (proj.legendTitle) $('legendTitle').textContent = proj.legendTitle;
  if (proj.hd !== undefined) $('hdTgl').checked = !!proj.hd;
  if (proj.basemap && BASEMAPS[proj.basemap]) $('basemapSel').value = proj.basemap;
  if (proj.imageryLook) setImageryLook(proj.imageryLook);
  if (proj.roadLook) setRoadLook(proj.roadLook);
  setBasemap($('basemapSel').value);
  if (proj.tilt !== undefined) { setTiltDeg(+proj.tilt || 0); $('tiltRange').value = tiltDeg; applyTilt(); }
  if (proj.hill) { $('hillTgl').checked = true; hillshade.addTo(map); }
  if (proj.chipPct) setChipPct(+proj.chipPct);
  else if (proj.chipFont) setChipPct(Math.round(+proj.chipFont / 11.5 * 100));
  else applyChipScale();
  if (proj.brand !== undefined) { $('brandTgl').checked = !!proj.brand; document.body.classList.toggle('no-brand', !proj.brand); }
  if (proj.north !== undefined) { $('northTgl').checked = !!proj.north; document.body.classList.toggle('no-north', !proj.north); }
  if (proj.projectLogo) setProjectLogo(proj.projectLogo);
  if (proj.siteUsesProjLogo) { brand.siteUsesProjLogo = true; $('siteUsesProjLogo').checked = true; }

  (proj.locations || []).forEach(l => addLocation(l));
  (proj.routes || []).forEach(r => addRoute(r));
  (proj.geometries || []).forEach(f => importGeoJSONFeature(f));

  if (proj.view) map.setView(proj.view.c, proj.view.z);
  else if (typeof fitAll === 'function') fitAll();

  if (!silent) status('Project loaded.');
  return true;
}

/** @returns {boolean} whether the map holds anything worth keeping. */
function projectHasContent(proj) {
  const p = proj || serialiseProject();
  return !!((p.locations && p.locations.length)
    || (p.routes && p.routes.length)
    || (p.geometries && p.geometries.length));
}
