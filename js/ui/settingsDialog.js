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
  $('prefBoardLight').checked = !!getPref('boardLight');
  $('prefMotion').checked = !!getPref('reduceMotion');
  $('prefLayout').querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.v === getPref('layout')));
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
  // applyBoardTheme rather than applyTheme: on the board with the light
  // override on, applyTheme would immediately undo it. It falls through to
  // applyTheme everywhere else, so this is the same call plus one condition.
  btn.addEventListener('click', () => {
    setPref('theme', btn.dataset.v);
    if (typeof applyBoardTheme === 'function') applyBoardTheme(); else applyTheme();
    reflectPrefs();
  });
});
/**
 * The layout a *new* map opens as — and the only writer of that pref.
 *
 * map/layouts.js deliberately no longer writes it when you switch layout on the
 * map, so this control is the setting rather than a record of the last thing
 * you touched. Applied immediately as well as saved: setting the default and
 * then watching the current map ignore it reads as the control not working.
 */
$('prefLayout').querySelectorAll('.seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setPref('layout', btn.dataset.v);
    reflectPrefs();
    if (typeof setMapLayout === 'function') setMapLayout(btn.dataset.v);
  });
});
$('prefGlass').addEventListener('change', e => {
  setPref('glass', e.target.checked); applyGlass();
});
$('prefBoardLight').addEventListener('change', e => {
  setPref('boardLight', e.target.checked);
  // Applied immediately, because this control is reachable FROM the board — the
  // gear is in its top bar — and a theme switch you have to leave and come back
  // to would read as not having worked.
  if (typeof applyBoardTheme === 'function') applyBoardTheme();
});
$('prefMotion').addEventListener('change', e => { setPref('reduceMotion', e.target.checked); applyMotion(); });
$('prefUnitDistance').addEventListener('change', e => { setPref('unitDistance', e.target.value); refreshMeasurementsForUnits(); });
$('prefUnitArea').addEventListener('change', e => { setPref('unitArea', e.target.value); refreshMeasurementsForUnits(); });
$('prefReset').addEventListener('click', () => { resetPrefs(); reflectPrefs(); refreshMeasurementsForUnits(); status('Preferences reset to defaults.'); });

// Apply persisted glass / motion once at startup. Preferences is the single
// home for both: the Settings tab used to carry a duplicate "Glass / frost
// effects" checkbox, and two controls for one setting is a consistency bug —
// they can disagree, and neither reads as authoritative.
applyGlass();
applyMotion();
