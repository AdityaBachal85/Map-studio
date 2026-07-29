/**
 * ui/exportCenter.js — the Export Centre and Basemap Manager dialogs.
 *
 * Export used to be three buttons in an accordion plus a GeoJSON button on
 * another tab plus Save/Open on a third — the same decision ("get this map out
 * of the app") split across three places, with no way to see the full set of
 * options at once. One dialog groups them by what you get: an image, something
 * to present or print, or data.
 *
 * The PPTX / print / save / GeoJSON controls keep the ids they had in the
 * accordion, so every existing handler binds to them unchanged; only their
 * location moved.
 */

/* ---------------------------------------------------------------------------
 * Shared modal behaviour
 * ------------------------------------------------------------------------- */

/**
 * Wire a modal overlay: open/close, backdrop click, Escape, and focus return.
 * Returning focus to the trigger matters for keyboard users — without it, focus
 * lands back at the top of the document and the operator loses their place.
 * @param {string} overlayId @param {string} closeId
 * @returns {{open:Function, close:Function}}
 */
function wireModal(overlayId, closeId) {
  const overlay = $(overlayId);
  let lastFocus = null;

  function open() {
    lastFocus = document.activeElement;
    overlay.hidden = false;
    // Next frame, so the transition has a start state to animate from.
    requestAnimationFrame(() => overlay.classList.add('on'));
    const first = overlay.querySelector('button, input, select, [tabindex]');
    if (first) first.focus();
  }

  function close() {
    overlay.classList.remove('on');
    const done = () => { overlay.hidden = true; overlay.removeEventListener('transitionend', done); };
    overlay.addEventListener('transitionend', done);
    setTimeout(done, 320);                       // fallback if transitions are off
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  $(closeId).addEventListener('click', close);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });
  return { open, close };
}

/* ---------------------------------------------------------------------------
 * Export Centre
 * ------------------------------------------------------------------------- */

function buildExportCenter() {
  const rows = $('xcPng');
  if (!rows) return;

  // PNG presets are generated so the pixel dimensions stay truthful: they
  // depend on the window, so a hard-coded label would lie on a resize.
  PNG_PRESETS.forEach(p => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'xc-row';
    b.innerHTML =
      '<span class="xc-ico" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/>' +
      '<circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg></span>' +
      `<span class="xc-txt"><b>${p.label}</b><i>${p.hint}</i></span>` +
      '<span class="xc-meta"></span>';
    b.addEventListener('click', () => {
      exportCenter.close();
      runPngExport(p.scale);
    });
    rows.appendChild(b);
  });
}

/** Refresh the live pixel dimensions shown against each PNG preset. */
function syncExportCenter() {
  const rows = $('xcPng');
  if (!rows) return;
  Array.from(rows.querySelectorAll('.xc-row')).forEach((el, i) => {
    const meta = el.querySelector('.xc-meta');
    if (meta && PNG_PRESETS[i]) meta.textContent = pngPresetDimensions(PNG_PRESETS[i].scale);
  });
  const note = $('exportNote');
  if (note) {
    note.textContent = basemapExportSafe(activeKey)
      ? 'Exports use the current map view.'
      : 'This basemap’s tiles cannot be rasterised — image and slide exports are unavailable.';
    note.classList.toggle('warn', !basemapExportSafe(activeKey));
  }
}

let exportCenter = null;

/* ---------------------------------------------------------------------------
 * Basemap Manager
 * ------------------------------------------------------------------------- */

let bmMgr = null;

/** Render the list of stored custom basemaps. */
function renderBasemapManager() {
  const list = $('bmMgrList');
  const empty = $('bmMgrEmpty');
  if (!list) return;
  const items = loadCustomBasemaps();
  list.innerHTML = '';
  empty.style.display = items.length ? 'none' : '';

  items.forEach(c => {
    const row = document.createElement('div');
    row.className = 'bm-item';
    row.innerHTML =
      `<span class="bm-item-thumb" style="background-image:url('${sampleCustomTile(c.url, c.maxNative)}')"></span>` +
      `<span class="bm-item-txt"><b>${esc(c.label)}</b><i>${esc(c.credit || c.url)}</i></span>` +
      `<button class="bm-item-del" type="button" title="Remove this basemap">&times;</button>`;
    row.querySelector('.bm-item-del').addEventListener('click', () => {
      const wasActive = activeKey === c.id;
      removeCustomBasemap(c.id);
      rebuildBasemapRegistry();
      buildBasemapGrid();
      // Never leave the map showing a basemap that no longer exists.
      if (wasActive) setBasemap(preferredBasemapId());
      renderBasemapManager();
      status(`Removed “${c.label}”.`);
    });
    list.appendChild(row);
  });
}

/** Load one sample tile and report whether the template works. */
function testCustomTile() {
  const url = $('bmUrl').value.trim();
  const state = $('bmPreviewState');
  const prev = $('bmPreview');
  const problem = validateTileUrl(url);
  if (problem) {
    state.textContent = problem;
    state.className = 'bad';
    prev.style.backgroundImage = '';
    return Promise.resolve(false);
  }
  state.textContent = 'Loading a tile…';
  state.className = '';
  const sample = sampleCustomTile(url, $('bmMaxZoom').value);
  return new Promise(res => {
    const img = new Image();
    const done = ok => {
      img.onload = img.onerror = null;
      state.textContent = ok ? 'Tile loaded — this server works.' : 'No tile came back from that URL.';
      state.className = ok ? 'good' : 'bad';
      prev.style.backgroundImage = ok ? `url('${sample}')` : '';
      res(ok);
    };
    img.onload = () => done(img.naturalWidth > 0);
    img.onerror = () => done(false);
    setTimeout(() => done(false), 10000);
    img.src = sample;
  });
}

function wireBasemapManager() {
  bmMgr = wireModal('bmMgrOverlay', 'bmMgrClose');
  $('bmTestBtn').addEventListener('click', testCustomTile);
  $('bmUrl').addEventListener('input', () => {
    $('bmPreviewState').textContent = 'Preview';
    $('bmPreviewState').className = '';
  });

  $('bmAddBtn').addEventListener('click', () => {
    const url = $('bmUrl').value.trim();
    const problem = validateTileUrl(url);
    if (problem) { $('bmPreviewState').textContent = problem; $('bmPreviewState').className = 'bad'; return; }
    const entry = addCustomBasemap({
      label: $('bmName').value,
      url,
      maxNative: $('bmMaxZoom').value,
      credit: $('bmAttrib').value,
      imagery: $('bmIsImagery').checked,
    });
    // The catalogue drives the picker, but chooseBasemap() checks the registry —
    // both have to know about the new entry before it can be selected.
    rebuildBasemapRegistry();
    buildBasemapGrid();
    renderBasemapManager();
    $('bmName').value = ''; $('bmUrl').value = ''; $('bmAttrib').value = '';
    $('bmPreview').style.backgroundImage = '';
    $('bmPreviewState').textContent = 'Preview';
    $('bmPreviewState').className = '';
    chooseBasemap(entry.id);
    status(`Added “${entry.label}” — switched to it so you can check the tiles.`);
  });
}

/** Open the basemap manager (from the basemap switcher panel). */
function openBasemapManager() {
  renderBasemapManager();
  bmMgr.open();
}

/* ---------------------------------------------------------------------------
 * Init
 * ------------------------------------------------------------------------- */

function initExportCenter() {
  exportCenter = wireModal('exportOverlay', 'exportClose');
  buildExportCenter();
  $('exportCenterBtn').addEventListener('click', () => { syncExportCenter(); exportCenter.open(); });
  // Format buttons close the dialog on their way out; their own handlers
  // (wired elsewhere) still run because those listeners were attached first.
  ['pptxBtn', 'printBtn', 'saveBtn', 'geoExportBtn', 'kmlExportBtn'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('click', () => exportCenter.close());
  });
  $('kmlExportBtn').addEventListener('click', exportKML);
  wireBasemapManager();
}
