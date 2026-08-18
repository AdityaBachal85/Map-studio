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

  if (on) startMap3dBearingWatch(); else stopMap3dBearingWatch();
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

  const north = $('northUpBtn');
  if (north) north.addEventListener('click', () => {
    if (typeof map3dResetNorth === 'function') map3dResetNorth();
  });

  syncMap3dControls();
}
