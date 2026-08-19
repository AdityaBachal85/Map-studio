/**
 * auth/loginFx.js — the sign-in page's three pointer effects.
 *
 * A glow that follows the cursor across the form, a bright point that runs
 * along a field's top and bottom edges as you move over it, and a highlight
 * that sweeps across a button once on hover.
 *
 * EVERY ELEMENT THESE NEED IS BUILT HERE, not written into login.html. They are
 * decoration with no meaning to a reader or a screen reader, and a page whose
 * markup is half empty divs is a page where the next person cannot tell which
 * parts matter. The form works identically with this file absent — which is
 * also what makes it safe to load last on a page whose actual job is
 * authentication.
 *
 * Nothing here touches a value, a submit, or a listener the auth code owns.
 */

/** The pointer effects are motion; Reduce Motion turns them off entirely. */
function loginFxMotionOff() {
  try {
    if (typeof getPref === 'function' && getPref('reduceMotion')) return true;
  } catch (e) { /* prefs not loaded on this page */ }
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A soft blob under the form that follows the pointer.
 *
 * Positioned with a transform rather than left/top: those are layout
 * properties, and animating them on every pointer move relays out the form
 * behind it sixty times a second.
 */
function initLoginGlow() {
  const main = document.querySelector('.auth-main');
  if (!main) return;

  const glow = document.createElement('div');
  glow.className = 'auth-glow';
  glow.setAttribute('aria-hidden', 'true');
  main.insertBefore(glow, main.firstChild);

  let raf = 0, x = 0, y = 0;
  const paint = () => { raf = 0; glow.style.transform = `translate(${x}px, ${y}px)`; };

  main.addEventListener('pointermove', e => {
    const r = main.getBoundingClientRect();
    x = e.clientX - r.left;
    y = e.clientY - r.top;
    // Coalesced to one write per frame: pointermove fires far faster than the
    // screen refreshes, and the extra writes are work nobody ever sees.
    if (!raf) raf = requestAnimationFrame(paint);
  });
  main.addEventListener('pointerenter', () => main.classList.add('glowing'));
  main.addEventListener('pointerleave', () => main.classList.remove('glowing'));
}

/**
 * A bright point running along a field's top and bottom edges, under the
 * pointer.
 *
 * Two 2px strips rather than the border itself: a border cannot carry a
 * gradient, let alone one that moves.
 */
function initLoginFieldEdges() {
  document.querySelectorAll('.auth-input').forEach(field => {
    const top = document.createElement('span');
    const bottom = document.createElement('span');
    top.className = 'edge edge-t';
    bottom.className = 'edge edge-b';
    top.setAttribute('aria-hidden', 'true');
    bottom.setAttribute('aria-hidden', 'true');
    field.appendChild(top);
    field.appendChild(bottom);

    let raf = 0, px = 0;
    const paint = () => {
      raf = 0;
      const g = `radial-gradient(26px circle at ${px}px 1px, var(--orange) 0%, transparent 72%)`;
      top.style.background = g;
      bottom.style.background = g;
    };

    field.addEventListener('pointermove', e => {
      px = e.clientX - field.getBoundingClientRect().left;
      if (!raf) raf = requestAnimationFrame(paint);
    });
    field.addEventListener('pointerenter', () => field.classList.add('tracking'));
    field.addEventListener('pointerleave', () => field.classList.remove('tracking'));
  });
}

/** The highlight that crosses a button once on hover. Pure CSS; this only
 *  supplies the element for it to move. */
function initLoginSheen() {
  document.querySelectorAll('.auth-ms, .auth-submit').forEach(btn => {
    if (btn.querySelector('.sheen')) return;
    const sheen = document.createElement('span');
    sheen.className = 'sheen';
    sheen.setAttribute('aria-hidden', 'true');
    btn.appendChild(sheen);
  });
}

function initLoginFx() {
  if (loginFxMotionOff()) return;
  initLoginGlow();
  initLoginFieldEdges();
  initLoginSheen();
}

// The fields for creating an account are built into the page but hidden, so
// they are already in the DOM by the time this runs — nothing here needs to
// watch for them appearing.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLoginFx);
} else {
  initLoginFx();
}
