/**
 * auth/loginFx.js — the sign-in page's pointer effects.
 *
 * A field of dots behind the whole page, a glow that follows the cursor across
 * the form, a bright point that runs along a field's top and bottom edges as
 * you move over it, and a highlight that sweeps across a button once on hover.
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
 * The dot field across the whole window, behind the card.
 *
 * The mechanics live in js/ui/dotField.js; what belongs here is the decision to
 * put one on this page, and its colours.
 *
 * THE PALETTE IS THIS PAGE'S, not the component's. Its defaults are violet and
 * blue on white, which on a #101214 ground read as a grey haze. These are the
 * two colours already on the page — the brand orange on the buttons and kicker,
 * and the cool blue of the map scene — run across the diagonal, so the corners
 * pick up a tint and the middle, which is behind an opaque card anyway, does
 * not have to resolve into anything.
 *
 * Attached to <body>, not to .auth-wrap: it is fixed-position, so it would
 * escape that wrapper regardless, and hanging it there would only imply a
 * containment that is not real.
 */
function initLoginDotField() {
  if (typeof startDotField !== 'function') return;   // absent in legacy snapshots
  if (!document.querySelector('.auth-wrap')) return;

  const host = document.createElement('div');
  host.className = 'dot-field';
  host.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(host, document.body.firstChild);

  startDotField(host, {
    // Bigger and brighter than the component's own defaults, which are tuned
    // for a white page. A 1.5px dot at 35% alpha is mostly antialiasing, and
    // antialiasing against near-black is nothing at all — at those defaults the
    // field was technically painting and visibly absent.
    dotRadius: 2.4,
    dotSpacing: 16,
    gradientFrom: 'rgba(255, 150, 64, .44)',
    gradientTo: 'rgba(104, 162, 240, .34)',
    // Cool, against warm dots. The obvious choice was to glow in the brand
    // orange, and the obvious choice is wrong: a warm wash at 12% over #101214
    // does not read as light, it reads as a brown stain on the page. A cool
    // pool separates from the dots it is lighting and looks like illumination.
    glowColor: 'rgba(160, 185, 240, .12)',
  });
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
 * A bright point that follows the pointer along a field's rule.
 *
 * ONE element per field, not two. It is the field's frame, masked down to a
 * hairline ring in CSS, so the light follows the corner radius instead of
 * running off the end of it — see the note on `.auth-input .edge`.
 *
 * Two radial gradients in one background: one riding the top edge and one the
 * bottom, both tracking the pointer's x. Where they reach a corner the ring
 * curves and so does the light.
 */
function initLoginFieldEdges() {
  document.querySelectorAll('.auth-input').forEach(field => {
    const ring = document.createElement('span');
    ring.className = 'edge';
    ring.setAttribute('aria-hidden', 'true');
    field.appendChild(ring);

    let raf = 0, px = 0;
    const paint = () => {
      raf = 0;
      ring.style.background =
        `radial-gradient(30px circle at ${px}px 0%, var(--orange) 0%, transparent 72%),`
        + `radial-gradient(30px circle at ${px}px 100%, var(--orange) 0%, transparent 72%)`;
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
  initLoginDotField();
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
