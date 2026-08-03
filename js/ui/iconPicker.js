/**
 * ui/iconPicker.js — the marker icon browser.
 *
 * Replaces a flat <select> of icon names. A name in a dropdown is a poor way
 * to pick a picture: you cannot see what you are choosing until you have
 * chosen it, and the list stops being scannable somewhere around fifteen
 * entries — which the library has now comfortably passed.
 *
 * Icons are shown as they actually appear on the map: the glyph knocked out of
 * a filled pin, tinted with that location's own colour, so the grid previews
 * the real result rather than an abstraction of it.
 *
 * One dialog is shared by every location card. `pickerTarget` is whichever
 * location opened it, and `pickerOnPick` is what to do with the choice, so the
 * card keeps ownership of its own state and this file stays a pure chooser.
 */

/** The location currently being edited, or null when the dialog is closed. */
let pickerTarget = null;
/** @type {((key:string) => void)|null} */
let pickerOnPick = null;
let iconPickerModal = null;

/** The pin outline every swatch is drawn in — a 24×32 teardrop. */
const PIN_OUTLINE = 'M12 0C5.37 0 0 5.37 0 12c0 9 12 20 12 20s12-11 12-20C24 5.37 18.63 0 12 0z';

/**
 * One icon rendered the way the map renders it: glyph reversed out of a
 * coloured pin. The glyph is a 24×24 drawing scaled to 13px and centred on the
 * pin's head at (12, 12).
 * @param {string} key @param {string} color
 * @returns {string} svg markup
 */
function iconPinSwatch(key, color, w) {
  const width = w || 26;
  return `<svg viewBox="0 0 24 32" width="${width}" height="${Math.round(width * 32 / 24)}" aria-hidden="true">
    <path fill="${esc(color)}" d="${PIN_OUTLINE}"/>
    <g transform="translate(5.5 5.5) scale(0.5417)">${iconPaths(key, '#FFFFFF')}</g>
  </svg>`;
}

/**
 * Draw the grid, optionally filtered.
 *
 * Filtering hides whole sections rather than leaving empty headings behind,
 * and a search that matches nothing says so instead of showing a blank panel.
 * @param {string} [query]
 */
function renderIconGrid(query) {
  const body = $('iconPickerBody');
  if (!body) return;
  const q = (query || '').trim().toLowerCase();
  const color = (pickerTarget && pickerTarget.color) || '#0A1E3C';
  const current = pickerTarget && pickerTarget.iconKey;

  let html = '';
  let shown = 0;
  for (const { cat, keys } of iconsByCategory()) {
    const hits = q
      ? keys.filter(k => ICON_LIBRARY[k].label.toLowerCase().includes(q) || k.includes(q) || cat.toLowerCase().includes(q))
      : keys;
    if (!hits.length) continue;
    shown += hits.length;
    html += `<div class="ip-cat">${esc(cat)}</div><div class="ip-grid">`
      + hits.map(k => `<button type="button" class="ip-cell${k === current ? ' sel' : ''}" data-key="${esc(k)}"
          title="${esc(ICON_LIBRARY[k].label)}" aria-label="${esc(ICON_LIBRARY[k].label)}">${iconPinSwatch(k, color)}</button>`).join('')
      + '</div>';
  }

  body.innerHTML = shown ? html : `<div class="ip-empty">No icons match “${esc(q)}”.</div>`;

  body.querySelectorAll('.ip-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const key = cell.getAttribute('data-key');
      if (pickerOnPick) pickerOnPick(key);
      iconPickerModal.close();
    });
  });
}

/**
 * Open the picker for one location.
 * @param {object} loc the location being edited — supplies the tint and current pick
 * @param {(key:string) => void} onPick
 */
function openIconPicker(loc, onPick) {
  pickerTarget = loc;
  pickerOnPick = onPick;
  const search = $('iconPickerSearch');
  if (search) search.value = '';
  renderIconGrid('');
  iconPickerModal.open();
  // Focus the search rather than the first swatch: typing is the fast path
  // through a hundred icons, and the grid is one Tab away either way.
  if (search) setTimeout(() => search.focus(), 50);
}

/**
 * Refresh a card's icon button face after the icon or colour changes.
 *
 * The pin sits in its own recessed tile rather than floating on the button:
 * at full height it touched both edges and read as a stray graphic instead of
 * a preview. The chevron matches the Frame select directly beneath it, so the
 * two controls look like the same kind of thing — which they are.
 */
function refreshIconButton(card, loc) {
  const btn = card.querySelector('.icoBtn');
  if (!btn) return;
  const key = loc.iconKey || (loc.type === 'site' ? 'star' : 'pin');
  btn.innerHTML =
    `<span class="icoBtn-sw">${iconPinSwatch(key, loc.color || '#0A1E3C', 17)}</span>`
    + `<span class="icoBtn-lbl">${esc((ICON_LIBRARY[key] || ICON_LIBRARY.pin).label)}</span>`
    + '<span class="icoBtn-chev" aria-hidden="true">'
    + '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"'
    + ' stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
    + '</span>';
}

function initIconPicker() {
  iconPickerModal = wireModal('iconPickerOverlay', 'iconPickerClose');
  const search = $('iconPickerSearch');
  if (search) search.addEventListener('input', e => renderIconGrid(e.target.value));
}
