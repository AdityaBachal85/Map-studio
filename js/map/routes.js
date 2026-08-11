/**
 * map/routes.js — route lifecycle: OSRM routing with fallbacks, drawing,
 * via-points (arm/place/drag), alternatives, deletion, recompute-on-move.
 */












      // ---------- routes ----------
      function routeAutoText(rt) {
        const alt = rt.alts && rt.alts[rt.altIndex];
        if (!alt) return '…';
        const km = (alt.d / 1000).toFixed(1) + ' km';
        return rt.approx ? km + ' (direct)' : km + ' • ' + Math.round(alt.t / 60) + ' min';
      }
      function routeLabelText(rt) { return rt.labelText && rt.labelText.trim() ? rt.labelText : routeAutoText(rt); }
      function drawRoute(rt) {
        if (rt.line) map.removeLayer(rt.line);
        if (rt._labelEl) { removeBB(rt._labelEl); rt._labelEl = null; rt._el = null; }
        if (rt._hidden) { updateRtCardStats(rt); scheduleRepaint(); return; }  // hidden via Layer Manager
        const alt = rt.alts && rt.alts[rt.altIndex];
        if (!alt) return;
        const coords = offsetCoords(alt.coords, rt.offsetPx || 0);
        rt.line = L.polyline(coords, {
          color: rt.color, weight: rt.weight, opacity: .92, lineJoin: 'round', renderer: vectorRenderer,
          dashArray: (rt.dash || rt.approx) ? '9,9' : null
        }).addTo(map);
        // Right-click a route line → contextual actions (add via-point here, etc.)
        rt.line.on('contextmenu', ev => {
          ev.originalEvent.preventDefault();
          L.DomEvent.stopPropagation(ev);
          showRouteContextMenu(rt, ev.originalEvent.clientX, ev.originalEvent.clientY, ev.latlng);
        });
        if (coords.length === 2) {
          rt.anchor = L.latLng((coords[0][0] + coords[1][0]) / 2, (coords[0][1] + coords[1][1]) / 2);
        } else {
          rt.anchor = L.latLng(coords[Math.floor(coords.length / 2)]);
        }
        if (rt.showLabel) {
          const bg = rt.labelBg || '#FFFFFF';
          const el = makeLabelEl(rt, 'route', { klass: 'route', bg: bg, color: textOn(bg), text: routeLabelText(rt) });
          rt._labelEl = el;
          rt._el = el.firstChild;
          rt._leaderColor = rt.color;
          rt.onLabelDblclick = () => {
            const v = prompt('Route label (leave empty for auto distance/time):', rt.labelText || '');
            if (v !== null) { rt.labelText = v; rt.card.querySelector('.lt').value = v; drawRoute(rt); rebuildLegend(); }
          };
        }
        updateRtCardStats(rt);
        scheduleRepaint();
      }
      async function computeRoute(rt) {
        const A = locById(rt.fromId), B = locById(rt.toId);
        if (!A || !B || A === B) { updateRtCardStats(rt); return; }
        const vias = rt.viaPoints || [];
        const viaLabel = vias.length ? ` (via ${vias.length} waypoint${vias.length > 1 ? 's' : ''})` : '';
        status('Routing ' + A.name + ' → ' + B.name + viaLabel + ' …', true);
        // Build coordinate string: origin ; via1 ; via2 ; ... ; dest
        const coordStr = [[A.lng, A.lat], ...vias.map(v => [v.lng, v.lat]), [B.lng, B.lat]]
          .map(c => c[0] + ',' + c[1]).join(';');
        // Alternatives only work for direct A→B (no via). OSRM refuses alternatives with waypoints.
        const altsParam = vias.length ? '' : '&alternatives=3';
        let ok = false;

        // Google first when a key is present. It knows Indian roads, service
        // lanes and one-ways that OSRM's extract does not, which is the point
        // of the integration. It returns null rather than throwing when it
        // cannot help — notably for bicycles, which it has no data for in
        // India — and the OSRM chain below then runs exactly as it always did.
        if (typeof googleReady === 'function' && googleReady()) {
          try {
            const g = await googleRoute(A, B, rt.mode, vias);
            if (g && g.length) {
              rt.alts = g.map(r => ({ d: r.d, t: r.t, coords: r.coords }));
              rt.altIndex = Math.min(rt.altIndex || 0, rt.alts.length - 1);
              rt.approx = false;
              ok = true;
              const named = g[0].desc ? ' via ' + g[0].desc : '';
              const altSuffix = g.length > 1 ? ' (' + g.length + ' alternatives — ⇆ to compare)' : '';
              status('Route found: ' + A.name + ' → ' + B.name + viaLabel + named + altSuffix);
            }
          } catch (e) { console.warn('Google routing failed:', e.message); }
        }

        for (const base of ok ? [] : (ROUTERS[rt.mode] || ROUTERS.car)) {
          try {
            const url = `${base}/route/v1/driving/${coordStr}?overview=full&geometries=geojson${altsParam}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (!data.routes || !data.routes.length) throw new Error('no route');
            rt.alts = data.routes.map(r => ({ d: r.distance, t: r.duration, coords: r.geometry.coordinates.map(c => [c[1], c[0]]) }));
            rt.altIndex = Math.min(rt.altIndex || 0, rt.alts.length - 1);
            rt.approx = false;
            ok = true;
            const altSuffix = rt.alts.length > 1 ? ' (' + rt.alts.length + ' alternatives — ⇆ to compare)' : '';
            status('Route found: ' + A.name + ' → ' + B.name + viaLabel + altSuffix);
            break;
          } catch (e) { /* try next server */ }
        }
        if (!ok) {
          // Straight-line fallback that still passes through any via-points
          const pts = [[A.lat, A.lng], ...vias.map(v => [v.lat, v.lng]), [B.lat, B.lng]];
          let d = 0;
          for (let i = 1; i < pts.length; i++) d += haversineKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) * 1000;
          rt.alts = [{ d, t: null, coords: pts }];
          rt.altIndex = 0; rt.approx = true;
          status('Live routing unavailable for ' + A.name + ' → ' + B.name + ' — showing straight line. Check internet or try ↻.', true);
        }
        drawRoute(rt); renderViaDots(rt); rebuildLegend();
      }
      function addRoute(opts) {
        opts = opts || {};
        const rt = {
          id: opts.id || newId(),
          fromId: opts.fromId || (locations[0] && locations[0].id) || null,
          toId: opts.toId || (locations[1] && locations[1].id) || null,
          mode: opts.mode || 'car',
          color: opts.color || PALETTE[routes.length % PALETTE.length],
          weight: opts.weight || 5, dash: !!opts.dash, offsetPx: opts.offsetPx || 0,
          labelText: opts.labelText || '', showLabel: opts.showLabel !== undefined ? opts.showLabel : true,
          labelOffset: opts.labelOffset || { x: 12, y: -26 },
          labelBg: opts.labelBg || '#FFFFFF',
          viaPoints: (opts.viaPoints || []).map(v => ({ lat: v.lat, lng: v.lng })),
          // Waypoint dots off, without giving up the waypoints themselves. They
          // are a control surface — something to drag while the route is being
          // shaped — and once it is right they are scaffolding on a drawing
          // that is about to be handed to somebody. Deleting them was the only
          // way to get rid of them, and that changes the route.
          viaHidden: !!opts.viaHidden,
          alts: opts.saved ? [opts.saved] : null, altIndex: 0, approx: opts.saved ? !!opts.saved.approx : false,
          line: null, _labelEl: null, _el: null, _viaEls: [], anchor: null, card: null
        };
        bumpId(rt.id);
        routes.push(rt);
        buildRtCard(rt);
        syncEmpties();
        // `defer` leaves the routing call to the caller. The bulk importer uses
        // it to run twenty routes one at a time: fired together they are twenty
        // simultaneous requests to a public OSRM instance, which is how you get
        // rate-limited into a map with half its routes missing.
        if (rt.alts) { drawRoute(rt); renderViaDots(rt); } else if (!opts.defer) computeRoute(rt);
        rebuildLegend();
        if (typeof refreshLayers === 'function') refreshLayers();
        return rt;
      }
      /**
       * Paint the waypoint dots' visibility from the two things that can hide
       * them: the Layer Manager hiding the whole route, and the route's own
       * "Dots" toggle. One function rather than two places setting `display`,
       * because the previous arrangement had the Layer Manager unhiding dots
       * the card had deliberately hidden.
       * @param {object} rt
       */
      function applyViaVisibility(rt) {
        const show = !rt._hidden && !rt.viaHidden;
        (rt._viaEls || []).forEach(el => { el.style.display = show ? '' : 'none'; });
      }

      /** Show or hide just this route's waypoint dots. @param {object} rt @param {boolean} on */
      function setViaDotsVisible(rt, on) {
        rt.viaHidden = !on;
        applyViaVisibility(rt);
      }

      /** Show/hide a route line + label without deleting it. Used by the Layer Manager. @param {object} rt @param {boolean} on */
      function setRouteVisible(rt, on) {
        rt._hidden = !on;
        applyViaVisibility(rt);
        drawRoute(rt); rebuildLegend();
      }
      function deleteRoute(rt) {
        if (rt.line) map.removeLayer(rt.line);
        if (rt._labelEl) removeBB(rt._labelEl);
        (rt._viaEls || []).forEach(removeBB);
        if (rt.card) rt.card.remove();
        routes.splice(routes.indexOf(rt), 1);
        rebuildLegend(); syncEmpties();
        scheduleRepaint();
        if (typeof refreshLayers === 'function') refreshLayers();
      }

      // ---------- via-points ----------
      let armingViaFor = null;   // Route currently in "click to add via-point" mode

      function renderViaDots(rt) {
        (rt._viaEls || []).forEach(removeBB);
        rt._viaEls = [];
        (rt.viaPoints || []).forEach((v, idx) => {
          const wrap = document.createElement('div');
          wrap.className = 'bb';
          wrap.style.zIndex = 360;
          const dot = document.createElement('div');
          dot.className = 'via-dot';
          dot.style.background = rt.color;
          dot.style.boxShadow = `0 3px 8px rgba(0,0,0,.5), 0 0 0 2px ${rt.color}55`;
          dot.setAttribute('data-idx', idx + 1);
          wrap.appendChild(dot);
          // Drag to reposition the waypoint (recomputes route on release)
          let dragging = false, dragMoved = false, sx = 0, sy = 0, sLat = 0, sLng = 0;
          wrap.addEventListener('pointerdown', e => {
            dragging = true; dragMoved = false;
            sx = e.clientX; sy = e.clientY; sLat = v.lat; sLng = v.lng;
            wrap.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
          });
          wrap.addEventListener('pointermove', e => {
            if (!dragging) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
            if (!dragMoved) return;
            const scale = 1 + tiltDeg / 120;
            const p0 = map.latLngToContainerPoint([sLat, sLng]);
            const ll = map.containerPointToLatLng(L.point(p0.x + dx / scale, p0.y + dy / scale));
            v.lat = ll.lat; v.lng = ll.lng;
            scheduleRepaint();
          });
          wrap.addEventListener('pointerup', () => { dragging = false; if (dragMoved) computeRoute(rt); });
          // Right-click to remove this specific via-point
          wrap.addEventListener('contextmenu', e => {
            e.preventDefault(); e.stopPropagation();
            rt.viaPoints.splice(idx, 1);
            computeRoute(rt);
            updateRtCardStats(rt);
          });
          // Positioning is handled centrally by the repaint loop
          v._el = wrap;
          bbLayer.appendChild(wrap);
          rt._viaEls.push(wrap);
        });
        // Re-hide immediately: renderViaDots() rebuilds the elements from
        // scratch on every recompute, so without this a hidden set reappeared
        // the moment the route was recalculated.
        applyViaVisibility(rt);
        scheduleRepaint();
      }

      function armViaAdd(rt) {
        if (armingViaFor === rt) { armingViaFor = null; $('mapWrap').classList.remove('via-arming'); status('Via-point mode cancelled.'); return; }
        armingViaFor = rt;
        if (typeof setAdding === 'function') setAdding(false);
        if (typeof aerialActive !== 'undefined' && aerialActive && typeof setAerialActive === 'function') setAerialActive(false);
        if (typeof disableAllDrawModes === 'function') disableAllDrawModes();
        if (typeof disableAllEditModes === 'function') disableAllEditModes();
        $('mapWrap').classList.add('via-arming');
        const A = locById(rt.fromId), B = locById(rt.toId);
        status(`Click on the map to force this route through a waypoint (${A ? A.name : '?'} → ${B ? B.name : '?'}). Esc to cancel.`, true);
      }
      function disarmVia() {
        armingViaFor = null;
        $('mapWrap').classList.remove('via-arming');
      }

      function recomputeRoutesTouching(locId) {
        routes.forEach(r => { if (r.fromId === locId || r.toId === locId) computeRoute(r); });
      }

