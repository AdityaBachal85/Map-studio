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
    btn.title = spec.credit;
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
  $('basemapSel').value = key;
  setBasemap(key);                          // updates the map + credit + (via hook) the switcher
  if (typeof setPref === 'function') setPref('basemap', key);
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

// Remember-last: apply the saved basemap on startup (falls back to the best
// imagery basemap the current keys unlock).
(function initBasemap() {
  const saved = (typeof getPref === 'function') ? getPref('basemap') : null;
  if (saved && BASEMAPS[saved]) chooseBasemap(saved);
  else syncBasemapSwitcher(typeof activeKey !== 'undefined' ? activeKey : preferredBasemapId());
})();
