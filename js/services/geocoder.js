/**
 * services/geocoder.js — Nominatim forward + reverse geocoding: the search
 * box's live suggestions dropdown (with recents + keyboard nav) and the
 * click-to-add reverse lookup.
 */






/** Provider id → what the result row shows. */
const SEARCH_SOURCE_LABEL = {
  google: 'Google', geoapify: 'Geoapify', photon: 'Photon', nominatim: 'OpenStreetMap',
};

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
          const bits = [];
          if (r.recent) bits.push('recent');
          else if (r.lat == null) {
            // An autocomplete prediction has no coordinate yet, so there is no
            // distance to show. Its address is the more useful thing anyway —
            // it is what distinguishes two places of the same name.
            if (r.secondary) bits.push(r.secondary);
          } else {
            const dist = haversineKm(ctr.lat, ctr.lng, r.lat, r.lng);
            if (dist < 1500) bits.push(dist.toFixed(dist < 20 ? 1 : 0) + ' km from view');
          }
          // Name the provider. "Google is not configured" and "Google returned
          // nothing" produce identical-looking results otherwise, and the only
          // way to tell was to open devtools.
          if (r.source && !r.recent) bits.push(SEARCH_SOURCE_LABEL[r.source] || r.source);
          const meta = bits.join(' · ');
          // A prediction's label already ends in its address, and the address is
          // also the meta line — printing both reads as a stutter. Predictions
          // show the name alone and let the meta carry the place.
          const shown = r.secondary ? r.name : r.label;
          row.innerHTML = `<span class="ico">${r.icon || '📍'}</span><span class="nm" title="${esc(r.label)}">${esc(shown)}${meta ? `<span class="meta">· ${esc(meta)}</span>` : ''}</span><button class="add" title="Add as location">+</button>`;
          row.querySelector('.nm').addEventListener('click', async () => {
            const f = await resolveResult(r);
            if (f) map.flyTo([f.lat, f.lng], 15);
          });
          row.querySelector('.add').addEventListener('click', () => pickResult(r));
          box.appendChild(row);
        });
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = hintText || '↑↓ select · Enter adds · click name to just fly there';
        box.appendChild(hint);
        showBox();
      }
      /**
       * Make sure a result has coordinates, fetching them if it is a prediction.
       *
       * Autocomplete deliberately omits the location — Google charges for it and
       * expects you to ask only for the one that gets chosen. So the lookup
       * happens here, once, at the moment of choosing.
       * @param {object} r @returns {Promise<object|null>}
       */
      async function resolveResult(r) {
        if (r.lat != null) return r;
        if (!r.needsDetails || typeof googlePlaceDetails !== 'function') return null;
        setSpin(true);
        try {
          const full = await googlePlaceDetails(r.placeId);
          if (!full) { status('Could not look that place up — try the search button.'); return null; }
          Object.assign(r, full);           // so a second click costs nothing
          return r;
        } catch (e) {
          status('Could not look that place up — try the search button.');
          return null;
        } finally { setSpin(false); }
      }

      async function pickResult(r) {
        const f = await resolveResult(r);
        if (!f) return;
        r = f;
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
          const bias = map.getZoom() >= 8 ? map.getBounds() : null;
          const data = await geocodeSearch(q, bias, !!live);   // Google -> Geoapify -> Photon -> Nominatim
          if (token !== searching) return;              // a newer keystroke superseded this request
          resultsData = data;
          selIdx = resultsData.length ? 0 : -1;
          renderResults();
          if (!live) {
            const src = resultsData.length && resultsData[0].source;
            status(resultsData.length
              ? (src ? resultsData.length + ' result' + (resultsData.length > 1 ? 's' : '') + ' from ' + (SEARCH_SOURCE_LABEL[src] || src) + '.' : '')
              : 'No results for "' + q + '".');
          }
        } catch (e) { if (!live) status('Search failed — check internet connection.'); }
        finally { if (token === searching) setSpin(false); }
      }
      $('searchInput').addEventListener('input', () => {
        clearTimeout(searchTimer);
        const q = $('searchInput').value.trim();
        $('sClear').hidden = !q;
        // Two characters is enough for predictions; the old threshold of three
        // was tuned for whole-word geocoders that need most of the name.
        const minChars = (typeof googleReady === 'function' && googleReady()) ? 2 : 3;
        if (q.length < minChars && !parseCoord(q)) { resultsData = []; renderResults(); return; }
        searchTimer = setTimeout(() => doSearch(true), 300);
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
      /**
       * Act on a submit — Enter, the arrow button, or the magnifier.
       *
       * If predictions are already on screen for what is typed, the answer has
       * been bought: take the highlighted one and resolve it with a Place
       * Details call, which is the same billing session the autocomplete
       * opened. Running a fresh Text Search instead is a second, separately
       * charged request for a question already answered — which is exactly
       * what the two buttons used to do, while Enter did the right thing.
       */
      function submitSearch() {
        const open = $('searchResults').style.display === 'block' && resultsData.length;
        if (open && selIdx >= 0) pickResult(resultsData[selIdx]);
        else doSearch(false);
      }
      $('searchInput').addEventListener('keydown', e => {
        const open = $('searchResults').style.display === 'block' && resultsData.length;
        if (e.key === 'ArrowDown' && open) { e.preventDefault(); selIdx = (selIdx + 1) % resultsData.length; renderResults(); }
        else if (e.key === 'ArrowUp' && open) { e.preventDefault(); selIdx = (selIdx - 1 + resultsData.length) % resultsData.length; renderResults(); }
        else if (e.key === 'Enter') submitSearch();
        else if (e.key === 'Escape') { resultsData = []; renderResults(); }
      });
      $('searchBtn').addEventListener('click', submitSearch);
      document.addEventListener('click', e => {
        if (!e.target.closest('.search-box')) $('searchResults').style.display = 'none';
      });

/**
 * Reverse-geocode a coordinate to a short place name (best-effort). Used by
 * click-to-add to pre-fill the new location's name. Geoapify first, then
 * Nominatim fallback (same silent-chain pattern as forward search).
 * @param {number} lat @param {number} lng
 * @returns {Promise<string|null>}
 */
async function reverseGeocodeName(lat, lng) {

  /* ---------- Geoapify ---------- */

  if (GEOAPIFY_API_KEY) {
    try {

      const url =
        SEARCH_PROVIDERS.geoapify.reverse
        + '?lat=' + lat
        + '&lon=' + lng
        + '&format=json'
        + '&apiKey=' + GEOAPIFY_API_KEY;

      const res = await fetch(url);

      if (res.ok) {
        const json = await res.json();

        if (json.results && json.results.length) {

          const r = json.results[0];

          return (
            r.name ||
            r.address_line1 ||
            (r.formatted || '').split(',')[0] ||
            null
          );

        }
      }

    } catch (e) {
      console.warn("Geoapify reverse failed:", e);
    }
  }

  /* ---------- Nominatim ---------- */

  try {

    const url =
      SEARCH_PROVIDERS.nominatim.reverse
      + '?format=jsonv2'
      + '&lat=' + lat
      + '&lon=' + lng;

    const res = await fetch(url);

    const json = await res.json();

    return (
      json.name ||
      (json.display_name || '').split(',')[0] ||
      null
    );

  } catch (e) {

    console.warn("Nominatim reverse failed:", e);

    return null;

  }

}


