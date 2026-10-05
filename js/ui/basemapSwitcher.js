/**
 * ui/basemapSwitcher.js — a Google-Earth-style floating basemap picker. Shows
 * the current basemap as a live thumbnail bottom-left; click to reveal a grid
 * of real tile previews grouped by family. Selecting one switches the map (via
 * the existing setBasemap) and remembers it in prefs.
 *
 * Both the grid and the hidden #basemapSel <select> are generated from
 * map/basemapProviders.js, so adding a provider there is enough to make it
 * appear here and to keep project load/save round-tripping correctly.
 */

/** Short switcher label, falling back to the catalogue label. @param {string} key */
const bmLabelFor = key => {
  const spec = BASEMAP_CATALOGUE[key];
  return spec ? spec.label : key;
};

// One representative tile (z/x/y over the Goa coast — land, sea, roads) makes
// the previews comparable and recognisable.
const BM_PREVIEW = { z: 12, x: 2887, y: 1869 };

/** Build a preview tile URL for a basemap from its own tile template. @param {string} key */
function basemapPreviewUrl(key) {
  try {
    const layer = BASEMAPS[key].build(false)[0];
    const z = layer.options.tileSize === 512 ? BM_PREVIEW.z - 1 : BM_PREVIEW.z;
    const d = layer.options.tileSize === 512
      ? { z, x: BM_PREVIEW.x >> 1, y: BM_PREVIEW.y >> 1 }
      : { z, x: BM_PREVIEW.x, y: BM_PREVIEW.y };
    return layer._url
      .replace('{s}', 'a').replace('{r}', '')
      .replace('{z}', d.z).replace('{x}', d.x)
      .replace('{y}', d.y).replace('{-y}', d.y);
  } catch (e) { return ''; }
}

/**
 * Fill the grid, grouped by BasemapSpec.group. The catalogue's `thumb` gradient
 * sits under the real tile so the picker never flashes empty squares while the
 * preview tiles fetch.
 */
function buildBasemapGrid() {
  const grid = $('bmGrid');
  const sel = $('basemapSel');
  if (!grid) return;
  grid.innerHTML = '';
  if (sel) sel.innerHTML = '';

  let lastGroup = null;
  let optGroup = null;
  availableBasemaps().forEach(spec => {
    if (spec.group !== lastGroup) {
      lastGroup = spec.group;
      const hd = document.createElement('div');
      hd.className = 'bm-group';
      hd.textContent = spec.group;
      grid.appendChild(hd);
      if (sel) { optGroup = document.createElement('optgroup'); optGroup.label = spec.group; sel.appendChild(optGroup); }
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bm-tile';
    btn.dataset.key = spec.id;
    // Credit alone answers "whose map is this", which is the only question most
    // of these raise. One entry has to answer "what is this" first.
    //
    // Joined with a space rather than a break: ui/tooltips.js moves every
    // `title` to `data-tip` and renders it as textContent in a box with no
    // white-space rule, so a newline would collapse into a space anyway and
    // only look deliberate in the source.
    btn.title = spec.note ? spec.note + ' ' + spec.credit : spec.credit;
    const url = basemapPreviewUrl(spec.id);
    btn.innerHTML =
      `<span class="bm-tile-img" style="background:${spec.thumb}">` +
      `<span class="bm-tile-tile" style="background-image:url('${url}')"></span></span>` +
      `<span class="bm-tile-lbl">${spec.label}</span>`;
    btn.addEventListener('click', () => chooseBasemap(spec.id));
    grid.appendChild(btn);

    if (optGroup) {
      const opt = document.createElement('option');
      opt.value = spec.id;
      opt.textContent = spec.label;
      optGroup.appendChild(opt);
    }
  });

  renderHdUpsell(grid);
}

/**
 * When no ArcGIS key is configured, say so where the choice is being made.
 *
 * The HD basemaps are hidden until a key exists — correct, because offering a
 * basemap that renders as 403s is worse than not offering it, but it leaves the
 * best cartography invisible and undiscoverable. One row names what is missing
 * and opens the place to fix it. Once a key is saved the row disappears: a nag
 * that survives being acted on is just noise.
 *
 * It goes at the end of the Satellite group rather than at the foot of the
 * panel, because that is where the basemap it unlocks would have appeared, and
 * because the foot of a scrolling list is where notices go to be missed.
 * @param {HTMLElement} grid
 */
function renderHdUpsell(grid) {
  if (isBasemapAvailable(BASEMAP_CATALOGUE.imageryHybridHD)) return;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'bm-upsell';
  row.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.4 5.5 6 .5-4.5 3.9 1.4 5.8L12 15.6 ' +
    '6.7 18.7l1.4-5.8L3.6 9l6-.5z"/></svg>' +
    '<span>Sharper imagery and labels — add a free ArcGIS key</span>';
  row.addEventListener('click', () => {
    $('bmPanel').hidden = true;
    $('bmToggle').classList.remove('open');
    openBasemapManager();
  });

  // The heading of whichever group follows Satellite marks the end of it.
  const groups = Array.from(grid.querySelectorAll('.bm-group'));
  const satIdx = groups.findIndex(g => g.textContent === 'Satellite');
  const next = satIdx >= 0 ? groups[satIdx + 1] : null;
  if (next) grid.insertBefore(row, next); else grid.appendChild(row);
}

/** Reflect the active basemap into the switcher (collapsed thumb + grid highlight). @param {string} key */
function syncBasemapSwitcher(key) {
  const img = $('bmThumbImg'), label = $('bmThumbLabel');
  const spec = BASEMAP_CATALOGUE[key];
  if (img) {
    img.style.background = spec ? spec.thumb : '';
    img.style.backgroundImage = `url('${basemapPreviewUrl(key)}')`;
  }
  if (label) label.textContent = bmLabelFor(key);
  const grid = $('bmGrid');
  if (grid) grid.querySelectorAll('.bm-tile').forEach(t => t.classList.toggle('active', t.dataset.key === key));
  const sel = $('basemapSel');
  if (sel && sel.value !== key) sel.value = key;
}

/** Switch basemap, sync the hidden <select> + prefs, and collapse the panel. @param {string} key */
function chooseBasemap(key) {
  if (!BASEMAPS[key]) return;
  // Checked here as well as on the button. Disabling a control hides it from
  // the mouse, not from a keyboard, a saved project, or anything else that
  // calls this directly — and a rule enforced only in the UI is not a rule.
  if (typeof basemapLocked === 'function' && basemapLocked()) {
    if (typeof status === 'function') {
      status('Connectivity is pinned to OpenStreetMap. Switch to the Satellite layout to change the ground.');
    }
    return;
  }
  $('basemapSel').value = key;
  // The choice is persisted by mapEngine's rememberBasemapWorks() once a tile
  // actually renders — not here. Saving it eagerly meant a basemap that could
  // not draw was remembered and re-applied on the next visit, so one bad
  // provider left the app opening on a blank map every time.
  setBasemap(key);                          // updates the map + credit + (via hook) the switcher
  // setBasemap rebuilds the tile pane from scratch, which drops the overlays
  // with it — they are tile layers too. Without this, changing ground silently
  // turns off every layer the user had ticked.
  if (typeof reapplyMapOverlays === 'function') reapplyMapOverlays();
  $('bmPanel').hidden = true;
  $('bmToggle').classList.remove('open');
}

function toggleBasemapPanel() {
  const panel = $('bmPanel');
  panel.hidden = !panel.hidden;
  $('bmToggle').classList.toggle('open', !panel.hidden);
}

buildBasemapGrid();
$('bmToggle').addEventListener('click', toggleBasemapPanel);
document.addEventListener('click', e => { if (!e.target.closest('#basemapSwitcher')) { $('bmPanel').hidden = true; $('bmToggle').classList.remove('open'); } });

// Remember-last is resolved by mapEngine's initialBasemapId() before the first
// tile is requested — it has to be, or a cached tile rendering mid-startup
// persists the default over the remembered choice. All that is left here is
// reflecting the decision into this UI, plus re-applying it in the case where
// the engine could not (an unavailable basemap that has since become available).
(function initBasemap() {
  const saved = (typeof getPref === 'function') ? getPref('basemap') : null;
  const current = typeof activeKey !== 'undefined' ? activeKey : preferredBasemapId();
  if (saved && saved !== current && BASEMAPS[saved]) chooseBasemap(saved);
  else syncBasemapSwitcher(current);
})();
