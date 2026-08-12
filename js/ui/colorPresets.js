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

/**
 * Named so the swatches have something to announce. A screen reader reading
 * "#E03131" says "number E zero three one three one", which tells nobody
 * anything; "Red" and "Light red" are the same information a sighted user
 * gets from looking at the square.
 */
const COLOR_PRESETS = [
  // Strong — the default weight for pins and routes.
  { hex: '#E03131', name: 'Red' }, { hex: '#7048E8', name: 'Violet' },
  { hex: '#3B5BDB', name: 'Indigo' }, { hex: '#1C7ED6', name: 'Blue' },
  { hex: '#0CA678', name: 'Teal' }, { hex: '#37B24D', name: 'Green' },
  { hex: '#F0A800', name: 'Amber' }, { hex: '#F76707', name: 'Orange' },
  // Light — secondary pins that should sit behind the strong ones.
  { hex: '#FF6B6B', name: 'Light red' }, { hex: '#B197FC', name: 'Light violet' },
  { hex: '#748FFC', name: 'Light indigo' }, { hex: '#4DABF7', name: 'Light blue' },
  { hex: '#38D9A9', name: 'Light teal' }, { hex: '#69DB7C', name: 'Light green' },
  { hex: '#FFD43B', name: 'Light amber' }, { hex: '#FFA94D', name: 'Light orange' },
  // Neutrals — greys for context, plus the two DBOT house colours at the end.
  { hex: '#FFFFFF', name: 'White' }, { hex: '#E9ECEF', name: 'Off white' },
  { hex: '#CED4DA', name: 'Light grey' }, { hex: '#868E96', name: 'Grey' },
  { hex: '#495057', name: 'Dark grey' }, { hex: '#000000', name: 'Black' },
  { hex: '#4B342A', name: 'Dark brown' }, { hex: '#8D6E63', name: 'Brown' },
];

/** Human name for a hex, when it is one of the presets. @param {string} hex */
function colorName(hex) {
  const h = String(hex || '').toLowerCase();
  const hit = COLOR_PRESETS.find(p => p.hex.toLowerCase() === h);
  return hit ? hit.name : hex;
}

let presetPopover = null;
let presetCleanup = null;

/** Pipette glyph for the eyedropper button — stroked so it inherits text colour. */
const DROPPER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
  + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/>'
  + '<path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4Z"/>'
  + '</svg>';

/**
 * Sample a colour from anywhere on screen with the browser's eyedropper.
 *
 * The map is the whole point of this. A pin colour that has to sit against a
 * particular road, roof, coastline or shade of water is a judgement about
 * what is already on screen, and matching it through a hex field is guesswork
 * — you end up nudging RGB values and re-checking, which is exactly the loop
 * the picker exists to remove.
 *
 * The popover hides for the duration: it is drawn over part of the map, and
 * the eyedropper reads real screen pixels, so anything it covers would
 * otherwise be unreachable. The hide waits two frames so the browser's live
 * capture starts from a frame the popover is no longer in — the click's user
 * activation lasts seconds, so the delay costs nothing.
 *
 * @param {HTMLElement} pop the open popover
 * @returns {Promise<string|null>} `#rrggbb`, or null if cancelled or unavailable
 */
function pickFromScreen(pop) {
  pop._sampling = true;                    // suspend outside-click/Escape dismissal
  pop.style.visibility = 'hidden';
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      let hex = null;
      try {
        const res = await new window.EyeDropper().open();
        hex = res && res.sRGBHex;
      } catch (err) {
        // Escape, or a click outside the browser window, rejects with
        // AbortError — that is a cancel, not a failure, and saying anything
        // about it would be noise. Anything else is worth reporting: the API
        // also refuses outside a secure context, which is silent otherwise.
        if (!err || err.name !== 'AbortError') status('Could not open the eyedropper here.');
      }
      pop.style.visibility = '';
      // Cleared a tick late in case the browser lets the selecting click
      // through to the page — it would otherwise land as an outside click and
      // close the picker the instant a colour was chosen.
      setTimeout(() => { pop._sampling = false; }, 0);
      resolve(hex || null);
    }));
  });
}

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

  const label = input.title || 'Choose a colour';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'clrBtn';
  btn.title = label;
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  if (input.title) input.removeAttribute('title');   // or both tooltips fire
  wrap.appendChild(btn);

  const sync = () => {
    btn.style.setProperty('--sw', input.value);
    // The swatch's only content is a colour, so without this a screen reader
    // announces nine identical "Label background colour" buttons on a card and
    // no way to tell which is set to what.
    btn.setAttribute('aria-label', label + ': ' + colorName(input.value));
  };
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
 * Lock or unlock a colour control.
 *
 * The visible control is the `.clrBtn` the enhancer injects, not the
 * `input[type=color]` behind it — so setting `input.disabled` alone leaves a
 * fully clickable swatch that still opens the picker. Both have to be told,
 * which is exactly the kind of thing that only bites once the enhancer has run.
 *
 * @param {HTMLInputElement} input
 * @param {boolean} locked
 * @param {string} [title] tooltip explaining who owns the colour
 */
function setColorInputLocked(input, locked, title) {
  if (!input) return;
  input.disabled = !!locked;
  const wrap = input.parentNode;
  const btn = wrap && wrap.classList && wrap.classList.contains('clrWrap')
    ? wrap.querySelector('.clrBtn') : null;
  if (btn) {
    btn.disabled = !!locked;
    btn.classList.toggle('locked', !!locked);
    if (title) btn.title = title;
  }
  input.classList.toggle('locked', !!locked);
  if (title) input.title = title;
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
  if (!btn) return;
  btn.style.setProperty('--sw', input.value);
  btn.setAttribute('aria-label', (btn.title || 'Colour') + ': ' + colorName(input.value));
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

  // Chromium-only API. Rendering the button unconditionally would leave
  // Firefox and Safari users with a control that does nothing, so it is only
  // built where it works — and the fields grid narrows to match.
  const canSample = typeof window.EyeDropper === 'function';

  pop.classList.add('cp-custom-mode');
  pop.innerHTML =
    '<div class="cp-sv" tabindex="0" role="group"'
    + ' aria-label="Saturation and brightness — arrow keys adjust, Shift for larger steps">'
    + '<div class="cp-sv-thumb"></div></div>'
    + '<div class="cp-hue" tabindex="0" role="slider" aria-label="Hue"'
    + ' aria-valuemin="0" aria-valuemax="359" aria-valuenow="0"><div class="cp-hue-thumb"></div></div>'
    + '<div class="cp-fields' + (canSample ? ' has-dropper' : '') + '">'
    + '<span class="cp-preview"></span>'
    + (canSample
      ? '<button type="button" class="cp-dropper" title="Pick a colour off the map"'
        + ' aria-label="Pick a colour off the map">' + DROPPER_SVG + '</button>'
      : '')
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
    hue.setAttribute('aria-valuenow', Math.round(h));
    hue.setAttribute('aria-valuetext', Math.round(h) + ' degrees');
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

  // The hue bar was pointer-only, which made the whole picker unusable from
  // the keyboard: the square can reach every shade of one hue, and nothing
  // could change which hue that was. Home/End jump to the ends of the wheel.
  hue.addEventListener('keydown', e => {
    const step = e.shiftKey ? 20 : 4;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') h = (h + step) % 360;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') h = (h - step + 360) % 360;
    else if (e.key === 'Home') h = 0;
    else if (e.key === 'End') h = 359;
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

  const dropper = pop.querySelector('.cp-dropper');
  if (dropper) dropper.addEventListener('click', async () => {
    const picked = await pickFromScreen(pop);
    // visibility:hidden makes an element unfocusable, so the browser blurred
    // the button on the way in and focus is sitting on <body>. Put it back.
    dropper.focus();
    const c = picked && hexToRgb(picked);
    if (!c) return;                       // cancelled
    const hsv = rgbToHsv(c.r, c.g, c.b);
    h = hsv.h; s = hsv.s; v = hsv.v;
    sync();
  });

  pop.querySelector('.cp-back').addEventListener('click', () => {
    closeColorPresets();
    openColorPresets(pop._anchor, hsvToHex(h, s, v), onPick);
  });

  sync();
  // Swapping the popover's contents destroys whatever had focus, which for a
  // keyboard user is the "Custom colour…" button they just pressed — focus
  // would fall to <body> and the next Tab would start from the top of the
  // document. The square is where the work happens, so it takes over.
  pop.setAttribute('aria-label', 'Custom colour');
  sv.focus();
}

/**
 * Tear down the open popover, if any.
 *
 * Focus goes back to the swatch that opened it, but only when it is still
 * inside the popover — returning it unconditionally would yank focus away
 * from wherever the user had since moved it.
 */
function closeColorPresets() {
  if (presetCleanup) { presetCleanup(); presetCleanup = null; }
  if (!presetPopover) return;
  const anchor = presetPopover._anchor;
  const inside = presetPopover.contains(document.activeElement);
  presetPopover.remove();
  presetPopover = null;
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'false');
    if (inside && document.body.contains(anchor)) anchor.focus();
  }
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
  // A dialog, like every other overlay in this app. Without a role it is an
  // anonymous div at the end of <body>, which is also where Tab would land
  // after the swatch — nowhere near it on screen.
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Colour presets');
  pop.innerHTML = COLOR_PRESETS.map(p => {
    const sel = p.hex.toLowerCase() === String(current).toLowerCase();
    return `<button type="button" class="cp-sw${sel ? ' sel' : ''}" aria-pressed="${sel}"
       style="--sw:${esc(p.hex)}" data-hex="${esc(p.hex)}" title="${esc(p.name)} ${esc(p.hex)}"
       aria-label="${esc(p.name)}"></button>`;
  }).join('') + '<button type="button" class="cp-custom">Custom colour…</button>';

  document.body.appendChild(pop);
  presetPopover = pop;
  anchor.setAttribute('aria-expanded', 'true');

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

  // Focus starts on the colour that is already set, so a keyboard user opens
  // the picker already standing where they are, and arrow/Tab moves relative
  // to that rather than from an arbitrary corner of the grid.
  const start = pop.querySelector('.cp-sw.sel') || pop.querySelector('.cp-sw');
  if (start) start.focus();

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

  // Dismiss on outside click or Escape — except while the eyedropper is up,
  // where a click anywhere on screen is the gesture and Escape cancels it.
  // Both would otherwise tear the picker down mid-sample.
  const onDocDown = e => {
    if (pop._sampling) return;
    if (!pop.contains(e.target) && e.target !== anchor) closeColorPresets();
  };
  const onKey = e => { if (!pop._sampling && e.key === 'Escape') closeColorPresets(); };

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
