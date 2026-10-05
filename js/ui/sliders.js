/**
 * ui/sliders.js — range input enhancement.
 *
 * The sliders were unstyled native inputs carrying only `accent-color`. That
 * gives a hairline track, a small default thumb, and — the part that actually
 * matters — no indication of how far along the range you are other than the
 * thumb's position against an undifferentiated line. On a control like 3D tilt
 * or label size, where the operator is matching a value to what they see on the
 * map, that reads as unfinished.
 *
 * CSS cannot fill a track up to the thumb on its own: it has no access to the
 * input's value. This writes the position to a `--fill` custom property, which
 * the stylesheet uses as a gradient stop, and keeps it in sync as the value
 * changes — including when it is changed programmatically (project load, the
 * reset button), which an `input` listener alone would miss.
 */

/**
 * Keep one slider's fill in sync with its value.
 * @param {HTMLInputElement} el
 */
function enhanceSlider(el) {
  if (el.dataset.sliderReady) return;
  el.dataset.sliderReady = '1';

  const paint = () => {
    const min = parseFloat(el.min) || 0;
    const max = parseFloat(el.max);
    const span = (isNaN(max) ? 100 : max) - min;
    const pct = span > 0 ? ((parseFloat(el.value) - min) / span) * 100 : 0;
    el.style.setProperty('--fill', Math.max(0, Math.min(100, pct)) + '%');
  };

  el.addEventListener('input', paint);
  // `change` fires on release; `input` covers the drag. Both are needed because
  // a keyboard arrow press fires only `input` in some browsers and only
  // `change` in others.
  el.addEventListener('change', () => { paint(); popReadout(el); });

  // A value set from code (project load, reset to defaults) fires no event at
  // all, so the fill would keep showing the old position. Watching the
  // attribute and re-painting on the next frame covers it without polling.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(paint).observe(el, { attributes: true, attributeFilter: ['value'] });
  }
  paint();
}

/**
 * Pop the numeric readout beside a slider when its value settles.
 *
 * The readout is the thing the operator is actually reading, and a value that
 * changes silently is easy to miss mid-drag. A single short scale draws the eye
 * to the number without moving anything around it.
 * @param {HTMLInputElement} el
 */
function popReadout(el) {
  const row = el.closest('.inline-ctl') || el.parentElement;
  const val = row && row.querySelector('.val');
  if (!val || motionReduced() || typeof anime !== 'function') return;
  anime.remove(val);
  anime({
    targets: val,
    scale: [1, 1.18, 1],
    duration: 260,
    easing: 'cubicBezier(.22,.8,.3,1)',
  });
}

/**
 * Enhance every range input, now and as more are added.
 * Ring rows, geometry cards and measurement cards all build sliders on demand,
 * so a one-off pass at startup would leave most of them plain.
 */
function initSliders() {
  document.querySelectorAll('input[type=range]').forEach(enhanceSlider);
  if (typeof MutationObserver !== 'function') return;
  new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches && n.matches('input[type=range]')) enhanceSlider(n);
        if (n.querySelectorAll) n.querySelectorAll('input[type=range]').forEach(enhanceSlider);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}
