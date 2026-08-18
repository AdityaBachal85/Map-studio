/**
 * utils/animate.js — anime.js-powered animations (vendor/anime.min.js), used
 * where CSS keyframes alone aren't a good fit (staggered/sequenced reveals).
 * Every helper here becomes a no-op shortcut (elements snap straight to their
 * end state) when the user has Reduce Motion on, or if anime.js isn't loaded.
 */

/** True when animations should be skipped per the user's Reduce Motion preference. */
function motionReduced() { return typeof getPref === 'function' && !!getPref('reduceMotion'); }

/**
 * Scale-and-fade-in a set of elements with a staggered delay between each, so
 * they cascade in one after another instead of all popping in at once. Used
 * for Nearby-place pins landing on the map.
 * @param {HTMLElement[]} els @param {number} [staggerMs]
 */
function staggerPopIn(els, staggerMs) {
  const list = (els || []).filter(Boolean);
  if (!list.length) return;
  if (motionReduced() || typeof anime !== 'function') {
    list.forEach(el => { el.style.opacity = '1'; el.style.transform = 'scale(1)'; });
    return;
  }
  list.forEach(el => { el.style.opacity = '0'; el.style.transform = 'scale(0.3)'; });
  anime({
    targets: list,
    opacity: [0, 1],
    scale: [0.3, 1],
    easing: 'easeOutElastic(1, .6)',
    duration: 650,
    delay: anime.stagger(staggerMs || 40),
  });
}

/**
 * Slide a set of elements in from one side, staggered.
 *
 * Kept short and shallow on purpose. This is used for the elevation legend's
 * bands, which are DATA — the reader is there to look up a number, not to watch
 * it arrive — so the motion only has to say "this list just changed", and a
 * 6px travel over 220ms says it without making anyone wait to read.
 *
 * @param {HTMLElement[]} els @param {object} [o] `{staggerMs, dx, duration}`
 */
function staggerSlideIn(els, o) {
  const list = (els || []).filter(Boolean);
  if (!list.length) return;
  const opts = o || {};
  if (motionReduced() || typeof anime !== 'function') {
    list.forEach(el => { el.style.opacity = '1'; el.style.transform = 'none'; });
    return;
  }
  anime({
    targets: list,
    opacity: [0, 1],
    // translateX only: animating a width or a height here would relayout the
    // card on every frame of every band.
    translateX: [opts.dx == null ? 6 : opts.dx, 0],
    easing: 'easeOutCubic',
    duration: opts.duration || 220,
    delay: anime.stagger(opts.staggerMs || 18),
  });
}

/**
 * Expand or collapse an accordion body with a real height transition.
 *
 * The previous behaviour toggled `display:none` and cross-faded, so the panel
 * appeared at full size and everything below it jumped. Height cannot be
 * animated to `auto` in CSS, which is why this needs JS: measure the natural
 * height, animate to that number, then hand height back to `auto` so the panel
 * still reflows if its contents change while open.
 *
 * Padding animates alongside height — animating height alone leaves the padding
 * snapping in at frame one, which reads as a glitch rather than a transition.
 *
 * @param {HTMLElement} acc The `.acc` element.
 * @param {boolean} open
 */
function animateAccordion(acc, open) {
  const body = acc.querySelector('.acc-body');
  if (!body) return;
  const PAD = 13;

  if (motionReduced() || typeof anime !== 'function') {
    acc.classList.toggle('open', open);
    body.style.height = open ? 'auto' : '';
    return;
  }

  anime.remove(body);
  if (open) {
    acc.classList.add('open');
    body.style.height = '0px';
    body.style.paddingTop = '0px';
    body.style.paddingBottom = '0px';
    const target = body.scrollHeight + PAD;
    anime({
      targets: body,
      height: [0, target],
      paddingTop: [0, 2],
      paddingBottom: [0, PAD],
      duration: 260,
      easing: 'cubicBezier(.22,.8,.3,1)',
      // Back to auto so later content changes are not clipped by a fixed height.
      complete: () => { body.style.height = 'auto'; },
    });
    // The contents arrive just behind the panel edge, which makes the opening
    // read as one movement instead of a box that fills instantly.
    const kids = Array.from(body.children);
    if (kids.length) {
      anime({
        targets: kids,
        opacity: [0, 1],
        translateY: [-4, 0],
        duration: 220,
        delay: anime.stagger(24, { start: 70 }),
        easing: 'cubicBezier(.22,.8,.3,1)',
      });
    }
  } else {
    body.style.height = body.scrollHeight + 'px';
    anime({
      targets: body,
      height: 0,
      paddingTop: 0,
      paddingBottom: 0,
      duration: 200,
      easing: 'cubicBezier(.4,0,.2,1)',
      complete: () => {
        acc.classList.remove('open');
        body.style.height = '';
        body.style.paddingTop = '';
        body.style.paddingBottom = '';
      },
    });
  }
}
