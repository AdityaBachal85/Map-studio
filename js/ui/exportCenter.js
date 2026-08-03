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
    const sub = BASEMAP_CATALOGUE[exportBasemapId(activeKey)];
    if (exportSubstitutes(activeKey)) {
      note.textContent = 'Exports use the current map view, rendered on “' + sub.label +
        '” imagery — the basemap on screen is licensed for viewing, not for files.';
    } else if (!basemapExportSafe(activeKey)) {
      note.textContent = 'This basemap’s tiles cannot be rasterised — image and slide exports are unavailable.';
    } else {
      note.textContent = 'Exports use the current map view.';
    }
    note.classList.toggle('warn', !exportReady(activeKey));
  }
}

let exportCenter = null;

/* ---------------------------------------------------------------------------
 * Basemap Manager
 * ------------------------------------------------------------------------- */

let bmMgr = null;

/* ---- Provider keys ----------------------------------------------------- */

/**
 * The provider-key cards are generated rather than written out per provider.
 *
 * Two providers with the same six controls is where copy-paste starts costing:
 * the second one silently misses whichever fix the first one got. Everything
 * that genuinely differs between them — the copy, the sign-up link, how a key is
 * verified, which basemap to offer as a one-click switch — lives in
 * PROVIDER_KEY_INFO, beside the code that uses it.
 */
function buildProviderKeyCards() {
  const host = $('bmKeys');
  if (!host || host.dataset.built) return;
  host.dataset.built = '1';

  PROVIDER_KEY_ORDER.forEach(id => {
    const info = PROVIDER_KEY_INFO[id];
    if (!info) return;
    const card = document.createElement('div');
    card.className = 'bm-key';
    card.dataset.provider = id;
    const link = `<a href="${info.signup}" target="_blank" rel="noopener noreferrer">${info.signupLabel}</a>`;
    card.innerHTML =
      '<div class="bm-key-hd"><b>' + esc(info.label) + '</b>' +
      '<span class="bm-key-state" data-role="state">Not set</span></div>' +
      '<p class="bm-key-note">' + info.blurb.replace('{signup}', link) + '</p>' +
      (info.caution ? '<p class="bm-key-caution">' + esc(info.caution) + '</p>' : '') +
      '<label class="bm-f"><span>API key</span><span class="bm-key-input">' +
      '<input type="password" data-role="key" spellcheck="false" autocomplete="off" placeholder="Paste your API key">' +
      '<button type="button" class="bm-key-eye" data-role="eye" aria-label="Show key">Show</button></span></label>' +
      '<div class="row2"><button class="btn" data-role="test">Verify key</button>' +
      '<button class="btn btn-primary" data-role="save">Save key</button></div>' +
      '<div class="bm-key-msg" data-role="msg" role="status" aria-live="polite"></div>' +
      '<ul class="bm-key-styles" data-role="styles" hidden></ul>' +
      (info.diagnostic
        ? '<p class="bm-key-note bm-key-diag" data-role="diag" hidden>Still not drawing? ' +
          `<a href="${info.diagnostic}" target="_blank" rel="noopener noreferrer">Run the tile diagnostic</a>` +
          ' — it asks the provider for every candidate style and shows exactly what it says back.</p>'
        : '') +
      '<div class="bm-key-actions">' +
      '<button class="btn btn-sm" data-role="use" hidden>Switch to ' + esc(info.primaryLabel) + '</button>' +
      '<button class="btn btn-sm btn-danger" data-role="clear" hidden>Remove key</button></div>';
    host.appendChild(card);
    wireProviderKeyCard(id, card);
  });
}

/** Element lookup within one provider card. */
const cardEl = (id, role) => {
  const host = $('bmKeys');
  const card = host && host.querySelector('.bm-key[data-provider="' + id + '"]');
  return card ? card.querySelector('[data-role="' + role + '"]') : null;
};

/**
 * Reflect a stored key into its card.
 *
 * The field is never repopulated with the saved key. Showing a credential back
 * to whoever opens the dialog buys nothing — you cannot check a 60-character
 * opaque string by eye — and it puts the key on screen for anyone standing
 * behind the operator. "Saved on this device" plus a Remove button is the whole
 * of what is useful.
 * @param {string} id Provider id.
 */
function renderProviderKey(id) {
  const state = cardEl(id, 'state');
  if (!state) return;
  const info = PROVIDER_KEY_INFO[id];
  const saved = storedProviderKey(id);
  const fromConfig = !saved && hasProviderKey(id);

  // A key of the wrong provider is worse than no key: it shadows the working
  // one in config.js and every call fails. Say so, loudly, with Remove offered.
  const mismatch = saved ? wrongProviderKey(id, saved) : '';
  state.textContent = mismatch ? 'Wrong key stored'
    : (saved ? 'Saved on this device' : (fromConfig ? 'Set in config.js' : 'Not set'));
  state.className = 'bm-key-state' + (mismatch ? ' bad' : ((saved || fromConfig) ? ' good' : ''));
  if (mismatch) {
    providerKeyMsg(id, mismatch + ' It is being ignored, so the built-in key is used instead — press Remove key to clear it.', 'bad');
  }
  cardEl(id, 'clear').hidden = !saved;
  cardEl(id, 'use').hidden = !isBasemapAvailable(BASEMAP_CATALOGUE[info.primary]) ||
    (typeof activeKey !== 'undefined' && activeKey === info.primary);
  const input = cardEl(id, 'key');
  input.value = '';
  input.placeholder = saved ? 'Paste a new key to replace it' : 'Paste your API key';
}

/** Re-render every provider card. */
function renderProviderKeys() {
  buildProviderKeyCards();
  PROVIDER_KEY_ORDER.forEach(renderProviderKey);
}

/**
 * Write a result line under a key field, plus the per-check breakdown.
 *
 * A single sentence cannot carry "the key works for streets but not satellite",
 * which is the failure that leaves someone staring at a blank map convinced the
 * key is wrong. One line per check says which half is broken.
 * @param {string} id @param {string} msg @param {string} cls @param {object[]} [results]
 */
function providerKeyMsg(id, msg, cls, results) {
  const el = cardEl(id, 'msg');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'bm-key-msg' + (cls ? ' ' + cls : '');

  const list = cardEl(id, 'styles');
  const rows = (results || []).filter(r => r.label);
  list.innerHTML = '';
  // Only worth showing when the results disagree — an all-pass or an all-fail
  // is already said in one sentence above.
  const mixed = rows.some(r => r.ok) && rows.some(r => !r.ok);
  list.hidden = !mixed;
  if (mixed) {
    rows.forEach(r => {
      const li = document.createElement('li');
      li.className = r.ok ? 'good' : 'bad';
      // Neutral wording: these rows cover tile services and JSON APIs alike.
      li.textContent = r.label + ' — ' + (r.ok ? 'responded' : (r.status ? 'HTTP ' + r.status : 'no response'));
      list.appendChild(li);
    });
  }
  const diag = cardEl(id, 'diag');
  if (diag) diag.hidden = !(cls === 'bad' || cls === 'warn');
}

/**
 * Re-offer every basemap now that the set of usable keys has changed.
 * The catalogue drives the picker but `chooseBasemap()` checks the registry, so
 * both have to be rebuilt before a key-gated basemap can actually be selected.
 */
function refreshBasemapAvailability() {
  rebuildBasemapRegistry();
  buildBasemapGrid();
  if (typeof syncBasemapSwitcher === 'function' && typeof activeKey !== 'undefined') syncBasemapSwitcher(activeKey);
  renderProviderKeys();
}

/** @param {string} id @param {HTMLElement} card */
function wireProviderKeyCard(id, card) {
  const info = PROVIDER_KEY_INFO[id];
  const input = card.querySelector('[data-role="key"]');
  const eye = card.querySelector('[data-role="eye"]');
  const test = card.querySelector('[data-role="test"]');
  const save = card.querySelector('[data-role="save"]');

  eye.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.textContent = show ? 'Hide' : 'Show';
    eye.setAttribute('aria-label', show ? 'Hide key' : 'Show key');
  });

  input.addEventListener('input', () => providerKeyMsg(id, ''));

  test.addEventListener('click', async () => {
    providerKeyMsg(id, 'Checking the key with ' + info.label + '…', '');
    test.disabled = true;
    try {
      const res = await info.verify(input.value.trim());
      providerKeyMsg(id, res.message, res.ok ? 'good' : 'bad', res.results);
    } finally {
      test.disabled = false;
    }
  });

  save.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) { providerKeyMsg(id, 'Paste a key first.', 'bad'); return; }
    // Two providers, two cards, two similar-looking fields. Catching the swap
    // here is the difference between an obvious message and a silent outage.
    const wrong = wrongProviderKey(id, key);
    if (wrong) { providerKeyMsg(id, wrong + ' Nothing was saved.', 'bad'); return; }

    // Verify before saving, but do not *require* it: a key that cannot be
    // checked because the network is down is still probably the right key, and
    // refusing to store it would strand the operator with no way forward.
    providerKeyMsg(id, 'Checking the key…', '');
    save.disabled = true;
    let res;
    try { res = await info.verify(key); } finally { save.disabled = false; }

    setProviderKey(id, key);
    if (info.onChange) info.onChange();
    refreshBasemapAvailability();
    providerKeyMsg(id, res.ok
      ? 'Key saved and verified — the ' + info.label + ' basemaps are now in the picker.'
      : res.message + ' Saved anyway; remove it here if those basemaps come up blank.',
      res.ok ? 'good' : 'warn', res.results);
    if (res.ok) status(info.label + ' key saved — new basemaps unlocked.');
  });

  card.querySelector('[data-role="clear"]').addEventListener('click', () => {
    clearProviderKey(id);
    if (info.onChange) info.onChange();
    // Never leave the map on a basemap the key no longer unlocks.
    const stranded = typeof activeKey !== 'undefined' && !isBasemapAvailable(BASEMAP_CATALOGUE[activeKey]);
    refreshBasemapAvailability();
    if (stranded) chooseBasemap(preferredBasemapId());
    providerKeyMsg(id, 'Key removed from this device.', '');
    status(info.label + ' key removed.');
  });

  card.querySelector('[data-role="use"]').addEventListener('click', () => {
    chooseBasemap(info.primary);
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
  buildProviderKeyCards();
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
  // Clear stale messages *before* rendering, not after: renderProviderKey emits
  // the wrong-key warning, and a blanket clear afterwards wiped the one message
  // the operator most needs to see.
  buildProviderKeyCards();
  PROVIDER_KEY_ORDER.forEach(id => providerKeyMsg(id, ''));
  renderProviderKeys();
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
  ['pptxBtn', 'printBtn', 'saveBtn', 'xcGeoExportBtn', 'kmlExportBtn', 'xlsxExportBtn'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('click', () => exportCenter.close());
  });
  $('kmlExportBtn').addEventListener('click', exportKML);
  // The Draw tab's button of the same purpose lives in project/geojson.js;
  // this row is the Export dialog's copy and needs its own wiring.
  $('xcGeoExportBtn').addEventListener('click', exportGeoJSON);
  wireBasemapManager();
  // Settings, not the basemap picker: provider keys and tile-server URLs are
  // configuration you set once, not part of choosing which basemap to look at.
  $('basemapMgrBtn').addEventListener('click', openBasemapManager);

  // Brand & logo is configuration rather than live tweaking, so it reads better
  // as a dialog than as a section you scroll past every time.
  const brand = wireModal('brandOverlay', 'brandClose');
  $('brandOpenBtn').addEventListener('click', brand.open);
}
