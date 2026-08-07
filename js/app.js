/**
 * app.js — application entry point.
 *
 * Every feature now lives in its own module (core/ map/ ui/ services/
 * project/ export/); this file only assembles them: sets the brand logo,
 * wires the billboard overlay to the map, wires every button/handler that
 * owns no other natural home, and prints the initial status message.
 */

// ui/toolbar.js and ui/sidebar.js wire their own buttons/tabs as a
// side-effect of being imported (all their listeners are plain top-level
// statements, matching the pattern map/mapEngine.js and map/routes.js use
// for the controls they each own).


// Exposed for the browser smoke test, console debugging, and the app's own
// PPTX button handler (export/pptxHandler.js) via this same reference.
window.DBOTExport = { exportDeck };

// ---------- version marker ----------
// Matches the ?v= stamp on every asset URL, so a mismatch between what this
// shows and the released version means the browser is serving a stale build.
(function showVersion() {
  const el = document.getElementById('appVer');
  if (el) el.textContent = 'v' + APP_VERSION;
})();

// Warn if the browser is serving a document older than what is deployed.
// See js/core/freshness.js — the assets bust on ?v=, the HTML cannot.
initFreshness();

// ---------- DBOT brand asset ----------
document.querySelectorAll('.dbotLogo').forEach(i => { i.src = 'data:image/png;base64,' + LOGO_B64; });

// Wire the billboard overlay to the map (see map/billboard.js).
initBillboard();

// Replace the browser's native `title` tooltips with the app's own.
initTooltips();
initSliders();

// export/* and project/* each export a wire*() function instead of wiring at
// module-load time, so every DOM listener they own is visible from one place.
initLegendDrag();
wirePngExport();
wirePrintExport();
wirePptxExport();
wireSaveProject();
initExportCenter();
initImportDialog();
initTabs();
initAiTab();
initIconPicker();
wireOpenProject();
// Autosave last, so the restore happens after every subsystem it touches
// (basemaps, brand, drawing) is wired and ready to be handed state.
//
// The project bridge has to settle *before* initAutosave, not merely start
// before it: initAutosave asks whether a named project claimed this session,
// and an unawaited promise would have it answer "no" every time and restore
// the previous session over the project the user just opened.
initAutosaveUI();
projectBridgeBoot()
  .catch(e => console.warn('Project bridge: boot failed —', e && e.message))
  // A file chosen on the projects page is waiting in sessionStorage. It has to
  // land after the project it belongs to has been applied — applyProject()
  // clears the map, so importing first would draw the places and then wipe
  // them — and before initAutosave(), so the very first autosave already has
  // the imported map in it.
  .then(() => runPendingImport())
  .then(() => initAutosave());

buildImageryLookControl();
buildRoadLookControl();
syncEmpties();
status('Start blank: type in the search bar for live suggestions, paste "lat, lng" directly, or use Click-to-add.');
