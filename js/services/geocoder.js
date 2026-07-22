/**
 * services/geocoder.js — Nominatim forward + reverse geocoding: the search
 * box's live suggestions dropdown (with recents + keyboard nav) and the
 * click-to-add reverse lookup.
 */






let searchTimer = null, resultsData = [], selIdx = -1, searching = 0;
const recents = [];
      function showBox() {
        const box = $('searchResults');
        box.style.display = 'block';
        box.style.animation = 'none'; void box.offsetWidth;
        box.style.animation = 'dropIn .18s ease';
      }
      function renderResults(hintText) {
        const box = $('searchResults');
        box.innerHTML = '';
        if (!resultsData.length) { box.style.display = 'none'; return; }
        const ctr = map.getCenter();
        resultsData.forEach((r, i) => {
          const row = document.createElement('div');
          row.className = 'res' + (i === selIdx ? ' sel' : '');
          const dist = haversineKm(ctr.lat, ctr.lng, r.lat, r.lng);
          const meta = r.recent ? 'recent' : (dist < 1500 ? dist.toFixed(dist < 20 ? 1 : 0) + ' km from view' : '');
          row.innerHTML = `<span class="ico">${r.icon || '📍'}</span><span class="nm" title="${esc(r.label)}">${esc(r.label)}${meta ? `<span class="meta">· ${esc(meta)}</span>` : ''}</span><button class="add" title="Add as location">+</button>`;
          row.querySelector('.nm').addEventListener('click', () => map.flyTo([r.lat, r.lng], 15));
          row.querySelector('.add').addEventListener('click', () => pickResult(r));
          box.appendChild(row);
        });
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = hintText || '↑↓ select · Enter adds · click name to just fly there';
        box.appendChild(hint);
        showBox();
      }
      function pickResult(r) {
        addLocation({ name: r.name, lat: r.lat, lng: r.lng });
        map.flyTo([r.lat, r.lng], 15);
        if (!r.synthetic) {
          const dup = recents.findIndex(x => x.label === r.label);
          if (dup >= 0) recents.splice(dup, 1);
          recents.unshift(Object.assign({}, r, { recent: true, icon: '🕘' }));
          if (recents.length > 5) recents.pop();
        }
        $('searchResults').style.display = 'none';
        resultsData = []; selIdx = -1;
        status('Added "' + r.name + '".');
      }
      function setSpin(on) { $('sSpin').hidden = !on; }
      async function doSearch(live) {
        const q = $('searchInput').value.trim();
        if (!q) { resultsData = []; renderResults(); return; }
        const c = parseCoord(q);
        if (c) {
          resultsData = [{ synthetic: true, lat: c[0], lng: c[1], name: 'Dropped pin', label: 'Use coordinates ' + fmtCoord(c[0], c[1]), icon: '🎯' }];
          selIdx = 0; renderResults(); return;
        }
        const token = ++searching;
        setSpin(true);
        try {
          let url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=' + encodeURIComponent(q);
          if (map.getZoom() >= 8) {
            const b = map.getBounds();
            url += `&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}&bounded=0`;
          }
          const res = await fetch(url);
          const data = await res.json();
          if (token !== searching) return;              // a newer keystroke superseded this request
          resultsData = data.map(r => ({ lat: +r.lat, lng: +r.lon, name: (r.name || r.display_name.split(',')[0]), label: r.display_name, icon: iconFor(r.class, r.type) }));
          selIdx = resultsData.length ? 0 : -1;
          renderResults();
          if (!live) status(resultsData.length ? '' : 'No results for "' + q + '".');
        } catch (e) { if (!live) status('Search failed — check internet connection.'); }
        finally { if (token === searching) setSpin(false); }
      }
      $('searchInput').addEventListener('input', () => {
        clearTimeout(searchTimer);
        const q = $('searchInput').value.trim();
        $('sClear').hidden = !q;
        if (q.length < 3 && !parseCoord(q)) { resultsData = []; renderResults(); return; }
        searchTimer = setTimeout(() => doSearch(true), 380);
      });
      $('searchInput').addEventListener('focus', () => {
        if (!$('searchInput').value.trim() && recents.length) {
          resultsData = recents.slice(); selIdx = 0;
          renderResults('Recent places — Enter adds again');
        }
      });
      $('sClear').addEventListener('click', () => {
        $('searchInput').value = ''; $('sClear').hidden = true;
        resultsData = []; renderResults(); $('searchInput').focus();
      });
      $('searchInput').addEventListener('keydown', e => {
        const open = $('searchResults').style.display === 'block' && resultsData.length;
        if (e.key === 'ArrowDown' && open) { e.preventDefault(); selIdx = (selIdx + 1) % resultsData.length; renderResults(); }
        else if (e.key === 'ArrowUp' && open) { e.preventDefault(); selIdx = (selIdx - 1 + resultsData.length) % resultsData.length; renderResults(); }
        else if (e.key === 'Enter') { if (open && selIdx >= 0) pickResult(resultsData[selIdx]); else doSearch(false); }
        else if (e.key === 'Escape') { resultsData = []; renderResults(); }
      });
      $('searchBtn').addEventListener('click', () => doSearch(false));
      document.addEventListener('click', e => {
        if (!e.target.closest('.search-box')) $('searchResults').style.display = 'none';
      });

/**
 * Reverse-geocode a coordinate to a short place name (best-effort).
 * Used by click-to-add to pre-fill the new location's name.
 * @param {number} lat @param {number} lng
 * @returns {Promise<string|null>}
 */
async function reverseGeocodeName(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`);
    const j = await r.json();
    return j.name || (j.display_name || '').split(',')[0] || null;
  } catch (e) { return null; }
}

