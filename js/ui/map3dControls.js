/**
 * ui/map3dControls.js — the 2D / 3D switch, and the compass that comes with it.
 *
 * Lives on the map rather than in the sidebar because it changes what the map
 * IS, not what is on it — the same reasoning that puts the Map / Dashboard /
 * Report switch on the map. It also has to be reachable in board mode, where
 * the sidebar is off-canvas.
 *
 * A segmented pair, not a single toggling button. With a toggle you have to
 * read the label to work out which state you are in, and the label names the
 * state you are NOT in, so it reads as the opposite of the truth. Two segments
 * show the choice and the current answer at the same time.
 */

/** How often the compass re-reads the camera while it is being dragged. */
let _m3dBearingRaf = 0;

/** Reflect the renderer's actual state into the controls. */
function syncMap3dControls() {
  const on = typeof map3dActive === 'function' && map3dActive();
  const b2 = $('dim2dBtn'), b3 = $('dim3dBtn');
  if (b2) { b2.classList.toggle('on', !on); b2.setAttribute('aria-pressed', String(!on)); }
  if (b3) { b3.classList.toggle('on', on); b3.setAttribute('aria-pressed', String(on)); }

  const north = $('northUpBtn');
  if (north) {
    const appearing = on && north.hidden;
    north.hidden = !on;
    // The compass belongs to the 3D view, so it arrives with it rather than
    // being there all along greyed out. One element, 180ms, transform and
    // opacity only — it is a control appearing, not an event.
    if (appearing && typeof anime === 'function' && !(typeof motionReduced === 'function' && motionReduced())) {
      anime({ targets: north, opacity: [0, 1], scale: [0.8, 1], duration: 180, easing: 'easeOutCubic' });
    }
  }

  const tilt = $('m3dTiltWrap');
  if (tilt) tilt.hidden = !on;
  if (on) syncMap3dTilt();

  if (on) startMap3dBearingWatch(); else stopMap3dBearingWatch();
}

/** Put the slider where the camera actually is. */
function syncMap3dTilt() {
  const el = $('m3dTilt'), out = $('m3dTiltVal');
  if (!el) return;
  const deg = Math.round(typeof map3dPitch === 'function' ? map3dPitch() : 0);
  // Not while it is being dragged: writing the camera's value back into the
  // control the user is holding fights them for it. The rail's fill still
  // follows, because that is the readout and it has to track the thumb.
  if (!el._dragging) el.value = String(deg);
  paintMap3dTiltFill(el, el._dragging ? Number(el.value) || 0 : deg);
  if (out) out.textContent = deg + '\u00B0';
}

/**
 * Colour the rail below the thumb.
 *
 * The track runs bottom-up — flat at the bottom, 80 degrees at the top — so the
 * stop is measured from the top, and everything below it is the part the camera
 * has actually leaned.
 *
 * @param {HTMLInputElement} el @param {number} deg
 */
function paintMap3dTiltFill(el, deg) {
  const max = Number(el.max) || 80;
  const pct = Math.max(0, Math.min(100, (1 - (Number(deg) || 0) / max) * 100));
  el.style.setProperty('--m3d-fill', pct.toFixed(1) + '%');
}

/**
 * Turn the compass with the camera.
 *
 * Polled on a frame rather than bound to MapLibre's `rotate` event: the camera
 * also moves under inertia and under easeTo, and an event-driven needle lags
 * both. A rotation only repaints when the number actually changed.
 */
function startMap3dBearingWatch() {
  if (_m3dBearingRaf) return;
  let last = null;
  const tick = () => {
    if (typeof map3dActive !== 'function' || !map3dActive()) { _m3dBearingRaf = 0; return; }
    const st = map3dStatus();
    if (st.bearing !== last) {
      last = st.bearing;
      const icon = $('northUpBtn') && $('northUpBtn').querySelector('svg');
      if (icon) icon.style.transform = 'rotate(' + (-st.bearing).toFixed(1) + 'deg)';
      // The map's own north arrow is the one people read; it has to agree.
      const arrow = $('northArrow');
      if (arrow) arrow.style.setProperty('--map-bearing', (-st.bearing).toFixed(1) + 'deg');
    }
    // The camera can be tilted by dragging as well as by the slider, and the
    // slider is the readout — so it follows the camera rather than only
    // driving it.
    syncMap3dTilt();
    _m3dBearingRaf = requestAnimationFrame(tick);
  };
  _m3dBearingRaf = requestAnimationFrame(tick);
}

function stopMap3dBearingWatch() {
  if (_m3dBearingRaf) cancelAnimationFrame(_m3dBearingRaf);
  _m3dBearingRaf = 0;
  const icon = $('northUpBtn') && $('northUpBtn').querySelector('svg');
  if (icon) icon.style.transform = '';
  const arrow = $('northArrow');
  if (arrow) arrow.style.removeProperty('--map-bearing');
}

function initMap3dControls() {
  const b2 = $('dim2dBtn'), b3 = $('dim3dBtn');
  if (!b2 || !b3) return;

  // Disabled while the switch is in flight: mounting loads a renderer and a
  // style, and a second click halfway through would mount a second map.
  const busy = state => {
    b2.disabled = state; b3.disabled = state;
    b3.classList.toggle('working', state);
  };

  b3.addEventListener('click', async () => {
    if (typeof map3dActive === 'function' && map3dActive()) return;
    busy(true);
    try { await setMap3d(true); } finally { busy(false); syncMap3dControls(); }
  });
  b2.addEventListener('click', async () => {
    if (typeof map3dActive !== 'function' || !map3dActive()) return;
    busy(true);
    try { await setMap3d(false); } finally { busy(false); syncMap3dControls(); }
  });

  wireMap3dNavigator();
  syncMap3dControls();
}

/**
 * The two gestures MapLibre had and never showed.
 *
 * It can orbit and tilt already — dragRotate and touchZoomRotate are enabled at
 * mount — but the bindings are right-drag and ctrl-drag, and nobody finds
 * those. The camera therefore read as being welded to one angle, which is
 * exactly how it was reported. Google Earth solves this with a visible
 * navigator, so this is one: drag the compass to spin, use the slider to lean.
 */
function wireMap3dNavigator() {
  const north = $('northUpBtn');
  if (north) {
    // Orbit by dragging the compass; click still faces north. The two are told
    // apart by distance travelled, not by timing — a slow, deliberate click
    // should still be a click, and a fast flick should still be a drag.
    let dragging = false, moved = false, pointerUsed = false;
    let cx = 0, cy = 0, startAngle = 0, startBearing = 0;
    const angleAt = e => Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;

    north.addEventListener('pointerdown', e => {
      if (typeof map3dActive !== 'function' || !map3dActive()) return;
      const r = north.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      dragging = true; moved = false;
      startAngle = angleAt(e);
      startBearing = typeof map3dBearing === 'function' ? map3dBearing() : 0;
      north.setPointerCapture(e.pointerId);
      north.classList.add('orbiting');
    });

    north.addEventListener('pointermove', e => {
      if (!dragging) return;
      const delta = angleAt(e) - startAngle;
      // Four degrees of travel before it counts as a drag. Below that it is
      // hand tremor on a button somebody meant to press.
      if (!moved && Math.abs(delta) < 4) return;
      moved = true;
      if (typeof map3dSetBearing === 'function') map3dSetBearing(startBearing + delta);
    });

    // THE DECISION IS MADE ON POINTERUP, NOT ON CLICK. A drag ends in a click
    // event as well, so a click handler has to know whether the gesture it is
    // seeing was a drag — and a flag shared between the two is only correct if
    // the click always arrives after the pointerup that cleared it. Whether it
    // does depends on pointer capture and on whether the pointer strayed off
    // the element, which is exactly the kind of ordering that works on one path
    // and not another. Deciding here removes the question.
    const end = e => {
      if (!dragging) return;
      dragging = false;
      north.classList.remove('orbiting');
      try { north.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
      pointerUsed = true;
      if (!moved && typeof map3dResetNorth === 'function') map3dResetNorth();
    };
    north.addEventListener('pointerup', end);
    north.addEventListener('pointercancel', end);

    // Keyboard only. Enter or Space on a focused button fires `click` with no
    // pointer events at all, and that still has to face north.
    north.addEventListener('click', () => {
      if (pointerUsed) { pointerUsed = false; return; }
      if (typeof map3dResetNorth === 'function') map3dResetNorth();
    });
  }

  const tilt = $('m3dTilt');
  if (tilt) {
    const apply = () => {
      const deg = Number(tilt.value) || 0;
      const out = $('m3dTiltVal');
      if (out) out.textContent = Math.round(deg) + '\u00B0';
      paintMap3dTiltFill(tilt, deg);
      // Not easeTo: `input` fires on every pixel of the drag, and queuing a
      // 200ms animation per event leaves each one fighting the next.
      const gl = typeof map3dGl === 'function' ? map3dGl() : null;
      if (gl) gl.jumpTo({ pitch: Math.max(0, Math.min(80, deg)) });
    };
    tilt.addEventListener('pointerdown', () => { tilt._dragging = true; });
    tilt.addEventListener('pointerup', () => { tilt._dragging = false; });
    tilt.addEventListener('input', apply);
    // Keyboard arrows fire `change` without a pointer ever going down.
    tilt.addEventListener('change', () => { tilt._dragging = false; apply(); });
  }
}
