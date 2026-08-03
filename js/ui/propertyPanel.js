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
      <button class="x-btn" title="Remove ring">&times;</button>`;
          row.querySelector('.rkm').addEventListener('change', e => { r.km = e.target.value; updateRings(loc); });
          row.querySelector('.rclr').addEventListener('input', e => { r.color = e.target.value; updateRings(loc); });
          row.querySelector('.rop').addEventListener('input', e => {
            r.op = (+e.target.value) / 100;
            row.querySelector('.pct').textContent = e.target.value + '%';
            updateRings(loc);
          });
          row.querySelector('.x-btn').addEventListener('click', () => { loc.rings.splice(idx, 1); renderRingRows(loc); updateRings(loc); });
          box.appendChild(row);
        });
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
        card.innerHTML = `
    <div class="r">
      <button type="button" class="clrBtn" title="Pin / accent colour" style="--sw:${esc(loc.color)}"></button>
      <input type="color" class="clr" value="${esc(loc.color)}" hidden>
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
      <div class="r"><span class="sub" style="width:52px;">Border</span>
        <input type="range" class="bw" min="0" max="6" step="1" value="${loc.iconBorder}" style="flex:1;">
        <input type="color" class="bc" value="${esc(loc.iconBorderColor)}" title="Border color">
      </div>
      <div class="r"><span class="sub" style="width:52px;">BG</span>
        <input type="color" class="ibg" value="${esc(loc.iconBg)}" title="Icon background">
        <span class="sub">Shadow</span>
        <input type="range" class="ish" min="0" max="16" step="1" value="${loc.iconShadow}" style="flex:1;">
      </div>
      <div class="r">
        <label class="chk"><input type="checkbox" class="gl" ${loc.iconGlow ? 'checked' : ''}> Glow ring</label>
        <span class="grow"></span>
        <label class="chk"><input type="checkbox" class="uspl" ${loc.iconUseProjectLogo ? 'checked' : ''}> Use project logo</label>
      </div>
    </div>

    <div class="ringsBox" style="display:flex;flex-direction:column;gap:5px;"></div>
    <div class="r">
      <button class="mini-btn addring" title="Add a catchment ring (radius circle)">+ Ring</button>
      <label class="chk"><input type="checkbox" class="sl" ${loc.showLabel ? 'checked' : ''}> Label</label>
      <input type="color" class="lbg" value="${esc(loc.labelBg)}" title="Label background color">
      <span class="grow"></span>
      <button class="mini-btn dup" title="Duplicate this location">⧉</button>
      <button class="mini-btn ctr" title="Center map here">⌖</button>
    </div>`;
        card.querySelector('.tp').value = loc.type;
        card.querySelector('.bt-row').style.display = loc.type === 'badge' ? '' : 'none';
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

        /** Apply a colour from either the preset grid or the OS colour dialog. */
        const applyLocColor = value => {
          if (!loc.iconBorderColor || loc.iconBorderColor === loc.color) loc.iconBorderColor = value;
          loc.color = value;
          card.querySelector('.clr').value = value;
          card.querySelector('.clrBtn').style.setProperty('--sw', value);
          // The icon button previews the pin in this colour, so it has to follow.
          refreshIconButton(card, loc);
          locChanged(loc);
        };
        card.querySelector('.clr').addEventListener('input', e => applyLocColor(e.target.value));
        card.querySelector('.clrBtn').addEventListener('click', e => {
          openColorPresets(e.currentTarget, loc.color, applyLocColor);
        });
        card.querySelector('.nm').addEventListener('change', e => { loc.name = e.target.value || 'Location'; locChanged(loc); });
        card.querySelector('.tp').addEventListener('change', e => {
          loc.type = e.target.value;
          card.querySelector('.bt-row').style.display = loc.type === 'badge' ? '' : 'none';
          if (loc.type === 'badge') {
            loc.color = '#F7C948';
            card.querySelector('.clr').value = '#F7C948';
            card.querySelector('.clrBtn').style.setProperty('--sw', '#F7C948');
          }
          if (loc.type === 'site') {
            loc.color = '#0A1E3C'; loc.labelBg = '#0A1E3C'; loc.iconBorderColor = '#FF7A1A';
            card.querySelector('.clr').value = '#0A1E3C'; card.querySelector('.lbg').value = '#0A1E3C'; card.querySelector('.bc').value = '#FF7A1A';
            card.querySelector('.clrBtn').style.setProperty('--sw', '#0A1E3C');
            if (!loc.iconImage) loc.iconKey = 'star';
          }
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
          if (!c) { status('Coordinates must be "lat, lng" — e.g. 15.28500, 73.95800'); e.target.value = fmtCoord(loc.lat, loc.lng); return; }
          loc.lat = c[0]; loc.lng = c[1]; locChanged(loc); recomputeRoutesTouching(loc.id);
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
        card.querySelector('.fr').addEventListener('change', e => { loc.iconFrame = e.target.value; locChanged(loc); });
        card.querySelector('.sz').addEventListener('input', e => { loc.iconSize = +e.target.value; card.querySelector('.sz-v').textContent = loc.iconSize; renderLocPin(loc); });
        card.querySelector('.bw').addEventListener('input', e => { loc.iconBorder = +e.target.value; renderLocPin(loc); });
        card.querySelector('.bc').addEventListener('input', e => { loc.iconBorderColor = e.target.value; renderLocPin(loc); });
        card.querySelector('.ibg').addEventListener('input', e => { loc.iconBg = e.target.value; renderLocPin(loc); });
        card.querySelector('.ish').addEventListener('input', e => { loc.iconShadow = +e.target.value; renderLocPin(loc); });
        card.querySelector('.gl').addEventListener('change', e => { loc.iconGlow = e.target.checked; renderLocPin(loc); });
        card.querySelector('.uspl').addEventListener('change', e => { loc.iconUseProjectLogo = e.target.checked; locChanged(loc); });

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
      }

      function locOptions(sel) {
        return locations.map(l => `<option value="${l.id}" ${sel === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
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
      <span class="grow"></span>
      <button class="mini-btn dup" title="Duplicate route">⧉</button>
      <button class="mini-btn zm" title="Zoom to this route">⌖</button>
      <span class="stats">…</span>
    </div>
    <div class="r via-row">
      <button class="mini-btn vAdd" title="Force this route through a waypoint you click on the map">+ Via-point</button>
      <button class="mini-btn vClear" title="Remove all waypoints from this route" style="display:none;">Clear vias</button>
      <span class="grow"></span>
      <span class="sub via-count" style="font-family:var(--mono);"></span>
    </div>`;
        card.querySelector('.md').value = rt.mode;
        card.querySelector('.clr').addEventListener('input', e => { rt.color = e.target.value; drawRoute(rt); rebuildLegend(); });
        card.querySelector('.from').addEventListener('change', e => { rt.fromId = parseInt(e.target.value, 10); rt.altIndex = 0; computeRoute(rt); });
        card.querySelector('.to').addEventListener('change', e => { rt.toId = parseInt(e.target.value, 10); rt.altIndex = 0; computeRoute(rt); });
        card.querySelector('.md').addEventListener('change', e => { rt.mode = e.target.value; rt.altIndex = 0; computeRoute(rt); });
        card.querySelector('.lt').addEventListener('change', e => { rt.labelText = e.target.value; drawRoute(rt); rebuildLegend(); });
        card.querySelector('.wt').addEventListener('input', e => { rt.weight = parseInt(e.target.value, 10); if (rt.line) rt.line.setStyle({ weight: rt.weight }); });
        card.querySelector('.of').addEventListener('input', e => { rt.offsetPx = parseInt(e.target.value, 10); drawRoute(rt); });
        card.querySelector('.ds').addEventListener('change', e => { rt.dash = e.target.checked; drawRoute(rt); });
        card.querySelector('.sl').addEventListener('change', e => { rt.showLabel = e.target.checked; drawRoute(rt); });
        card.querySelector('.lbg').addEventListener('input', e => { rt.labelBg = e.target.value; drawRoute(rt); });
        card.querySelector('.alt').addEventListener('click', () => {
          if (!rt.alts || rt.alts.length < 2) { status('Only one route was found between these points.'); return; }
          rt.altIndex = (rt.altIndex + 1) % rt.alts.length;
          drawRoute(rt); rebuildLegend();
        });
        card.querySelector('.rf').addEventListener('click', () => { rt.altIndex = 0; computeRoute(rt); });
        card.querySelector('.zm').addEventListener('click', () => {
          if (rt.line) map.fitBounds(rt.line.getBounds(), { padding: [70, 70] });
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
        card.querySelector('.x-btn').addEventListener('click', () => deleteRoute(rt));
        rt.card = card;
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
        if (vCount) vCount.textContent = vc ? (vc + ' via-point' + (vc > 1 ? 's' : '')) : '';
      }
      // ---------- legend ----------
      function legendRows() {
        const rows = [];
        routes.forEach(rt => {
          const A = locById(rt.fromId), B = locById(rt.toId);
          if (!A || !B || !rt.alts) return;
          const alt = rt.alts[rt.altIndex];
          const name = rt.labelText && rt.labelText.trim() ? rt.labelText
            : (A.type === 'site' ? B.name : A.name + ' → ' + B.name);
          rows.push({ color: rt.color, name: name, km: (alt.d / 1000).toFixed(1) + ' km', min: alt.t ? Math.round(alt.t / 60) + ' min' : '—' });
        });
        return rows;
      }
      function rebuildLegend() {
        const body = $('legendBody');
        body.innerHTML = '';
        legendRows().forEach(r => {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td><span class="swatch" style="background:${esc(r.color)}"></span></td>
      <td>${esc(r.name)}</td><td class="num">${esc(r.km)}</td><td class="num">${esc(r.min)}</td>`;
          body.appendChild(tr);
        });
        $('legendCard').style.display = ($('legendTgl').checked && body.children.length) ? '' : 'none';
      }
      function syncEmpties() {
        $('locEmpty').style.display = locations.length ? 'none' : '';
        $('rtEmpty').style.display = routes.length ? 'none' : '';
      }
      /** Wire the legend card's drag handle so it can be repositioned. */
      function initLegendDrag() {
        const cardEl = $('legendCard'), hd = $('legendDrag'), wrap = $('mapWrap');
        let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
        hd.addEventListener('pointerdown', e => {
          dragging = true;
          const r = cardEl.getBoundingClientRect(), w = wrap.getBoundingClientRect();
          ox = r.left - w.left; oy = r.top - w.top; sx = e.clientX; sy = e.clientY;
          cardEl.style.right = 'auto'; cardEl.style.bottom = 'auto';
          hd.setPointerCapture(e.pointerId);
          e.preventDefault();
        });
        hd.addEventListener('pointermove', e => {
          if (!dragging) return;
          cardEl.style.left = (ox + e.clientX - sx) + 'px';
          cardEl.style.top = (oy + e.clientY - sy) + 'px';
        });
        hd.addEventListener('pointerup', () => { dragging = false; });
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
      // Default project logo to the embedded DBOT
      setProjectLogo('data:image/png;base64,' + LOGO_B64);
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
      $('clearProjLogoBtn').addEventListener('click', () => {
        setProjectLogo('data:image/png;base64,' + LOGO_B64);
        status('Project logo reset to DBOT default.');
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

