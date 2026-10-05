/**
 * ui/tooltips.js — a single styled tooltip for the whole app.
 *
 * The interface previously relied on the browser's native `title` tooltip.
 * Nothing else marks an interface as unconsidered quite as reliably: it appears
 * after an uncontrollable ~1s delay, renders in the OS's own style with no
 * relation to the product, cannot be positioned, never appears on keyboard
 * focus, and on touch devices does not appear at all.
 *
 * This replaces it with one tooltip element reused for every target:
 *
 *   - **Adopts existing markup.** Every `title` in the DOM is converted to
 *     `data-tip` on init, so nothing had to be re-authored, and any element
 *     added later is picked up by the same conversion. Icon-only controls that
 *     had no `aria-label` get one from the same text, which is an accessibility
 *     improvement the native tooltip never provided.
 *   - **Positioned, not clipped.** It is `position: fixed` on `document.body`,
 *     so it escapes the sidebar's `overflow: auto` panes — a CSS-only
 *     `::after` tooltip would be cut off there.
 *   - **Keyboard reachable.** Shows on focus-visible as well as hover, which is
 *     a WCAG expectation the native tooltip fails.
 *
 * One element, one listener pair, delegated: no per-element bookkeeping and
 * nothing to clean up when a card is removed from the DOM.
 */

/** Delay before a hovered tooltip appears. Focus shows immediately. */
const TIP_DELAY_MS = 320;
/** Gap between the target and the tooltip. */
const TIP_GAP = 9;

let tipEl = null;
let tipTimer = null;
let tipTarget = null;

/** Create (once) the shared tooltip element. @returns {HTMLElement} */
function tipElement() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'tip';
  tipEl.setAttribute('role', 'tooltip');
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  return tipEl;
}

/**
 * Place the tooltip against a target, preferring above and flipping below when
 * there is no room. Kept inside the viewport horizontally so a tooltip on a
 * control near the edge is never half off-screen.
 * @param {HTMLElement} target
 */
function positionTip(target) {
  const el = tipElement();
  const t = target.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;

  let top = t.top - h - TIP_GAP;
  let placement = 'top';
  if (top < 8) { top = t.bottom + TIP_GAP; placement = 'bottom'; }

  let left = t.left + t.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));

  el.style.top = Math.round(top) + 'px';
  el.style.left = Math.round(left) + 'px';
  el.dataset.placement = placement;
}

/** Show the tooltip for a target. @param {HTMLElement} target */
function showTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  const el = tipElement();
  el.textContent = text;
  el.hidden = false;
  // Measure with the final text in place before positioning.
  positionTip(target);
  el.classList.add('on');
  tipTarget = target;
}

function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  if (!tipEl) return;
  tipEl.classList.remove('on');
  tipEl.hidden = true;
}

/**
 * Move `title` to `data-tip` so the native tooltip never fires, and backfill
 * `aria-label` on controls that would otherwise be announced as unlabelled.
 * Safe to call repeatedly — elements already converted have no `title` left.
 * @param {ParentNode} [root]
 */
function adoptTitles(root) {
  (root || document).querySelectorAll('[title]').forEach(el => {
    const text = el.getAttribute('title');
    if (!text) return;
    el.removeAttribute('title');
    el.setAttribute('data-tip', text);
    const labelled = el.getAttribute('aria-label') || el.textContent.trim();
    if (!labelled) el.setAttribute('aria-label', text);
  });
}

/** Wire the delegated listeners. Called once from app.js. */
function initTooltips() {
  adoptTitles();

  document.addEventListener('pointerover', e => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t || t === tipTarget) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(t), TIP_DELAY_MS);
  });

  document.addEventListener('pointerout', e => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t) hideTip();
  });

  // Keyboard users get it without the hover delay.
  document.addEventListener('focusin', e => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t && t.matches(':focus-visible')) showTip(t);
  });
  document.addEventListener('focusout', hideTip);

  // A tooltip anchored to a scrolled-away element is worse than none.
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);
  document.addEventListener('pointerdown', hideTip);

  // Newly built cards, chips and layer rows carry `title` from their templates;
  // adopting on mutation keeps them consistent without touching every builder.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) adoptTitles(n.parentNode === document.body ? n : n);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
}
