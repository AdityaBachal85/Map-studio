/**
 * map/roadDraw.js — draw a road by clicking its two ends.
 *
 * WHAT IT REPLACES. To show a road running past a site you used to: add a
 * location, add a second location, tick "Hide marker" on both, route between
 * them, and then live with two junk entries in the Locations list forever. On
 * a map with eight roads on it that is sixteen invisible pins in a list you
 * have to scroll past to reach the four places you actually care about.
 *
 * WHY THIS STILL CREATES LOCATIONS. A route is `{fromId, toId}` and
 * `computeRoute` bails the moment `locById` misses either — the whole routing,
 * serialisation, undo and cascade-delete machinery is built on ids. Making
 * routes accept raw coordinates would mean touching every one of those paths
 * for a feature that is really about the sidebar. So the anchors are still
 * locations; they are simply marked as scaffolding and kept out of the list.
 *
 * `routeAnchor` and not `anchor`: `loc.anchor` is already a runtime field on
 * both locations and routes (the billboard's label tie-point), and quietly
 * overloading it would have produced a bug with no obvious cause.
 *
 * The anchors are real, so nothing downstream needs a special case: they
 * serialise, they restore, they undo. What changes is presentation — the
 * Locations list and the route's from/to selects skip them, because a dropdown
 * listing two invisible points is not a control anyone can use.
 */

/** Whether the tool is armed. */
let roadDrawActive = false;

/** The first click, waiting for its pair. */
let roadDrawPendingA = null;
let roadDrawPendingMarker = null;

/** Which class the next road is drawn as. */
let roadDrawClass = 'major';

/** @returns {object} the faint dot that marks a half-placed road */
function roadDrawDot() {
  return L.divIcon({ className: 'road-draw-dot', html: '<i></i>', iconSize: [14, 14], iconAnchor: [7, 7] });
}

/** Discard a half-started road. Never touches a finished one. */
function roadDrawCancelPending() {
  if (roadDrawPendingMarker) { map.removeLayer(roadDrawPendingMarker); roadDrawPendingMarker = null; }
  roadDrawPendingA = null;
}

/** @returns {object[]} the locations a user should actually see */
function visibleLocations() {
  return locations.filter(l => !l.routeAnchor);
}

/**
 * Arm or disarm the tool.
 *
 * Turning it on stands down every other mode that wants map clicks, the same
 * way the measure tool does — two tools claiming one click is how you get a
 * pin dropped in the middle of drawing a road.
 *
 * @param {boolean} on
 */
function setRoadDrawActive(on) {
  roadDrawActive = on;
  if (on) {
    if (typeof setAdding === 'function') setAdding(false);
    if (typeof armingViaFor !== 'undefined' && armingViaFor && typeof disarmVia === 'function') disarmVia();
    if (typeof setAerialActive === 'function' && typeof aerialActive !== 'undefined' && aerialActive) setAerialActive(false);
    if (typeof disableAllDrawModes === 'function') disableAllDrawModes();
    if (typeof disableAllEditModes === 'function') disableAllEditModes();
    if (typeof setTextLabelPlacing === 'function' && typeof textLabelPlacing !== 'undefined' && textLabelPlacing) {
      setTextLabelPlacing(false);
    }
  }
  roadDrawCancelPending();

  const btn = document.getElementById('roadDrawBtn');
  if (btn) {
    btn.classList.toggle('toggled', on);
    const label = btn.querySelector('.rd-label');
    if (label) label.textContent = on ? 'Click the two ends (Esc)' : 'Draw a road';
  }
  const wrap = document.getElementById('mapWrap');
  if (wrap) wrap.classList.toggle('road-drawing', on);

  if (on && typeof status === 'function') {
    const c = typeof connClass === 'function' ? connClass(roadDrawClass) : null;
    status('Drawing ' + (c ? c.label.toLowerCase() : 'a road')
      + ' — click one end, then the other. Esc to stop.', true);
  }
}

/**
 * Classes that are NOT roads, and must not be routed.
 *
 * A metro line is not a car journey. Sending one through OSRM snaps it to the
 * nearest drivable road and reports a driving time along a parallel highway —
 * confidently wrong, and wrong in a way that looks right. These become plain
 * lines in the Draw list instead. That is a slightly surprising home for
 * something you drew with a tool called "road", so the status line says which
 * of the two it did.
 */
const ROAD_DRAW_UNROUTED = ['metro', 'railway', 'water'];

/** How close is too close to be two ends of the same road, in metres. */
const ROAD_DRAW_MIN_M = 30;

/**
 * Build the feature between two clicked points.
 *
 * @param {object} a L.LatLng @param {object} b L.LatLng
 * @returns {{kind:string, name:string}|null}
 */
function makeDrawnRoad(a, b) {
  const c = typeof connClass === 'function' ? connClass(roadDrawClass) : null;
  const name = (c ? c.label : 'Road');

  if (ROAD_DRAW_UNROUTED.indexOf(roadDrawClass) >= 0) {
    const line = L.polyline([[a.lat, a.lng], [b.lat, b.lng]]);
    const meta = { name, cls: roadDrawClass };
    if (c) {
      meta.borderColor = c.color;
      meta.borderWidth = c.weight;
      meta.lineStyle = c.dash ? 'dashed' : 'solid';
    }
    registerGeom(line, 'Line', meta);
    return { kind: 'line', name };
  }

  const from = addLocation({
    lat: +a.lat.toFixed(6), lng: +a.lng.toFixed(6),
    name: name + ' — start', hideMarker: true, routeAnchor: true, showLabel: false,
  });
  const to = addLocation({
    lat: +b.lat.toFixed(6), lng: +b.lng.toFixed(6),
    name: name + ' — end', hideMarker: true, routeAnchor: true, showLabel: false,
  });

  addRoute({ fromId: from.id, toId: to.id, cls: roadDrawClass, labelText: name });
  return { kind: 'route', name };
}

/**
 * Remove a drawn road and the two anchors that exist only to hold it.
 *
 * The mirror of deleteLocation's cascade: an anchor with no route is invisible,
 * un-listed and unreachable — a leak you could only find by reading the
 * project file.
 *
 * @param {object} rt
 */
function cleanupRoadAnchors(rt) {
  [rt.fromId, rt.toId].forEach(id => {
    const loc = locById(id);
    if (!loc || !loc.routeAnchor) return;
    // Only if nothing else is using it.
    const stillUsed = routes.some(r => r !== rt && (r.fromId === id || r.toId === id));
    if (stillUsed) return;
    if (loc._pinEl && typeof removeBB === 'function') removeBB(loc._pinEl);
    if (loc._labelEl && typeof removeBB === 'function') removeBB(loc._labelEl);
    (loc.ringLayers || []).forEach(l => map.removeLayer(l));
    if (loc.card) loc.card.remove();
    locations.splice(locations.indexOf(loc), 1);
  });
}

(function wireRoadDraw() {
  const btn = document.getElementById('roadDrawBtn');
  if (btn) btn.addEventListener('click', () => setRoadDrawActive(!roadDrawActive));

  const sel = document.getElementById('roadDrawClass');
  if (sel) {
    // Filled from the standard rather than hard-coded, so the list and the
    // colours can never disagree about what classes exist.
    if (typeof connLineClasses === 'function') {
      sel.innerHTML = connLineClasses()
        .map(([id, label]) => '<option value="' + id + '"'
          + (id === roadDrawClass ? ' selected' : '') + '>' + esc(label) + '</option>').join('');
    }
    sel.addEventListener('change', e => {
      roadDrawClass = e.target.value;
      if (roadDrawActive) setRoadDrawActive(true);    // restate the status line
    });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && roadDrawActive) {
      setRoadDrawActive(false);
      if (typeof status === 'function') status('Road drawing off.');
    }
  });

  // Ahead of click-to-add in toolbar.js only because that handler returns early
  // unless `uiState.addingMode` is on, and arming this tool turns that off.
  map.on('click', e => {
    if (!roadDrawActive) return;
    if (!roadDrawPendingA) {
      roadDrawPendingA = e.latlng;
      roadDrawPendingMarker = L.marker(e.latlng, { icon: roadDrawDot(), interactive: false }).addTo(map);
      if (typeof status === 'function') status('One end set — click the other.', true);
      return;
    }
    const A = roadDrawPendingA;
    // Two clicks in the same spot is a mis-click, not a road. Keep A pending
    // rather than making a zero-length feature the user then has to find and
    // delete.
    if (map.distance(A, e.latlng) < ROAD_DRAW_MIN_M) {
      if (typeof status === 'function') {
        status('Those two points are on top of each other — click the far end of the road.', true);
      }
      return;
    }
    roadDrawCancelPending();
    const made = makeDrawnRoad(A, e.latlng);
    if (typeof status === 'function' && made) {
      status(made.kind === 'route'
        ? made.name + ' added to Routes — nothing added to Locations. Click two more points for another, or Esc to stop.'
        : made.name + ' added to Draw as a line — rail and water are not driven, so they are not routed. Esc to stop.',
        true);
    }
    if (typeof pushHistory === 'function') pushHistory();
  });
})();
