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

function buildNearbyChips() {
  const grid = $('nearbyGrid');
  NEARBY_CATEGORIES.forEach(cat => {
    const chip = document.createElement('button');
    chip.className = 'nearby-chip';
    chip.dataset.key = cat.key;
    chip.type = 'button';
    chip.innerHTML = `<span class="nc-ico">${cat.icon}</span><span class="nc-lbl">${cat.label}</span><span class="nc-count"></span>`;
    chip.addEventListener('click', () => toggleNearbyCategory(cat.key));
    grid.appendChild(chip);
  });
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
  const el = $('nearbyGrid').querySelector(`[data-key="${key}"] .nc-count`);
  if (el) el.textContent = n != null ? n : '';
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
    m.addTo(map);
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
  const chip = $('nearbyGrid').querySelector(`[data-key="${key}"]`);
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
  const chip = $('nearbyGrid').querySelector(`[data-key="${key}"]`);
  if (chip) chip.classList.add('loading');
  try {
    const places = await fetchNearbyCategory(nearbyCenter.lat, nearbyCenter.lng, nearbyRadiusM, cat.cats, 50, cat.gtypes);
    dropNearbyMarkers(key, places);
    setNearbyChipCount(key, places.length);
    status(places.length ? `Found ${places.length} ${cat.label.toLowerCase()} within ${fmtRadius(nearbyRadiusM)}.`
      : `No ${cat.label.toLowerCase()} found within ${fmtRadius(nearbyRadiusM)}.`);
    return true;
  } catch (e) {
    status(`Couldn't load ${cat.label.toLowerCase()} — check the Geoapify key or this category.`);
    return false;
  } finally { if (chip) chip.classList.remove('loading'); }
}

/** Toggle one category on/off. Fetches on first enable for a given centre/radius, then caches. @param {string} key */
async function toggleNearbyCategory(key) {
  const chip = $('nearbyGrid').querySelector(`[data-key="${key}"]`);
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
// Only refetch on release (not on every slider step) so a drag isn't dozens of API calls.
$('nearbyRadius').addEventListener('change', () => { if (nearbyEnabled.size) refetchEnabledNearby(); });
$('nearbyClearBtn').addEventListener('click', clearAllNearby);
