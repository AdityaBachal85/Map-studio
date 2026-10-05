/**
 * ui/importDialog.js — the review step of the bulk location import.
 *
 * The whole point of this feature is the pause. Reading a spreadsheet is easy;
 * the value is in refusing to touch the map until the operator has seen what
 * twenty rows are about to become. A mistyped coordinate does not announce
 * itself — it is a pin three streets from where it should be, in a deck that
 * has already gone to a client.
 *
 * So the flow is: pick a file → every row is checked → a report with a verdict
 * per row → an explicit Import. Bad rows are named and skipped; they never hold
 * up the good ones, because a sheet of twenty with one bad row should import
 * nineteen, not nothing.
 */

let importDlg = null;

/** The parsed sheet currently under review. */
let importState = null;

/* ---------------------------------------------------------------------------
 * Rendering the report
 * ------------------------------------------------------------------------- */

/** Human distance for the extent line. */
function importSpan(m) {
  return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
}

/**
 * Draw the check report.
 *
 * Ordering is deliberate: rows that will not import come first. The failure is
 * the thing that needs a decision; the eighteen that are fine need only a
 * count.
 */
function renderImportReport() {
  const s = importState;
  if (!s) return;

  const chips = $('impSummary');
  chips.innerHTML =
    `<span class="imp-chip good"><b>${s.summary.ready}</b> ready</span>` +
    (s.summary.warned ? `<span class="imp-chip warn"><b>${s.summary.warned}</b> with a warning</span>` : '') +
    (s.summary.skipped ? `<span class="imp-chip bad"><b>${s.summary.skipped}</b> will be skipped</span>` : '') +
    (s.summary.routes ? `<span class="imp-chip"><b>${s.summary.routes}</b> route${s.summary.routes > 1 ? 's' : ''}</span>` : '');

  // One sentence that makes a whole sheet checkable at a glance. A stray row is
  // far easier to notice as "spanning 1,400 km" than by reading twenty numbers.
  const ext = s.summary.extent;
  $('impExtent').textContent = ext
    ? `${s.summary.ready} point${s.summary.ready > 1 ? 's' : ''}, spanning ${importSpan(ext.span)} · centre ${ext.centre.lat.toFixed(4)}, ${ext.centre.lng.toFixed(4)}`
    : '';

  const fixBtn = $('impFixSwap');
  fixBtn.hidden = !s.summary.fixable;
  if (s.summary.fixable) {
    fixBtn.textContent = `Swap latitude and longitude on ${s.summary.fixable} row${s.summary.fixable > 1 ? 's' : ''}`;
  }

  const tbody = $('impRows');
  tbody.innerHTML = '';
  const ordered = s.records.slice().sort((a, b) => {
    const rank = r => (r.errors.length ? 0 : (r.warnings.length ? 1 : 2));
    return rank(a) - rank(b) || a.row - b.row;
  });

  ordered.forEach(r => {
    const bad = !!r.errors.length;
    const warn = !bad && !!r.warnings.length;
    const notes = r.errors.concat(r.warnings);
    const tr = document.createElement('tr');
    tr.className = bad ? 'bad' : (warn ? 'warn' : '');
    tr.innerHTML =
      `<td class="imp-row-n">${r.row}</td>` +
      `<td class="imp-st">${bad ? 'Skip' : (warn ? 'Check' : 'OK')}</td>` +
      `<td>${esc(r.name || '—')}${r.type !== 'pin' ? ` <i>${esc(LOC_TYPE_LABEL[r.type])}</i>` : ''}</td>` +
      `<td class="imp-coord">${r.lat != null ? esc(formatLatLng(r.lat, r.lng)) : esc(r.rawCoords || '—')}</td>` +
      `<td>${r.routeTo ? esc(r.routeTo) : '—'}</td>` +
      `<td class="imp-note">${notes.map(esc).join(' ')}</td>`;
    tbody.appendChild(tr);
  });

  const btn = $('impGo');
  btn.disabled = !s.summary.ready;
  btn.textContent = s.summary.ready
    ? `Import ${s.summary.ready} location${s.summary.ready > 1 ? 's' : ''}` +
    (s.summary.skipped ? ` of ${s.summary.total}` : '')
    : 'Nothing to import';

  $('impReport').hidden = false;
  $('impError').hidden = true;
  // Step 1 has done its job — shrink it so the report and the action fit on
  // screen together. A file chooser that keeps its full height after the file
  // is chosen is just pushing the thing you came here to press out of view.
  $('impStep1').classList.add('done');
}

/**
 * Re-run the checks after an inline fix.
 *
 * validateImport rebuilds every row's problems from its own baseline, so this
 * is simply a re-run — no unpicking of previous messages, which is where a
 * stale "duplicate name" would otherwise survive the duplicate being fixed.
 */
function revalidateImport() {
  if (!importState) return;
  importState.summary = validateImport(importState.records, typeof locations !== 'undefined' ? locations : []);
  renderImportReport();
}

/* ---------------------------------------------------------------------------
 * Reading a file
 * ------------------------------------------------------------------------- */

/** Show a fatal problem — a file that is not a sheet at all. */
function importFailed(msg) {
  importState = null;
  $('impStep1').classList.remove('done');
  $('impReport').hidden = true;
  $('impError').hidden = false;
  $('impError').textContent = msg;
}

/** @param {File} file */
async function loadImportFile(file) {
  $('impFileName').textContent = file.name;
  $('impError').hidden = true;
  $('impReport').hidden = true;
  try {
    const grid = await readSheetFile(file);
    const parsed = parseSheetGrid(grid);
    if (!parsed.ok) { importFailed(parsed.error); return; }
    importState = {
      records: parsed.records,
      columns: parsed.columns,
      summary: validateImport(parsed.records, typeof locations !== 'undefined' ? locations : []),
    };
    renderImportReport();
  } catch (e) {
    importFailed(e.message || 'Could not read that file.');
  }
}

/* ---------------------------------------------------------------------------
 * Applying
 * ------------------------------------------------------------------------- */

/**
 * Create the locations and then the routes.
 *
 * Locations land immediately — they need no network and the operator should see
 * their map fill in at once. Routes are computed **one at a time**: twenty
 * simultaneous requests to a public OSRM instance get rate-limited, and a map
 * with eleven of its twenty routes drawn is worse than one that took half a
 * minute to finish. A route that fails is counted and reported rather than
 * abandoning the rest.
 */
async function applyImport() {
  const s = importState;
  if (!s || !s.summary.ready) return;
  const replace = $('impReplace').checked;
  const ready = s.records.filter(r => !r.errors.length);

  importDlg.close();

  if (replace && typeof deleteLocation === 'function') {
    locations.slice().forEach(deleteLocation);
  }

  // Row → created location, so a "Route to" naming another row can be resolved
  // after everything exists.
  const made = new Map();
  ready.forEach(r => {
    const loc = addLocation({ name: r.name, lat: r.lat, lng: r.lng, type: r.type });
    made.set(r, loc);
  });

  const pending = [];
  ready.forEach(r => {
    if (!r.routeTarget) return;
    const from = made.get(r);
    const to = r.routeTarget.kind === 'row' ? made.get(r.routeTarget.rec) : r.routeTarget.loc;
    // A route whose target row was skipped simply does not appear; the location
    // is still imported, because losing the pin as well would compound one
    // error into two.
    if (!from || !to || from === to) return;
    pending.push(addRoute({ fromId: from.id, toId: to.id, mode: r.mode, defer: true }));
  });

  if (typeof fitAll === 'function') fitAll();
  status(`Imported ${ready.length} location${ready.length > 1 ? 's' : ''}` +
    (s.summary.skipped ? `, skipped ${s.summary.skipped}` : '') +
    (pending.length ? `. Routing ${pending.length}…` : '.'), !!pending.length);

  let done = 0, failed = 0;
  for (const rt of pending) {
    try { await computeRoute(rt); } catch (e) { failed++; }
    done++;
    if (pending.length > 1) status(`Routing ${done} of ${pending.length}…`, true);
  }

  if (pending.length) {
    status(`Imported ${ready.length} location${ready.length > 1 ? 's' : ''} and ` +
      `${pending.length - failed} route${pending.length - failed === 1 ? '' : 's'}` +
      (failed ? ` — ${failed} route${failed > 1 ? 's' : ''} could not be computed.` : '.'), !!failed);
  }
  importState = null;
}

/* ---------------------------------------------------------------------------
 * Template download
 * ------------------------------------------------------------------------- */

/** @param {Blob} blob @param {string} name */
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** Blank template, with the dropdowns armed and three example rows. */
async function downloadSheetTemplate() {
  try {
    downloadBlob(await buildSheetWorkbook(null), 'map-studio-locations-template.xlsx');
    status('Template downloaded — fill in the Locations sheet, then import it.');
  } catch (e) {
    status('Could not build the template: ' + e.message);
  }
}

/** The current map in the same layout, for the round trip. */
async function exportSheetOfCurrentMap() {
  const rows = currentMapAsSheetRows();
  if (!rows.length) { status('There are no locations to export yet.'); return; }
  try {
    downloadBlob(await buildSheetWorkbook(rows), 'map-studio-locations.xlsx');
    status(`Exported ${rows.length} location${rows.length > 1 ? 's' : ''} to Excel.`);
  } catch (e) {
    status('Could not build the workbook: ' + e.message);
  }
}

/* ---------------------------------------------------------------------------
 * Wiring
 * ------------------------------------------------------------------------- */

function initImportDialog() {
  if (!$('importOverlay')) return;
  importDlg = wireModal('importOverlay', 'importClose');

  $('importOpenBtn').addEventListener('click', () => {
    importState = null;
    $('impStep1').classList.remove('done');
    $('impReport').hidden = true;
    $('impError').hidden = true;
    $('impGo').disabled = true;
    $('impGo').textContent = 'Import';
    $('impFileName').textContent = 'No file chosen';
    $('impInput').value = '';
    importDlg.open();
  });

  $('impPick').addEventListener('click', () => $('impInput').click());
  $('impInput').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) loadImportFile(f);
  });

  // Drag and drop, because the file is usually already sitting in a folder
  // next to the browser window.
  const drop = $('impDrop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadImportFile(f);
  });

  $('impFixSwap').addEventListener('click', () => {
    if (!importState) return;
    const n = swapFlaggedRows(importState.records);
    revalidateImport();
    status(`Swapped latitude and longitude on ${n} row${n > 1 ? 's' : ''}.`);
  });

  $('impTemplateBtn').addEventListener('click', downloadSheetTemplate);
  $('impGo').addEventListener('click', applyImport);
  const xl = $('xlsxExportBtn');
  if (xl) xl.addEventListener('click', exportSheetOfCurrentMap);
}
