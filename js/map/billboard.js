/**
 * map/billboard.js — the billboard overlay: DOM pins/labels that live outside
 * the tilt stage, screen-space projection through the tilt transform, the
 * repaint loop, leader-line canvas, and element factories with drag handling.
 */
import L from 'leaflet';
import { brand, locations, routes, uiState } from '../core/state.js';
import { svgForKey } from '../map/icons.js';
import { map, tiltDeg } from '../map/mapEngine.js';
import { updateRings } from '../map/markers.js';
import { drawRoute, recomputeRoutesTouching } from '../map/routes.js';
import { autoAvoidCollisions } from '../map/snapping.js';
import { $ } from '../utils/dom.js';
import { fmtCoord } from '../utils/math.js';

      // ---------- billboard layer: labels/markers live OUTSIDE the tilt stage ----------
      export const bbLayer = $('billboardLayer');
      const leaderCanvas = document.createElement('canvas');
      leaderCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      bbLayer.appendChild(leaderCanvas);
      let bbW = 0, bbH = 0;
      export function resizeBB() {
        bbW = bbLayer.clientWidth; bbH = bbLayer.clientHeight;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        leaderCanvas.width = bbW * dpr; leaderCanvas.height = bbH * dpr;
        leaderCanvas.style.width = bbW + 'px'; leaderCanvas.style.height = bbH + 'px';
        leaderCanvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
        scheduleRepaint();
      }

      // Project the tilted map's container point through the CSS 3D transform to the
      // user's viewport plane, so labels sit exactly on the imagery even when tilted.
      export function projectPin(latlng) {
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
      export function scheduleRepaint() {
        if (repaintScheduled) return;
        repaintScheduled = true;
        requestAnimationFrame(() => {
          repaintScheduled = false;
          repaintBillboard();
        });
      }

      // ---------- main billboard repaint ----------
      export function repaintBillboard() {
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

        autoAvoidCollisions(entries);

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
        entries.forEach(e => {
          const pin = projectPin(e.anchor);
          const rect = e._labelEl.getBoundingClientRect();
          const wrapRect = bbLayer.getBoundingClientRect();
          const lx = rect.left - wrapRect.left + rect.width / 2;
          const ly = rect.top - wrapRect.top + rect.height / 2;
          ctx.beginPath();
          ctx.moveTo(pin.x, pin.y);
          ctx.lineTo(lx, ly);
          ctx.strokeStyle = e._leaderColor || 'rgba(255,255,255,.7)';
          ctx.lineWidth = 1.4;
          ctx.setLineDash([]);
          ctx.stroke();
        });
      }

      // ---------- creating billboard elements ----------
      export function makePinEl(loc, animate) {
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
        wrap.addEventListener('pointerenter', () => wrap.classList.add('hover'));
        wrap.addEventListener('pointerleave', () => wrap.classList.remove('hover'));
        wrap.addEventListener('click', e => {
          if (dragMoved) { e.preventDefault(); return; }
          document.querySelectorAll('#billboardLayer .bb.selected').forEach(el => el.classList.remove('selected'));
          wrap.classList.add('selected');
          setTimeout(() => wrap.classList.remove('selected'), 1500);
        });
        setTimeout(() => wrap.classList.remove('drop-anchor'), 600);
        bbLayer.appendChild(wrap);
        return wrap;
      }

      export function makeLabelEl(ent, kind, opts, animate) {
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

      export function removeBB(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }


      // ---------- geometry ----------
      export function offsetCoords(coords, px) {
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
      export function initBillboard() {
        window.addEventListener('resize', resizeBB);
        map.on('resize', resizeBB);
        setTimeout(resizeBB, 0);
        setTimeout(resizeBB, 200);   // second pass after fonts/layout settle
        map.on('move zoom moveend zoomend viewreset', scheduleRepaint);
        map.on('zoomend', () => { routes.forEach(rt => { if (rt.offsetPx) drawRoute(rt); }); });
      }

