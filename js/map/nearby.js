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

/** divIcon for a nearby place: category emoji on a coloured pin. @param {object} cat */
function nearbyMarkerIcon(cat) {
  return L.divIcon({
    className: 'nearby-pin-wrap',
    html: `<span class="nearby-pin" style="background:${cat.color}"><b>${cat.icon}</b></span>`,
    iconSize: [26, 26], iconAnchor: [13, 26],
  });
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
  places.forEach(p => {
    const m = L.marker([p.lat, p.lng], { icon: nearbyMarkerIcon(cat), keyboard: false, zIndexOffset: 200 });
    m.bindTooltip(`${cat.icon} ${esc(p.name)}`, { direction: 'top', offset: [0, -12], className: 'nearby-tip' });
    m.addTo(map);
    arr.push(m);
  });
  nearbyMarkers[key] = arr;
}

function showNearbyCategory(key) { (nearbyMarkers[key] || []).forEach(m => { if (!map.hasLayer(m)) m.addTo(map); }); }
function hideNearbyCategory(key) { (nearbyMarkers[key] || []).forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); }); }

/** Fetch + drop one category's markers around the current centre/radius. @param {string} key */
async function fetchNearbyKey(key) {
  const cat = nearbyCatByKey(key);
  const chip = $('nearbyGrid').querySelector(`[data-key="${key}"]`);
  if (chip) chip.classList.add('loading');
  try {
    const places = await fetchNearbyCategory(nearbyCenter.lat, nearbyCenter.lng, nearbyRadiusM, cat.cats);
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
    return;
  }
  if (!nearbyCenter) { nearbyCenter = map.getCenter(); drawNearbyCircle(); }
  nearbyEnabled.add(key);
  if (chip) chip.classList.add('active');
  if (nearbyMarkers[key]) { showNearbyCategory(key); updateNearbyClearBtn(); return; }
  const ok = await fetchNearbyKey(key);
  if (!ok) { nearbyEnabled.delete(key); if (chip) chip.classList.remove('active'); }
  updateNearbyClearBtn();
}

/** Drop every marker cache (used when centre/radius changes so enabled categories refetch). */
function clearNearbyMarkerCache() {
  Object.keys(nearbyMarkers).forEach(key => {
    (nearbyMarkers[key] || []).forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
    delete nearbyMarkers[key];
  });
  $('nearbyGrid').querySelectorAll('.nc-count').forEach(el => (el.textContent = ''));
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
$('nearbyCenterBtn').addEventListener('click', setNearbyCenterToView);
$('nearbyRadius').addEventListener('input', e => {
  nearbyRadiusM = +e.target.value;
  $('nearbyRadiusVal').textContent = fmtRadius(nearbyRadiusM);
  if (nearbyCenter) drawNearbyCircle();
});
// Only refetch on release (not on every slider step) so a drag isn't dozens of API calls.
$('nearbyRadius').addEventListener('change', () => { if (nearbyEnabled.size) refetchEnabledNearby(); });
$('nearbyClearBtn').addEventListener('click', clearAllNearby);
