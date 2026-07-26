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
