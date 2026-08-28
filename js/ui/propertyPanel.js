/**
 * ui/propertyPanel.js — sidebar cards for locations & routes, ring rows,
 * route selects, the legend table, and empty-state visibility.
 */










      function renderRingRows(loc) {
        const box = loc.card.querySelector('.ringsBox');
        box.innerHTML = '';
        (loc.rings || []).forEach((r, idx) => {
          const row = document.createElement('div');
          row.className = 'ring-row';
          row.innerHTML = `
      <input type="text" inputmode="decimal" class="rkm" value="${esc(r.km)}" placeholder="km" title="Radius in km">
      <input type="color" class="rclr" value="${esc(r.color)}" title="Ring color">
      <input type="range" class="rop" min="0" max="60" step="2" value="${Math.round((r.op || 0) * 100)}" title="Fill transparency">
      <span class="pct">${Math.round((r.op || 0) * 100)}%</span>
      <button class="mini-btn rscan" title="Find the metro, railway, rivers and airports inside this ring">⊙ Scan</button>
      <button class="x-btn" title="Remove ring">&times;</button>`;
          row.querySelector('.rkm').addEventListener('change', e => { r.km = e.target.value; updateRings(loc); });
          row.querySelector('.rclr').addEventListener('input', e => { r.color = e.target.value; updateRings(loc); });
          row.querySelector('.rop').addEventListener('input', e => {
            r.op = (+e.target.value) / 100;
            row.querySelector('.pct').textContent = e.target.value + '%';
            updateRings(loc);
          });
          // Deliberately a button, not something the radius input fires on
          // change. Typing "3" then "30" would otherwise launch two city-scale
          // Overpass queries nobody asked for, against a donated service.
          row.querySelector('.rscan').addEventListener('click', () => {
            if (typeof openRingScan === 'function') openRingScan(loc, r);
          });
          row.querySelector('.x-btn').addEventListener('click', () => { loc.rings.splice(idx, 1); renderRingRows(loc); updateRings(loc); });
          enhanceColorInputs(row);
          box.appendChild(row);
        });
      }
/**
 * Which icon fields are *presentation* rather than identity.
 *
 * Frame, size, border, fill, shadow and glow are how a marker is drawn, and
 * wanting them consistent across a map is the normal case — setting them one
 * location at a time is what makes people stop bothering.
 *
 * `iconKey`, `color` and `iconImage` are deliberately NOT here. They are what
 * each location *is* — copying them would turn every pin into a shopping mall
 * in one colour, which is not "apply this style", it is "delete my map".
 */
const ICON_STYLE_FIELDS = ['iconFrame', 'iconSize', 'iconBorder', 'iconBorderColor',
  'iconBg', 'iconShadow', 'iconGlow'];

/**
 * Push a location's current style back onto its own card's controls.
 *
 * Anything that changes a location from outside its card has to do this, or the
 * panel keeps the old numbers and the next drag of a slider snaps the map back
 * to them — a bug that reads as "the control does not work" rather than as a
 * stale readout. Extracted so the bulk paths and this one cannot drift: it is
 * used by applyIconStyleToAll() below and by ui/locGroups.js.
 *
 * @param {object} l
 */
function syncLocCardStyle(l) {
  if (!l || !l.card) return;
  const set = (sel, v) => { const el = l.card.querySelector(sel); if (el) el.value = v; };
  set('.fr', l.iconFrame); set('.sz', l.iconSize); set('.bw', l.iconBorder);
  set('.bc', l.iconBorderColor); set('.ibg', l.iconBg); set('.ish', l.iconShadow);
  set('.lbg', l.labelBg);
  set('.lsz', l.labelScale == null ? 100 : l.labelScale);
  const szv = l.card.querySelector('.sz-v'); if (szv) szv.textContent = l.iconSize;
  const lszv = l.card.querySelector('.lsz-v');
  if (lszv) lszv.textContent = (l.labelScale == null ? 100 : l.labelScale) + '%';
  const gl = l.card.querySelector('.gl'); if (gl) gl.checked = !!l.iconGlow;
  const sl = l.card.querySelector('.sl'); if (sl) sl.checked = !!l.showLabel;
  l.card.querySelectorAll('input[type="color"]').forEach(i => {
    if (typeof syncColorSwatch === 'function') syncColorSwatch(i);
  });
  const framed = (l.iconFrame || 'none') !== 'none';
  l.card.querySelectorAll('.frame-only').forEach(r => { r.style.display = framed ? '' : 'none'; });
}

/**
 * Copy one location's icon styling onto every other location.
 * @param {object} src the location whose card the button was pressed on
 */
function applyIconStyleToAll(src) {
  const all = typeof realLocations === 'function' ? realLocations() : locations;
  const others = all.filter(l => l.id !== src.id);
  if (!others.length) { status('There is only one location to style.'); return; }

  others.forEach(l => {
    ICON_STYLE_FIELDS.forEach(k => { l[k] = src[k]; });
    // Rebuild the marker, then re-sync the card so the sliders and swatches on
    // screen agree with what the map now shows. Without the second half the
    // panels keep the old numbers and the next drag snaps back to them.
    renderLocPin(l);
    syncLocCardStyle(l);
  });

  if (typeof pushHistory === 'function') pushHistory();
  // Deliberately does NOT promise undo. The first version of this line said
  // "Undo puts them back" and a test showed it does not — the history snapshot
  // restores geometry and routes but not a location's icon styling, so undo
  // leaves every marker on the new frame and size. Telling somebody they can
  // undo a bulk change to twenty markers when they cannot is worse than saying
  // nothing, so the message states only what happened. Making undo cover these
  // fields is the real fix and is a separate piece of work.
  status('Style applied to ' + others.length + ' other location'
    + (others.length === 1 ? '' : 's') + '.');
}

/**
 * Build the location card's DOM (markup only, no event wiring). Split out of
 * buildLocCard() to keep both halves under the ~150-line guideline.
 * @param {object} loc
 * @returns {HTMLDivElement}
 */
function locCardMarkup(loc) {
        const card = document.createElement('div');
        card.className = 'item-card';
        // Lets anything outside this file find the card for a given location —
        // the boundary toggle repaints itself from the shapes on the map.
        card.dataset.locId = loc.id;
        card.innerHTML = `
    <div class="r">
      <!-- Plain input: enhanceColorInputs() wraps it in the swatch + picker,
           the same treatment every other colour control in the app gets. -->
      <input type="color" class="clr" value="${esc(loc.color)}" title="Pin / accent colour">
      <input type="text" class="nm grow" value="${esc(loc.name)}" placeholder="Name">
      <button class="x-btn" title="Delete">&times;</button>
    </div>
    <div class="r">
      <select class="tp" style="width:104px;flex:none;">
        <option value="pin">Location</option>
        <option value="site">Site ★</option>
        <option value="badge">Hwy badge</option>
      </select>
      <input type="text" class="coord grow" value="${fmtCoord(loc.lat, loc.lng)}" placeholder="Lat, Lng">
      <button class="mini-btn iconTgl" title="Icon &amp; style">🎨</button>
    </div>
    <div class="r">
      <label class="chk wrap"><input type="checkbox" class="hm" ${loc.hideMarker ? 'checked' : ''}> Hide marker — routing anchor only, no pin or label on the map</label>
    </div>
    <div class="r bt-row" style="display:none;">
      <input type="text" class="bt grow" value="${esc(loc.badgeText)}" placeholder="Badge text e.g. NH 66">
    </div>

    <div class="iconPanel" style="display:none;border-top:1px solid var(--stroke);padding-top:8px;margin-top:2px;">
      <div class="r"><span class="sub" style="width:52px;">Icon</span>
        <button type="button" class="icoBtn grow" title="Browse icons"></button>
        <button class="mini-btn upIcon" title="Upload custom PNG/SVG">📁</button>
        <button class="mini-btn clearIcon" title="Reset icon">✕</button>
        <input type="file" class="icoFile" accept="image/png,image/svg+xml,image/jpeg,image/webp" style="display:none;">
      </div>
      <div class="r customPreview" style="display:${loc.iconImage ? 'flex' : 'none'};">
        <span class="sub" style="width:52px;">Custom</span>
        <img class="cpreview" src="${loc.iconImage || ''}" style="width:36px;height:36px;border-radius:8px;background:#fff;padding:2px;object-fit:contain;">
      </div>
      <div class="r"><span class="sub" style="width:52px;">Frame</span>
        <select class="fr grow">
          <option value="pin" ${loc.iconFrame === 'pin' ? 'selected' : ''}>Map pin — symbol inside</option>
          <option value="circle" ${loc.iconFrame === 'circle' ? 'selected' : ''}>Circle</option>
          <option value="rounded" ${loc.iconFrame === 'rounded' ? 'selected' : ''}>Rounded square</option>
          <option value="square" ${loc.iconFrame === 'square' ? 'selected' : ''}>Square</option>
          <option value="none" ${loc.iconFrame === 'none' ? 'selected' : ''}>None — icon only</option>
        </select>
      </div>
      <div class="r"><span class="sub" style="width:52px;">Size</span>
        <input type="range" class="sz" min="22" max="72" step="1" value="${loc.iconSize}">
        <span class="pct sz-v" style="width:32px;">${loc.iconSize}</span>
      </div>
      <!-- Border and BG only style the frame, so they are hidden entirely when
           there isn't one. Leaving dead controls on screen invited people to
           drag a slider and conclude the app was broken when nothing moved. -->
      <div class="r frame-only"><span class="sub" style="width:52px;">Border</span>
        <input type="range" class="bw" min="0" max="6" step="1" value="${loc.iconBorder}" style="flex:1;">
        <input type="color" class="bc" value="${esc(loc.iconBorderColor)}" title="Border colour">
      </div>
      <div class="r frame-only"><span class="sub" style="width:52px;">Fill</span>
        <input type="color" class="ibg" value="${esc(loc.iconBg)}" title="Icon background">
      </div>
      <div class="r"><span class="sub" style="width:52px;">Shadow</span>
        <input type="range" class="ish" min="0" max="16" step="1" value="${loc.iconShadow}" style="flex:1;">
      </div>
      <div class="r icon-toggles">
        <label class="chk"><input type="checkbox" class="gl" ${loc.iconGlow ? 'checked' : ''}> Glow ring</label>
        <label class="chk"><input type="checkbox" class="uspl" ${loc.iconUseProjectLogo ? 'checked' : ''}> Use project logo</label>
      </div>
      <div class="r">
        <button class="mini-btn applyAll" title="Give every location this frame, size, border, fill, shadow and glow. Their own icons and colours are left alone.">⧉ Apply this style to all locations</button>
      </div>
    </div>

    <div class="ringsBox" style="display:flex;flex-direction:column;gap:5px;"></div>
    <div class="r">
      <button class="mini-btn addring" title="Add a catchment ring (radius circle)">+ Ring</button>
      <label class="chk"><input type="checkbox" class="sl" ${loc.showLabel ? 'checked' : ''}> Label</label>
      <input type="color" class="lbg" value="${esc(loc.labelBg)}" title="Label background color">
      <input type="range" class="lsz" min="50" max="220" step="5" value="${loc.labelScale == null ? 100 : loc.labelScale}" style="width:56px;flex:none;" title="This label's size, as a percentage of the global chip scale in Settings. Double-click to reset." aria-label="Label size for this location">
      <span class="sub lsz-v" style="width:34px;font-family:var(--mono);">${loc.labelScale == null ? 100 : loc.labelScale}%</span>
      <span class="grow"></span>
      <button class="mini-btn bnd" title="Draw this place's real boundary from OpenStreetMap">⬡ Boundary</button>
      <button class="mini-btn dup" title="Duplicate this location">⧉</button>
      <!-- Labelled, not a bare ⌖. This button was reported missing when it was
           present the whole time — clipped off the row, and unrecognisable even
           when visible. The row wraps now, which pays for the word. -->
      <button class="mini-btn ctr" title="Center the map on this location">⌖ Centre</button>
    </div>`;
        card.querySelector('.tp').value = loc.type;
        card.querySelector('.bt-row').style.display = loc.type === 'badge' ? '' : 'none';
        // Every colour control in this card gets the swatch + picker.
        enhanceColorInputs(card);
        return card;
      }

/**
 * Wire up every control in a location card built by locCardMarkup().
 * @param {HTMLDivElement} card
 * @param {object} loc
 */
function wireLocCard(card, loc) {
        const iconPanel = card.querySelector('.iconPanel');
        card.querySelector('.iconTgl').addEventListener('click', () => {
          iconPanel.style.display = iconPanel.style.display === 'none' ? 'block' : 'none';
        });

        card.querySelector('.clr').addEventListener('input', e => {
          const value = e.target.value;
          if (!loc.iconBorderColor || loc.iconBorderColor === loc.color) loc.iconBorderColor = value;
          loc.color = value;
          // The icon button previews the pin in this colour, so it has to follow.
          refreshIconButton(card, loc);
          locChanged(loc);
        });
        card.querySelector('.nm').addEventListener('change', e => { loc.name = e.target.value || 'Location'; locChanged(loc); });
        card.querySelector('.tp').addEventListener('change', e => {
          loc.type = e.target.value;
          card.querySelector('.bt-row').style.display = loc.type === 'badge' ? '' : 'none';
          if (loc.type === 'badge') {
            loc.color = '#F7C948';
            card.querySelector('.clr').value = '#F7C948';
          }
          if (loc.type === 'site') {
            loc.color = '#0A1E3C'; loc.labelBg = '#0A1E3C'; loc.iconBorderColor = '#FF7A1A';
            card.querySelector('.clr').value = '#0A1E3C'; card.querySelector('.lbg').value = '#0A1E3C'; card.querySelector('.bc').value = '#FF7A1A';
            if (!loc.iconImage) loc.iconKey = 'star';
          }
          // Values were assigned in code above, which fires no event — repaint
          // the swatches so they don't keep showing the previous colours.
          card.querySelectorAll('input[type="color"]').forEach(syncColorSwatch);
          refreshIconButton(card, loc);
          if (loc.type === 'site') {
            if (brand.siteUsesProjLogo) loc.iconUseProjectLogo = true;
            card.querySelector('.uspl').checked = loc.iconUseProjectLogo;
          }
          locChanged(loc);
        });
        card.querySelector('.bt').addEventListener('change', e => { loc.badgeText = e.target.value || 'NH'; locChanged(loc); });
        card.querySelector('.hm').addEventListener('change', e => {
          loc.hideMarker = e.target.checked;
          locChanged(loc);
          status(loc.hideMarker ? 'Marker hidden — this point still anchors any route connected to it.' : 'Marker restored.');
        });
        card.querySelector('.coord').addEventListener('change', e => {
          const c = parseCoord(e.target.value);
          if (!c) {
            status('Coordinates must be "lat, lng" (e.g. 15.28500, 73.95800) or DMS with N/S/E/W (e.g. 19°22\'37.1"N 73°10\'10.4"E)');
            e.target.value = fmtCoord(loc.lat, loc.lng);
            return;
          }
          loc.lat = c[0]; loc.lng = c[1]; locChanged(loc); recomputeRoutesTouching(loc.id);
          // Repaint in canonical decimal even on success — otherwise a DMS
          // string sits in a field meant to show decimal degrees until the
          // card happens to rebuild for some unrelated reason.
          e.target.value = fmtCoord(loc.lat, loc.lng);
        });
        refreshIconButton(card, loc);
        card.querySelector('.icoBtn').addEventListener('click', () => {
          openIconPicker(loc, key => {
            loc.iconKey = key;
            // A built-in icon and an uploaded one are the same slot on the map,
            // so choosing from the library clears any upload rather than
            // leaving an invisible override in place.
            loc.iconImage = null;
            card.querySelector('.customPreview').style.display = 'none';
            refreshIconButton(card, loc);
            locChanged(loc);
          });
        });
        /** Border/fill style the frame, so they only apply when there is one. */
        const syncFrameControls = () => {
          const framed = (loc.iconFrame || 'none') !== 'none';
          card.querySelectorAll('.frame-only').forEach(r => { r.style.display = framed ? '' : 'none'; });
        };
        syncFrameControls();
        card.querySelector('.fr').addEventListener('change', e => {
          loc.iconFrame = e.target.value;
          syncFrameControls();
          locChanged(loc);
        });
        card.querySelector('.sz').addEventListener('input', e => { loc.iconSize = +e.target.value; card.querySelector('.sz-v').textContent = loc.iconSize; renderLocPin(loc); });
        card.querySelector('.bw').addEventListener('input', e => { loc.iconBorder = +e.target.value; renderLocPin(loc); });
        card.querySelector('.bc').addEventListener('input', e => { loc.iconBorderColor = e.target.value; renderLocPin(loc); });
        card.querySelector('.ibg').addEventListener('input', e => { loc.iconBg = e.target.value; renderLocPin(loc); });
        card.querySelector('.ish').addEventListener('input', e => { loc.iconShadow = +e.target.value; renderLocPin(loc); });
        card.querySelector('.gl').addEventListener('change', e => { loc.iconGlow = e.target.checked; renderLocPin(loc); });
        card.querySelector('.uspl').addEventListener('change', e => { loc.iconUseProjectLogo = e.target.checked; locChanged(loc); });
        const applyAllBtn = card.querySelector('.applyAll');
        if (applyAllBtn) applyAllBtn.addEventListener('click', () => applyIconStyleToAll(loc));

        // Custom icon upload
        const upBtn = card.querySelector('.upIcon');
        const clrBtn = card.querySelector('.clearIcon');
        const upIn = card.querySelector('.icoFile');
        upBtn.addEventListener('click', () => upIn.click());
        clrBtn.addEventListener('click', () => {
          loc.iconImage = null;
          card.querySelector('.customPreview').style.display = 'none';
          locChanged(loc); status('Icon reset.');
        });
        upIn.addEventListener('change', e => {
          const f = e.target.files[0]; if (!f) return;
          const rd = new FileReader();
          rd.onload = () => {
            const dataUrl = rd.result;
            if (f.type === 'image/svg+xml') {
              // Store SVG directly as data URL (transparent-friendly)
              loc.iconImage = dataUrl;
              card.querySelector('.cpreview').src = dataUrl;
              card.querySelector('.customPreview').style.display = 'flex';
              locChanged(loc); status('Custom SVG icon set.');
            } else {
              const img = new Image();
              img.onload = () => {
                const cv = document.createElement('canvas');
                const target = 192;
                const s = Math.min(1, target / Math.max(img.width, img.height));
                cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
                cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
                loc.iconImage = cv.toDataURL('image/png');
                card.querySelector('.cpreview').src = loc.iconImage;
                card.querySelector('.customPreview').style.display = 'flex';
                locChanged(loc); status('Custom icon set (transparency preserved).');
              };
              img.src = dataUrl;
            }
          };
          rd.readAsDataURL(f);
          e.target.value = '';
        });

        card.querySelector('.addring').addEventListener('click', () => {
          loc.rings.push({ km: '3', color: loc.color === '#0A1E3C' ? '#FF7A1A' : loc.color, op: .08 });
          renderRingRows(loc); updateRings(loc);
        });
        card.querySelector('.sl').addEventListener('change', e => { loc.showLabel = e.target.checked; updateLocLabel(loc); scheduleRepaint(); });
        card.querySelector('.lbg').addEventListener('input', e => { loc.labelBg = e.target.value; updateLocLabel(loc); scheduleRepaint(); });
        const lsz = card.querySelector('.lsz');
        lsz.addEventListener('input', e => {
          loc.labelScale = +e.target.value;
          card.querySelector('.lsz-v').textContent = loc.labelScale + '%';
          // Not a full re-render: the size is a CSS variable on the element that
          // is already there, so nothing has to be rebuilt to change it.
          applyLabelScale(loc);
          scheduleRepaint();
        });
        // Back to following Settings, without hunting for exactly 100 on a
        // 5-step slider.
        lsz.addEventListener('dblclick', () => {
          loc.labelScale = 100;
          lsz.value = 100;
          card.querySelector('.lsz-v').textContent = '100%';
          applyLabelScale(loc);
          scheduleRepaint();
        });
        card.querySelector('.bnd').addEventListener('click', e => toggleBoundaryForLocation(loc, e.currentTarget));
        card.querySelector('.ctr').addEventListener('click', () => map.flyTo([loc.lat, loc.lng], Math.max(map.getZoom(), 15)));
        card.querySelector('.dup').addEventListener('click', () => {
          addLocation(Object.assign({}, loc, {
            id: 0, name: loc.name + ' copy',
            labelOffset: { x: loc.labelOffset.x + 14, y: loc.labelOffset.y + 14 },
            rings: JSON.parse(JSON.stringify(loc.rings || [])),
            _pinEl: null, _labelEl: null, _el: null, _ringLabelEls: [], ringLayers: [], ringLabels: [], anchor: null, card: null, marker: null
          }));
          status('Location duplicated.');
        });
        card.querySelector('.x-btn').addEventListener('click', () => deleteLocation(loc));

        loc.card = card;
        // The other half of the map/list link: hovering a card lights its pin,
        // clicking the card selects and flies to it.
        card.addEventListener('pointerenter', () => setLocationHover(loc, true));
        card.addEventListener('pointerleave', () => setLocationHover(loc, false));
        $('locList').appendChild(card);
        renderRingRows(loc);
      }

      /**
       * Build and wire a location's sidebar card, then append it to the list.
       * @param {object} loc
       */
      function buildLocCard(loc) {
        const card = locCardMarkup(loc);
        wireLocCard(card, loc);
        // A routing anchor gets a card like everything else, and then that card
        // is hidden. Building it and hiding it, rather than skipping it, keeps
        // every `loc.card.querySelector(…)` in the codebase valid — markers.js,
        // toolbar.js and layerManager.js all dereference it without checking,
        // and one hidden node per traced road is cheaper than auditing them all
        // and hoping nobody adds a fourth.
        if (loc.routeAnchor && loc.card) {
          loc.card.style.display = 'none';
          loc.card.dataset.routeAnchor = '1';
        }
      }

      function locOptions(sel) {
        // Anchors are hidden, EXCEPT the one this select currently holds. Drop
        // that too and the browser silently selects the first remaining option
        // — so a traced road's dropdown would show an unrelated location, and
        // the next `change` event would quietly repoint the road to it.
        return locations
          .filter(l => !l.routeAnchor || l.id === sel)
          .map(l => `<option value="${l.id}" ${sel === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
      }
      function refreshRouteSelects() {
        routes.forEach(rt => {
          if (!rt.card) return;
          rt.card.querySelector('.from').innerHTML = locOptions(rt.fromId);
          rt.card.querySelector('.to').innerHTML = locOptions(rt.toId);
        });
      }
      function buildRtCard(rt) {
        const card = document.createElement('div');
        card.className = 'item-card';
        card.innerHTML = `
    <div class="r">
      <input type="color" class="clr" value="${esc(rt.color)}" title="Route color">
      <select class="from grow">${locOptions(rt.fromId)}</select>
      <span class="arrow">→</span>
      <select class="to grow">${locOptions(rt.toId)}</select>
      <button class="x-btn" title="Delete">&times;</button>
    </div>
    <div class="r">
      <select class="md" style="width:86px;flex:none;">
        <option value="car">🚗 Drive</option>
        <option value="bike">🚲 Bike</option>
        <option value="foot">🚶 Walk</option>
      </select>
      <input type="text" class="lt grow" value="${esc(rt.labelText)}" placeholder="Custom label (empty = auto km/min)">
    </div>
    <div class="r">
      <span class="sub">Type</span>
      <select class="cls grow" title="What kind of road this is. Under the Connectivity layout the type decides the colour, so the same road is the same colour in every report."></select>
      <span class="rt-deviates" style="display:none;">custom colour</span>
      <button class="mini-btn rstd" title="Put this route back to its type's standard colour" style="display:none;">↺</button>
    </div>
    <div class="r">
      <span class="sub">Width</span><input type="range" class="wt" min="2" max="10" step="1" value="${rt.weight}" style="width:52px;flex:none;">
      <span class="sub">Shift</span><input type="range" class="of" min="-18" max="18" step="1" value="${rt.offsetPx}" title="Sideways shift so overlapping routes stay visible" style="width:52px;flex:none;">
      <label class="chk"><input type="checkbox" class="ds" ${rt.dash ? 'checked' : ''}> Dash</label>
      <span class="grow"></span>
      <button class="mini-btn alt" title="Cycle alternative routes">⇆ 1/1</button>
      <button class="mini-btn rf" title="Recompute route">↻</button>
    </div>
    <div class="r">
      <label class="chk"><input type="checkbox" class="sl" ${rt.showLabel ? 'checked' : ''}> Label</label>
      <input type="color" class="lbg" value="${esc(rt.labelBg)}" title="Label background color">
      <input type="range" class="lsz" min="50" max="220" step="5" value="${rt.labelScale == null ? 100 : rt.labelScale}" style="width:56px;flex:none;" title="This label's size, as a percentage of the global chip scale in Settings. Double-click to reset." aria-label="Label size for this route">
      <span class="sub lsz-v" style="width:34px;font-family:var(--mono);">${rt.labelScale == null ? 100 : rt.labelScale}%</span>
      <span class="grow"></span>
      <button class="mini-btn dup" title="Duplicate route">⧉</button>
      <button class="mini-btn zm" title="Zoom to this route">⌖</button>
      <span class="stats">…</span>
    </div>
    <div class="r via-row">
      <button class="mini-btn vAdd" title="Force this route through a waypoint you click on the map">+ Via-point</button>
      <button class="mini-btn vClear" title="Remove all waypoints from this route" style="display:none;">Clear vias</button>
      <label class="chk vDots" style="display:none;" title="Hide the waypoint dots on the map. The route still goes through them — this only stops them being drawn, and keeps them out of exports."><input type="checkbox" class="vShow" ${rt.viaHidden ? '' : 'checked'}> Dots</label>
      <span class="grow"></span>
      <span class="sub via-count" style="font-family:var(--mono);"></span>
    </div>`;
        card.querySelector('.md').value = rt.mode;

        /* ---- road class: the colour standard's handle on this route ---- */
        const clsSel = card.querySelector('.cls');
        if (clsSel && typeof connLineClasses === 'function') {
          clsSel.innerHTML = '<option value="">— No type (free colour) —</option>'
            + connLineClasses().map(([id, label]) =>
              `<option value="${id}" ${rt.cls === id ? 'selected' : ''}>${esc(label)}</option>`).join('');
        }
        /**
         * Keep the colour control honest about who owns the colour.
         *
         * Under the Connectivity layout a typed road's colour is the type's,
         * full stop — the picker is disabled and shows it. A standard that can
         * be nudged with a colour drag is not a standard; it is a default, and
         * defaults are exactly what produced "the same road is a different
         * colour in every report".
         *
         * The escape is the Type dropdown's "No type (free colour)", not a
         * hidden override: coming off the standard should be a decision you can
         * see on the card and in the legend, not a colour that drifted.
         */
        function syncRtStandard() {
          const dev = typeof connRouteDeviates === 'function' && connRouteDeviates(rt);
          const note = card.querySelector('.rt-deviates');
          const rst = card.querySelector('.rstd');
          const clr = card.querySelector('.clr');
          const locked = typeof connStandardOn === 'function' && connStandardOn() && !!rt.cls;
          if (clr && typeof setColorInputLocked === 'function') {
            setColorInputLocked(clr, locked, locked
              ? 'Set by the road type under the Connectivity layout. To choose a colour freely,'
                + ' set Type to "No type".'
              : 'Route colour');
          }
          // A locked route cannot deviate, so the note and its reset are only
          // ever for free-colour routes and for the Satellite layout.
          if (note) note.style.display = dev && !locked ? '' : 'none';
          if (rst) rst.style.display = dev && !locked ? '' : 'none';
        }
        if (clsSel) {
          clsSel.addEventListener('change', e => {
            rt.cls = e.target.value || null;
            // Picking a type always restyles: choosing "Metro" and staying the
            // old colour would make the control look broken.
            if (typeof connApplyToRoute === 'function') connApplyToRoute(rt, { force: true });
            drawRoute(rt); rebuildLegend(); syncRtStandard();
          });
        }
        const rstBtn = card.querySelector('.rstd');
        if (rstBtn) {
          rstBtn.addEventListener('click', () => {
            if (typeof connApplyToRoute === 'function') connApplyToRoute(rt, { force: true });
            const c = card.querySelector('.clr');
            if (c) c.value = rt.color;
            drawRoute(rt); rebuildLegend(); syncRtStandard();
          });
        }
        // Hung off the card so a layout change can re-sync every route's lock
        // without rebuilding the list — the cards hold live listeners and
        // in-progress edits, and throwing them away to flip one disabled flag
        // would discard a half-typed label.
        card._syncStandard = syncRtStandard;
        setTimeout(syncRtStandard, 0);

        card.querySelector('.clr').addEventListener('input', e => {
          rt.color = e.target.value; drawRoute(rt); rebuildLegend(); syncRtStandard();
        });
        card.querySelector('.from').addEventListener('change', e => { rt.fromId = parseInt(e.target.value, 10); rt.altIndex = 0; computeRoute(rt); });
        card.querySelector('.to').addEventListener('change', e => { rt.toId = parseInt(e.target.value, 10); rt.altIndex = 0; computeRoute(rt); });
        card.querySelector('.md').addEventListener('change', e => { rt.mode = e.target.value; rt.altIndex = 0; computeRoute(rt); });
        card.querySelector('.lt').addEventListener('change', e => { rt.labelText = e.target.value; drawRoute(rt); rebuildLegend(); });
        card.querySelector('.wt').addEventListener('input', e => { rt.weight = parseInt(e.target.value, 10); if (rt.line) rt.line.setStyle({ weight: rt.weight }); });
        card.querySelector('.of').addEventListener('input', e => { rt.offsetPx = parseInt(e.target.value, 10); drawRoute(rt); });
        card.querySelector('.ds').addEventListener('change', e => { rt.dash = e.target.checked; drawRoute(rt); });
        card.querySelector('.sl').addEventListener('change', e => { rt.showLabel = e.target.checked; drawRoute(rt); });
        card.querySelector('.lbg').addEventListener('input', e => { rt.labelBg = e.target.value; drawRoute(rt); });
        const rlsz = card.querySelector('.lsz');
        rlsz.addEventListener('input', e => {
          rt.labelScale = +e.target.value;
          card.querySelector('.lsz-v').textContent = rt.labelScale + '%';
          applyLabelScale(rt);
          scheduleRepaint();
        });
        rlsz.addEventListener('dblclick', () => {
          rt.labelScale = 100;
          rlsz.value = 100;
          card.querySelector('.lsz-v').textContent = '100%';
          applyLabelScale(rt);
          scheduleRepaint();
        });
        card.querySelector('.alt').addEventListener('click', () => {
          if (!rt.alts || rt.alts.length < 2) { status('Only one route was found between these points.'); return; }
          rt.altIndex = (rt.altIndex + 1) % rt.alts.length;
          drawRoute(rt); rebuildLegend();
        });
        card.querySelector('.rf').addEventListener('click', () => { rt.altIndex = 0; computeRoute(rt); });
        card.querySelector('.zm').addEventListener('click', () => {
          if (rt.line) map.fitBounds(rt.line.getBounds(), { padding: [70, 70] });
        });
        card.querySelector('.vShow').addEventListener('change', e => {
          setViaDotsVisible(rt, e.target.checked);
          status(e.target.checked
            ? 'Waypoint dots shown.'
            : 'Waypoint dots hidden — the route still runs through them.');
        });
        card.querySelector('.vAdd').addEventListener('click', () => armViaAdd(rt));
        card.querySelector('.vClear').addEventListener('click', () => {
          if (!rt.viaPoints || !rt.viaPoints.length) return;
          rt.viaPoints = [];
          computeRoute(rt);
          updateRtCardStats(rt);
          status('Via-points cleared — routing is back to auto.');
        });
        card.querySelector('.dup').addEventListener('click', () => {
          addRoute({
            fromId: rt.fromId, toId: rt.toId, mode: rt.mode, color: rt.color, weight: rt.weight, dash: rt.dash,
            offsetPx: (rt.offsetPx || 0) + 6, labelText: rt.labelText, showLabel: rt.showLabel, labelBg: rt.labelBg,
            labelOffset: { x: rt.labelOffset.x + 14, y: rt.labelOffset.y + 14 },
            viaPoints: (rt.viaPoints || []).map(v => ({ lat: v.lat, lng: v.lng }))
          });
          status('Route duplicated (shifted sideways so both stay visible).');
        });
        // Undo lives on the button, not inside deleteRoute() — that is also
        // called for every route attached to a location being deleted, and
        // one toast per cascaded route would bury the one that matters (the
        // location's own, which already restores these).
        card.querySelector('.x-btn').addEventListener('click', () => {
          const snapshot = serialiseRoute(rt);
          // A traced road's endpoints go with it, because deleteRoute sweeps
          // them. Without this the undo restores a route whose fromId/toId
          // point at nothing: the line still draws from its saved geometry, so
          // it *looks* restored, while computeRoute bails, ↻ does nothing, and
          // the row disappears from Key Distances. Anchors first, then the
          // route — ids are restored, not regenerated, which is the same
          // ordering deleteLocation's undo relies on.
          const anchors = [rt.fromId, rt.toId]
            .map(id => locById(id))
            .filter(l => l && l.routeAnchor)
            .map(serialiseLocation);
          const label = rt.labelText || routeLabelText(rt) || 'route';
          deleteRoute(rt);
          status(`Deleted ${label}.`, false, {
            label: 'Undo',
            onClick: () => {
              anchors.forEach(a => { if (!locById(a.id)) addLocation(a); });
              addRoute(snapshot);
              rebuildLegend(); syncEmpties(); scheduleRepaint();
              if (typeof refreshLayers === 'function') refreshLayers();
              status(`Restored ${label}.`);
            },
          });
        });
        rt.card = card;
        enhanceColorInputs(card);
        $('rtList').appendChild(card);
      }
      function updateRtCardStats(rt) {
        if (!rt.card) return;
        rt.card.querySelector('.stats').textContent = routeAutoText(rt);
        rt.card.querySelector('.alt').textContent = '⇆ ' + ((rt.altIndex || 0) + 1) + '/' + (rt.alts ? rt.alts.length : 1);
        const vc = (rt.viaPoints || []).length;
        const vClear = rt.card.querySelector('.vClear');
        const vCount = rt.card.querySelector('.via-count');
        if (vClear) vClear.style.display = vc ? '' : 'none';
        // Only offered when there is something to hide: a Dots checkbox on a
        // route with no waypoints is a control with nothing to control.
        const vDots = rt.card.querySelector('.vDots');
        if (vDots) vDots.style.display = vc ? '' : 'none';
        if (vCount) vCount.textContent = vc ? (vc + ' via-point' + (vc > 1 ? 's' : '')) : '';
      }
      // ---------- legend ----------
      /* legendRows() and rebuildLegend() moved to ui/legendTable.js when the
         Key Distances card became editable — see that file. They kept their
         names because a dozen call sites here and in map/routes.js already say
         them. */

      function syncEmpties() {
        $('locEmpty').style.display = realLocations().length ? 'none' : '';
        $('rtEmpty').style.display = routes.length ? 'none' : '';
        // The one place every add and remove already funnels through, so the
        // colour swatches cannot drift out of step with the locations they
        // describe. Same hook syncGeomEmpty() uses for shapes.
        if (typeof renderLocGroups === 'function') renderLocGroups();
      }
      /** Wire the legend card's drag handle so it can be repositioned. */
      /**
       * The key-distances card's drag, from its whole header bar.
       *
       * Same treatment the colour key got, and for the same reason: the grip is
       * a 12px target and the map's search button floats over that corner with a
       * higher z-index, so parking the card there made it unmovable with nothing
       * on screen to explain why. A 4px movement threshold means a click still
       * places the caret in the editable title while any real drag moves the
       * card.
       */
      function initLegendDrag() {
        const cardEl = $('legendCard');
        const hd = cardEl && cardEl.querySelector('.hd');
        const wrap = $('mapWrap');
        if (!cardEl || !hd || !wrap) return;
        hd.style.cursor = 'move';
        let sx = 0, sy = 0, ox = 0, oy = 0, armed = false, dragging = false;

        hd.addEventListener('pointerdown', e => {
          if (e.target.closest('#legendEditBtn')) return;   // a button, not a bar
          const r = cardEl.getBoundingClientRect(), w = wrap.getBoundingClientRect();
          ox = r.left - w.left; oy = r.top - w.top; sx = e.clientX; sy = e.clientY;
          armed = true; dragging = false;
        });

        hd.addEventListener('pointermove', e => {
          if (!armed) return;
          if (!dragging) {
            if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 4) return;
            dragging = true;
            cardEl.style.right = 'auto';
            cardEl.style.bottom = 'auto';
            // Or the browser selects the title text as the pointer crosses it.
            if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
            try { hd.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
          }
          cardEl.style.left = (ox + e.clientX - sx) + 'px';
          cardEl.style.top = (oy + e.clientY - sy) + 'px';
          e.preventDefault();
        });

        const stop = () => { armed = false; dragging = false; };
        hd.addEventListener('pointerup', stop);
        hd.addEventListener('pointercancel', stop);
      }

      function setProjectLogo(dataUrl) {
        brand.projectLogo = dataUrl;
        const im = $('projectLogoImg'), emp = $('projectLogoEmpty');
        if (dataUrl) { im.src = dataUrl; im.style.display = ''; emp.style.display = 'none'; }
        else { im.style.display = 'none'; emp.style.display = ''; im.removeAttribute('src'); }
        // Re-render any locations using project logo
        locations.forEach(l => { if (l.iconUseProjectLogo) renderLocPin(l); if (l.iconUseProjectLogo && l.showLabel) updateLocLabel(l); });
        scheduleRepaint();
      }
      // NO LOGO UNTIL SOMEBODY PICKS ONE. This used to seed the DBOT mark, so
      // every project began branded whether or not that was wanted — and a pin
      // set to "use the project logo" carried it onto the map by default. The
      // upload control is unchanged and the DBOT mark is one click away in the
      // picker; it is the DEFAULT that was wrong, not the option.
      setProjectLogo(null);
      $('uploadProjLogoBtn').addEventListener('click', () => $('projLogoInput').click());
      $('projLogoInput').addEventListener('change', e => {
        const f = e.target.files[0]; if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          if (f.type === 'image/svg+xml') setProjectLogo(rd.result);
          else {
            const img = new Image();
            img.onload = () => {
              const cv = document.createElement('canvas');
              const s = Math.min(1, 480 / Math.max(img.width, img.height));
              cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
              cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
              setProjectLogo(cv.toDataURL('image/png'));
            };
            img.src = rd.result;
          }
          status('Project logo updated.');
        };
        rd.readAsDataURL(f);
        e.target.value = '';
      });
      // It always set the DBOT mark rather than clearing anything, which was a
      // button labelled "Reset" that added a logo. Now that a project starts
      // with none, the honest name for what it does is what it does.
      $('clearProjLogoBtn').addEventListener('click', () => {
        setProjectLogo('data:image/png;base64,' + LOGO_B64);
        status('Using the DBOT mark as the project logo.');
      });
      $('siteUsesProjLogo').addEventListener('change', e => {
        brand.siteUsesProjLogo = e.target.checked;
        locations.forEach(l => {
          if (l.type === 'site') {
            l.iconUseProjectLogo = brand.siteUsesProjLogo;
            if (l.card) { const cb = l.card.querySelector('.uspl'); if (cb) cb.checked = brand.siteUsesProjLogo; }
            renderLocPin(l); updateLocLabel(l);
          }
        });
        scheduleRepaint();
        status(brand.siteUsesProjLogo ? 'All Site pins now use the project logo.' : 'Site pins reverted to their per-location icons.');
      });
      $('brandTitleInput').addEventListener('input', e => { $('titleCard').textContent = e.target.value || 'PROPERTY LOCATION & ACCESS'; });

