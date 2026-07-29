/**
 * map/markerCluster.js — screen-space clustering for Nearby place markers.
 *
 * Two categories at a 2 km radius return fifty-odd places, and at anything
 * below street zoom they land on top of each other: overlapping dots, no
 * readable labels, and no sense of *where the density is*, which is the
 * question a property map is usually being asked. Clustering answers it — one
 * badge saying "12 schools here" carries more than twelve pins in a pile.
 *
 * Deliberately not leaflet.markercluster: that library is ~30 KB, owns the
 * markers it manages, and animates its own spiderfy — none of which fits an app
 * that already positions, declutters and exports these markers itself. This is
 * a grid clusterer working in container pixels, which is the right space for
 * the problem: whether two markers *look* merged depends on the screen, not on
 * their distance in metres.
 *
 * Only Nearby markers cluster. Locations the operator placed are few and each
 * one was a deliberate act — collapsing them into a count would hide the very
 * thing the map is about.
 */

/** Cell size in screen px. Roughly the width of a POI dot plus its label gap. */
const CLUSTER_CELL = 58;
/** Above this zoom the map is detailed enough that pins rarely collide. */
const CLUSTER_MAX_ZOOM = 16;

/** Live cluster badge markers, rebuilt on every recompute. */
let clusterMarkers = [];

/** divIcon for a cluster badge. @param {number} count @param {string} color */
function clusterIcon(count, color) {
  // Three size steps: a 40-strong cluster should read as heavier than a pair
  // without the badge growing large enough to hide what is under it.
  const size = count < 10 ? 30 : (count < 50 ? 36 : 42);
  return L.divIcon({
    className: 'poi-cluster-wrap',
    html:
      `<span class="poi-cluster" style="--cl:${color};width:${size}px;height:${size}px">` +
      `<b>${count}</b></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/** Remove every cluster badge from the map. */
function clearClusters() {
  clusterMarkers.forEach(m => map.removeLayer(m));
  clusterMarkers = [];
}

/**
 * Recompute clusters across every enabled Nearby category.
 *
 * Runs over all enabled categories at once rather than per category, because a
 * school and a college on the same corner are still two pins on top of each
 * other — clustering each category separately would leave exactly the overlap
 * this exists to remove.
 */
function updateNearbyClusters() {
  clearClusters();

  const zoom = map.getZoom();
  const all = [];
  Object.keys(nearbyMarkers).forEach(key => {
    if (!nearbyEnabled.has(key)) return;
    (nearbyMarkers[key] || []).forEach(m => all.push({ m, key }));
  });

  // Past the zoom threshold, or with too few markers to collide, show them all.
  if (zoom >= CLUSTER_MAX_ZOOM || all.length < 4) {
    all.forEach(({ m }) => showNearbyMarker(m, true));
    scheduleNearbyDeclutter();
    return;
  }

  const bounds = map.getBounds();
  const cells = new Map();
  all.forEach(entry => {
    const ll = entry.m.getLatLng();
    if (!bounds.contains(ll)) { showNearbyMarker(entry.m, false); return; }
    const p = map.latLngToContainerPoint(ll);
    const cx = Math.floor(p.x / CLUSTER_CELL), cy = Math.floor(p.y / CLUSTER_CELL);
    const id = cx + ':' + cy;
    if (!cells.has(id)) cells.set(id, []);
    cells.get(id).push(entry);
  });

  cells.forEach(group => {
    if (group.length === 1) { showNearbyMarker(group[0].m, true); return; }

    group.forEach(({ m }) => showNearbyMarker(m, false));

    // Centre the badge on the group's mean position, and colour it by whichever
    // category dominates so the badge still says *what* is there.
    let lat = 0, lng = 0;
    const tally = {};
    group.forEach(({ m, key }) => {
      const ll = m.getLatLng();
      lat += ll.lat; lng += ll.lng;
      tally[key] = (tally[key] || 0) + 1;
    });
    const top = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
    const cat = nearbyCatByKey(top) || { color: '#4C9AFF', label: 'places' };

    const marker = L.marker([lat / group.length, lng / group.length], {
      icon: clusterIcon(group.length, cat.color),
      zIndexOffset: 400,
      keyboard: false,
    });
    const names = group.slice(0, 6).map(({ m }) => m._poiName).filter(Boolean);
    marker.bindTooltip(
      `<b>${group.length} places</b><br><span class="nt-sub">${esc(names.join(' · '))}` +
      (group.length > names.length ? ' …' : '') + '</span>',
      { direction: 'top', offset: [0, -14], className: 'nearby-tip' });

    // Clicking a cluster zooms to fit exactly what it contains, which is the
    // only interaction that reliably breaks it apart.
    marker.on('click', () => {
      map.fitBounds(L.latLngBounds(group.map(({ m }) => m.getLatLng())).pad(0.35), { maxZoom: 18 });
    });
    marker.addTo(map);
    clusterMarkers.push(marker);
  });

  scheduleNearbyDeclutter();
}

/**
 * Show or hide one Nearby marker without removing it from the map.
 *
 * Toggling a CSS class rather than adding/removing the layer keeps Leaflet from
 * tearing down and rebuilding the DOM on every pan, which at fifty markers is
 * the difference between a smooth drag and a stuttering one.
 * @param {L.Marker} m @param {boolean} on
 */
function showNearbyMarker(m, on) {
  const el = m.getElement();
  if (el) el.classList.toggle('poi-clustered', !on);
}
