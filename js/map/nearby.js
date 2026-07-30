/**
 * map/nearby.js — Nearby Places discovery UI + map markers (Nearby tab).
 * Builds the category chips from services/nearbyPlaces.js, manages a search
 * centre + radius, fetches per category on demand (credit-friendly), and drops
 * toggleable category markers. Purely additive — its own tab, listeners and
 * layers; nothing existing is touched.
 */

const nearbyMarkers = {};   // catKey -> [L.marker]   (kept as a cache; hidden when toggled off)
let nearbyCenter = null;    // L.LatLng or null
let nearbyRadiusM = 2000;
let nearbyCircle = null;
const nearbyEnabled = new Set();

/** Human radius string, e.g. "750 m" or "2.0 km". @param {number} m */
function fmtRadius(m) { return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`; }

/**
 * divIcon for a nearby place: a small category-coloured dot with the place name
 * beside it.
 *
 * Modelled on how Google Maps draws points of interest, because that is the
 * comparison users make. The important differences from the previous teardrop
 * pin are that the name is *always* visible rather than hidden behind a hover
 * tooltip — a printed map has no hover, so an unlabelled pin carries no
 * information into an export — and that the marker is small enough for the
 * label to be the thing you read.
 *
 * @param {object} cat Category descriptor from NEARBY_CATEGORIES.
 * @param {string} name Place name.
 */
function nearbyMarkerIcon(cat, name) {
  return L.divIcon({
    className: 'nearby-poi-wrap',
    html:
      `<span class="np-dot" style="background:${cat.color}"><b>${cat.icon}</b></span>` +
      `<span class="np-name">${esc(name || '')}</span>`,
    // iconSize null on purpose: Leaflet writes iconSize onto the element as a
    // fixed width, which would squeeze the name — a flex child in a 16px box —
    // down to nothing. Leaving it unset lets the marker size to its content
    // while iconAnchor still centres the dot on the coordinate.
    iconSize: null, iconAnchor: [8, 8],
  });
}

/* ---------------------------------------------------------------------------
 * Label decluttering
 * ------------------------------------------------------------------------- */

/**
 * Hide the names that would collide, keeping the dots.
 *
 * Two categories at a 2 km radius can return fifty places; drawn naively their
 * names overlap into an unreadable mat. Google solves this by dropping labels
 * rather than markers, so the density of places still reads while the text
 * stays legible — and by suppressing them entirely when zoomed too far out for
 * any of them to be meaningful. This does the same, cheaply: walk the visible
 * markers in draw order, keep a label if its box clears every label already
 * kept, hide it otherwise.
 *
 * O(n²) over the labels actually on screen, which at these counts is a fraction
 * of a millisecond — and it only runs when the view settles, not during a pan.
 */
const NEARBY_LABEL_MIN_ZOOM = 14;

function declutterNearbyLabels() {
  const shown = [];
  const zoomOk = map.getZoom() >= NEARBY_LABEL_MIN_ZOOM;
  const bounds = map.getBounds();

  Object.keys(nearbyMarkers).forEach(key => {
    (nearbyMarkers[key] || []).forEach(m => {
      const el = m.getElement();
      if (!el) return;
      const label = el.querySelector('.np-name');
      if (!label) return;
      // A marker folded into a cluster has no label to place.
      if (!zoomOk || el.classList.contains('poi-clustered') || !bounds.contains(m.getLatLng())) {
        label.classList.add('np-hidden');
        return;
      }

      // Measure with the label visible, then decide.
      label.classList.remove('np-hidden');
      const r = label.getBoundingClientRect();
      if (!r.width) return;
      const box = { l: r.left - 2, t: r.top - 1, r: r.right + 2, b: r.bottom + 1 };
      const clash = shown.some(s => !(box.r < s.l || box.l > s.r || box.b < s.t || box.t > s.b));
      if (clash) label.classList.add('np-hidden');
      else shown.push(box);
    });
  });
}

/** Re-run decluttering once the view has settled. */
let nearbyDeclutterTimer = null;
function scheduleNearbyDeclutter() {
  clearTimeout(nearbyDeclutterTimer);
  nearbyDeclutterTimer = setTimeout(declutterNearbyLabels, 60);
}

/**
 * Build one chip. Custom searches get a remove button; the twelve built-in
 * categories do not, because they are always available and never accumulate.
 * @param {object} cat @param {HTMLElement} grid
 */
function buildNearbyChip(cat, grid) {
  const chip = document.createElement('button');
  chip.className = 'nearby-chip' + (cat.custom ? ' is-custom' : '');
  chip.dataset.key = cat.key;
  chip.type = 'button';
  chip.innerHTML = `<span class="nc-ico">${cat.icon}</span><span class="nc-lbl">${esc(cat.label)}</span><span class="nc-count"></span>`;
  chip.addEventListener('click', () => toggleNearbyCategory(cat.key));
  if (cat.custom) {
    chip.title = 'Search: ' + cat.gquery;
    const x = document.createElement('span');
    x.className = 'nc-del';
    x.textContent = '×';
    x.title = 'Remove this search';
    x.addEventListener('click', e => { e.stopPropagation(); removeCustomNearby(cat.key); });
    chip.appendChild(x);
  }
  grid.appendChild(chip);
  return chip;
}

function buildNearbyChips() {
  const grid = $('nearbyGrid');
  NEARBY_CATEGORIES.forEach(cat => buildNearbyChip(cat, grid));
}

/* ---------------------------------------------------------------------------
 * Searching for anything the chips do not cover
 *
 * The twelve categories can only offer what Google has a type for, which leaves
 * out most of what a property map wants to point at — "real estate agents",
 * "cake shops", "under construction projects". A typed search becomes a chip of
 * its own so that everything downstream (the marker layer, the Layer Manager,
 * clustering, Clear) treats it exactly like a built-in category and needed no
 * changes to support it.
 * ------------------------------------------------------------------------- */

/** Colours for custom chips, cycled. Deliberately distinct from the built-ins. */
const CUSTOM_NEARBY_COLORS = ['#E8590C', '#0B7285', '#5F3DC4', '#087F5B', '#A61E4D', '#5C940D'];
let customNearbyCount = 0;

/** @param {string} q @returns {string} a stable key for one query. */
function customNearbyKey(q) {
  return 'q:' + q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Run a typed search and give it a chip. Re-running an existing search reuses
 * its chip and colour rather than stacking duplicates.
 * @param {string} raw
 */
async function runCustomNearbySearch(raw) {
  const q = (raw || '').trim();
  if (!q) return;
  if (q.length < 2) { status('Type at least two characters to search nearby.'); return; }

  if (!nearbyCenter) { nearbyCenter = map.getCenter(); drawNearbyCircle(); }

  const key = customNearbyKey(q);
  let cat = nearbyCatByKey(key);
  if (!cat) {
    cat = {
      key, label: q, icon: '🔎', custom: true, gquery: q,
      color: CUSTOM_NEARBY_COLORS[customNearbyCount++ % CUSTOM_NEARBY_COLORS.length],
    };
    NEARBY_CATEGORIES.push(cat);
    buildNearbyChip(cat, $('nearbyGrid'));
  } else if (nearbyMarkers[key]) {
    // Already fetched at this centre — just make sure it is showing.
    setNearbyCategoryVisible(key, true);
    status(`"${q}" is already on the map.`);
    return;
  }

  nearbyEnabled.add(key);
  const chip = $('nearbyGrid').querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (chip) chip.classList.add('active');
  const ok = await fetchNearbyKey(key);
  if (!ok) {
    nearbyEnabled.delete(key);
    if (chip) chip.classList.remove('active');
  }
  updateNearbyClearBtn();
  if (typeof refreshLayers === 'function') refreshLayers();
}

/** Drop a custom search: its markers, its chip and its descriptor. @param {string} key */
function removeCustomNearby(key) {
  hideNearbyCategory(key);
  (nearbyMarkers[key] || []).forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
  delete nearbyMarkers[key];
  nearbyEnabled.delete(key);
  const i = NEARBY_CATEGORIES.findIndex(c => c.key === key);
  if (i >= 0) NEARBY_CATEGORIES.splice(i, 1);
  const chip = $('nearbyGrid').querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (chip) chip.remove();
  updateNearbyClusters();
  updateNearbyClearBtn();
  if (typeof refreshLayers === 'function') refreshLayers();
}

function drawNearbyCircle() {
  if (nearbyCircle) { map.removeLayer(nearbyCircle); nearbyCircle = null; }
  if (!nearbyCenter) return;
  nearbyCircle = L.circle(nearbyCenter, {
    radius: nearbyRadiusM, color: '#FF7A1A', weight: 1.5, dashArray: '5,6',
    fill: true, fillColor: '#FF7A1A', fillOpacity: 0.05, interactive: false, renderer: vectorRenderer,
  }).addTo(map);
}

function setNearbyChipCount(key, n) {
  const el = $('nearbyGrid').querySelector(`[data-key="${CSS.escape(key)}"] .nc-count`);
  if (el) el.textContent = n != null ? n : '';
}

/* ---------------------------------------------------------------------------
 * Promoting a discovered place into the project
 * ------------------------------------------------------------------------- */

/**
 * Is this place already a location on the map?
 *
 * Matched on coordinates rather than name, because the same place added twice
 * from two different categories (a junior college shows under both Schools and
 * Colleges) is the same pin, whereas two branches of one bank are not.
 * @param {{lat:number,lng:number}} p
 */
function nearbyAlreadyAdded(p) {
  return locations.some(l => Math.abs(l.lat - p.lat) < 1e-6 && Math.abs(l.lng - p.lng) < 1e-6);
}

/**
 * Add a discovered place to the locations list.
 * @param {object} cat @param {object} p
 * @param {HTMLElement} [btn] @param {object} [marker] the POI marker it came from
 */
function addNearbyToLocations(cat, p, btn, marker) {
  if (nearbyAlreadyAdded(p)) {
    status(`"${p.name}" is already in the locations list.`);
    if (btn) markAddButtonDone(btn);
    markPoiPromoted(marker, true);
    return null;
  }
  // The category colour carries over, so a school added from the Schools chip
  // keeps reading as a school once it is a project pin.
  const loc = addLocation({ name: p.name, lat: p.lat, lng: p.lng, color: cat.color });
  if (btn) markAddButtonDone(btn);
  markPoiPromoted(marker, true);
  status(`Added "${p.name}" to locations.`);
  return loc;
}

/** @param {HTMLElement} btn */
function markAddButtonDone(btn) {
  btn.textContent = '✓ In locations';
  btn.disabled = true;
  btn.classList.add('is-added');
}

/**
 * Silence a POI's own label once it is a real location.
 *
 * The location pin draws its own label at the same coordinate, so leaving the
 * POI label on stacks two copies of the same name on top of each other. The dot
 * stays — it still says which category the place came from — but the name is
 * left to the pin that now owns it.
 * @param {object} [marker] @param {boolean} on
 */
function markPoiPromoted(marker, on) {
  const el = marker && marker.getElement && marker.getElement();
  if (el) el.classList.toggle('np-promoted', !!on);
}

/**
 * The popup shown when a discovered place is clicked: what it is, how far, and
 * the one action worth offering — put it on the map for real.
 *
 * Built as a DOM node rather than an HTML string so the button carries a real
 * listener. Leaflet re-uses the node each time the popup opens, which is also
 * why the added/not-added state is refreshed on open rather than baked in.
 *
 * @param {object} cat @param {object} p @param {object} marker
 * @returns {HTMLElement}
 */
function nearbyPopupNode(cat, p, marker) {
  const box = document.createElement('div');
  box.className = 'np-pop';

  const title = document.createElement('div');
  title.className = 'np-pop-name';
  title.textContent = p.name;
  box.appendChild(title);

  const detail = [p.address, p.distance != null ? fmtRadius(Math.round(p.distance)) + ' away' : null]
    .filter(Boolean).join(' · ');
  if (detail) {
    const sub = document.createElement('div');
    sub.className = 'np-pop-sub';
    sub.textContent = detail;
    box.appendChild(sub);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-block np-pop-add';
  btn.textContent = '+ Add to locations';
  btn.addEventListener('click', () => addNearbyToLocations(cat, p, btn, marker));
  box.appendChild(btn);

  // Re-derived on every open rather than remembered, so deleting the location
  // again puts the action back instead of leaving a dead "✓ In locations".
  box._resetAdd = () => {
    const added = nearbyAlreadyAdded(p);
    if (added) markAddButtonDone(btn);
    else {
      btn.textContent = '+ Add to locations';
      btn.disabled = false;
      btn.classList.remove('is-added');
    }
    markPoiPromoted(marker, added);
  };
  return box;
}

function dropNearbyMarkers(key, places) {
  const cat = nearbyCatByKey(key);
  const arr = [];
  const pinEls = [];
  places.forEach(p => {
    const m = L.marker([p.lat, p.lng], { icon: nearbyMarkerIcon(cat, p.name), keyboard: false, zIndexOffset: 200 });
    m._poiName = p.name;
    // The name is on the marker now, so the tooltip carries what the label
    // cannot: the address and how far out it is.
    const detail = [p.address, p.distance != null ? Math.round(p.distance) + ' m away' : null]
      .filter(Boolean).join(' · ');
    if (detail) m.bindTooltip(`${esc(p.name)}<br><span class="nt-sub">${esc(detail)}</span>`, {
      direction: 'top', offset: [0, -12], className: 'nearby-tip',
    });
    // Click to add. A discovered place is useless until it can become a pin,
    // which is what "I can see ten schools but cannot put one on the map" meant.
    const node = nearbyPopupNode(cat, p, m);
    m.bindPopup(node, { className: 'nearby-pop', closeButton: true, minWidth: 180, autoPanPadding: [24, 24] });
    m.on('popupopen', () => node._resetAdd());
    m.addTo(map);
    // A place already on the map when its category is (re)fetched must not show
    // a second copy of its name.
    if (nearbyAlreadyAdded(p)) markPoiPromoted(m, true);
    arr.push(m);
    const iconEl = m.getElement();
    const pinEl = iconEl && iconEl.querySelector('.np-dot');
    if (pinEl) pinEls.push(pinEl);
  });
  nearbyMarkers[key] = arr;
  if (typeof staggerPopIn === 'function') staggerPopIn(pinEls);
  updateNearbyClusters();
  if (typeof refreshLayers === 'function') refreshLayers();
}

function showNearbyCategory(key) {
  (nearbyMarkers[key] || []).forEach(m => { if (!map.hasLayer(m)) m.addTo(map); });
  updateNearbyClusters();
}
function hideNearbyCategory(key) {
  (nearbyMarkers[key] || []).forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
  updateNearbyClusters();   // freed space may let other labels back in
}

/**
 * Show/hide a fetched nearby category, keeping its Nearby-tab chip in sync.
 * Used by the Layer Manager. Operates on the cached markers only (no refetch).
 * @param {string} key @param {boolean} on
 */
function setNearbyCategoryVisible(key, on) {
  const chip = $('nearbyGrid').querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (on) {
    nearbyEnabled.add(key);
    showNearbyCategory(key);
    if (chip) chip.classList.add('active');
  } else {
    nearbyEnabled.delete(key);
    hideNearbyCategory(key);
    if (chip) chip.classList.remove('active');
  }
  updateNearbyClearBtn();
}

/** Fetch + drop one category's markers around the current centre/radius. @param {string} key */
async function fetchNearbyKey(key) {
  const cat = nearbyCatByKey(key);
  const chip = $('nearbyGrid').querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (chip) chip.classList.add('loading');
  try {
    const places = await fetchNearbyCategory(nearbyCenter.lat, nearbyCenter.lng, nearbyRadiusM, cat, 50);
    dropNearbyMarkers(key, places);
    setNearbyChipCount(key, places.length);
    // `note` is set when Google failed and Geoapify answered instead. Saying so
    // matters: an exhausted daily quota makes every chip go quiet at once, and
    // silently falling back just looks like the feature broke.
    const via = places.note ? ` — ${places.note}`
      : places.source === 'google' ? ' via Google'
      : places.source ? ' via Geoapify' : '';
    // A typed search takes a location *bias*, so Google will happily answer with
    // places well outside the circle. Those are dropped, but saying how many were
    // dropped turns "it only found three" into "widen the radius".
    const more = places.outside ? ` ${places.outside} more further out — widen the radius to include them.` : '';
    const what = cat.custom ? `matches for "${cat.label}"` : cat.label.toLowerCase();
    status(places.length ? `Found ${places.length} ${what} within ${fmtRadius(nearbyRadiusM)}${via}.${more}`
      : `No ${what} within ${fmtRadius(nearbyRadiusM)}${via}.${more}`);
    return true;
  } catch (e) {
    status(cat.custom ? (e.message || `Couldn't search for "${cat.label}".`)
      : `Couldn't load ${cat.label.toLowerCase()} — check the Geoapify key or this category.`);
    return false;
  } finally { if (chip) chip.classList.remove('loading'); }
}

/** Toggle one category on/off. Fetches on first enable for a given centre/radius, then caches. @param {string} key */
async function toggleNearbyCategory(key) {
  const chip = $('nearbyGrid').querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (nearbyEnabled.has(key)) {
    nearbyEnabled.delete(key);
    hideNearbyCategory(key);
    if (chip) chip.classList.remove('active');
    updateNearbyClearBtn();
    if (typeof refreshLayers === 'function') refreshLayers();
    return;
  }
  if (!nearbyCenter) { nearbyCenter = map.getCenter(); drawNearbyCircle(); }
  nearbyEnabled.add(key);
  if (chip) chip.classList.add('active');
  if (nearbyMarkers[key]) { showNearbyCategory(key); updateNearbyClearBtn(); return; }
  const ok = await fetchNearbyKey(key);
  if (!ok) { nearbyEnabled.delete(key); if (chip) chip.classList.remove('active'); }
  updateNearbyClearBtn();
  if (typeof refreshLayers === 'function') refreshLayers();
}

/** Drop every marker cache (used when centre/radius changes so enabled categories refetch). */
function clearNearbyMarkerCache() {
  Object.keys(nearbyMarkers).forEach(key => {
    (nearbyMarkers[key] || []).forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
    delete nearbyMarkers[key];
  });
  $('nearbyGrid').querySelectorAll('.nc-count').forEach(el => (el.textContent = ''));
  if (typeof clearClusters === 'function') clearClusters();
  if (typeof refreshLayers === 'function') refreshLayers();
}

/** Refetch every currently-enabled category (after a centre or radius change). */
async function refetchEnabledNearby() {
  if (!nearbyCenter || !nearbyEnabled.size) return;
  clearNearbyMarkerCache();
  for (const key of [...nearbyEnabled]) await fetchNearbyKey(key);
}

/** Point the nearby search at the current map view. */
function setNearbyCenterToView() {
  nearbyCenter = map.getCenter();
  drawNearbyCircle();
  updateNearbyClearBtn();
  if (nearbyEnabled.size) refetchEnabledNearby();
  else status(`Nearby search centred on the map view (${fmtRadius(nearbyRadiusM)} radius) — toggle categories below.`);
}

function updateNearbyClearBtn() {
  const btn = $('nearbyClearBtn');
  if (btn) btn.style.display = (nearbyCenter || Object.keys(nearbyMarkers).length) ? '' : 'none';
}

/** Remove all nearby markers, the radius circle and reset the panel. */
function clearAllNearby() {
  clearNearbyMarkerCache();
  nearbyEnabled.clear();
  $('nearbyGrid').querySelectorAll('.nearby-chip').forEach(c => c.classList.remove('active'));
  if (nearbyCircle) { map.removeLayer(nearbyCircle); nearbyCircle = null; }
  nearbyCenter = null;
  updateNearbyClearBtn();
  status('Nearby places cleared.');
}

buildNearbyChips();
// Labels are decluttered against screen space, so the decision has to be
// remade whenever the view changes. `moveend`/`zoomend` only — re-running
// during a pan would thrash layout for no visible benefit.
map.on('moveend zoomend', updateNearbyClusters);
$('nearbyCenterBtn').addEventListener('click', setNearbyCenterToView);
$('nearbyRadius').addEventListener('input', e => {
  nearbyRadiusM = +e.target.value;
  $('nearbyRadiusVal').textContent = fmtRadius(nearbyRadiusM);
  if (nearbyCenter) drawNearbyCircle();
});
// Refetch on release rather than on every slider step, and then only after the
// slider has been still for a moment. A radius change costs one request per
// active chip, so four chips and five nudges used to be twenty requests before
// the user had settled on a number. Growing the radius still costs; shrinking it
// is served from the wider answer already held (see nearbyNarrowable).
let nearbyRadiusTimer = null;
$('nearbyRadius').addEventListener('change', () => {
  if (!nearbyEnabled.size) return;
  clearTimeout(nearbyRadiusTimer);
  nearbyRadiusTimer = setTimeout(refetchEnabledNearby, 700);
});
$('nearbyClearBtn').addEventListener('click', clearAllNearby);

// The free-text search fires on Enter or on the button — never while typing.
// Text Search is billed per request and there is no prediction to show, so
// debounced-as-you-type would spend a request per pause for no benefit.
function submitNearbySearch() {
  const input = $('nearbySearchInput');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  runCustomNearbySearch(q);
}
$('nearbySearchBtn').addEventListener('click', submitNearbySearch);
$('nearbySearchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitNearbySearch(); }
});
