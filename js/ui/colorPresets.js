/**
 * ui/colorPresets.js — a small palette popover for colour swatches.
 *
 * A raw `<input type="color">` hands the whole problem to the OS picker: a
 * full-gamut dialog for what is nearly always one of a dozen sensible map
 * colours. That makes the common case slow and lets maps drift into
 * near-identical shades that read as noise in a legend.
 *
 * So: presets first, one click, consistent across a project — with the OS
 * picker still one click further for the times a brand colour is genuinely
 * required.
 *
 * The palette is three tiers of the same hues (strong / light / neutral) so a
 * project can hold a consistent visual weight across many pins.
 */

const COLOR_PRESETS = [
  // Strong — the default weight for pins and routes.
  '#E03131', '#7048E8', '#3B5BDB', '#1C7ED6', '#0CA678', '#37B24D', '#F0A800', '#F76707',
  // Light — secondary pins that should sit behind the strong ones.
  '#FF6B6B', '#B197FC', '#748FFC', '#4DABF7', '#38D9A9', '#69DB7C', '#FFD43B', '#FFA94D',
  // Neutrals — greys for context, plus the two DBOT house colours at the end.
  '#FFFFFF', '#E9ECEF', '#CED4DA', '#868E96', '#495057', '#000000', '#4B342A', '#8D6E63',
];

let presetPopover = null;
let presetCleanup = null;

/** Tear down the open popover, if any. */
function closeColorPresets() {
  if (presetCleanup) { presetCleanup(); presetCleanup = null; }
  if (presetPopover) { presetPopover.remove(); presetPopover = null; }
}

/**
 * Show the palette anchored under a swatch button.
 *
 * @param {HTMLElement} anchor the button that was clicked
 * @param {string} current the colour to mark as selected
 * @param {(hex:string) => void} onPick
 */
function openColorPresets(anchor, current, onPick) {
  // A second click on the same swatch closes rather than stacking a duplicate.
  const wasOpen = presetPopover && presetPopover._anchor === anchor;
  closeColorPresets();
  if (wasOpen) return;

  const pop = document.createElement('div');
  pop._anchor = anchor;
  pop.className = 'cp-pop frost';
  pop.innerHTML = COLOR_PRESETS.map(hex =>
    `<button type="button" class="cp-sw${hex.toLowerCase() === String(current).toLowerCase() ? ' sel' : ''}"
       style="--sw:${esc(hex)}" data-hex="${esc(hex)}" title="${esc(hex)}" aria-label="${esc(hex)}"></button>`
  ).join('') + '<button type="button" class="cp-custom">Custom colour…</button>';

  document.body.appendChild(pop);
  presetPopover = pop;

  // Positioned against the viewport (position:fixed) so it escapes the
  // sidebar's own scroll container instead of being clipped by it, and
  // flipped up when there isn't room below.
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = top + 'px';

  pop.querySelectorAll('.cp-sw').forEach(sw => {
    sw.addEventListener('click', () => { onPick(sw.getAttribute('data-hex')); closeColorPresets(); });
  });

  // The hidden native input next to the swatch is what actually opens the OS
  // dialog — reusing it means the custom path emits the same 'input' events
  // the card is already listening to.
  pop.querySelector('.cp-custom').addEventListener('click', () => {
    const native = anchor.parentElement && anchor.parentElement.querySelector('input[type="color"]');
    closeColorPresets();
    if (native) native.click();
  });

  // Dismiss on outside click, Escape, or anything that moves the anchor.
  const onDocDown = e => { if (!pop.contains(e.target) && e.target !== anchor) closeColorPresets(); };
  const onKey = e => { if (e.key === 'Escape') closeColorPresets(); };
  const onScroll = () => closeColorPresets();
  setTimeout(() => document.addEventListener('pointerdown', onDocDown), 0);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onScroll);
  // Capture phase: scroll events from the sidebar's inner container don't
  // bubble to window, and that container is exactly what moves the anchor.
  window.addEventListener('scroll', onScroll, true);

  presetCleanup = () => {
    document.removeEventListener('pointerdown', onDocDown);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('scroll', onScroll, true);
  };
}
