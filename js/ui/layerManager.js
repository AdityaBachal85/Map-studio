/**
 * ui/layerManager.js — a floating, GIS-style Layers panel. Gives one unified
 * place to see and control everything on the map: user locations, routes and
 * drawn shapes, grouped and searchable, with per-item and per-group visibility
 * toggles and click-to-zoom. Reads the app's existing state arrays and drives
 * visibility through each subsystem's setLocVisible / setRouteVisible /
 * setGeomVisible helpers — it owns no map state of its own.
 */

const SHAPE_LAYER_ICON = { Marker: '📍', Line: '／', Polygon: '⬠', Rectangle: '▭', Circle: '◯', CircleMarker: '•' };
const lpCollapsed = new Set(); // group keys currently collapsed

/** Build the current group model from live app state. @returns {Array} */
function layerGroups() {
  const locItems = locations.map(loc => ({
    name: loc.name || 'Location', color: loc.color,
    icon: loc.type === 'site' ? '★' : (loc.type === 'badge' ? '▮' : '📍'),
    hidden: !!loc._hidden,
    zoom: () => map.flyTo([loc.lat, loc.lng], Math.max(map.getZoom(), 15)),
    setVisible: on => setLocVisible(loc, on),
  }));
  const rtItems = routes.map(rt => {
    const A = locById(rt.fromId), B = locById(rt.toId);
    const nm = rt.labelText && rt.labelText.trim() ? rt.labelText : `${A ? A.name : '?'} → ${B ? B.name : '?'}`;
    return {
      name: nm, color: rt.color, icon: '🛣️', hidden: !!rt._hidden,
      zoom: () => { if (rt.line) map.fitBounds(rt.line.getBounds(), { padding: [70, 70] }); },
      setVisible: on => setRouteVisible(rt, on),
    };
  });
  const geomItems = geometries.map(g => ({
    name: g.name, color: g.fillColor, icon: SHAPE_LAYER_ICON[g.shape] || '⬠', hidden: !!g._hidden,
    zoom: () => { if (g.layer.getBounds) map.fitBounds(g.layer.getBounds(), { padding: [60, 60] }); else if (g.layer.getLatLng) map.flyTo(g.layer.getLatLng(), Math.max(map.getZoom(), 16)); },
    setVisible: on => setGeomVisible(g, on),
  }));
  // Nearby: one row per fetched category (from services/nearbyPlaces + map/nearby).
  const nearbyItems = (typeof nearbyMarkers !== 'undefined' ? Object.keys(nearbyMarkers) : []).map(key => {
    const cat = nearbyCatByKey(key);
    const markers = nearbyMarkers[key] || [];
    return {
      name: `${cat.label} · ${markers.length}`, color: cat.color, icon: cat.icon,
      hidden: !nearbyEnabled.has(key),
      zoom: () => { if (markers.length) map.fitBounds(L.featureGroup(markers).getBounds(), { padding: [60, 60] }); },
      setVisible: on => setNearbyCategoryVisible(key, on),
    };
  });
  return [
    { key: 'loc', label: 'Locations', icon: '📍', items: locItems },
    { key: 'rt', label: 'Routes', icon: '🛣️', items: rtItems },
    { key: 'geom', label: 'Shapes', icon: '⬠', items: geomItems },
    { key: 'nearby', label: 'Nearby', icon: '📌', items: nearbyItems },
  ];
}

function lpItemRow(item) {
  const row = document.createElement('div');
  row.className = 'lp-item' + (item.hidden ? ' off' : '');
  row.innerHTML = `<button class="lp-eye" title="Show / hide"></button>
    <span class="lp-dot" style="background:${esc(item.color || '#888')}"></span>
    <span class="lp-ico">${item.icon}</span>
    <span class="lp-name" title="${esc(item.name)}">${esc(item.name)}</span>`;
  row.querySelector('.lp-eye').addEventListener('click', e => {
    e.stopPropagation();
    item.setVisible(item.hidden);       // hidden -> show, visible -> hide
    refreshLayers();
  });
  row.querySelector('.lp-name').addEventListener('click', () => item.zoom());
  row.querySelector('.lp-ico').addEventListener('click', () => item.zoom());
  return row;
}

/** Rebuild the panel body from live state, honouring collapse state + the search filter. */
function refreshLayers() {
  const body = $('lpBody');
  if (!body) return;
  const q = ($('lpSearch').value || '').trim().toLowerCase();
  body.innerHTML = '';
  let totalShown = 0;
  layerGroups().forEach(group => {
    const items = q ? group.items.filter(it => it.name.toLowerCase().includes(q)) : group.items;
    if (!group.items.length) return;            // no such objects at all
    if (q && !items.length) return;             // filtered out entirely
    totalShown += items.length;

    const wrap = document.createElement('div');
    wrap.className = 'lp-group' + (lpCollapsed.has(group.key) ? ' collapsed' : '');
    const anyVisible = group.items.some(it => !it.hidden);

    const head = document.createElement('div');
    head.className = 'lp-group-head';
    head.innerHTML = `<button class="lp-collapse" title="Collapse / expand">▾</button>
      <span class="lp-group-title">${group.label}</span>
      <span class="lp-count">${items.length}${q ? '/' + group.items.length : ''}</span>
      <button class="lp-group-eye ${anyVisible ? '' : 'off'}" title="Show / hide all"></button>`;
    head.querySelector('.lp-collapse').addEventListener('click', () => {
      if (lpCollapsed.has(group.key)) lpCollapsed.delete(group.key); else lpCollapsed.add(group.key);
      refreshLayers();
    });
    head.querySelector('.lp-group-title').addEventListener('click', () => {
      if (lpCollapsed.has(group.key)) lpCollapsed.delete(group.key); else lpCollapsed.add(group.key);
      refreshLayers();
    });
    head.querySelector('.lp-group-eye').addEventListener('click', e => {
      e.stopPropagation();
      const show = !anyVisible;                  // if any visible -> hide all, else show all
      group.items.forEach(it => it.setVisible(show));
      refreshLayers();
    });
    wrap.appendChild(head);

    const list = document.createElement('div');
    list.className = 'lp-items';
    items.forEach(it => list.appendChild(lpItemRow(it)));
    wrap.appendChild(list);
    body.appendChild(wrap);
  });
  $('lpEmpty').style.display = totalShown ? 'none' : '';
}

function openLayerPanel() { $('layerPanel').hidden = false; $('layerBtn').classList.add('toggled'); refreshLayers(); }
function closeLayerPanel() { $('layerPanel').hidden = true; $('layerBtn').classList.remove('toggled'); }

$('layerBtn').addEventListener('click', () => { $('layerPanel').hidden ? openLayerPanel() : closeLayerPanel(); });
$('lpClose').addEventListener('click', closeLayerPanel);
$('lpSearch').addEventListener('input', refreshLayers);
