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
      /* ---------- where along the route the label sits ---------- */

      /**
       * WHY A FRACTION AND NOT A POINT.
       *
       * The label used to hang off the route's midpoint — coords[length/2] —
       * and dragging it only moved the box away from that one spot on a leader
       * line. So a label could be put anywhere on the map and nowhere on the
       * route: "Kalyan-Murbad Road" pointing at the middle of a road it names
       * the whole of, with no way to move it to the end where there was room.
       *
       * `rt.labelPos` is a fraction of the route's length, 0 at the origin and
       * 1 at the destination, and the anchor is resolved from it every time the
       * route is drawn. A fraction rather than a coordinate because a route is
       * recomputed constantly — a waypoint dragged, a mode changed, an
       * alternative cycled — and a stored coordinate would end up off the line
       * it belongs to. A fraction lands in the same *relative* place on
       * whatever geometry comes back.
       *
       * Measured in metres along the path, not in vertices: OSRM returns
       * vertices bunched at corners and sparse on straights, so "halfway
       * through the array" can be nowhere near halfway along the road.
       */

      /**
       * Cumulative distance along a coordinate array, in metres.
       * @param {Array} coords [[lat,lng], ...]
       * @returns {{cum:number[], total:number}}
       */
      function routeCumLengths(coords) {
        const cum = [0];
        let total = 0;
        for (let i = 1; i < coords.length; i++) {
          total += map.distance(coords[i - 1], coords[i]);
          cum.push(total);
        }
        return { cum, total };
      }

      /**
       * The point a fraction of the way along a route.
       * @param {Array} coords @param {number} t 0..1
       * @returns {L.LatLng}
       */
      function routeAnchorAt(coords, t) {
        if (!coords || !coords.length) return null;
        if (coords.length === 1) return L.latLng(coords[0]);
        const f = Math.min(1, Math.max(0, isFinite(t) ? t : 0.5));
        const { cum, total } = routeCumLengths(coords);
        if (!total) return L.latLng(coords[0]);

        const want = f * total;
        let i = 1;
        while (i < cum.length - 1 && cum[i] < want) i++;
        const segLen = cum[i] - cum[i - 1];
        const k = segLen ? (want - cum[i - 1]) / segLen : 0;
        const a = coords[i - 1], b = coords[i];
        const lat = a[0] !== undefined ? a[0] : a.lat, lng = a[1] !== undefined ? a[1] : a.lng;
        const lat2 = b[0] !== undefined ? b[0] : b.lat, lng2 = b[1] !== undefined ? b[1] : b.lng;
        return L.latLng(lat + (lat2 - lat) * k, lng + (lng2 - lng) * k);
      }

      /**
       * Snapshot the route in screen space for the duration of a label drag.
       *
       * Projecting every vertex on each pointermove would be a few thousand
       * transforms per frame on a city-scale route. The map cannot move while a
       * label is being dragged — the pointer is captured — so one projection at
       * the start stays correct until the pointer is released.
       *
       * @param {object} rt
       */
      function cacheRouteLabelDrag(rt) {
        rt._dragPts = null;
        if (!rt.line || typeof projectPin !== 'function') return;
        let lls = rt.line.getLatLngs();
        if (Array.isArray(lls[0])) lls = lls[0];
        if (!lls || lls.length < 2) return;

        rt._dragLatLngs = lls.map(ll => [ll.lat, ll.lng]);
        rt._dragPts = lls.map(ll => projectPin(ll));
        rt._dragGeo = routeCumLengths(rt._dragLatLngs);
      }

      /**
       * Re-anchor a dragged label to the nearest point on its own route.
       *
       * The box stays exactly where it was dropped; what moves is the point it
       * is tied to. That is the useful half of "snap to the line" — snapping
       * the box itself onto the road would put type on top of the very thing it
       * labels, and there would be no way to nudge it clear.
       *
       * Nearest is measured in screen space, because that is where the drag
       * happens and where "nearest" means what the eye says it means; the
       * result is then converted to a distance-along fraction so it survives
       * the next recompute.
       *
       * @param {object} rt
       */
      function reanchorRouteLabel(rt) {
        const pts = rt._dragPts;
        if (!pts || !rt.anchor || typeof projectPin !== 'function') return;

        // Where the box is right now, from the same numbers the repaint uses.
        const pin = projectPin(rt.anchor);
        const bw = rt._el ? rt._el.offsetWidth : 0;
        const bh = rt._el ? rt._el.offsetHeight : 0;
        const cx = pin.x + rt.labelOffset.x + bw / 2;
        const cy = pin.y + rt.labelOffset.y + bh / 2;

        let bestI = 1, bestK = 0, bestD = Infinity;
        for (let i = 1; i < pts.length; i++) {
          const ax = pts[i - 1].x, ay = pts[i - 1].y;
          const dx = pts[i].x - ax, dy = pts[i].y - ay;
          const len2 = dx * dx + dy * dy;
          // Clamped projection onto the segment: past either end the nearest
          // point is that end, which is what makes the route's start and finish
          // reachable rather than only its interior.
          const k = len2 ? Math.min(1, Math.max(0, ((cx - ax) * dx + (cy - ay) * dy) / len2)) : 0;
          const px = ax + dx * k, py = ay + dy * k;
          const d = (cx - px) * (cx - px) + (cy - py) * (cy - py);
          if (d < bestD) { bestD = d; bestI = i; bestK = k; }
        }

        const geo = rt._dragGeo;
        if (!geo || !geo.total) return;
        const segLen = geo.cum[bestI] - geo.cum[bestI - 1];
        rt.labelPos = Math.min(1, Math.max(0, (geo.cum[bestI - 1] + segLen * bestK) / geo.total));

        // Move the anchor, and take the same amount back out of the offset, so
        // the box does not jump out from under the pointer as the tie-point
        // slides along the road.
        const next = routeAnchorAt(rt._dragLatLngs, rt.labelPos);
        if (!next) return;
        const nextPin = projectPin(next);
        rt.labelOffset.x = (pin.x + rt.labelOffset.x) - nextPin.x;
        rt.labelOffset.y = (pin.y + rt.labelOffset.y) - nextPin.y;
        rt.anchor = next;
      }

      /** Free the drag snapshot. @param {object} rt */
      function endRouteLabelDrag(rt) {
        rt._dragPts = null; rt._dragLatLngs = null; rt._dragGeo = null;
      }

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
        // Resolved from labelPos every draw, so a recompute puts the label back
        // where the user left it rather than snapping it to the middle again.
        rt.anchor = routeAnchorAt(coords, rt.labelPos == null ? 0.5 : rt.labelPos)
          || L.latLng(coords[Math.floor(coords.length / 2)]);
        if (rt.showLabel) {
          const bg = rt.labelBg || '#FFFFFF';
          const el = makeLabelEl(rt, 'route', { klass: 'route', bg: bg, color: textOn(bg), text: routeLabelText(rt) });
          rt._labelEl = el;
          rt._el = el.firstChild;
          rt._leaderColor = rt.color;
          rt.onLabelDragStart = () => cacheRouteLabelDrag(rt);
          rt.onLabelDrag = () => reanchorRouteLabel(rt);
          rt.onLabelDragEnd = () => endRouteLabelDrag(rt);
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
      /**
       * A new route's colour: its class's, under the standard; otherwise the
       * next palette entry. Split out of addRoute so the three style fields
       * read the same way and the fallback is stated once.
       * @param {object} opts @returns {string}
       */
      function routeInitialColor(opts) {
        const c = (typeof connClass === 'function' && opts.cls) ? connClass(opts.cls) : null;
        if (c && typeof connStandardOn === 'function' && connStandardOn()) return c.color;
        return PALETTE[routes.length % PALETTE.length];
      }

      /** @param {object} opts @returns {number} */
      function routeInitialWeight(opts) {
        const c = (typeof connClass === 'function' && opts.cls) ? connClass(opts.cls) : null;
        return (c && typeof connStandardOn === 'function' && connStandardOn()) ? c.weight : 5;
      }

      /** @param {object} opts @returns {boolean} */
      function routeInitialDash(opts) {
        if (opts.proposed) return true;
        const c = (typeof connClass === 'function' && opts.cls) ? connClass(opts.cls) : null;
        return !!(c && typeof connStandardOn === 'function' && connStandardOn() && c.dash);
      }

      /**
       * The class a new route starts on.
       *
       * Under the standard a route with no class falls through to
       * `PALETTE[routes.length % n]` — the exact rotating-palette behaviour the
       * standard exists to kill, and reached by "+ Add route", which is how
       * most routes get made. So it starts on the default class and the Type
       * dropdown changes it. Outside the standard the palette is the right
       * answer for "N unrelated destinations" and is left alone.
       *
       * @param {object} opts @returns {string|null}
       */
      function routeInitialClass(opts) {
        if (opts.cls) return opts.cls;
        const on = typeof connStandardOn === 'function' && connStandardOn();
        return (on && typeof CONNECTIVITY_DEFAULT_CLASS === 'string') ? CONNECTIVITY_DEFAULT_CLASS : null;
      }

      function addRoute(opts) {
        opts = opts || {};
        // Resolved before the literal, because routeInitialColor/Weight/Dash all
        // read `opts.cls` — setting it only on the record would leave the three
        // style fields still taking the palette branch.
        opts = Object.assign({}, opts, { cls: routeInitialClass(opts) });
        const rt = {
          id: opts.id || newId(),
          fromId: opts.fromId || (locations[0] && locations[0].id) || null,
          toId: opts.toId || (locations[1] && locations[1].id) || null,
          mode: opts.mode || 'car',
          // What kind of road this is. Only meaningful under the connectivity
          // standard, but carried always so switching layouts does not lose it.
          cls: opts.cls || null,
          proposed: !!opts.proposed,
          // The rotating palette is right for "N unrelated destinations" and
          // wrong for road classes — it made the same road a different colour
          // in every report. Under the standard the class decides; otherwise
          // the palette keeps its old behaviour.
          color: opts.color || routeInitialColor(opts),
          weight: opts.weight || routeInitialWeight(opts),
          dash: opts.dash !== undefined ? !!opts.dash : routeInitialDash(opts),
          offsetPx: opts.offsetPx || 0,
          labelText: opts.labelText || '', showLabel: opts.showLabel !== undefined ? opts.showLabel : true,
          labelOffset: opts.labelOffset || { x: 12, y: -26 },
          // How far along the route the label ties on: 0 origin, 1 destination.
          labelPos: opts.labelPos == null ? 0.5 : Math.min(1, Math.max(0, +opts.labelPos)),
          labelScale: opts.labelScale == null ? 100 : +opts.labelScale,
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
        // A traced road's two endpoints exist only to hold it. Left behind they
        // are invisible, unlisted and unreachable — a leak you could only find
        // by reading the project file. Guarded because roadDraw.js loads after
        // this file, the same way refreshLayers is guarded below.
        if (typeof cleanupRoadAnchors === 'function') cleanupRoadAnchors(rt);
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

