/**
 * ui/ringScanPanel.js — the ring's scan dialog: what was found, and what to keep.
 *
 * WHY A PICK-LIST AND NOT AUTOMATIC. A 5 km ring over a city holds hundreds of
 * ways. Dropping all of them on the map would bury the drawing they were meant
 * to support, and every one becomes a card in the Draw list and a shape the
 * undo system re-serialises twice a second. So the scan reports counts per
 * class, and you tick the ones you want. Nothing lands unasked.
 *
 * What you tick becomes an ordinary shape — restyleable, renameable, hideable,
 * deletable, saved with the project — because the alternative (a managed layer
 * that refetches on open) needs the network every time somebody opens the file,
 * and a colleague opening it on a blocked office connection would see an empty
 * map where you saw a metro line.
 */

/** Which classes the checklist starts with. Remembered per device. */
function ringScanClasses() {
  let saved = null;
  try { saved = getPref('ringScanClasses'); } catch (e) { /* ignore */ }
  if (Array.isArray(saved) && saved.length) return saved.slice();
  return RING_FEATURE_DEFAULTS.slice();
}

/** @param {string[]} ids */
function setRingScanClasses(ids) {
  try { setPref('ringScanClasses', ids); } catch (e) { /* ignore */ }
}

/** The scan currently on screen. */
let ringScanState = null;

/** @returns {HTMLElement|null} */
function ringScanOverlay() { return document.getElementById('ringScanOverlay'); }

/** Whether a scanned area also gets a pin at its middle. @type {boolean} */
let ringScanMarkAreas = true;

/**
 * Close the dialog. Leaves whatever was already kept on the map.
 *
 * `.on` drives the opacity transition and `hidden` takes it out of the layout;
 * both are needed. Clearing only `hidden` leaves a fully-built, fully-readable
 * dialog at `opacity: 0` — which is how this shipped for one test run, passing
 * every assertion because textContent works fine on an invisible element. A
 * screenshot is what caught it.
 */
function closeRingScan() {
  const o = ringScanOverlay();
  if (o) {
    o.classList.remove('on');
    const done = () => { o.hidden = true; o.removeEventListener('transitionend', done); };
    o.addEventListener('transitionend', done);
    setTimeout(done, 320);          // fallback when transitions are off
  }
  ringScanState = null;
}

/**
 * Open the dialog for one ring and start the scan.
 *
 * @param {object} loc @param {object} ring the `{km, color, op}` entry
 */
async function openRingScan(loc, ring) {
  const o = ringScanOverlay();
  if (!o) return;
  const km = parseFloat(ring && ring.km);
  if (!(km > 0)) { status('Give the ring a radius first.'); return; }

  ringScanState = { loc, km, ids: ringScanClasses(), result: null, picked: new Set() };
  o.hidden = false;
  // Next frame, so the opacity transition has a start state to animate from.
  requestAnimationFrame(() => o.classList.add('on'));
  renderRingScan();
  await runRingScan();
}

/** Fetch, then redraw. */
async function runRingScan() {
  if (!ringScanState) return;
  const s = ringScanState;
  s.busy = true; s.error = null; s.result = null;
  // A SEARCH THAT SAYS NOTHING FOR TWENTY SECONDS READS AS A BROKEN ONE.
  // Overpass is a donated service under real load and a wide ring genuinely
  // takes that long; the fault was never that it was quiet, it was that the
  // dialog gave a reader no way to tell waiting from hung. The clock ticks and
  // the note names what is being waited on.
  s.startedAt = Date.now();
  s.step = { mirror: 1, of: 1 };
  s.tick = setInterval(() => { if (ringScanState === s && s.busy) renderRingScan(); }, 1000);
  renderRingScan();

  const res = await fetchRingFeatures(s.loc.lat, s.loc.lng, s.km * 1000, s.ids, step => {
    if (ringScanState !== s) return;
    s.step = Object.assign({}, s.step, step);
    renderRingScan();
  });
  clearInterval(s.tick); s.tick = null;
  if (!ringScanState || ringScanState !== s) return;    // dialog closed mid-flight
  s.busy = false;
  if (!res.ok) { s.error = res.reason; s.skipped = res.skipped || []; }
  else {
    s.result = res.features || [];
    s.skipped = res.skipped || [];
    s.truncated = !!res.truncated;
    s.cached = !!res.cached;
    s.google = res.google || null;
    // Everything found starts ticked: the common case is "yes, put the metro
    // line on the map". Unticking a class is one click; ticking six is six.
    s.picked = new Set(s.result.map((f, i) => i));
  }
  renderRingScan();
}

/** @param {object[]} features @returns {Map<string, object[]>} grouped by class */
function ringScanGroups(features) {
  const g = new Map();
  features.forEach((f, i) => {
    if (!g.has(f.classId)) g.set(f.classId, []);
    g.get(f.classId).push(Object.assign({ _i: i }, f));
  });
  return g;
}

/**
 * How big a scanned area is, in the unit the reader actually works in.
 *
 * SQUARE FEET, because this is a property tool. A parcel of built-up land is
 * bought, sold, rented and compared in sq ft everywhere this app is used, and
 * "2.4 ha" is a number the reader has to convert before it means anything. This
 * ignored the unitArea preference altogether and printed hectares regardless of
 * what anybody had set.
 *
 * Areas here still span six orders of magnitude — a shed and a reserve forest —
 * so past about ten acres the sq ft figure stops being readable and km² leads,
 * with the sq ft kept alongside rather than dropped.
 *
 * @param {number} km2 @returns {string}
 */
function fmtScanArea(km2) {
  const m2 = km2 * 1e6;
  // An explicit preference is an instruction; only 'auto' is ours to decide.
  const u = typeof getPref === 'function' ? getPref('unitArea') : 'auto';
  if (u && u !== 'auto' && typeof fmtAreaPref === 'function') return fmtAreaPref(m2);
  const sqft = m2 * 10.7639;
  if (km2 >= 0.04) {
    return km2.toFixed(km2 >= 1 ? 1 : 2) + ' km² ('
      + (sqft / 1e6).toFixed(1) + 'M sq ft)';
  }
  return Math.round(sqft).toLocaleString() + ' sq ft';
}

/**
 * One row in the found list.
 *
 * `parts` is how many OSM ways were chained into this line. Shown as a tooltip
 * rather than on the row: it explains why a road that OSM stores in nine pieces
 * appears once, but it is not what anybody is reading the list for.
 *
 * @param {object} it @param {boolean} on @returns {string}
 */
function ringScanItemRow(it, on) {
  let label = it.name || (it.kind === 'point' ? 'Unnamed' : 'Unnamed section');
  if (it.ref && it.name && it.ref !== it.name) label += ' (' + it.ref + ')';
  if (it.ofParts > 1) label += ' — ' + it.part + ' of ' + it.ofParts;
  // Said on the row, not just in the tooltip: somebody looking at the imagery
  // can count two carriageways and needs to know the one line is both of them,
  // not half the road.
  if (it.carriageways > 1) label += ' — ' + it.carriageways + ' carriageways as one';
  const tip = it.parts > 1 ? ' title="' + it.parts + ' OpenStreetMap segments joined into one line"' : '';
  // WHERE THE ANSWER CAME FROM, on the row. Two sources disagree sometimes, and
  // a reader who cannot see which one produced a name has no way to judge it.
  // OSM alone is the ordinary case and says nothing; the other two are worth a
  // word each.
  // NOT BUILT YET, on the row as well as on the map. Somebody reading the list
  // is choosing what to put in front of a client, and "Mumbai-Ahmedabad
  // High-Speed Rail Corridor" reads as a railway unless the list says when.
  const soon = it.proposed
    ? ' <u title="Mapped as proposed or under construction — not built yet">not built yet</u>'
    : '';
  const src = it.source === 'google' ? ' <u title="Google knows this place; '
      + 'OpenStreetMap has not mapped it">Google</u>'
    : it.source === 'osm+google' ? ' <u title="OpenStreetMap geometry, Google\'s name'
      + (it.googleName ? ': ' + esc(it.googleName) : '') + '">OSM + Google</u>'
    : '';
  return '<label class="chk"' + tip + '><input type="checkbox" data-scan-i="' + it._i + '"'
    + (on ? ' checked' : '') + '> ' + esc(label)
    + (it.km > 0.05 ? ' <i>' + it.km.toFixed(1) + ' km</i>' : '')
    + (it.areaKm2 > 0.005 ? ' <i>' + fmtScanArea(it.areaKm2) + '</i>' : '')
    + (it.parts > 1 ? ' <u>' + it.parts + ' joined</u>' : '') + soon + src + '</label>';
}

/** Draw the dialog from `ringScanState`. */
function renderRingScan() {
  const body = document.getElementById('ringScanBody');
  const foot = document.getElementById('ringScanFoot');
  if (!body || !ringScanState) return;
  const s = ringScanState;

  /* ---- the class checklist, always shown ---- */
  let html = '<div class="rs-scan-classes">'
    + RING_FEATURE_CLASSES.map(c => {
      const on = s.ids.indexOf(c.id) >= 0;
      const tooWide = s.km > c.max;
      return '<label class="chk' + (tooWide ? ' rs-wide' : '') + '"'
        + (tooWide ? ' title="Not searched — a ' + s.km + ' km ring is wider than the '
          + c.max + ' km limit for this type"' : '') + '>'
        + '<input type="checkbox" data-scan-cls="' + c.id + '"' + (on ? ' checked' : '')
        + (tooWide ? ' disabled' : '') + '> ' + esc(c.label) + '</label>';
    }).join('') + '</div>';

  if (s.busy) {
    const secs = s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0;
    const st = s.step || {};
    const where = st.stage === 'google' ? 'Asking Google about the places found'
      : (st.mirror > 1
        ? 'The first OpenStreetMap server did not answer — trying number '
          + st.mirror + ' of ' + st.of
        : 'Searching OpenStreetMap inside the ' + esc(String(s.km)) + ' km ring');
    // The count is worth saying: a scan is one request covering every ticked
    // type, so ten types is a heavier question than three, and the reader is
    // the only one who can make it lighter.
    html += '<div class="rs-scan-note">' + where + ' — ' + s.ids.length
      + ' type' + (s.ids.length === 1 ? '' : 's') + ', ' + secs + 's'
      + (secs >= 20 ? '. A wide ring over a city takes this long; untick types'
        + ' you do not need to make it lighter.' : '…') + '</div>';
  } else if (s.error) {
    html += '<div class="rs-scan-err">' + esc(ringFeatureMessage(s.error, { skipped: s.skipped })) + '</div>';
  } else if (s.result) {
    const groups = ringScanGroups(s.result);
    if (!groups.size) {
      html += '<div class="rs-scan-note">Nothing of those types is mapped inside this ring.'
        + ' That is a real answer — OpenStreetMap\'s coverage of smaller stations and'
        + ' waterways is patchy in places.</div>';
    } else {
      html += [...groups.entries()].map(([cid, items]) => {
        const fc = ringFeatureClass(cid);
        const cc = typeof connClass === 'function' ? connClass(fc ? fc.cls : null) : null;
        const allOn = items.every(it => s.picked.has(it._i));
        return '<div class="rs-scan-group">'
          + '<div class="rs-scan-hd">'
          + '<label class="chk"><input type="checkbox" data-scan-group="' + cid + '"'
            + (allOn ? ' checked' : '') + '> <b>' + esc(fc ? fc.label : cid) + '</b></label>'
          + '<span class="rs-scan-sw" style="background:' + esc(cc ? cc.color : '#888') + '"></span>'
          + '<span class="rs-scan-count">' + items.length + '</span></div>'
          // Every one of them, always. A truncated list with "…and 106 more"
          // is the one thing a scan must not do: the whole point is knowing
          // what is there, and a hidden remainder that the group tick silently
          // includes means ticking a group adds things you were never shown.
          + '<div class="rs-scan-items">'
          + items.map(it => ringScanItemRow(it, s.picked.has(it._i))).join('')
          + '</div></div>';
      }).join('');
    }

    if (s.skipped && s.skipped.length) {
      html += '<div class="rs-scan-note">Not searched: '
        + s.skipped.map(k => esc(k.label) + ' (over ' + k.max + ' km)').join(', ')
        + '. A ring this wide returns thousands of those.</div>';
    }
    if (s.truncated) {
      html += '<div class="rs-scan-note">Overpass returned its maximum. There is more inside this'
        + ' ring than is shown — narrow the ring for a complete answer.</div>';
    }
    // Said out loud, because it is the difference between "the scan found
    // eleven stations" and "the scan found eleven stations, four of which OSM
    // had no name for and one of which it has not mapped at all".
    if (s.google && (s.google.added || s.google.named)) {
      const bits = [];
      if (s.google.named) bits.push('named ' + s.google.named + ' that OpenStreetMap left blank');
      if (s.google.added) bits.push('found ' + s.google.added + ' more it has not mapped');
      html += '<div class="rs-scan-note">Google ' + bits.join(' and ') + '.</div>';
    }
    if (s.cached) html += '<div class="rs-scan-note">From this browser\'s cache.</div>';
  }

  body.innerHTML = html;

  if (foot) {
    const n = s.picked ? s.picked.size : 0;
    foot.innerHTML =
      '<button class="btn btn-ghost" id="ringScanAgain">'
      + (s.error && ringFeatureRetryable(s.error) ? 'Try again' : 'Search again') + '</button>'
      + '<span class="grow"></span>'
      // A parcel of land arrives as a polygon and nothing else — no pin, no
      // entry in Locations — so on a map already carrying roads, rail and
      // rings it is genuinely hard to find, and there is nothing to route to.
      // On by default because that is the complaint; a switch because a scan
      // that returns twelve residential parcels would otherwise plant twelve
      // pins somebody has to delete.
      + '<label class="chk" id="ringScanMarkWrap" title="Drop a pin at the middle of each '
      + 'area, so it can be found and routed to"><input type="checkbox" id="ringScanMark"'
      + (ringScanMarkAreas ? ' checked' : '') + '> Pin each area</label>'
      + '<button class="btn btn-primary" id="ringScanKeep"' + (n ? '' : ' disabled') + '>'
      + (n ? 'Add ' + n + ' to the map' : 'Nothing selected') + '</button>';
  }
}

/**
 * Turn the ticked features into real shapes.
 *
 * Registered through the same `registerGeom` every drawn shape uses, with the
 * connectivity class attached — so they take the standard colours, appear in
 * the road-type legend, and can be edited or deleted like anything else.
 */
function keepRingScanSelection() {
  if (!ringScanState || !ringScanState.result) return;
  const s = ringScanState;
  let n = 0;
  const added = [];
  // Counted apart, because they land in two different places and the message
  // has to say which — "added to Draw" was already a lie for half of them.
  let placed = 0;

  // Classes flagged `merge` become one shape instead of hundreds. Buildings
  // are the case this exists for: a square kilometre of a city is thousands of
  // footprints, and as separate shapes that is thousands of sidebar cards and
  // thousands of objects the undo system re-serialises twice a second. Leaflet
  // takes them all as one multipolygon, so the map looks identical and the app
  // stays usable.
  const mergePolys = new Map();

  // Unnamed finds of one class, counted so each gets its own name. OSM does not
  // name most residential and industrial land, so all of them arrived as
  // "Built-up / residential land" — five identical pins on five different
  // parcels, which is five ways to lose track of which is which. Numbered only
  // when there IS more than one, so a lone unnamed parcel is not "… 1".
  const unnamed = new Map();
  s.result.forEach((f, i) => {
    if (!s.picked.has(i) || f.name) return;
    const fc = ringFeatureClass(f.classId);
    if (fc && fc.merge) return;             // merged classes number their own
    unnamed.set(f.classId, (unnamed.get(f.classId) || 0) + 1);
  });
  const unnamedSeen = new Map();
  // Closure over both maps: `unnamed` is how many there are, `unnamedSeen` is
  // how many have been handed out so far.
  const ringScanNameOf = (f, fc, total) => {
    if (f.name) return f.name;
    const base = fc ? fc.label : 'Feature';
    if ((total.get(f.classId) || 0) < 2) return base;
    const n = (unnamedSeen.get(f.classId) || 0) + 1;
    unnamedSeen.set(f.classId, n);
    return base + ' ' + n;
  };

  s.result.forEach((f, i) => {
    if (!s.picked.has(i)) return;
    const fc = ringFeatureClass(f.classId);
    if (fc && fc.merge && f.kind === 'area' && f.polys) {
      if (!mergePolys.has(f.classId)) mergePolys.set(f.classId, []);
      const bag = mergePolys.get(f.classId);
      f.polys.forEach(p => bag.push(p));
      n++;
      return;
    }

    // The feature's OWN class where it has one. A scan class that covers
    // several real ones — planned roads, tunnels — derives it per way from
    // what the way says it is going to be, so a planned residential street is
    // not drawn as six pixels of expressway blue.
    const clsId = f.cls || (fc ? fc.cls : null);
    const name = ringScanNameOf(f, fc, unnamed);
    const iconKey = fc ? fc.icon : null;
    const markerStyle = (fc && fc.marker) || 'pin';

    // A PLACE GOES INTO LOCATIONS, NOT INTO DRAW. A station is the same kind of
    // thing as a location typed in by hand — it wants a name you can correct, a
    // colour, a ring, and above all it is what a route gets measured TO. Landing
    // it in Draw made it a shape that looked like a location and could do none
    // of those things, so the only way to route to a station the scan had just
    // found was to type it in again by hand.
    if (fc && fc.place) {
      const at = ringScanPointOf(f);
      if (at) {
        added.push(addLocation({
          name: name,
          lat: at.lat, lng: at.lng,
          color: (typeof connClass === 'function' && connClass(clsId) || {}).color || undefined,
          iconKey: iconKey || 'dot',
          // Its own frame, so a scanned station reads like the pins around it.
          iconFrame: 'pin',
          fromRing: true,
        }));
        n++; placed++;
        return;
      }
    }
    const wantLabel = !(fc && fc.label_off);
    let layer = null, shape = null;
    // A pin, not a circle. What comes back as a `point` from a scan is a
    // *place* — a metro station, an airport, a substation — and a 7px circle
    // says "this coordinate" where a pin says "this thing is here". On OSM's
    // own cartography a small circle also reads as part of the basemap rather
    // than as something the map's author put there, which is the opposite of
    // what a scanned result is for. Named on the map too: a station nobody can
    // read the name of has not really been marked.
    if (f.kind === 'point') { layer = L.marker([f.lat, f.lng]); shape = 'Marker'; }
    else if (f.kind === 'area' && f.polys) { layer = L.polygon(f.polys); shape = 'Polygon'; }
    else if (f.pts) { layer = L.polyline(f.pts); shape = 'Line'; }
    if (!layer) return;

    added.push(registerGeom(layer, shape,
      ringScanMeta(name, clsId, shape, iconKey, markerStyle, wantLabel,
        f.overRoad, f.shiftRank, f.shiftSide, !f.name, f.proposed)));
    n++;
    if (f.kind === 'area') { placed += ringScanPinArea(f, name, clsId, iconKey); }
  });

  mergePolys.forEach((polys, classId) => {
    const fc = ringFeatureClass(classId);
    const label = (fc ? fc.label : 'Features') + ' (' + polys.length + ')';
    added.push(registerGeom(L.polygon(polys), 'Polygon',
      ringScanMeta(label, fc ? fc.cls : null, 'Polygon')));
    // One pin per PARCEL, not one for the merged blob: a class merged into a
    // single shape is still a dozen separate places on the ground, and a pin at
    // the mean of all of them lands in a field between them.
    polys.forEach((ring, i) => {
      placed += ringScanPinArea({ kind: 'area', polys: [ring] },
        label.replace(/\s*\(\d+\)$/, '') + ' ' + (i + 1),
        fc ? fc.cls : null, fc ? fc.icon : null);
    });
  });

  // Put the whole map back in class order, not just what was added.
  //
  // This was a bringToBack over the new areas, which handled the case it was
  // written for — ground cover fetched last covering the roads it was fetched
  // to give context to — and no other. It could not put a metro added now
  // above a road added an hour ago, because it only ever looked at `added`,
  // and that is the case where the two lines sit on top of each other and one
  // of them disappears. See CONNECTIVITY_STACK for the order and why.
  if (typeof restackClassedShapes === 'function') restackClassedShapes();

  closeRingScan();
  if (typeof rebuildLegend === 'function') rebuildLegend();
  if (typeof pushHistory === 'function') pushHistory();
  const drawn = n - placed;
  const bits = [];
  if (placed) {
    bits.push(placed + ' place' + (placed === 1 ? '' : 's')
      + ' added to Locations — rename, restyle or route to ' + (placed === 1 ? 'it' : 'them')
      + ' like any other location');
  }
  if (drawn) {
    bits.push(drawn + ' feature' + (drawn === 1 ? '' : 's')
      + ' added to Draw — restyle, rename or delete '
      + (drawn === 1 ? 'it' : 'them') + ' like anything else you drew');
  }
  status(bits.length ? bits.join('. ') + '.' : 'Nothing was added.');
}

/**
 * Drop a pin at the middle of a scanned area, so it can be found and routed to.
 *
 * A LOCATION, NOT A DECORATION — the same treatment a scanned station already
 * gets. A parcel marked only by its outline cannot be routed to, renamed or
 * given a ring, so the only way to measure to the industrial estate the scan
 * had just found was to type it in again by hand.
 *
 * @param {object} f the area @param {string} name @param {?string} clsId
 * @param {?string} iconKey @returns {number} 1 if a pin was placed
 */
function ringScanPinArea(f, name, clsId, iconKey) {
  if (!ringScanMarkAreas || typeof addLocation !== 'function') return 0;
  const at = ringScanPointOf(f);
  if (!at) return 0;
  addLocation({
    name: name,
    lat: at.lat, lng: at.lng,
    color: (typeof connClass === 'function' && connClass(clsId) || {}).color || undefined,
    iconKey: iconKey || 'dot',
    iconFrame: 'pin',
    fromRing: true,
  });
  return 1;
}

/**
 * Where to put a single mark for a feature, whatever shape it arrived as.
 *
 * A node has its own coordinate. An aerodrome arrives as a perimeter several
 * kilometres across, and the answer it is on the map to give is "the airport is
 * over there, this far away" — so it is marked at the middle of that perimeter
 * rather than drawn as a grey field covering everything under it.
 *
 * The mean of the ring's vertices, not a true centroid: OSM perimeters are
 * dense and fairly convex, the two agree to within a few metres at this scale,
 * and a shoelace centroid inverts on a self-touching ring, which aerodrome
 * relations sometimes are.
 *
 * @param {object} f a scan result @returns {?{lat:number,lng:number}}
 */
function ringScanPointOf(f) {
  if (f.kind === 'point' && isFinite(f.lat) && isFinite(f.lng)) {
    return { lat: f.lat, lng: f.lng };
  }
  // INSIDE the ring, not the mean of its corners. The mean of an L-shaped
  // residential zone is in the notch — on somebody else's land — and of a
  // C-shaped one is in the gap, which around here is usually the creek the
  // zone wraps around. A pin beside the area it marks is worse than no pin:
  // it says a place is somewhere it is not.
  //
  // Shared with the scan's own Google merge (services/ringFeatures.js), so a
  // find and the pin dropped on it can never disagree about where it is.
  if (typeof ringFeaturePoint === 'function') {
    const at = ringFeaturePoint(f);
    if (at) return at;
  }
  const ring = (f.polys && f.polys[0]) || f.pts;
  if (!ring || !ring.length) return null;
  let la = 0, ln = 0, k = 0;
  ring.forEach(pt => {
    const a = Array.isArray(pt) ? pt[0] : pt.lat;
    const b = Array.isArray(pt) ? pt[1] : pt.lng;
    if (isFinite(a) && isFinite(b)) { la += a; ln += b; k++; }
  });
  return k ? { lat: la / k, lng: ln / k } : null;
}

/**
 * The style a scanned feature starts with.
 * @param {string} name @param {string|null} clsId @param {string} shape
 * @param {string|null} [iconKey] Symbol for the pin's head, from the scan class.
 * @param {string} [markerStyle] 'pin' or 'square'.
 * @param {boolean} [wantLabel] Whether to caption it on the map.
 * @returns {object}
 */
function ringScanMeta(name, clsId, shape, iconKey, markerStyle, wantLabel, overRoad, shiftRank, shiftSide, isClassLabel, proposed) {
  const cc = typeof connClass === 'function' ? connClass(clsId) : null;
  const meta = { name, cls: clsId, fromRing: true };
  // A metro mapped along the road it flies over, drawn beside it so both can
  // be seen. Carried on the shape rather than re-measured on every restyle:
  // the two alignments do not change, and the scan that compared them is the
  // only place that had both lines in hand.
  //
  // The side comes from the scan, which had both alignments in hand: the shift
  // pushes AWAY from the road, so the real offset and the drawn one add rather
  // than cancelling at whatever zoom makes them equal and opposite.
  //
  // A second line over the same road steps further out on the SAME side rather
  // than crossing to the other one, which would put it back in the cancelling
  // case it was moved to escape.
  if (overRoad) {
    meta.overRoad = true;
    const step = (typeof GEOM_SHIFT_STEP === 'number' ? GEOM_SHIFT_STEP : 7);
    meta.shiftPx = (shiftSide < 0 ? -1 : 1) * Math.max(1, shiftRank || 1) * step;
  }
  // A SCANNED ROAD CARRIES ITS NAME, the same as one you draw. The scan knows
  // the road is "Mumbai-Ahmedabad High-Speed Rail Corridor" and was drawing it
  // as an unlabelled line, so the one useful thing it had found — what the
  // thing is called — stayed in the sidebar where the reader of the map never
  // sees it.
  //
  // Only when the scan found a REAL name. An unnamed line falls back to its
  // class label, and "Major roads" written along forty roads is not a set of
  // labels, it is a wall. Same rule a route follows.
  if (shape === 'Line') meta.showLabel = wantLabel !== false && !!(name && !isClassLabel);
  // NOT THERE YET, and the map has to say so. A proposed motorway drawn like a
  // built one is not a cosmetic slip on a sheet somebody is deciding from — it
  // is the sheet asserting a road exists. The standard already draws a
  // proposed line dashed in its class's colour and gives it its own
  // "(proposed)" row in the legend.
  if (proposed) meta.proposed = true;
  if (cc) {
    meta.borderColor = cc.color;
    meta.borderWidth = cc.weight;
    meta.lineStyle = (cc.dash || proposed) ? 'dashed' : 'solid';
    if (shape !== 'Line') {
      meta.fillColor = cc.color;
      meta.fillOpacity = cc.fill == null ? 0.18 : cc.fill;
    }
  }
  if (shape === 'Marker') {
    const style = markerStyle || 'pin';
    meta.markerStyle = style;
    meta.showLabel = wantLabel !== false && style !== 'square';
    // What was found, drawn inside the pin. Without it every scanned place is
    // the same teardrop and the legend is the only way to tell a station from
    // a substation. A square is too small to carry one.
    if (iconKey && style === 'pin') meta.iconKey = iconKey;
    // The teardrop is a solid body with a white keyline, like a location's pin.
    // The class colour is the body; a 0.18 fill opacity inherited from the area
    // styling above would render it as a ghost.
    meta.fillColor = cc ? cc.color : '#FF7A1A';
    meta.fillOpacity = 1;
    meta.borderColor = '#FFFFFF';
    meta.borderWidth = style === 'square' ? 1 : 2;
  }
  return meta;
}

(function wireRingScan() {
  const o = ringScanOverlay();
  if (!o) return;

  o.addEventListener('click', e => {
    if (e.target === o || e.target.closest('#ringScanClose')) { closeRingScan(); return; }
    if (!ringScanState) return;
    const s = ringScanState;

    const cls = e.target.closest('[data-scan-cls]');
    if (cls) {
      const id = cls.dataset.scanCls;
      s.ids = cls.checked ? s.ids.concat([id]) : s.ids.filter(x => x !== id);
      setRingScanClasses(s.ids);
      return;
    }
    const grp = e.target.closest('[data-scan-group]');
    if (grp) {
      const items = ringScanGroups(s.result || []).get(grp.dataset.scanGroup) || [];
      items.forEach(it => { if (grp.checked) s.picked.add(it._i); else s.picked.delete(it._i); });
      renderRingScan();
      return;
    }
    const one = e.target.closest('[data-scan-i]');
    if (one) {
      const i = +one.dataset.scanI;
      if (one.checked) s.picked.add(i); else s.picked.delete(i);
      renderRingScan();
      return;
    }
    // Read straight off the box: the footer is rebuilt on every tick of the
    // list, so a value kept only in the DOM would reset itself.
    if (e.target.id === 'ringScanMark') { ringScanMarkAreas = !!e.target.checked; return; }
    if (e.target.closest('#ringScanAgain')) { runRingScan(); return; }
    if (e.target.closest('#ringScanKeep')) { keepRingScanSelection(); return; }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && ringScanState) closeRingScan();
  });
})();
