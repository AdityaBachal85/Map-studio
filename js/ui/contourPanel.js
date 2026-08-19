/**
 * ui/contourPanel.js — the contour map's controls, and its elevation legend.
 *
 * Lives in the Draw tab rather than in a tab of its own: sidebar.js already
 * records that a sixth tab truncates every label in the bar, which is why AI
 * Reports became a map panel instead. Contouring is also genuinely a drawing
 * job — you choose an area on the map and something is drawn inside it — so it
 * sits beside the shape tools rather than beside the basemap settings.
 *
 * Markup is static in index.html and only reflected here, which is the
 * convention every other panel in this app follows. The two exceptions build
 * their own markup because they have to: the interval list changes with the
 * unit, and the colour ramp cannot be shown in a <select> — you have to see the
 * colours to choose between them.
 */

const CONTOUR_BOLD_OPTS = [
  ['1', 'All lines'], ['2', 'Every 2nd'], ['5', 'Every 5th'],
  ['10', 'Every 10th'], ['0', 'None'],
];
const CONTOUR_LABEL_OPTS = [['off', 'Off'], ['bold', 'Bold contours'], ['all', 'All contours']];
const CONTOUR_SMOOTH_OPTS = [['none', 'None'], ['light', 'Light'], ['medium', 'Medium'], ['heavy', 'Heavy']];
const CONTOUR_DETAIL_OPTS = [['standard', 'Standard'], ['high', 'High'], ['ultra', 'Ultra']];
const CONTOUR_ROAD_OPTS = [['off', 'Off'], ['roads', 'Roads & water'], ['full', 'Roads, water & buildings']];
const CONTOUR_UNIT_OPTS = [['m', 'm'], ['ft', 'ft']];
const CONTOUR_SHAPE_OPTS = [['Rectangle', 'Rectangle'], ['Polygon', 'Polygon'], ['Circle', 'Circle']];

/* ---------------------------------------------------------------------------
 * Reflecting state into the controls
 * ------------------------------------------------------------------------- */

/** Repaint every control from contourState. Safe to call at any time. */
function renderContourPanel() {
  if (!$('contourMapList')) return;
  renderContourMapList();

  const set = (id, v) => { const el = $(id); if (el && el.value !== String(v)) el.value = String(v); };
  const opts = (id, list, v) => {
    const el = $(id);
    if (el) el.innerHTML = optionList(list, String(v));
  };

  // Rebuilt rather than reflected: switching to feet has to replace 5/10/20 m
  // with 10/20/50 ft, and a stale option list would leave the select showing a
  // number that is not on it.
  const iv = contourIntervalChoices();
  if (iv.indexOf(contourState.interval) < 0) contourState.interval = iv[Math.min(2, iv.length - 1)];
  opts('contourInterval', iv.map(v => [String(v), v + ' ' + contourState.unit]), contourState.interval);

  opts('contourUnit', CONTOUR_UNIT_OPTS, contourState.unit);
  opts('contourBold', CONTOUR_BOLD_OPTS, contourState.boldEvery);
  opts('contourLabels', CONTOUR_LABEL_OPTS, contourState.labels);
  opts('contourSmoothing', CONTOUR_SMOOTH_OPTS, contourState.smoothing);
  opts('contourDetail', CONTOUR_DETAIL_OPTS, contourState.detail);
  opts('contourRoads', CONTOUR_ROAD_OPTS, contourState.roads);
  opts('contourShape', CONTOUR_SHAPE_OPTS, contourState.areaShape);

  set('contourOpacity', Math.round(contourState.fillOpacity * 100));
  const ov = $('contourOpacityVal');
  if (ov) ov.textContent = Math.round(contourState.fillOpacity * 100) + '%';

  const shade = $('contourShade'); if (shade) shade.checked = contourState.shade;
  const outline = $('contourOutline'); if (outline) outline.checked = contourState.showOutline;

  const ramp = contourRamp(contourState.ramp);
  const bar = $('contourRampBar');
  if (bar) {
    bar.style.background = rampGradientCss(ramp, 'to right');
    bar.setAttribute('aria-label', 'Colours: ' + ramp.label);
    bar.title = ramp.label + (ramp.note ? ' — ' + ramp.note : '');
  }

  set('contourExag', Math.round(contourState.exaggeration * 10));
  const ev = $('contourExagVal');
  if (ev) ev.textContent = contourState.exaggeration.toFixed(1) + '×';

  renderContourAreaInfo();
  renderContourStats();

  const gen = $('contourGenBtn');
  if (gen) {
    gen.disabled = !contourState.area || contourBusy;
    gen.textContent = contourBusy ? 'Working…'
      : (contourModel.ready ? 'Update contour map' : 'Generate contour map');
  }
  const shapes = $('contourShapesBtn');
  if (shapes) shapes.disabled = !contourModel.ready || !contourModel.lines.length;
}

/**
 * The list of contour maps: which one you are editing, what each covers, and
 * the two things you do to one without opening it — hide it, or delete it.
 *
 * Rendered rather than static markup because the list is data. Each row is a
 * whole button so the target is the row and not the eight pixels of its label;
 * the eye and the cross are separate buttons inside it, which is why the row is
 * a div with a button in it rather than nested buttons — those do not nest.
 */
function renderContourMapList() {
  const host = $('contourMapList');
  if (!host || typeof contourMaps === 'undefined') return;

  const eye = on => on
    ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"'
      + ' stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/>'
      + '<circle cx="12" cy="12" r="2.6"/></svg>'
    : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"'
      + ' stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l16 16"/>'
      + '<path d="M9.6 5.7A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.3 4"/>'
      + '<path d="M6.3 7.9A17 17 0 0 0 2 12s3.6 6.5 10 6.5a10 10 0 0 0 3.5-.6"/></svg>';

  host.innerHTML = contourMaps.map(m => {
    const area = m.settings.area && typeof polygonAreaM2 === 'function'
      ? (typeof fmtArea === 'function' ? fmtArea(polygonAreaM2(m.settings.area)) : '')
      : 'no area yet';
    const state = m.model.ready ? area : (m.settings.area ? area + ' · not built' : area);
    const shown = m.settings.visible !== false;
    return `<div class="cm-row${m.id === activeContourId ? ' on' : ''}${shown ? '' : ' off'}" data-id="${esc(m.id)}">
      <button type="button" class="cm-pick" title="Edit this contour map">
        <span class="cm-name">${esc(m.name)}</span><em>${esc(state)}</em></button>
      <button type="button" class="cm-eye" title="${shown ? 'Hide' : 'Show'} this contour map"
        aria-pressed="${shown}">${eye(shown)}</button>
      <button type="button" class="cm-del" title="Delete this contour map">&times;</button>
    </div>`;
  }).join('');

  host.querySelectorAll('.cm-row').forEach(row => {
    const id = row.getAttribute('data-id');
    row.querySelector('.cm-pick').addEventListener('click', () => selectContourMap(id));
    row.querySelector('.cm-eye').addEventListener('click', () => {
      const rec = contourMapById(id);
      if (rec) setContourVisible(id, rec.settings.visible === false);
    });
    row.querySelector('.cm-del').addEventListener('click', () => removeContourMapWithUndo(id));
  });
}

/** Delete one contour map, offering the reversal rather than asking first. */
function removeContourMapWithUndo(id) {
  const rec = contourMapById(id);
  if (!rec) return;
  const name = rec.name;
  const undo = deleteContourMap(id);
  if (!undo) return;
  const n = (undo.geoms || []).length;
  status(`"${name}" removed.` + (n ? ` ${n} converted shape${n === 1 ? '' : 's'} too.` : ''), false, {
    label: 'Undo',
    onClick: () => { restoreContourMap(undo); renderContourPanel(); },
  });
}

/** The "Area Size: 14.66 km²" line, and what is missing when there isn't one. */
function renderContourAreaInfo() {
  const el = $('contourAreaInfo');
  if (!el) return;
  if (!contourState.area) {
    el.textContent = 'No area chosen yet.';
    el.classList.add('sub');
    return;
  }
  const m2 = contourAreaM2();
  const txt = (typeof fmtArea === 'function') ? fmtArea(m2) : (m2 / 1e6).toFixed(2) + ' km²';
  el.textContent = contourState.areaShape + ' · ' + txt;
}

/** Below this much total relief, a hypsometric ramp flatters the ground. */
const CONTOUR_FLAT_RELIEF_M = 25;

/**
 * What was actually built, including the two things that make a correct
 * elevation model look wrong.
 *
 * THE COLOUR SCALE IS RELATIVE. The ramp stretches from the lowest point in the
 * selection to the highest, whatever those are — which is what makes one ramp
 * usable over a river plain and a hill range. The cost is that an area with
 * fifteen metres in it gets the same red summit and blue depths as one with
 * five hundred, and reads as mountains. The numbers on the legend are right;
 * the picture is what misleads. So the relief is stated outright, and an area
 * flat enough for this to matter is called flat in as many words.
 *
 * IT IS A SURFACE MODEL. SRTM is radar: it measures what the beam bounced off,
 * which over a town is rooftops and over forest is canopy — not the ground
 * under either. A house in a built-up block therefore sits on a small plateau
 * made of the buildings around it. That is the single most common reason
 * somebody looks at their own address and says the elevation is wrong, and it
 * is not something the app can correct for, so it says so instead.
 */
function renderContourStats() {
  const el = $('contourStats');
  if (!el) return;
  const g = contourModel.grid;

  if (!g) {
    el.innerHTML = 'Elevation comes from open SRTM-derived data at roughly 30 m between '
      + 'real samples. It is a <b>surface</b> model — buildings and tree canopy are part of '
      + 'the terrain it describes, not stripped out of it — and it dates from 2000, so '
      + 'anything levelled, quarried or built since is not in it. Good for the shape of the '
      + 'ground; not a survey.';
    return;
  }

  const relief = g.max - g.min;
  const deep = contourState.detail !== 'standard' && g.zoom >= 15
    ? ' (the deepest the source has)' : '';
  const facts = contourHeightText(g.min) + ' to ' + contourHeightText(g.max)
    + ' · ' + contourHeightText(relief) + ' of relief'
    + ' · ' + contourModel.lines.length + ' contours · '
    + g.metresPerSample.toFixed(1) + ' m per sample' + deep
    + (g.partial ? ' · some tiles unavailable' : '');

  let note = '';
  if (relief < CONTOUR_FLAT_RELIEF_M) {
    note = '<b>This area is nearly flat.</b> The colours stretch to fit whatever range is '
      + 'in the selection, so ' + contourHeightText(relief) + ' of relief is painted with the '
      + 'same full ramp a mountain would get. Read the numbers, not the drama.';
  }
  // Always said, because it is the usual reason a familiar address looks wrong.
  const surface = 'Buildings and tree canopy are part of this model, so a house in a built-up '
    + 'block reads a few metres above the street it stands on.';

  el.innerHTML = esc(facts).replace(/·/g, '·')
    + (note ? '<br><br>' + note : '')
    + '<br><br>' + surface;
}

/* ---------------------------------------------------------------------------
 * The colour-ramp picker
 * ------------------------------------------------------------------------- */

let contourRampPop = null;

function closeContourRampPop() {
  if (contourRampPop && contourRampPop.parentNode) contourRampPop.parentNode.removeChild(contourRampPop);
  contourRampPop = null;
}

/**
 * A ramp cannot be chosen from a <select>: the names mean nothing until you see
 * the colours. So this is a small popover of gradient bars, positioned and
 * dismissed the same way ui/colorPresets.js does it.
 */
function openContourRampPop(anchor) {
  if (contourRampPop) { closeContourRampPop(); return; }

  const pop = document.createElement('div');
  pop.className = 'contour-ramp-pop frost';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Elevation colours');
  pop.innerHTML = CONTOUR_RAMPS.map(r =>
    `<button type="button" class="cr-opt${r.id === contourState.ramp ? ' sel' : ''}" data-ramp="${esc(r.id)}"
       aria-pressed="${r.id === contourState.ramp}">
       <span class="cr-bar" style="background:${rampGradientCss(r, 'to right')}"></span>
       <span class="cr-name">${esc(r.label)}${r.note ? '<em>' + esc(r.note) + '</em>' : ''}</span>
     </button>`).join('');

  document.body.appendChild(pop);
  contourRampPop = pop;

  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  pop.style.top = top + 'px';

  pop.querySelectorAll('.cr-opt').forEach(b => {
    b.addEventListener('click', () => {
      contourState.ramp = b.getAttribute('data-ramp');
      closeContourRampPop();
      renderContourPanel();
      // Only the fill: the lines do not know what colour the ground is.
      contourInvalidate('fill');
    });
  });

  const onDown = e => {
    if (!pop.contains(e.target) && e.target !== anchor) { closeContourRampPop(); cleanup(); }
  };
  const onKey = e => { if (e.key === 'Escape') { closeContourRampPop(); cleanup(); } };
  const cleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

/* ---------------------------------------------------------------------------
 * Clearing
 * ------------------------------------------------------------------------- */

let contourClearPop = null;

function closeContourClearMenu() {
  if (contourClearPop && contourClearPop.parentNode) contourClearPop.parentNode.removeChild(contourClearPop);
  contourClearPop = null;
  const btn = $('contourClearBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/**
 * Ask which contour map to clear.
 *
 * A single Clear button was fine when there was one contour map and wrong the
 * moment there could be several: it silently meant "all of them", which is the
 * one reading nobody wants when they have just spent a minute building two.
 * So it names them, and "All" is the last item rather than the default.
 */
function openContourClearMenu(anchor) {
  if (contourClearPop) { closeContourClearMenu(); return; }
  if (typeof contourMaps === 'undefined' || !contourMaps.length) return;

  const pop = document.createElement('div');
  pop.className = 'contour-clear-pop frost';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', 'Clear a contour map');

  const rows = contourMaps.map(m => {
    const shapes = (typeof contourDerivedGeoms === 'function') ? contourDerivedGeoms(m.id).length : 0;
    return `<button type="button" role="menuitem" class="cc-item" data-id="${esc(m.id)}">
      <span>${esc(m.name)}</span><em>${m.model.ready ? 'built' : 'not built'}${shapes ? ' · ' + shapes + ' shapes' : ''}</em>
    </button>`;
  }).join('');
  pop.innerHTML = rows
    + (contourMaps.length > 1
      ? `<button type="button" role="menuitem" class="cc-item cc-all" data-id="*">
           <span>All contour maps</span><em>${contourMaps.length} of them</em></button>`
      : '');

  document.body.appendChild(pop);
  contourClearPop = pop;
  anchor.setAttribute('aria-expanded', 'true');

  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  pop.style.top = top + 'px';

  pop.querySelectorAll('.cc-item').forEach(b => {
    b.addEventListener('click', () => {
      const id = b.getAttribute('data-id');
      closeContourClearMenu();
      if (id === '*') clearAllContourMapsWithUndo();
      else removeContourMapWithUndo(id);
    });
  });

  const onDown = ev => {
    if (!pop.contains(ev.target) && ev.target !== anchor) { closeContourClearMenu(); cleanup(); }
  };
  const onKey = ev => { if (ev.key === 'Escape') { closeContourClearMenu(); cleanup(); } };
  const cleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

/** Clear every contour map at once, still reversible. */
function clearAllContourMapsWithUndo() {
  const kept = contourSettings();
  const n = contourMaps.length;
  const snaps = removeContourGeoms();
  clearContourMap();
  status(`${n} contour map${n === 1 ? '' : 's'} cleared.`
    + (snaps.length ? ` ${snaps.length} converted shape${snaps.length === 1 ? '' : 's'} too.` : ''),
    false, {
      label: 'Undo',
      onClick: () => {
        snaps.forEach(sn => { if (typeof recreateGeomFromSnapshot === 'function') recreateGeomFromSnapshot(sn); });
        applyContourSettings(kept);
      },
    });
}

/* ---------------------------------------------------------------------------
 * Choosing the area
 * ------------------------------------------------------------------------- */

let contourAreaDrawing = false;

/**
 * Draw the study area with Geoman, and take the geometry BEFORE drawing.js
 * turns it into a tracked shape.
 *
 * `pm:create` is a map-level event with one listener already on it
 * (drawing.js:728, which calls finalizeNewGeom). Registering here first and
 * removing the layer inside the handler means the shape never becomes a
 * geometry at all — the operator asked for a study area, not for a rectangle
 * they now have to find and delete from the shapes list.
 */
function startContourAreaDraw(shape) {
  if (typeof map === 'undefined' || !map.pm) return;
  if (typeof disableAllDrawModes === 'function') disableAllDrawModes();
  if (typeof disableAllEditModes === 'function') disableAllEditModes();

  contourAreaDrawing = true;
  contourState.areaShape = shape;
  status('Draw the area to contour on the map.', true);

  const onCreate = e => {
    map.off('pm:create', onCreate);
    contourAreaDrawing = false;
    const ring = contourRingFromLayer(e.layer, e.shape || shape);
    if (map.hasLayer(e.layer)) map.removeLayer(e.layer);
    map.pm.disableDraw();

    if (!ring || ring.length < 3) { status('That area was too small to use.'); return; }
    setContourArea(ring, shape);
    contourState.visible = true;
    setContourEnabled(true);
    renderContourPanel();
    generateContours();
  };

  // Registered before Geoman fires, and ahead of drawing.js's own listener in
  // the same phase, so this one gets the layer first.
  map.on('pm:create', onCreate);
  map.pm.enableDraw(shape, { continueDrawing: false });
}

/** A ring of {lat,lng} for whichever shape Geoman produced. */
function contourRingFromLayer(layer, shape) {
  if (!layer) return null;
  if (shape === 'Circle' && typeof layer.getRadius === 'function') {
    // Approximated as a polygon so everything downstream — the bounds, the
    // area, the clip path — has one kind of thing to deal with.
    const c = layer.getLatLng(), rad = layer.getRadius();
    const out = [];
    const latPerM = 1 / 111320;
    const lngPerM = 1 / (111320 * Math.cos(c.lat * Math.PI / 180) || 1);
    for (let i = 0; i < 64; i++) {
      const a = i / 64 * Math.PI * 2;
      out.push({ lat: c.lat + Math.sin(a) * rad * latPerM, lng: c.lng + Math.cos(a) * rad * lngPerM });
    }
    return out;
  }
  if (typeof layer.getLatLngs !== 'function') return null;
  let ll = layer.getLatLngs();
  while (Array.isArray(ll) && Array.isArray(ll[0])) ll = ll[0];
  return ll.map(p => ({ lat: p.lat, lng: p.lng }));
}

/* ---------------------------------------------------------------------------
 * The elevation legend card
 * ------------------------------------------------------------------------- */

/** Most bands before the card is taller than the map it sits on. */
const CONTOUR_LEGEND_MAX_BANDS = 22;

/**
 * A banded elevation scale: one block per contour band, each labelled, high
 * ground at the top.
 *
 * WHY BANDS AND NOT A SMOOTH BAR WITH FOUR TICKS. A contour map is not a
 * continuous field to the reader — it is a set of steps, and the question they
 * ask it is "which step is this?". A gradient with a tick every hundred metres
 * makes them interpolate by eye; a block per band lets them match a colour on
 * the map to a number and stop.
 *
 * THE COLOURS ARE READ FROM THE LOOKUP TABLE THE MAP WAS PAINTED FROM, through
 * rampLutHexAt, rounding included. A legend that computes its own colours
 * almost-correctly is worse than no legend: it is a legend that disagrees with
 * the map by an amount too small to notice and too large to trust.
 *
 * THE LEVELS ARE REAL CONTOUR LEVELS. When the interval is too fine to list —
 * ninety bands would be taller than the map — the step is widened to a MULTIPLE
 * of the interval, so every line on the card is still a line on the map, and
 * the footer says what the interval actually is.
 */
function renderContourLegend() {
  const card = $('contourLegendCard');
  if (!card) return;

  const tgl = $('contourLegendTgl');
  const wanted = (!tgl || tgl.checked) && contourState.visible !== false && contourModel.ready;
  card.style.display = wanted ? '' : 'none';
  if (!wanted) return;

  const ramp = contourRamp(contourState.ramp);
  const lut = rampLut(ramp);
  const min = contourModel.min, max = contourModel.max;
  const span = (max - min) || 1;

  const step = contourLegendStep(min, max);
  const levels = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-6; v += step) levels.push(v);
  if (!levels.length) levels.push(min, max);

  const body = $('contourLegendBands');
  if (body) {
    body.innerHTML = levels.slice().reverse().map(v => {
      const hex = rampLutHexAt(lut, (v - min) / span);
      // Ink chosen against the band it sits on, not against the card. Over a
      // rainbow the same grey is unreadable at one end and shouting at the
      // other; isLightColor already makes this decision everywhere else.
      const ink = (typeof isLightColor === 'function' && isLightColor(hex)) ? '#12181F' : '#FFFFFF';
      return `<div class="cl-band" style="background:${esc(hex)};color:${ink}">`
        + `<span>${esc(contourHeightText(v))}</span></div>`;
    }).join('');

    if (typeof staggerSlideIn === 'function') {
      staggerSlideIn(Array.from(body.children), { staggerMs: 14, dx: 8, duration: 200 });
    }
  }

  const title = $('contourLegendTitle');
  // Named, because there can be several on the map now and a scale that does
  // not say which one it belongs to is a scale you cannot trust.
  if (title && !title._renamed && typeof activeContourMap === 'function') {
    const rec = activeContourMap();
    if (rec) title.textContent = rec.name.toUpperCase();
  }

  const foot = $('contourLegendFoot');
  if (foot) {
    // Two facts the bands cannot carry: the real interval when the card had to
    // widen its step to fit, and the true range, whose ends fall between bands.
    const iv = contourState.interval + ' ' + contourState.unit;
    const shown = contourLabelFor(step) + ' ' + contourState.unit;
    foot.innerHTML = `<span>${esc(iv)} interval</span>`
      + (shown !== iv ? `<span class="cl-note">shown every ${esc(shown)}</span>` : '')
      + `<span class="cl-note">${esc(contourHeightText(min))} – ${esc(contourHeightText(max))}</span>`;
  }
}

/**
 * The band step: the smallest multiple of the contour interval that fits.
 *
 * A multiple, not a "nice" round number of its own — every band edge has to be
 * a contour that is actually drawn on the map, or the card is describing a
 * different map from the one beside it.
 */
function contourLegendStep(min, max) {
  const iv = contourIntervalMetres();
  if (!(iv > 0)) return Math.max(1, (max - min) / 8);
  for (const mult of [1, 2, 4, 5, 10, 20, 25, 50, 100]) {
    if (contourLevelCount(min, max, iv * mult) <= CONTOUR_LEGEND_MAX_BANDS) return iv * mult;
  }
  return iv * 100;
}

/** A round step near `span / count` — 1, 2, 2.5 or 5 times a power of ten. */
function contourNiceStep(span, count) {
  const raw = Math.abs(span) / Math.max(1, count);
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const pick = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return pick * mag;
}

/* ---------------------------------------------------------------------------
 * Wiring
 * ------------------------------------------------------------------------- */

function initContourPanel() {
  if (!$('contourMapList')) return;
  // There is always one to edit — the nine controls below have to write
  // somewhere before the first area is drawn.
  if (typeof ensureContourMap === 'function') ensureContourMap();

  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  // Each control declares the deepest stage it invalidates, and nothing more.
  const pick = (id, key, depth, cast) => on(id, 'change', e => {
    contourState[key] = cast ? cast(e.target.value) : e.target.value;
    renderContourPanel();
    contourInvalidate(depth);
  });

  on('contourNewBtn', 'click', () => {
    const rec = addContourMap();
    renderContourPanel();
    status(`"${rec.name}" added. Draw its area, or use the current view.`);
  });

  pick('contourInterval', 'interval', 'lines', Number);
  pick('contourBold', 'boldEvery', 'lines', Number);
  pick('contourLabels', 'labels', 'style');
  pick('contourSmoothing', 'smoothing', 'lines');
  pick('contourDetail', 'detail', 'all');

  on('contourUnit', 'change', e => {
    // Keep the physical interval as close as the new unit's list allows, so
    // switching to feet does not silently redraw at a quarter of the detail.
    const wasM = contourIntervalMetres();
    contourState.unit = e.target.value;
    const choices = contourIntervalChoices();
    const toM = v => (contourState.unit === 'ft' ? v / FT_PER_M : v);
    contourState.interval = choices.reduce((best, v) =>
      Math.abs(toM(v) - wasM) < Math.abs(toM(best) - wasM) ? v : best, choices[0]);
    renderContourPanel();
    contourInvalidate('lines');
  });

  on('contourRoads', 'change', e => {
    contourState.roads = e.target.value;
    renderContourPanel();
    contourLoadOsm();
  });

  on('contourOpacity', 'input', e => {
    contourState.fillOpacity = Number(e.target.value) / 100;
    const v = $('contourOpacityVal');
    if (v) v.textContent = e.target.value + '%';
    contourInvalidate('style');
  });

  on('contourShade', 'change', e => { contourState.shade = e.target.checked; contourInvalidate('fill'); });
  on('contourOutline', 'change', e => { contourState.showOutline = e.target.checked; contourInvalidate('style'); });

  on('contourRampBar', 'click', e => openContourRampPop(e.currentTarget));

  on('contourShape', 'change', e => { contourState.areaShape = e.target.value; });
  on('contourAreaDrawBtn', 'click', () => startContourAreaDraw(contourState.areaShape));
  on('contourAreaViewBtn', 'click', () => {
    contourAreaFromView();
    contourState.visible = true;
    setContourEnabled(true);
    renderContourPanel();
    generateContours();
  });

  on('contourGenBtn', 'click', () => generateContours());
  on('contourShapesBtn', 'click', () => contoursToShapes('auto'));
  on('contourClearBtn', 'click', e => openContourClearMenu(e.currentTarget));

  on('contourLegendTgl', 'change', renderContourLegend);

  on('contourExag', 'input', e => {
    contourState.exaggeration = Number(e.target.value) / 10;
    const v = $('contourExagVal');
    if (v) v.textContent = contourState.exaggeration.toFixed(1) + '×';
    if (typeof map3dSetExaggeration === 'function') map3dSetExaggeration(contourState.exaggeration);
  });

  const legendTitle = $('contourLegendTitle');
  if (legendTitle) {
    // Once somebody types their own title, the map's name stops overwriting it.
    legendTitle.addEventListener('input', () => { legendTitle._renamed = true; });
  }

  initContourLegendDrag();
  renderContourPanel();
  renderContourLegend();
}

/**
 * The same arm-then-drag the other two map cards use: a plain click has to
 * still reach the title to rename it, so a drag only starts once the pointer
 * has actually moved. Copied from ui/colorKey.js deliberately — three cards
 * that behave differently on the same map is worse than a repeated pattern.
 */
function initContourLegendDrag() {
  const card = $('contourLegendCard');
  const hd = card && card.querySelector('.hd');
  const wrap = $('mapWrap');
  if (!hd || !wrap) return;

  hd.style.cursor = 'move';
  let sx = 0, sy = 0, ox = 0, oy = 0, armed = false, dragging = false;

  hd.addEventListener('pointerdown', e => {
    const r = card.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    ox = r.left - w.left; oy = r.top - w.top; sx = e.clientX; sy = e.clientY;
    armed = true; dragging = false;
  });
  hd.addEventListener('pointermove', e => {
    if (!armed) return;
    if (!dragging) {
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 4) return;
      dragging = true;
      card._moved = true;
      card.style.right = 'auto'; card.style.bottom = 'auto';
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      try { hd.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
    }
    card.style.left = (ox + e.clientX - sx) + 'px';
    card.style.top = (oy + e.clientY - sy) + 'px';
    e.preventDefault();
  });
  const stop = () => { armed = false; dragging = false; };
  hd.addEventListener('pointerup', stop);
  hd.addEventListener('pointercancel', stop);
}
