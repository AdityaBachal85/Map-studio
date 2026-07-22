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
  const tgl = $('glassTgl'); if (tgl) tgl.checked = e.target.checked;   // keep the Settings-tab checkbox in sync
});
$('prefMotion').addEventListener('change', e => { setPref('reduceMotion', e.target.checked); applyMotion(); });
$('prefUnitDistance').addEventListener('change', e => { setPref('unitDistance', e.target.value); refreshMeasurementsForUnits(); });
$('prefUnitArea').addEventListener('change', e => { setPref('unitArea', e.target.value); refreshMeasurementsForUnits(); });
$('prefReset').addEventListener('click', () => { resetPrefs(); reflectPrefs(); refreshMeasurementsForUnits(); status('Preferences reset to defaults.'); });

// Apply persisted glass / motion once at startup and keep the existing
// Settings-tab "Glass / frost effects" checkbox as a second entry point.
applyGlass();
applyMotion();
(function syncGlassCheckbox() {
  const tgl = $('glassTgl');
  if (!tgl) return;
  tgl.checked = getPref('glass');
  tgl.addEventListener('change', e => { setPref('glass', e.target.checked); applyGlass(); });
})();
