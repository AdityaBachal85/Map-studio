/**
 * map/billboard.js — the billboard overlay: DOM pins/labels that live outside
 * the tilt stage, screen-space projection through the tilt transform, the
 * repaint loop, leader-line canvas, and element factories with drag handling.
 */









      // ---------- billboard layer: labels/markers live OUTSIDE the tilt stage ----------
      const bbLayer = $('billboardLayer');
      const leaderCanvas = document.createElement('canvas');
      leaderCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      bbLayer.appendChild(leaderCanvas);
      let bbW = 0, bbH = 0;
      /**
       * Backing-store multiplier for the leader canvas. 0 means "follow the
       * display"; the hi-res exporter raises it so leader lines rasterise at
       * export resolution instead of being upscaled from screen pixels.
       */
      let leaderRenderScale = 0;
      function resizeBB() {
        bbW = bbLayer.clientWidth; bbH = bbLayer.clientHeight;
        const dpr = leaderRenderScale || Math.min(window.devicePixelRatio || 1, 2);
        leaderCanvas.width = Math.round(bbW * dpr); leaderCanvas.height = Math.round(bbH * dpr);
        leaderCanvas.style.width = bbW + 'px'; leaderCanvas.style.height = bbH + 'px';
        leaderCanvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
        scheduleRepaint();
      }

      /**
       * Render leader lines at `s`× device resolution for an export pass.
       * Pass 0 to go back to following the display.
       * @param {number} s
       */
      function setLeaderRenderScale(s) {
        leaderRenderScale = s && s > 0 ? s : 0;
        resizeBB();
        repaintBillboard();          // synchronous — the caller captures immediately after
      }

      // Project the tilted map's container point through the CSS 3D transform to the
      // user's viewport plane, so labels sit exactly on the imagery even when tilted.
      function projectPin(latlng) {
        const cp = map.latLngToContainerPoint(latlng);
        if (!tiltDeg) return { x: cp.x, y: cp.y, s: 1 };
        const t = tiltDeg * Math.PI / 180;
        const cx = bbW * 0.5, cy = bbH * 0.62;
        const dx = cp.x - cx, dy = cp.y - cy;
        const scale = 1 + tiltDeg / 120;
        const sx = dx * scale, sy = dy * scale;                        // apply the CSS scale
        const d = 1600;                                            // matches CSS perspective
        const denom = d + sy * Math.sin(t);
        const px = sx * d / denom;
        const py = sy * Math.cos(t) * d / denom;
        const s = d / denom;
        return { x: cx + px, y: cy + py, s: s };
      }

      let repaintScheduled = false;
      /**
       * Set while an export capture is in flight. A repaint during a capture
       * would re-apply the CSS transforms that flattenBillboardForCapture() just
       * removed — and the capture is asynchronous, so a queued rAF lands right in
       * the middle of it. That is not cosmetic: html2canvas silently drops text
       * inside transformed elements, so a single stray repaint turns every label
       * in the export into an empty chip.
       */
      let bbCaptureLock = false;

      function scheduleRepaint() {
        if (repaintScheduled || bbCaptureLock) return;
        repaintScheduled = true;
        requestAnimationFrame(() => {
          repaintScheduled = false;
          repaintBillboard();
        });
      }

      // ---------- main billboard repaint ----------
      function repaintBillboard() {
        if (bbCaptureLock) return;
        const ctx = leaderCanvas.getContext('2d');
        ctx.clearRect(0, 0, bbW, bbH);

        const entries = [];
        const decorEntries = [];   // ring labels — positioned but skipped by collision + leader
        locations.forEach(l => {
          if (!l._pinEl) return;
          const pin = projectPin(L.latLng(l.lat, l.lng));
          // Pin: position (anchored bottom-center)
          // Pin anchor: at tilt 0° the pin's tip (bottom-center) sits on the ground point.
          // Under tilt, we shorten the vertical offset by cos(tilt) so the pin doesn't
          // float above its real location — the tip stays snapped to the ground point.
          const tiltFactor = Math.cos(tiltDeg * Math.PI / 180);
          const anchorY = 50 + 50 * tiltFactor;   // 100% at tilt 0, 50% when fully flat
          l._pinEl.style.transform = `translate(${pin.x}px, ${pin.y}px) translate(-50%, -${anchorY}%)`;
          if (l.type === 'badge' || l.hideMarker) l._pinEl.style.transform = `translate(${pin.x}px, ${pin.y}px) translate(-50%, -50%)`;
          l.anchor = L.latLng(l.lat, l.lng);
          if (l.showLabel && l._labelEl) {
            entries.push(l);
          }
          (l.ringLabels || []).forEach(rl => { if (rl.ent && rl.ent._labelEl) decorEntries.push(rl.ent); });
        });
        routes.forEach(rt => {
          if (!rt._labelEl || !rt.anchor) return;
          if (rt.showLabel) entries.push(rt);
        });

        // snapping.js loads *after* this file, so a repaint triggered while the
        // page is still parsing scripts would throw on an undefined global and
        // abort the whole repaint — pins and labels then sit at stale positions
        // until the next one. Guarded the same way as the other cross-module
        // calls here; collision avoidance simply does not run for that one frame.
        if (typeof autoAvoidCollisions === 'function') autoAvoidCollisions(entries);

        entries.concat(decorEntries).forEach(e => {
          const pin = projectPin(e.anchor);
          const ox = (e.labelPinned ? e.labelOffset.x : (e._autoOffsetX != null ? e._autoOffsetX : e.labelOffset.x));
          const oy = (e.labelPinned ? e.labelOffset.y : (e._autoOffsetY != null ? e._autoOffsetY : e.labelOffset.y));
          e._labelEl.style.transform = `translate(${pin.x + ox}px, ${pin.y + oy}px)`;
        });
        // Via-point dots: pin them exactly on their coordinate (bottom-center of the dot)
        routes.forEach(rt => {
          (rt.viaPoints || []).forEach(v => {
            if (!v._el) return;
            const p = projectPin(L.latLng(v.lat, v.lng));
            v._el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
          });
        });
        // Leader lines only for entries with a real pin — skip decor
        const wrapRect = bbLayer.getBoundingClientRect();
        entries.forEach(e => {
          const rect = e._labelEl.getBoundingClientRect();
          drawLeader(ctx, projectPin(e.anchor), {
            x: rect.left - wrapRect.left,
            y: rect.top - wrapRect.top,
            w: rect.width,
            h: rect.height,
          }, e._leaderColor);
        });
      }

      /* ---------- leader lines ---------- */

      // Cartographic leader geometry, in CSS px. Tuned against the way ArcGIS
      // Pro and Illustrator draw callouts: a hairline is too faint over
      // satellite imagery, anything past ~1.6px starts to read as a route line.
      const LEADER = {
        width: 1.5,          // coloured stroke
        halo: 3.4,           // dark casing drawn underneath for contrast
        shoulder: 9,         // horizontal run entering the label
        gapAtPin: 4,         // clearance so the line never touches the pin tip
        gapAtLabel: 2,       // clearance so it never slides under the chip
        minRun: 16,          // below this the label is on top of the pin — skip
        dot: 2.4,            // anchor dot radius at the feature end
      };

      /**
       * Where a ray from `from` towards the centre of `box` first meets the box.
       * Anchoring on the edge — rather than on the centre, as the old code did —
       * is what stops the connector disappearing under the label chip and is why
       * the result reads as a drawn callout instead of a stray diagonal.
       * @param {{x:number,y:number,w:number,h:number}} box
       * @param {{x:number,y:number}} from
       * @returns {{x:number, y:number, side:string}}
       */
      function boxEdgePoint(box, from) {
        const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
        const dx = from.x - cx, dy = from.y - cy;
        if (!dx && !dy) return { x: cx, y: cy, side: 'c' };
        const hw = box.w / 2 + LEADER.gapAtLabel, hh = box.h / 2 + LEADER.gapAtLabel;
        // Scale the ray until it hits whichever pair of edges it reaches first.
        const tx = dx ? hw / Math.abs(dx) : Infinity;
        const ty = dy ? hh / Math.abs(dy) : Infinity;
        const t = Math.min(tx, ty);
        return {
          x: cx + dx * t,
          y: cy + dy * t,
          side: tx <= ty ? (dx < 0 ? 'l' : 'r') : (dy < 0 ? 't' : 'b'),
        };
      }

      /**
       * The polyline a connector follows, from the feature to the label edge.
       *
       * Shared by the on-screen canvas renderer and the PPTX exporter so the
       * exported connector has exactly the geometry the operator positioned.
       *
       * When the label sits to the side of its pin the path gets a short
       * horizontal shoulder before it enters the chip, so the connector meets
       * the text along its baseline direction rather than stabbing into a corner.
       *
       * @param {{x:number,y:number}} pin Feature anchor in layer px.
       * @param {{x:number,y:number,w:number,h:number}} box Label box in layer px.
       * @returns {Array<{x:number,y:number}>|null} null when the label is sitting
       *          on top of its own pin and a connector would be noise.
       */
      function leaderPathPoints(pin, box) {
        const edge = boxEdgePoint(box, pin);
        const dx = edge.x - pin.x, dy = edge.y - pin.y;
        const run = Math.hypot(dx, dy);
        if (run < LEADER.minRun) return null;            // label covers the pin already

        // Pull the start clear of the pin graphic.
        const ux = dx / run, uy = dy / run;
        const pts = [{ x: pin.x + ux * LEADER.gapAtPin, y: pin.y + uy * LEADER.gapAtPin }];
        // A shoulder only helps when the label is genuinely off to one side; for
        // a label directly above or below, a straight line is cleaner.
        if ((edge.side === 'l' || edge.side === 'r') && run > LEADER.shoulder * 2.5) {
          const dir = edge.side === 'r' ? 1 : -1;
          pts.push({ x: edge.x + dir * LEADER.shoulder, y: edge.y });
        }
        pts.push({ x: edge.x, y: edge.y });
        return pts;
      }

      /**
       * Draw one label connector: dark casing, coloured stroke on top, anchor dot
       * at the feature.
       *
       * The casing is the detail that makes these read as professional. A single
       * light stroke vanishes over pale imagery and a single dark one vanishes
       * over dark imagery; stroking a wider translucent dark line first and the
       * colour over it keeps the connector legible on any basemap — the same
       * trick cartographers use for halo'd label text.
       *
       * @param {CanvasRenderingContext2D} ctx
       * @param {{x:number,y:number}} pin Feature anchor in layer px.
       * @param {{x:number,y:number,w:number,h:number}} box Label box in layer px.
       * @param {string} [color] Stroke colour.
       */
      function drawLeader(ctx, pin, box, color) {
        const pts = leaderPathPoints(pin, box);
        if (!pts) return;
        const stroke = color || 'rgba(255,255,255,.92)';
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([]);

        const trace = () => {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        };

        trace();
        ctx.strokeStyle = 'rgba(8,14,24,.42)';
        ctx.lineWidth = LEADER.halo;
        ctx.stroke();

        trace();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = LEADER.width;
        ctx.stroke();

        // Anchor dot: reads as a deliberate attachment point rather than a line
        // that happens to stop near the pin.
        ctx.beginPath();
        ctx.arc(pin.x, pin.y, LEADER.dot, 0, Math.PI * 2);
        ctx.fillStyle = stroke;
        ctx.strokeStyle = 'rgba(8,14,24,.42)';
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      /* ---------- capture helpers ---------- */

      // Billboard elements are placed with CSS transforms, which html2canvas
      // 1.4.1 mishandles: it draws the chip's background and border but silently
      // drops the text inside. Flattening each transform to plain left/top for
      // the duration of a capture sidesteps the bug, which in turn lets the
      // exporter use html2canvas's standard renderer instead of
      // foreignObjectRendering — the renderer that refuses to draw cross-origin
      // map tiles. Positions are read from getBoundingClientRect so percentage
      // translates resolve correctly.
      let bbFlattened = [];

      /** Freeze billboard positions as left/top for an export capture. */
      function flattenBillboardForCapture() {
        restoreBillboardAfterCapture();
        const base = bbLayer.getBoundingClientRect();
        bbCaptureLock = true;   // no repaint may re-apply transforms until we restore
        const els = Array.from(bbLayer.querySelectorAll('.bb'));
        // Read every rect before writing any style, so no measurement is taken
        // against a partially-rewritten layout.
        const rects = els.map(el => el.getBoundingClientRect());
        els.forEach((el, i) => {
          bbFlattened.push({ el, transform: el.style.transform, left: el.style.left, top: el.style.top });
          el.style.transform = 'none';
          el.style.left = (rects[i].left - base.left) + 'px';
          el.style.top = (rects[i].top - base.top) + 'px';
        });
      }

      /** Undo {@link flattenBillboardForCapture}. Safe to call when not flattened. */
      function restoreBillboardAfterCapture() {
        bbCaptureLock = false;
        if (!bbFlattened.length) return;
        bbFlattened.forEach(s => {
          s.el.style.transform = s.transform;
          s.el.style.left = s.left;
          s.el.style.top = s.top;
        });
        bbFlattened = [];
        scheduleRepaint();
      }

      // ---------- creating billboard elements ----------
      function makePinEl(loc, animate) {
        const wrap = document.createElement('div');
        wrap.className = 'bb grabbable' + (animate ? ' drop-anchor' : '') + (loc.hideMarker ? ' pin-ghost' : '');
        wrap.style.zIndex = loc.type === 'site' ? 400 : 350;
        if (loc.hideMarker) {
          // Marker hidden: keep a faint, draggable dot for editing — never appears in
          // PNG/PPTX/print exports (hidden via the .pin-ghost + .capturing CSS rule).
          const ghost = document.createElement('div');
          ghost.className = 'ghost-dot';
          ghost.style.background = loc.color || '#FF7A1A';
          wrap.appendChild(ghost);
        } else if (loc.type === 'badge') {
          const shield = document.createElement('div');
          shield.className = 'hwy-shield badge-shape';
          shield.style.background = loc.color;
          shield.textContent = loc.badgeText || 'NH';
          wrap.appendChild(shield);
        } else {
          const s = (loc.iconSize || 36);
          const box = document.createElement('div');
          box.className = 'pin-icon ' + (loc.iconFrame || 'circle') + (loc.iconGlow ? ' glow' : '');
          box.style.width = s + 'px';
          box.style.height = s + 'px';
          const frameless = loc.iconFrame === 'none';
          if (frameless) {
            // Bare icon: transparent, no border, only a soft drop-shadow for readability
            box.style.background = 'transparent';
            box.style.border = 'none';
            box.style.setProperty('--glowCol', (loc.color || '#FF7A1A') + '99');
            box.style.boxShadow = 'none';
            box.style.filter = `drop-shadow(0 ${1 + (loc.iconShadow || 6) * 0.4}px ${2 + (loc.iconShadow || 6) * 0.6}px rgba(0,0,0,${.25 + (loc.iconShadow || 6) * 0.03}))`;
          } else {
            box.style.background = loc.iconBg || '#FFFFFF';
            box.style.border = (loc.iconBorder || 2) + 'px solid ' + (loc.iconBorderColor || '#FFFFFF');
            box.style.setProperty('--glowCol', (loc.color || '#FF7A1A') + '99');
            box.style.boxShadow = `0 ${4 + (loc.iconShadow || 6)}px ${(loc.iconShadow || 6) * 3}px rgba(0,0,0,${.15 + (loc.iconShadow || 6) * 0.03}), 0 1px 2px rgba(0,0,0,.14)`;
          }
          // Content: uploaded image, or SVG from library
          const contentPct = frameless ? '100%' : '78%';
          const svgPct = frameless ? '100%' : '66%';
          if (loc.iconImage) {
            const img = document.createElement('img');
            img.src = loc.iconImage;
            img.style.cssText = `width:${contentPct};height:${contentPct};object-fit:contain;`;
            box.appendChild(img);
          } else if (loc.iconUseProjectLogo && brand.projectLogo) {
            const img = document.createElement('img');
            img.src = brand.projectLogo;
            img.style.cssText = `width:${contentPct};height:${contentPct};object-fit:contain;`;
            box.appendChild(img);
          } else {
            box.innerHTML = svgForKey(loc.iconKey || (loc.type === 'site' ? 'star' : 'pin'), loc.color);
            const svg = box.querySelector('svg');
            if (svg) svg.style.cssText = `width:${svgPct};height:${svgPct};`;
          }
          wrap.appendChild(box);
        }
        // Drag handling
        let dragging = false, dragMoved = false, sx = 0, sy = 0, startLat = 0, startLng = 0;
        wrap.addEventListener('pointerdown', e => {
          if (uiState.addingMode) return;
          dragging = true; dragMoved = false;
          sx = e.clientX; sy = e.clientY;
          startLat = loc.lat; startLng = loc.lng;
          wrap.setPointerCapture(e.pointerId);
          e.preventDefault();
        });
        wrap.addEventListener('pointermove', e => {
          if (!dragging) return;
          const dx = e.clientX - sx, dy = e.clientY - sy;
          if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
          if (!dragMoved) return;
          // Approx: unscale the tilt to move in map pixels
          const scale = 1 + tiltDeg / 120;
          const p0 = map.latLngToContainerPoint([startLat, startLng]);
          const newP = L.point(p0.x + dx / scale, p0.y + dy / scale);
          const ll = map.containerPointToLatLng(newP);
          loc.lat = ll.lat; loc.lng = ll.lng;
          updateRings(loc);
          scheduleRepaint();
        });
        wrap.addEventListener('pointerup', () => {
          dragging = false;
          if (dragMoved) {
            if (loc.card) { const ci = loc.card.querySelector('.coord'); if (ci) ci.value = fmtCoord(loc.lat, loc.lng); }
            recomputeRoutesTouching(loc.id);
          }
        });
        // Hover and selection are mirrored onto the location's sidebar card, so
        // the map and the list read as one object seen two ways. Without the
        // link, finding which of fifteen cards belongs to the pin you are
        // looking at means reading coordinates.
        wrap.addEventListener('pointerenter', () => setLocationHover(loc, true));
        wrap.addEventListener('pointerleave', () => setLocationHover(loc, false));
        wrap.addEventListener('click', e => {
          if (dragMoved) { e.preventDefault(); return; }
          e.stopPropagation();
          selectLocation(loc);
        });
        setTimeout(() => wrap.classList.remove('drop-anchor'), 600);
        bbLayer.appendChild(wrap);
        return wrap;
      }

      function makeLabelEl(ent, kind, opts, animate) {
        // kind: 'loc' | 'route' | 'ring'
        const wrap = document.createElement('div');
        wrap.className = 'bb' + (animate ? ' drop-label' : '');
        wrap.style.zIndex = (kind === 'loc' ? 380 : (kind === 'route' ? 370 : 360));
        const badge = document.createElement('div');
        badge.className = 'label-badge ' + (opts.klass || '');
        if (opts.bg) badge.style.background = opts.bg;
        if (opts.color) badge.style.color = opts.color;
        if (opts.accent) badge.style.setProperty('--accent', opts.accent);
        if (opts.iconHtml) { const ico = document.createElement('div'); ico.className = 'lb-ico' + (opts.iconPlain ? ' plain' : ''); ico.innerHTML = opts.iconHtml; badge.appendChild(ico); }
        const txt = document.createElement('span');
        txt.textContent = opts.text;
        badge.appendChild(txt);
        wrap.appendChild(badge);
        // Drag handling on the label
        let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        wrap.addEventListener('pointerdown', e => {
          if (uiState.addingMode) return;
          dragging = true; sx = e.clientX; sy = e.clientY;
          ox = ent.labelOffset.x; oy = ent.labelOffset.y;
          ent.labelPinned = true;
          wrap.setPointerCapture(e.pointerId);
          e.preventDefault();
        });
        wrap.addEventListener('pointermove', e => {
          if (!dragging) return;
          ent.labelOffset.x = ox + (e.clientX - sx);
          ent.labelOffset.y = oy + (e.clientY - sy);
          scheduleRepaint();
        });
        wrap.addEventListener('pointerup', () => { dragging = false; });
        wrap.addEventListener('dblclick', () => { if (ent.onLabelDblclick) ent.onLabelDblclick(); });
        setTimeout(() => wrap.classList.remove('drop-label'), 600);
        bbLayer.appendChild(wrap);
        return wrap;
      }

      function removeBB(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

      /* ---------- selection ---------- */

      /**
       * The selected location, or null.
       *
       * Selection persists until something clears it. The previous behaviour
       * added a `.selected` class and stripped it again after 1.5s, which is a
       * flash of acknowledgement rather than a state — nothing could depend on
       * it, so the sidebar had no way to follow the map.
       */
      let selectedLocation = null;

      /** Highlight a location's pin and card together. @param {object} loc @param {boolean} on */
      function setLocationHover(loc, on) {
        if (loc._pinEl) loc._pinEl.classList.toggle('hover', on);
        if (loc._labelEl) loc._labelEl.classList.toggle('hover', on);
        if (loc.card) loc.card.classList.toggle('hovered', on);
      }

      /**
       * Select a location: ring the pin, mark its card, and bring the card into
       * view. Scrolling the list is the half that makes this useful — a
       * highlighted card the operator has to hunt for is no better than none.
       * @param {object} loc
       */
      function selectLocation(loc) {
        if (selectedLocation === loc) { clearLocationSelection(); return; }
        clearLocationSelection();
        selectedLocation = loc;
        if (loc._pinEl) loc._pinEl.classList.add('selected');
        if (loc._labelEl) loc._labelEl.classList.add('selected');
        if (loc.card) {
          loc.card.classList.add('selected');
          loc.card.scrollIntoView({ block: 'nearest', behavior: motionReduced() ? 'auto' : 'smooth' });
        }
      }

      /** Drop any current selection. */
      function clearLocationSelection() {
        if (!selectedLocation) return;
        const l = selectedLocation;
        selectedLocation = null;
        if (l._pinEl) l._pinEl.classList.remove('selected');
        if (l._labelEl) l._labelEl.classList.remove('selected');
        if (l.card) l.card.classList.remove('selected');
      }


      // ---------- geometry ----------
      function offsetCoords(coords, px) {
        if (!px) return coords;
        const pts = coords.map(c => map.latLngToLayerPoint(L.latLng(c[0], c[1])));
        const out = [];
        let lastNx = 0, lastNy = -1;
        for (let i = 0; i < pts.length; i++) {
          let dx = 0, dy = 0;
          if (i > 0) { dx += pts[i].x - pts[i - 1].x; dy += pts[i].y - pts[i - 1].y; }
          if (i < pts.length - 1) { dx += pts[i + 1].x - pts[i].x; dy += pts[i + 1].y - pts[i].y; }
          const len = Math.hypot(dx, dy);
          let nx, ny;
          if (len < 0.001) { nx = lastNx; ny = lastNy; }
          else { nx = -dy / len; ny = dx / len; lastNx = nx; lastNy = ny; }
          const ll = map.layerPointToLatLng(L.point(pts[i].x + nx * px, pts[i].y + ny * px));
          out.push([ll.lat, ll.lng]);
        }
        return out;
      }


      /**
       * Wire the billboard layer to the map. Called once from app.js after all
       * modules are evaluated (breaks the mapEngine<->billboard import cycle:
       * nothing here runs at module-evaluation time).
       */
      function initBillboard() {
        window.addEventListener('resize', resizeBB);
        map.on('resize', resizeBB);
        setTimeout(resizeBB, 0);
        setTimeout(resizeBB, 200);   // second pass after fonts/layout settle
        map.on('move zoom moveend zoomend viewreset', scheduleRepaint);
        map.on('click', clearLocationSelection);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') clearLocationSelection(); });
        map.on('zoomend', () => { routes.forEach(rt => { if (rt.offsetPx) drawRoute(rt); }); });
      }

