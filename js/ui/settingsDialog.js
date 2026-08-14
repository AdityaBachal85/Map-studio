/**
 * ui/settingsDialog.js — the Preferences dialog (gear button). Presentation +
 * wiring only; all state lives in core/prefs.js. Opening reflects the saved
 * prefs into the controls; changing a control writes through setPref() and
 * applies the effect immediately. Kept distinct from the "Settings" tab, which
 * holds map/export/project options.
 */

function reflectPrefs() {
  $('prefTheme').querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.v === getPref('theme')));
  $('prefGlass').checked = !!getPref('glass');
  $('prefMotion').checked = !!getPref('reduceMotion');
  $('prefUnitDistance').value = getPref('unitDistance');
  $('prefUnitArea').value = getPref('unitArea');
  $('prefVectorBasemap').checked = !!getPref('vectorBasemap');
}

/** Re-render any on-screen measurements after a unit change. */
function refreshMeasurementsForUnits() {
  if (typeof geometries !== 'undefined') geometries.forEach(g => updateGeomMeasurement(g));
}

function openPrefs() { reflectPrefs(); $('prefsOverlay').hidden = false; }
function closePrefs() { $('prefsOverlay').hidden = true; }

$('prefsBtn').addEventListener('click', openPrefs);
$('prefsClose').addEventListener('click', closePrefs);
$('prefsOverlay').addEventListener('click', e => { if (e.target === $('prefsOverlay')) closePrefs(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('prefsOverlay').hidden) closePrefs(); });

$('prefTheme').querySelectorAll('.seg-btn').forEach(btn => {
  btn.addEventListener('click', () => { setPref('theme', btn.dataset.v); applyTheme(); reflectPrefs(); });
});
$('prefGlass').addEventListener('change', e => {
  setPref('glass', e.target.checked); applyGlass();
});
$('prefMotion').addEventListener('change', e => { setPref('reduceMotion', e.target.checked); applyMotion(); });
$('prefUnitDistance').addEventListener('change', e => { setPref('unitDistance', e.target.value); refreshMeasurementsForUnits(); });
$('prefUnitArea').addEventListener('change', e => { setPref('unitArea', e.target.value); refreshMeasurementsForUnits(); });
/**
 * The vector ground is gated in the basemap catalogue rather than in the
 * switcher, so flipping this changes what availableBasemaps() returns — and the
 * registry mapEngine built from it has to be rebuilt, or the picker goes on
 * offering yesterday's answer. Turning it *off* while it is the active ground
 * would leave the map on a basemap that no longer exists, so that case falls
 * back to the layout's own ground first.
 */
$('prefVectorBasemap').addEventListener('change', e => {
  setPref('vectorBasemap', e.target.checked);
  if (typeof rebuildBasemapRegistry === 'function') rebuildBasemapRegistry();
  if (!e.target.checked && typeof activeKey !== 'undefined' && activeKey === 'openfreemap') {
    setBasemap(typeof layoutBasemap === 'function' ? layoutBasemap(mapLayout()) : 'osm');
  }
  if (typeof buildBasemapGrid === 'function') buildBasemapGrid();
  if (typeof syncBasemapSwitcher === 'function') syncBasemapSwitcher(activeKey);
  status(e.target.checked
    ? 'Vector street map added to the basemap picker — choose “Streets — vector”.'
    : 'Vector street map hidden from the basemap picker.');
});
$('prefReset').addEventListener('click', () => { resetPrefs(); reflectPrefs(); refreshMeasurementsForUnits(); status('Preferences reset to defaults.'); });

// Apply persisted glass / motion once at startup. Preferences is the single
// home for both: the Settings tab used to carry a duplicate "Glass / frost
// effects" checkbox, and two controls for one setting is a consistency bug —
// they can disagree, and neither reads as authoritative.
applyGlass();
applyMotion();
