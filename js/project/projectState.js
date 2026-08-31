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
 * One location as plain data.
 *
 * Named rather than inlined in serialiseProject() because undo-delete
 * (map/markers.js) snapshots a single location with it. Sharing the one
 * function is what guarantees a restored location carries everything a saved
 * one does — a second, hand-written field list would drift the first time
 * somebody adds a property.
 *
 * @param {object} l @returns {object}
 */
function serialiseLocation(l) {
  return {
    id: l.id, name: l.name, lat: l.lat, lng: l.lng, color: l.color, type: l.type,
    badgeText: l.badgeText,
    showLabel: l.showLabel, labelOffset: l.labelOffset, labelPinned: l.labelPinned, labelScale: l.labelScale,
    // labelShowIcon is deliberately not saved: labels carry the name only
    // (see map/markers.js). Writing it back would keep resurrecting the
    // setting in files long after nothing reads it.
    labelBg: l.labelBg,
    iconKey: l.iconKey, iconImage: l.iconImage, iconUseProjectLogo: l.iconUseProjectLogo,
    iconSize: l.iconSize, iconFrame: l.iconFrame, iconBg: l.iconBg,
    iconBorder: l.iconBorder, iconBorderColor: l.iconBorderColor,
    iconShadow: l.iconShadow, iconGlow: l.iconGlow,
    hideMarker: l.hideMarker,
    // undefined rather than false so an ordinary location's JSON does not grow
    // a key — which keeps old projects byte-comparable to new ones, and the
    // history fingerprint stable.
    routeAnchor: l.routeAnchor || undefined,
    rings: l.rings,
    // `photo` was missing from the original serialiser, so a location's photo
    // survived only until the tab closed — it was dropped by Save and never
    // came back from Open. Autosave would have inherited exactly that hole.
    photo: l.photo || null,
    photoCaption: l.photoCaption || '',
    photoDesc: l.photoDesc || '',
    photoW: l.photoW || 168,
  };
}

/**
 * One route as plain data, including its computed geometry.
 * @param {object} r @returns {object}
 */
function serialiseRoute(r) {
  const alt = r.alts && r.alts[r.altIndex];
  return {
    id: r.id, fromId: r.fromId, toId: r.toId, mode: r.mode, color: r.color,
    // The road class, so a project reopens with its legend intact and the
    // standard can restyle it if the palette is ever revised.
    cls: r.cls || undefined, proposed: r.proposed || undefined,
    weight: r.weight, dash: r.dash, offsetPx: r.offsetPx, labelText: r.labelText,
    showLabel: r.showLabel, labelOffset: r.labelOffset, labelBg: r.labelBg,
    labelPos: r.labelPos, labelScale: r.labelScale,
    viaPoints: (r.viaPoints || []).map(v => ({ lat: v.lat, lng: v.lng })),
    viaHidden: !!r.viaHidden,
    // The computed geometry travels with the route so reopening a project
    // does not re-spend a routing request per route.
    saved: alt ? { d: alt.d, t: alt.t, coords: alt.coords, approx: r.approx } : null,
  };
}

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
    // Which kind of map this is — connectivity or satellite. Saved with the
    // project because it is a property of the map, not of whoever opens it.
    layout: (typeof mapLayout === 'function') ? mapLayout() : undefined,
    imageryLook: getImageryLook(),
    roadLook: getRoadLook(),
    tilt: tiltDeg,
    hill: $('hillTgl').checked,
    chipPct: chipPct,
    hd: $('hdTgl').checked,
    brand: $('brandTgl').checked,
    north: $('northTgl').checked,
    // Whether the title card and the scale bar are showing, not just what the
    // title says. They default to off now, so a project that deliberately turns
    // them on has to carry that or it loses the setting every time it opens.
    titleOn: $('titleTgl').checked,
    scaleOn: $('scaleTgl').checked,
    projectLogo: brand.projectLogo,
    siteUsesProjLogo: brand.siteUsesProjLogo,
    // The Key Distances card's overrides. Only what differs from the measured
    // table is stored, so a project saved before this existed still opens with
    // a live table rather than a frozen copy of one.
    legendEdits: (typeof legendEdits === 'object' && legendEdits) ? legendEdits : {},
    legendExtras: (typeof legendExtras !== 'undefined' && Array.isArray(legendExtras)) ? legendExtras : [],
    legendShowTime: (typeof legendShowTime === 'undefined') ? true : !!legendShowTime,
    legendOrder: (typeof legendOrder !== 'undefined' && Array.isArray(legendOrder)) ? legendOrder : [],
    // The colour key's captions. Keyed by class id, not row position, so a
    // rename survives drawing one more road and reordering the rows.
    colorKeyTitle: (document.getElementById('colorKeyTitle') || {}).textContent || undefined,
    colorKeyEdits: (typeof colorKeyEdits === 'object' && colorKeyEdits) ? colorKeyEdits : {},
    colorKeyExtras: (typeof colorKeyExtras !== 'undefined' && Array.isArray(colorKeyExtras)) ? colorKeyExtras : [],
    mapOverlays: (typeof activeOverlays === 'function') ? activeOverlays() : [],
    // Which groups of the vector style are switched off. A property of the map
    // somebody composed, not of the browser they composed it in — a project
    // saved with the medical symbols hidden has to reopen with them hidden, or
    // the deliverable changes behind their back.
    vectorLayers: (typeof vectorLayerPrefs === 'function') ? vectorLayerPrefs() : undefined,
    // Settings and the study area only — never the contours themselves. Half a
    // million coordinates would dwarf everything else in the file, and they are
    // derived: the same area at the same interval gives the same lines back for
    // the cost of one DEM read on open.
    contour: (typeof contourSettings === 'function') ? contourSettings() : undefined,
    // The board and the sheet travel with the map they describe: they are
    // about this place, not about this browser.
    dashboard: (typeof dashCards !== 'undefined' && dashCards.length) ? dashCards : undefined,
    // The map's tile goes with them: how big the map was on the board is part
    // of the layout somebody arranged, not a preference of this browser.
    dashMap: (typeof dashMapTile !== 'undefined' && dashMapTile) ? dashMapTile : undefined,
    reportSheet: (typeof reportSheet !== 'undefined' && reportSheet) ? reportSheet : undefined,
    locations: locations.map(serialiseLocation),
    routes: routes.map(serialiseRoute),
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
/**
 * What the three editable card titles say before anybody renames them.
 *
 * Named here rather than read back out of the DOM: by the time a project is
 * applied the DOM holds the PREVIOUS project's titles, so "the default" has to
 * be a constant. They match index.html; if one is edited there, edit it here.
 */
const TITLE_CARD_DEFAULT = 'PROPERTY LOCATION & ACCESS';
const LEGEND_TITLE_DEFAULT = 'KEY DISTANCES';
const COLOR_KEY_TITLE_DEFAULT = 'LEGEND';

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

  // A FIELD THE PROJECT DOES NOT CARRY MEANS THE DEFAULT, NOT WHATEVER WAS
  // THERE BEFORE. These were all written as `if (proj.x) set(x)` with no else,
  // which is correct for restoring a saved project and wrong for opening a new
  // one: New project writes an empty document, so every one of these silently
  // kept the last project's value. The reported symptom was a brand new map
  // still titled "MY OLD PROJECT", and the same bug was sitting under the
  // legend titles, the hillshade, the logo and the imagery grading.
  $('titleCard').textContent = proj.title || TITLE_CARD_DEFAULT;
  $('legendTitle').textContent = proj.legendTitle || LEGEND_TITLE_DEFAULT;
  if (proj.hd !== undefined) $('hdTgl').checked = !!proj.hd;
  if (proj.basemap && BASEMAPS[proj.basemap]) $('basemapSel').value = proj.basemap;
  setImageryLook(proj.imageryLook || (typeof getPref === 'function' ? getPref('imageryLook') : 'natural'));
  setRoadLook(proj.roadLook || (typeof getPref === 'function' ? getPref('roadLook') : 'subtle'));
  // Before setBasemap, not after: mounting a vector ground applies these as its
  // style loads, so a pref written afterwards would arrive to a ground that had
  // already drawn itself with the previous project's filters.
  try {
    setPref('vectorLayers',
      (proj.vectorLayers && typeof proj.vectorLayers === 'object') ? proj.vectorLayers : null);
  } catch (e) { /* ignore */ }
  if (typeof applyContourSettings === 'function') {
    // Always called, even with nothing saved: a project without a contour map
    // has to CLEAR whatever the last one left on screen, not inherit it.
    if (proj.contour && typeof proj.contour === 'object') applyContourSettings(proj.contour);
    else if (typeof clearContourMap === 'function') clearContourMap();
  }
  setBasemap($('basemapSel').value);
  if (proj.tilt !== undefined) { setTiltDeg(+proj.tilt || 0); $('tiltRange').value = tiltDeg; applyTilt(); }
  // Off unless the project says on. It only ever turned itself ON, so terrain
  // shading followed you out of the project that wanted it and into the next.
  const hillOn = !!proj.hill;
  $('hillTgl').checked = hillOn;
  if (hillOn) hillshade.addTo(map);
  else if (map.hasLayer(hillshade)) map.removeLayer(hillshade);
  if (proj.chipPct) setChipPct(+proj.chipPct);
  else if (proj.chipFont) setChipPct(Math.round(+proj.chipFont / 11.5 * 100));
  else applyChipScale();
  if (proj.brand !== undefined) { $('brandTgl').checked = !!proj.brand; document.body.classList.toggle('no-brand', !proj.brand); }
  // Dispatched rather than set directly: the toggle's own handler owns building
  // and tearing down the scale control, and duplicating that here is how the
  // two get out of step.
  [['titleTgl', proj.titleOn], ['scaleTgl', proj.scaleOn]].forEach(([id, on]) => {
    if (on === undefined) return;
    const el = $(id);
    if (!el || el.checked === !!on) return;
    el.checked = !!on;
    el.dispatchEvent(new Event('change'));
  });
  if (proj.north !== undefined) { $('northTgl').checked = !!proj.north; document.body.classList.toggle('no-north', !proj.north); }
  setProjectLogo(proj.projectLogo || null);
  brand.siteUsesProjLogo = !!proj.siteUsesProjLogo;
  $('siteUsesProjLogo').checked = !!proj.siteUsesProjLogo;

  if (typeof dashCards !== 'undefined') {
    dashCards = Array.isArray(proj.dashboard) ? proj.dashboard : [];
    // Keep new cards from colliding with restored ids.
    dashCardSeq = dashCards.reduce((n, c) => Math.max(n, (parseInt(String(c.id).slice(1), 10) || 0) + 1), 1);
  }
  if (typeof dashMapTile !== 'undefined') {
    const m = proj.dashMap;
    // Sanity-check the restored geometry rather than trusting the file: a bad
    // width would put the map off the canvas with no handle to drag it back.
    dashMapTile = (m && isFinite(m.x) && isFinite(m.y) && m.w > 0 && m.h > 0)
      ? { id: DASH_MAP_ID, x: +m.x, y: +m.y, w: +m.w, h: +m.h }
      : { id: DASH_MAP_ID, x: 0, y: 0, w: 8, h: 14 };
  }
  if (typeof reportSheet !== 'undefined') {
    reportSheet = (proj.reportSheet && typeof proj.reportSheet === 'object') ? proj.reportSheet : null;
  }
  if (typeof renderDashboard === 'function' && appMode() === 'dashboard') renderDashboard();
  if (typeof renderReportSheet === 'function' && appMode() === 'report') renderReportSheet();

  if (typeof legendShowTime !== 'undefined') legendShowTime = proj.legendShowTime !== false;
  if (typeof colorKeyEdits !== 'undefined') {
    colorKeyEdits = (proj.colorKeyEdits && typeof proj.colorKeyEdits === 'object') ? proj.colorKeyEdits : {};
    colorKeyExtras = Array.isArray(proj.colorKeyExtras) ? proj.colorKeyExtras : [];
    const t = document.getElementById('colorKeyTitle');
    if (t) t.textContent = proj.colorKeyTitle || COLOR_KEY_TITLE_DEFAULT;
  }
  if (typeof legendOrder !== 'undefined') legendOrder = Array.isArray(proj.legendOrder) ? proj.legendOrder : [];
  if (typeof legendEdits !== 'undefined') legendEdits = (proj.legendEdits && typeof proj.legendEdits === 'object') ? proj.legendEdits : {};
  if (typeof legendExtras !== 'undefined') {
    legendExtras = Array.isArray(proj.legendExtras) ? proj.legendExtras : [];
    // Keep new hand-added rows from colliding with restored ones.
    legendExtraSeq = legendExtras.reduce((n, x) => Math.max(n, (+x.id || 0) + 1), 1);
  }

  // The layout before the contents: it decides the ground and whether the
  // standard is on, and both of those want to be settled before routes and
  // shapes arrive asking what colour they are. keepBasemap because the project
  // saved its own basemap above — the layout's default must not overrule a
  // deliberate choice somebody saved.
  if (typeof setMapLayout === 'function') {
    setMapLayout(proj.layout || (typeof MAP_LAYOUT_DEFAULT !== 'undefined' ? MAP_LAYOUT_DEFAULT : 'satellite'),
      { silent: true, keepBasemap: true });
  }

  (proj.locations || []).forEach(l => addLocation(l));
  (proj.routes || []).forEach(r => addRoute(r));
  (proj.geometries || []).forEach(f => importGeoJSONFeature(f));

  // Rebuild the legends now that everything is in. Nothing else does it after
  // a load: routes trigger a rebuild when their measurements come back, but
  // shapes do not recompute, so a project whose key is driven by shape classes
  // reopened with a key describing the *previous* project — every row that came
  // from a shape simply missing. The data was on disk and correct; only the
  // card was stale, which is the kind of bug that reads as data loss.
  if (proj.view) map.setView(proj.view.c, proj.view.z);
  else if (typeof fitAll === 'function') fitAll();

  if (typeof rebuildLegend === 'function') rebuildLegend();
  // A project stores the ground it was saved with, so opening an older file is
  // one of the ways an icon-heavy basemap returns. The setting has to outrank
  // the file, or it holds until the first time you open your own work.
  if (typeof enforcePlaceIcons === 'function') { try { enforcePlaceIcons(); } catch (e) { } }
  if (typeof reapplyMapOverlays === 'function') {
    try { setPref('mapOverlays', Array.isArray(proj.mapOverlays) ? proj.mapOverlays : []); } catch (e) { }
    reapplyMapOverlays();
  }

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
