/**
 * ui/basemapSwitcher.js — a Google-Earth-style floating basemap picker. Shows
 * the current basemap as a live thumbnail bottom-left; click to reveal a grid
 * of real tile previews. Selecting one switches the map (via the existing
 * setBasemap) and remembers it in prefs. The old #basemapSel <select> is kept
 * hidden inside this control so project load/save and existing wiring are
 * untouched; #hdTgl also lives here now.
 */

// Display order + short labels for the switcher tiles (keys match BASEMAPS).
const BASEMAP_LIST = [
  { key: 'hybrid', label: 'Satellite' },
  { key: 'sat', label: 'Satellite (clean)' },
  { key: 'esristreet', label: 'Streets' },
  { key: 'osm', label: 'OpenStreetMap' },
  { key: 'voyager', label: 'Voyager' },
  { key: 'lightgray', label: 'Light Gray' },
  { key: 'darkgray', label: 'Dark Gray' },
  { key: 'positron', label: 'Minimal light' },
  { key: 'dark', label: 'Minimal dark' },
  { key: 'topo', label: 'Terrain' },
  { key: 'natgeo', label: 'Nat Geo' },
  { key: 'opentopo', label: 'OpenTopo' },
];
const bmLabelFor = key => (BASEMAP_LIST.find(b => b.key === key) || {}).label || key;

// One representative tile (z/x/y over the Goa coast — land, sea, roads) makes
// the previews comparable and recognisable.
const BM_PREVIEW = { z: 12, x: 2887, y: 1869 };

/** Build a preview tile URL for a basemap from its own tile template. @param {string} key */
function basemapPreviewUrl(key) {
  try {
    const tpl = BASEMAPS[key].build(false)[0]._url;
    return tpl
      .replace('{s}', 'a').replace('{r}', '')
      .replace('{z}', BM_PREVIEW.z).replace('{x}', BM_PREVIEW.x)
      .replace('{y}', BM_PREVIEW.y).replace('{-y}', BM_PREVIEW.y);
  } catch (e) { return ''; }
}

function buildBasemapGrid() {
  const grid = $('bmGrid');
  grid.innerHTML = '';
  BASEMAP_LIST.forEach(b => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bm-tile';
    btn.dataset.key = b.key;
    const url = basemapPreviewUrl(b.key);
    btn.innerHTML = `<span class="bm-tile-img" style="background-image:url('${url}')"></span><span class="bm-tile-lbl">${b.label}</span>`;
    btn.addEventListener('click', () => chooseBasemap(b.key));
    grid.appendChild(btn);
  });
}

/** Reflect the active basemap into the switcher (collapsed thumb + grid highlight). @param {string} key */
function syncBasemapSwitcher(key) {
  const img = $('bmThumbImg'), label = $('bmThumbLabel');
  if (img) img.style.backgroundImage = `url('${basemapPreviewUrl(key)}')`;
  if (label) label.textContent = bmLabelFor(key);
  const grid = $('bmGrid');
  if (grid) grid.querySelectorAll('.bm-tile').forEach(t => t.classList.toggle('active', t.dataset.key === key));
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

// Remember-last: apply the saved basemap on startup (falls back to hybrid).
(function initBasemap() {
  const saved = (typeof getPref === 'function') ? getPref('basemap') : 'hybrid';
  if (saved && BASEMAPS[saved]) chooseBasemap(saved);
  else syncBasemapSwitcher(typeof activeKey !== 'undefined' ? activeKey : 'hybrid');
})();
