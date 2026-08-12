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
  renderRingScan();

  const res = await fetchRingFeatures(s.loc.lat, s.loc.lng, s.km * 1000, s.ids);
  if (!ringScanState || ringScanState !== s) return;    // dialog closed mid-flight
  s.busy = false;
  if (!res.ok) { s.error = res.reason; s.skipped = res.skipped || []; }
  else {
    s.result = res.features || [];
    s.skipped = res.skipped || [];
    s.truncated = !!res.truncated;
    s.cached = !!res.cached;
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
 * Areas here span six orders of magnitude — a shed and a reserve forest — so
 * one unit cannot serve them. @param {number} km2
 */
function fmtScanArea(km2) {
  if (km2 >= 1) return km2.toFixed(1) + ' km²';
  if (km2 >= 0.01) return (km2 * 100).toFixed(1) + ' ha';
  return Math.round(km2 * 1e6).toLocaleString() + ' m²';
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
  const tip = it.parts > 1 ? ' title="' + it.parts + ' OpenStreetMap segments joined into one line"' : '';
  return '<label class="chk"' + tip + '><input type="checkbox" data-scan-i="' + it._i + '"'
    + (on ? ' checked' : '') + '> ' + esc(label)
    + (it.km > 0.05 ? ' <i>' + it.km.toFixed(1) + ' km</i>' : '')
    + (it.areaKm2 > 0.005 ? ' <i>' + fmtScanArea(it.areaKm2) + '</i>' : '')
    + (it.parts > 1 ? ' <u>' + it.parts + ' joined</u>' : '') + '</label>';
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
    html += '<div class="rs-scan-note">Searching OpenStreetMap inside the '
      + esc(String(s.km)) + ' km ring…</div>';
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
    if (s.cached) html += '<div class="rs-scan-note">From this browser\'s cache.</div>';
  }

  body.innerHTML = html;

  if (foot) {
    const n = s.picked ? s.picked.size : 0;
    foot.innerHTML =
      '<button class="btn btn-ghost" id="ringScanAgain">'
      + (s.error && ringFeatureRetryable(s.error) ? 'Try again' : 'Search again') + '</button>'
      + '<span class="grow"></span>'
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

  // Classes flagged `merge` become one shape instead of hundreds. Buildings
  // are the case this exists for: a square kilometre of a city is thousands of
  // footprints, and as separate shapes that is thousands of sidebar cards and
  // thousands of objects the undo system re-serialises twice a second. Leaflet
  // takes them all as one multipolygon, so the map looks identical and the app
  // stays usable.
  const mergePolys = new Map();

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

    const clsId = fc ? fc.cls : null;
    const name = f.name || (fc ? fc.label : 'Feature');
    let layer = null, shape = null;
    if (f.kind === 'point') { layer = L.circleMarker([f.lat, f.lng], { radius: 7 }); shape = 'CircleMarker'; }
    else if (f.kind === 'area' && f.polys) { layer = L.polygon(f.polys); shape = 'Polygon'; }
    else if (f.pts) { layer = L.polyline(f.pts); shape = 'Line'; }
    if (!layer) return;

    added.push(registerGeom(layer, shape, ringScanMeta(name, clsId, shape)));
    n++;
  });

  mergePolys.forEach((polys, classId) => {
    const fc = ringFeatureClass(classId);
    const label = (fc ? fc.label : 'Features') + ' (' + polys.length + ')';
    added.push(registerGeom(L.polygon(polys), 'Polygon',
      ringScanMeta(label, fc ? fc.cls : null, 'Polygon')));
  });

  // Ground cover goes underneath. Added last, an area covers the roads and
  // rail it was fetched to give context to — the exact opposite of why anyone
  // fetched it.
  added.forEach(g => {
    const c = typeof connClass === 'function' ? connClass(g.cls) : null;
    if (c && c.kind === 'area' && g.layer && g.layer.bringToBack) g.layer.bringToBack();
  });

  closeRingScan();
  if (typeof rebuildLegend === 'function') rebuildLegend();
  if (typeof pushHistory === 'function') pushHistory();
  status(n + ' feature' + (n === 1 ? '' : 's') + ' added to Draw — restyle, rename or delete'
    + ' any of them like anything else you drew.');
}

/**
 * The style a scanned feature starts with.
 * @param {string} name @param {string|null} clsId @param {string} shape
 * @returns {object}
 */
function ringScanMeta(name, clsId, shape) {
  const cc = typeof connClass === 'function' ? connClass(clsId) : null;
  const meta = { name, cls: clsId, fromRing: true };
  if (cc) {
    meta.borderColor = cc.color;
    meta.borderWidth = cc.weight;
    meta.lineStyle = cc.dash ? 'dashed' : 'solid';
    if (shape !== 'Line') {
      meta.fillColor = cc.color;
      meta.fillOpacity = cc.fill == null ? 0.18 : cc.fill;
    }
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
    if (e.target.closest('#ringScanAgain')) { runRingScan(); return; }
    if (e.target.closest('#ringScanKeep')) { keepRingScanSelection(); return; }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && ringScanState) closeRingScan();
  });
})();
