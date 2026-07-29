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

/* ---- Provider keys ----------------------------------------------------- */

/**
 * Reflect the stored ArcGIS key into the panel.
 *
 * The field is never repopulated with the saved key. Showing a credential back
 * to whoever opens the dialog buys nothing — you cannot check a 60-character
 * opaque string by eye — and it puts the key on screen for anyone standing
 * behind the operator. "Saved on this device" plus a Remove button is the whole
 * of what is useful.
 */
function renderProviderKeys() {
  const state = $('bmArcgisState');
  if (!state) return;
  const saved = storedProviderKey('arcgis');
  const fromConfig = !saved && hasProviderKey('arcgis');

  state.textContent = saved ? 'Saved on this device' : (fromConfig ? 'Set in config.js' : 'Not set');
  state.className = 'bm-key-state' + (saved || fromConfig ? ' good' : '');
  $('bmArcgisClear').hidden = !saved;
  $('bmArcgisUse').hidden = !isBasemapAvailable(BASEMAP_CATALOGUE.imageryHybridHD) ||
    (typeof activeKey !== 'undefined' && activeKey === 'imageryHybridHD');
  $('bmArcgisKey').value = '';
  $('bmArcgisKey').placeholder = saved ? 'Paste a new key to replace it' : 'Paste your API key';
}

/** Write a result line under the key field. @param {string} msg @param {string} cls */
function arcgisMsg(msg, cls) {
  const el = $('bmArcgisMsg');
  el.textContent = msg || '';
  el.className = 'bm-key-msg' + (cls ? ' ' + cls : '');
}

/**
 * Re-offer every basemap now that the set of usable keys has changed.
 * The catalogue drives the picker but `chooseBasemap()` checks the registry, so
 * both have to be rebuilt before an HD basemap can actually be selected.
 */
function refreshBasemapAvailability() {
  rebuildBasemapRegistry();
  buildBasemapGrid();
  if (typeof syncBasemapSwitcher === 'function' && typeof activeKey !== 'undefined') syncBasemapSwitcher(activeKey);
  renderProviderKeys();
}

function wireProviderKeys() {
  const input = $('bmArcgisKey');
  if (!input) return;

  $('bmArcgisEye').addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('bmArcgisEye').textContent = show ? 'Hide' : 'Show';
    $('bmArcgisEye').setAttribute('aria-label', show ? 'Hide key' : 'Show key');
  });

  input.addEventListener('input', () => arcgisMsg(''));

  $('bmArcgisTest').addEventListener('click', async () => {
    const key = input.value.trim();
    arcgisMsg('Asking Esri for one tile…', '');
    $('bmArcgisTest').disabled = true;
    try {
      const res = await verifyArcgisKey(key);
      arcgisMsg(res.message, res.ok ? 'good' : 'bad');
    } finally {
      $('bmArcgisTest').disabled = false;
    }
  });

  $('bmArcgisSave').addEventListener('click', async () => {
    const key = input.value.trim();
    const problem = looksLikeArcgisKey(key);
    if (problem) { arcgisMsg(problem, 'bad'); return; }

    // Verify before saving, but do not *require* it: a key that cannot be
    // checked because the network is down is still probably the right key, and
    // refusing to store it would strand the operator with no way forward.
    arcgisMsg('Checking the key…', '');
    $('bmArcgisSave').disabled = true;
    let res;
    try { res = await verifyArcgisKey(key); } finally { $('bmArcgisSave').disabled = false; }

    setProviderKey('arcgis', key);
    refreshBasemapAvailability();
    arcgisMsg(res.ok
      ? 'Key saved and verified — Imagery Hybrid HD and Navigation HD are now in the basemap picker.'
      : res.message + ' Saved anyway; remove it here if the HD basemaps come up blank.',
      res.ok ? 'good' : 'warn');
    if (res.ok) status('ArcGIS key saved — HD basemaps unlocked.');
  });

  $('bmArcgisClear').addEventListener('click', () => {
    clearProviderKey('arcgis');
    const wasHD = typeof activeKey !== 'undefined' && !isBasemapAvailable(BASEMAP_CATALOGUE[activeKey]);
    refreshBasemapAvailability();
    // Never leave the map on a basemap the key no longer unlocks.
    if (wasHD) chooseBasemap(preferredBasemapId());
    arcgisMsg('Key removed from this device.', '');
    status('ArcGIS key removed.');
  });

  $('bmArcgisUse').addEventListener('click', () => {
    chooseBasemap('imageryHybridHD');
    renderProviderKeys();
    bmMgr.close();
  });
}

/* ---- Custom tile servers ----------------------------------------------- */

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
  wireProviderKeys();
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
  renderProviderKeys();
  renderBasemapManager();
  arcgisMsg('');
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

  // Brand & logo is configuration rather than live tweaking, so it reads better
  // as a dialog than as a section you scroll past every time.
  const brand = wireModal('brandOverlay', 'brandClose');
  $('brandOpenBtn').addEventListener('click', brand.open);
}
