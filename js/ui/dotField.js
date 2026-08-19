/**
 * ui/dotField.js — the interactive dot field behind the sign-in card.
 *
 * A grid of dots that bulges away from the pointer as it moves, with a soft
 * pool of light following it. Ported from a React component; the mechanics are
 * a canvas, a requestAnimationFrame loop and a radial gradient, none of which
 * needed React to begin with.
 *
 * THREE THINGS MAKE IT CHEAP ENOUGH TO LEAVE RUNNING:
 *
 *   - Every dot goes into ONE path and one fill. Several thousand arcs cost a
 *     single draw call; a fill per dot would cost several thousand, and that is
 *     the difference between this being free and it being the reason a laptop
 *     fan starts on a login screen.
 *   - It reacts to the pointer's SPEED, not its position. A still cursor
 *     settles the field back to its grid and the loop does almost nothing —
 *     which is the state a sign-in page is in most of the time, because people
 *     are typing.
 *   - It stops entirely when the tab is hidden, and never starts under Reduce
 *     Motion.
 *
 * It is decoration. Nothing on the page reads it, and removing the element it
 * draws into changes nothing about the form.
 */

const DOT_FIELD_DEFAULTS = {
  dotRadius: 1.5,
  dotSpacing: 14,
  /** How far from the pointer dots begin to move. */
  cursorRadius: 500,
  /** How far the nearest dots are pushed away, in pixels. */
  bulgeStrength: 67,
  /** The pool of light under the pointer. */
  glowRadius: 160,
  glowColor: 'rgba(150, 170, 255, .14)',
  /** The dots themselves, across the diagonal. */
  gradientFrom: 'rgba(168, 133, 255, .30)',
  gradientTo: 'rgba(93, 158, 255, .20)',
  /** Dots above this many are not drawn — see the note in build(). */
  maxDots: 9000,
};

/** True when the operator has asked for less motion. */
function dotFieldMotionOff() {
  try {
    if (typeof getPref === 'function' && getPref('reduceMotion')) return true;
  } catch (e) { /* prefs may not be loaded on this page */ }
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Start a dot field inside a host element.
 *
 * @param {HTMLElement} host
 * @param {object} [options] any of DOT_FIELD_DEFAULTS
 * @returns {{destroy:function}|null} null when it declined to start
 */
function startDotField(host, options) {
  if (!host || dotFieldMotionOff()) return null;

  const o = Object.assign({}, DOT_FIELD_DEFAULTS, options || {});
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.className = 'dot-field-canvas';
  host.appendChild(canvas);

  const glow = document.createElement('div');
  glow.setAttribute('aria-hidden', 'true');
  glow.className = 'dot-field-glow';
  glow.style.width = glow.style.height = (o.glowRadius * 2) + 'px';
  glow.style.margin = (-o.glowRadius) + 'px 0 0 ' + (-o.glowRadius) + 'px';
  glow.style.background = 'radial-gradient(circle, ' + o.glowColor + ' 0%, transparent 70%)';
  host.appendChild(glow);

  const ctx = canvas.getContext('2d', { alpha: true });
  // Capped at 2: past that the extra pixels cost real time and nobody can see
  // a 1.5px dot get sharper.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  let dots = [];
  let w = 0, h = 0;
  let raf = 0, speedTimer = 0, resizeTimer = 0;
  let frame = 0;
  let running = false;

  // Where the pointer is, how fast it is going, and how much the field has
  // woken up in response. `engagement` is separate from speed so the field
  // eases in and out rather than snapping the moment the mouse twitches.
  const m = { x: -9999, y: -9999, prevX: -9999, prevY: -9999, speed: 0 };
  let engagement = 0;
  let glowAlpha = 0;

  function build() {
    const step = o.dotRadius + o.dotSpacing;
    const cols = Math.floor(w / step);
    const rows = Math.floor(h / step);
    // A very large window at a fine spacing is tens of thousands of dots, and
    // the honest answer there is fewer dots rather than a slower page: the
    // spacing widens until the count fits.
    let spacing = step;
    if (cols * rows > o.maxDots) {
      spacing = Math.sqrt((w * h) / o.maxDots);
    }
    const c = Math.max(1, Math.floor(w / spacing));
    const r = Math.max(1, Math.floor(h / spacing));
    const padX = (w - c * spacing) / 2 + spacing / 2;
    const padY = (h - r * spacing) / 2 + spacing / 2;

    dots = new Array(c * r);
    let i = 0;
    for (let row = 0; row < r; row++) {
      for (let col = 0; col < c; col++) {
        const ax = padX + col * spacing;
        const ay = padY + row * spacing;
        // ax/ay is where the dot belongs; sx/sy is where it is on the way
        // there. Keeping both is what lets it spring back.
        dots[i++] = { ax, ay, sx: ax, sy: ay };
      }
    }
  }

  function resize() {
    const rect = host.getBoundingClientRect();
    w = Math.max(1, rect.width);
    h = Math.max(1, rect.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
  }

  function onResize() {
    clearTimeout(resizeTimer);
    // Rebuilding the grid on every resize event of a window drag is thousands
    // of allocations for frames nobody sees.
    resizeTimer = setTimeout(resize, 120);
  }

  function onMove(e) {
    const rect = host.getBoundingClientRect();
    m.x = e.clientX - rect.left;
    m.y = e.clientY - rect.top;
  }

  function onLeave() { m.x = -9999; m.y = -9999; }

  /**
   * Pointer speed, smoothed.
   *
   * On its own timer rather than measured inside the frame loop: pointermove
   * fires irregularly, so a per-frame delta is a measure of how many events
   * happened to arrive that frame as much as of how fast the hand moved.
   */
  function sampleSpeed() {
    const dx = m.prevX - m.x;
    const dy = m.prevY - m.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    m.speed += (dist - m.speed) * 0.5;
    if (m.speed < 0.001) m.speed = 0;
    m.prevX = m.x;
    m.prevY = m.y;
  }

  function tick() {
    frame++;
    const len = dots.length;

    const target = Math.min(m.speed / 5, 1);
    engagement += (target - engagement) * 0.06;
    if (engagement < 0.001) engagement = 0;

    glowAlpha += (engagement - glowAlpha) * 0.08;
    glow.style.transform = 'translate(' + m.x + 'px,' + m.y + 'px)';
    glow.style.opacity = glowAlpha;

    ctx.clearRect(0, 0, w, h);

    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, o.gradientFrom);
    grad.addColorStop(1, o.gradientTo);
    ctx.fillStyle = grad;

    const cr = o.cursorRadius;
    const crSq = cr * cr;
    const rad = o.dotRadius / 2;
    const awake = engagement > 0.01;

    // One path for every dot, filled once. See the header.
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const d = dots[i];

      if (awake) {
        const dx = m.x - d.ax;
        const dy = m.y - d.ay;
        const distSq = dx * dx + dy * dy;
        if (distSq < crSq) {
          const dist = Math.sqrt(distSq) || 0.0001;
          const t = 1 - dist / cr;
          // Squared, so the bulge is a dome rather than a cone: the dots right
          // under the pointer move far and the falloff is gentle at the edge.
          const push = t * t * o.bulgeStrength * engagement;
          d.sx += (d.ax - (dx / dist) * push - d.sx) * 0.15;
          d.sy += (d.ay - (dy / dist) * push - d.sy) * 0.15;
        } else {
          d.sx += (d.ax - d.sx) * 0.1;
          d.sy += (d.ay - d.sy) * 0.1;
        }
      } else {
        d.sx += (d.ax - d.sx) * 0.1;
        d.sy += (d.ay - d.sy) * 0.1;
      }

      // moveTo before arc, or every dot is joined to the last one by a line.
      ctx.moveTo(d.sx + rad, d.sy);
      ctx.arc(d.sx, d.sy, rad, 0, Math.PI * 2);
    }
    ctx.fill();

    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    speedTimer = setInterval(sampleSpeed, 20);
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    clearInterval(speedTimer);
    raf = speedTimer = 0;
  }

  function onVisibility() {
    // A background tab still runs its timers; the frame loop is the expensive
    // half and there is nobody watching it.
    if (document.hidden) stop(); else start();
  }

  resize();
  window.addEventListener('resize', onResize);
  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', onLeave);
  document.addEventListener('visibilitychange', onVisibility);
  start();

  return {
    destroy() {
      stop();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(resizeTimer);
      canvas.remove();
      glow.remove();
    },
  };
}
