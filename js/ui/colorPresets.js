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

/**
 * Turn one `<input type="color">` into a swatch that opens this picker.
 *
 * The input stays in the DOM as the value holder, and a pick writes to it and
 * fires `input`/`change` exactly as the OS dialog would. That is the whole
 * trick: every existing listener in the app keeps working untouched, so the
 * picker can be applied to a colour control without knowing or caring what
 * that control does.
 *
 * @param {HTMLInputElement} input
 */
function enhanceColorInput(input) {
  if (!input || input._cpEnhanced) return;
  input._cpEnhanced = true;

  const wrap = document.createElement('span');
  wrap.className = 'clrWrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'clrBtn';
  btn.title = input.title || 'Choose a colour';
  if (input.title) input.removeAttribute('title');   // or both tooltips fire
  wrap.appendChild(btn);

  const sync = () => btn.style.setProperty('--sw', input.value);
  sync();
  // Keep the face right when something *else* sets the value — switching a
  // location to Site rewrites several colours at once, for instance.
  input.addEventListener('input', sync);
  input.addEventListener('change', sync);

  btn.addEventListener('click', () => {
    openColorPresets(btn, input.value, hex => {
      input.value = hex;
      sync();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

/**
 * Enhance every colour input inside a freshly-built card or panel.
 * Idempotent, so calling it on a container twice is harmless.
 * @param {ParentNode} [root]
 */
function enhanceColorInputs(root) {
  (root || document).querySelectorAll('input[type="color"]').forEach(enhanceColorInput);
}

/**
 * Repaint a swatch after its input's value was set in code.
 *
 * Assigning to `.value` fires no event, so the enhancer's own listeners never
 * hear about it — switching a location to Site rewrites three colours at once
 * and every swatch would otherwise keep showing the old one.
 * @param {HTMLInputElement} input
 */
function syncColorSwatch(input) {
  const wrap = input && input.parentNode;
  if (!wrap || !wrap.classList || !wrap.classList.contains('clrWrap')) return;
  const btn = wrap.querySelector('.clrBtn');
  if (btn) btn.style.setProperty('--sw', input.value);
}

/**
 * Swap the popover into full-picker mode: saturation/value square, hue slider,
 * and hex/RGB fields, all in the app's own styling.
 *
 * Colour is committed live as the user drags rather than on release, so the
 * pin on the map tracks the square — picking a map colour is a judgement made
 * against the map, not against a swatch in isolation.
 *
 * @param {HTMLElement} pop the open popover, reused so it stays anchored
 * @param {string} current @param {(hex:string) => void} onPick
 */
function renderCustomPicker(pop, current, onPick) {
  const rgb = hexToRgb(current) || { r: 255, g: 122, b: 26 };
  let { h, s, v } = rgbToHsv(rgb.r, rgb.g, rgb.b);

  pop.classList.add('cp-custom-mode');
  pop.innerHTML =
    '<div class="cp-sv" tabindex="0"><div class="cp-sv-thumb"></div></div>'
    + '<div class="cp-hue"><div class="cp-hue-thumb"></div></div>'
    + '<div class="cp-fields">'
    + '<span class="cp-preview"></span>'
    + '<input class="cp-hex" type="text" spellcheck="false" maxlength="7" aria-label="Hex colour">'
    + '<input class="cp-n" data-ch="r" type="number" min="0" max="255" aria-label="Red">'
    + '<input class="cp-n" data-ch="g" type="number" min="0" max="255" aria-label="Green">'
    + '<input class="cp-n" data-ch="b" type="number" min="0" max="255" aria-label="Blue">'
    + '</div>'
    + '<button type="button" class="cp-back">‹ Presets</button>';

  const sv = pop.querySelector('.cp-sv');
  const svThumb = pop.querySelector('.cp-sv-thumb');
  const hue = pop.querySelector('.cp-hue');
  const hueThumb = pop.querySelector('.cp-hue-thumb');
  const hexIn = pop.querySelector('.cp-hex');
  const preview = pop.querySelector('.cp-preview');
  const nums = pop.querySelectorAll('.cp-n');

  /** Push the current h/s/v out to every control and to the caller. */
  function sync(fromField) {
    const hex = hsvToHex(h, s, v);
    sv.style.setProperty('--hue', hsvToHex(h, 1, 1));
    svThumb.style.left = (s * 100) + '%';
    svThumb.style.top = ((1 - v) * 100) + '%';
    // The thumb sits on whichever of black/white stays visible on the colour
    // under it, so it never disappears into a corner of the square.
    svThumb.style.borderColor = isLightColor(hex) ? '#000' : '#fff';
    hueThumb.style.left = (h / 360 * 100) + '%';
    preview.style.background = hex;
    if (fromField !== 'hex') hexIn.value = hex;
    if (fromField !== 'rgb') {
      const c = hexToRgb(hex);
      nums.forEach(n => { n.value = c[n.getAttribute('data-ch')]; });
    }
    onPick(hex);
  }

  /**
   * Track a pointer across an element, in normalised 0–1 coordinates.
   * setPointerCapture is what keeps the drag alive once the pointer leaves the
   * square — without it, dragging past the edge (which is exactly how you
   * reach pure white or full saturation) drops the gesture.
   */
  function drag(el, onMove) {
    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId);
      const apply = ev => {
        const r = el.getBoundingClientRect();
        onMove(
          Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
          Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))
        );
      };
      apply(e);
      const move = ev => apply(ev);
      const up = ev => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      e.preventDefault();
    });
  }

  drag(sv, (x, y) => { s = x; v = 1 - y; sync(); });
  drag(hue, x => { h = x * 360; sync(); });

  // Arrow keys nudge the square — a colour a shade off is otherwise a
  // pixel-hunt with a mouse.
  sv.addEventListener('keydown', e => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowRight') s = Math.min(1, s + step);
    else if (e.key === 'ArrowLeft') s = Math.max(0, s - step);
    else if (e.key === 'ArrowUp') v = Math.min(1, v + step);
    else if (e.key === 'ArrowDown') v = Math.max(0, v - step);
    else return;
    e.preventDefault();
    sync();
  });

  hexIn.addEventListener('input', () => {
    const c = hexToRgb(hexIn.value);
    if (!c) return;                       // mid-typing, not yet a colour
    const hsv = rgbToHsv(c.r, c.g, c.b);
    h = hsv.h; s = hsv.s; v = hsv.v;
    sync('hex');
  });

  nums.forEach(n => n.addEventListener('input', () => {
    const c = { r: 0, g: 0, b: 0 };
    nums.forEach(m => { c[m.getAttribute('data-ch')] = Math.min(255, Math.max(0, +m.value || 0)); });
    const hsv = rgbToHsv(c.r, c.g, c.b);
    h = hsv.h; s = hsv.s; v = hsv.v;
    sync('rgb');
  }));

  pop.querySelector('.cp-back').addEventListener('click', () => {
    closeColorPresets();
    openColorPresets(pop._anchor, hsvToHex(h, s, v), onPick);
  });

  sync();
}

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
  // flipped up when there isn't room below. Re-run whenever the anchor moves.
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.min(r.left, window.innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = top + 'px';
  };
  place();
  pop._place = place;

  pop.querySelectorAll('.cp-sw').forEach(sw => {
    sw.addEventListener('click', () => { onPick(sw.getAttribute('data-hex')); closeColorPresets(); });
  });

  // Swap the popover's contents in place rather than opening the OS colour
  // dialog. The native dialog is drawn by the browser and cannot be styled at
  // all, so it arrived as a stark system panel over a dark frosted app — and
  // positioned itself, which is its own problem. This keeps the picker in the
  // app's own theme and anchored where the user clicked.
  pop.querySelector('.cp-custom').addEventListener('click', () => {
    renderCustomPicker(pop, current, onPick);
    // The picker is taller than the swatch grid, so a popover that fitted
    // below the anchor may no longer — re-run the flip-up check.
    place();
  });

  // Dismiss on outside click or Escape.
  const onDocDown = e => { if (!pop.contains(e.target) && e.target !== anchor) closeColorPresets(); };
  const onKey = e => { if (e.key === 'Escape') closeColorPresets(); };

  // A scroll *follows* the anchor rather than dismissing. Closing on any
  // scroll looked reasonable and was not: focusing the hex field scrolls it
  // into view, which closed the picker the moment you clicked into it. The
  // one case that must still close is the anchor being destroyed — every
  // colour change re-renders its card, so the button this was opened against
  // can be replaced while the picker is still up.
  const onMove = () => {
    if (!document.body.contains(anchor)) { closeColorPresets(); return; }
    place();
  };
  setTimeout(() => document.addEventListener('pointerdown', onDocDown), 0);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onMove);
  // Capture phase: scroll events from the sidebar's inner container don't
  // bubble to window, and that container is exactly what moves the anchor.
  window.addEventListener('scroll', onMove, true);

  presetCleanup = () => {
    document.removeEventListener('pointerdown', onDocDown);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onMove);
    window.removeEventListener('scroll', onMove, true);
  };
}
