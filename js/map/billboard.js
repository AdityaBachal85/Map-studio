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


/**
 * The teardrop, with the chosen symbol sitting in its head.
 *
 * The glyph is nested as a child `<svg>` rather than parsed apart: a nested svg
 * is valid and gets its own coordinate system from x/y/width/height, so the
 * icon library's own viewBox — whatever it happens to be — is preserved without
 * this function needing to know anything about it.
 *
 * The white stroke is on the path, so it follows the silhouette. That edge is
 * what keeps a pin legible against a dark satellite ground or a busy street
 * map, and it is exactly what a rotated div could not give: a CSS border there
 * traces the box, not the shape.
 *
 * @param {object} loc @param {string} glyph an `<svg>…</svg>` string
 * @returns {string}
 */
function pinTeardropSvg(loc) {
  // Coloured body, white symbol. Built that way first, flipped to a white body
  // in 6.0071 on a reference image, and flipped back here after seeing both on
  // a real map: a coloured teardrop reads as a marker at a glance, where a
  // white one competes with the white roads and buildings underneath it.
  //
  // Fill still wins when it has been set to something other than the default
  // white, or the control would do nothing at all on this frame.
  const body = (loc.iconBg && loc.iconBg !== '#FFFFFF') ? loc.iconBg : (loc.color || '#FF7A1A');
  const ring = (loc.iconBorderColor && loc.iconBorderColor !== loc.color)
    ? loc.iconBorderColor : '#FFFFFF';
  const w = loc.iconBorder == null ? 1.6 : Math.max(0, loc.iconBorder * 0.8);
  // A circle of r=11 about (12,11), drawn down to a point at (12,31).
  const path = 'M12 .8a11 11 0 0 0-11 11c0 3.1 1.5 6.3 3.7 9.3 2.2 3 4.9 5.6 6.4 7.7'
    + '.5.7 1.3.7 1.8 0 1.5-2.1 4.2-4.7 6.4-7.7 2.2-3 3.7-6.2 3.7-9.3a11 11 0 0 0-11-11z';
  return '<svg viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg"'
    + ' style="position:absolute;inset:0;width:100%;height:100%">'
    + '<path d="' + path + '" fill="' + esc(body) + '"'
    + (w ? ' stroke="' + esc(ring) + '" stroke-width="' + w + '"' : '') + '/>'
    + '</svg>';
}

/**
 * Where the symbol sits inside the teardrop's head.
 *
 * The head is a circle of r=11 about (12, 11) in a 24x32 viewBox, so a 13.2
 * square centred on it is 22.5% from the left, 13.75% down, 55% wide and 41.25%
 * tall. Expressed in percentages so it holds at every icon size.
 */
const PIN_HEAD_BOX = 'position:absolute;left:22.5%;top:13.75%;width:55%;height:41.25%;'
  + 'display:flex;align-items:center;justify-content:center;';

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
          // The teardrop is taller than it is wide; every other frame is square.
          box.style.height = (loc.iconFrame === 'pin' ? Math.round(s * 1.32) : s) + 'px';
          const frameless = loc.iconFrame === 'none';
          // The teardrop is a white body with the location's colour on the
          // symbol — the same way round as every other frame here. I built it
          // inverted first (coloured body, white glyph); it is the shape that
          // changes, not the colour scheme.
          const isPin = loc.iconFrame === 'pin';
          if (frameless) {
            // Bare icon: no box at all, so the pin silhouette is the marker.
            box.style.background = 'transparent';
            box.style.border = 'none';
            box.style.setProperty('--glowCol', (loc.color || '#FF7A1A') + '99');
            box.style.boxShadow = 'none';
            // Separation from the basemap comes from a white keyline stroked
            // onto the path itself (see svgForKey's `outline`), not from a
            // white drop-shadow. A white shadow spreads into a halo and reads
            // as the marker glowing; a stroke gives the hard edge a Google
            // Maps pin has. The only filter left is the soft dark shadow that
            // lifts the marker off the map.
            const depth = loc.iconShadow || 6;
            box.style.filter =
              `drop-shadow(0 ${1 + depth * 0.35}px ${1.5 + depth * 0.4}px rgba(0,0,0,${.25 + depth * 0.025}))`;
          } else if (isPin) {
            // Everything visible is inside the SVG, so the box carries only the
            // shadow — a CSS border here would trace the rectangle, not the pin.
            // The teardrop is written first and absolutely positioned, so any
            // content appended after it lands on top rather than beside it.
            box.style.position = 'relative';
            box.innerHTML = pinTeardropSvg(loc);
            const depth = loc.iconShadow == null ? 6 : loc.iconShadow;
            box.style.setProperty('--glowCol', (loc.color || '#FF7A1A') + '99');
            box.style.filter = depth
              ? `drop-shadow(0 ${1 + depth * 0.3}px ${1.5 + depth * 0.35}px rgba(0,0,0,${.22 + depth * 0.02}))`
              : 'none';
          } else {
            box.style.background = loc.iconBg || '#FFFFFF';
            box.style.border = (loc.iconBorder || 2) + 'px solid ' + (loc.iconBorderColor || '#FFFFFF');
            box.style.setProperty('--glowCol', (loc.color || '#FF7A1A') + '99');
            box.style.boxShadow = `0 ${4 + (loc.iconShadow || 6)}px ${(loc.iconShadow || 6) * 3}px rgba(0,0,0,${.15 + (loc.iconShadow || 6) * 0.03}), 0 1px 2px rgba(0,0,0,.14)`;
          }
          // Content: uploaded image, or SVG from library
          const contentPct = frameless ? '100%' : '78%';
          const svgPct = frameless ? '100%' : '66%';
          // An uploaded logo used to be appended straight into the box, which
          // for a pin meant the image alone with no teardrop behind it at all —
          // the frame silently did nothing for anyone using their own icon.
          const imgCss = isPin
            ? PIN_HEAD_BOX + 'object-fit:contain;'
            : `width:${contentPct};height:${contentPct};object-fit:contain;`;
          if (loc.iconImage) {
            const img = document.createElement('img');
            img.src = loc.iconImage;
            img.style.cssText = imgCss;
            box.appendChild(img);
          } else if (loc.iconUseProjectLogo && brand.projectLogo) {
            const img = document.createElement('img');
            img.src = brand.projectLogo;
            img.style.cssText = imgCss;
            box.appendChild(img);
          } else {
            // A frameless pin is the marker itself, so it carries the white
            // keyline. A framed one already sits on its own background and
            // border, where a keyline would just muddy the glyph.
            //
            // Hardcoded white, deliberately not iconBorderColor: that field
            // defaults to the location's own colour, which made the keyline
            // the same colour as the fill and therefore invisible. It also
            // styles the *frame's* border, and the frame's controls are hidden
            // in frameless mode — so it is the wrong field twice over.
            const glyph = svgForKey(
              loc.iconKey || (loc.type === 'site' ? 'star' : 'pin'),
              loc.color,
              (frameless || isPin) ? '#FFFFFF' : null
            );
            if (isPin) {
              // Appended, never assigned: innerHTML would replace the teardrop
              // that was just written into this box.
              const holder = document.createElement('span');
              holder.style.cssText = PIN_HEAD_BOX;
              holder.innerHTML = glyph;
              const g = holder.querySelector('svg');
              if (g) g.style.cssText = 'width:100%;height:100%;';
              box.appendChild(holder);
            } else {
              box.innerHTML = glyph;
              const svg = box.querySelector('svg');
              if (svg) svg.style.cssText = `width:${svgPct};height:${svgPct};`;
            }
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

      /**
       * This label's size relative to the global chip scale, as a multiplier.
       *
       * Stored on the entity as a percentage to match the Settings slider it
       * composes with — 100 means "whatever Settings says", 160 means "half
       * again bigger than whatever Settings says". Clamped, because a label
       * scaled to zero is a label nobody can find again to fix.
       *
       * @param {object} ent @returns {number}
       */
      function labelScaleOf(ent) {
        const pct = Number(ent && ent.labelScale);
        return Math.min(3, Math.max(0.5, (isFinite(pct) && pct > 0 ? pct : 100) / 100));
      }

      /** Push an entity's own label size onto its label element. @param {object} ent */
      function applyLabelScale(ent) {
        if (!ent || !ent._labelEl) return;
        ent._labelEl.style.setProperty('--label-scale', labelScaleOf(ent));
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
          // A route label re-ties itself to the nearest point on its own line
          // as it moves; the snapshot that makes that cheap is taken here, once
          // per drag. Anything without the hooks drags exactly as before.
          if (ent.onLabelDragStart) ent.onLabelDragStart();
          wrap.setPointerCapture(e.pointerId);
          e.preventDefault();
        });
        wrap.addEventListener('pointermove', e => {
          if (!dragging) return;
          ent.labelOffset.x = ox + (e.clientX - sx);
          ent.labelOffset.y = oy + (e.clientY - sy);
          if (ent.onLabelDrag) {
            ent.onLabelDrag();
            // The hook rewrites labelOffset relative to the new anchor, so the
            // drag's own baseline has to move with it or the next pointermove
            // would re-apply the whole delta from the old anchor and the label
            // would shoot off.
            ox = ent.labelOffset.x - (e.clientX - sx);
            oy = ent.labelOffset.y - (e.clientY - sy);
          }
          scheduleRepaint();
        });
        wrap.addEventListener('pointerup', () => {
          dragging = false;
          if (ent.onLabelDragEnd) ent.onLabelDragEnd();
        });
        wrap.addEventListener('dblclick', () => { if (ent.onLabelDblclick) ent.onLabelDblclick(); });
        setTimeout(() => wrap.classList.remove('drop-label'), 600);
        // Set here rather than at each call site: every label in the app is
        // built through this one function, so this is the only place that
        // cannot be forgotten when a new kind of label is added.
        wrap.style.setProperty('--label-scale', labelScaleOf(ent));
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

