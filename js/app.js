/**
 * app.js — application entry point.
 *
 * Phase 4 step 1: the entire v4.96 inline script moved here verbatim (still one
 * IIFE), with Leaflet and html2canvas now bundled from npm (same pinned
 * versions the CDN served: leaflet 1.9.4, html2canvas 1.4.1) and the PPTX
 * engine imported directly. Subsequent steps split this body into
 * core/ map/ ui/ services/ project/ modules.
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import html2canvas from 'html2canvas';
import { exportDeck } from './export/exportPPT.js';

// Exposed for the browser smoke test and console debugging; the app itself
// calls exportDeck via this same reference.

import { LOGO_B64, LOGO_AR, PALETTE } from './constants.js';
import { ROUTERS } from './config.js';
import { $, esc } from './utils/dom.js';
import { parseCoord, fmtCoord, haversineKm } from './utils/math.js';
import { hex, chan, textOn, lighten } from './utils/colors.js';
import { locations, routes, locById, newId, bumpId } from './core/state.js';
import { ICON_LIBRARY, ICON_KEYS, svgForKey } from './map/icons.js';
import { status } from './ui/notifications.js';
window.DBOTExport = { exportDeck };

    /*JS-START*/
    (function () {
      'use strict';

      // ---------- DBOT brand asset ----------
      document.querySelectorAll('.dbotLogo').forEach(i => { i.src = 'data:image/png;base64,' + LOGO_B64; });

      // ---------- helpers ----------

      // ---------- map + basemaps ----------
      const map = L.map('map', { zoomControl: false, attributionControl: false, maxZoom: 21 }).setView([21.5, 78.5], 5);
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      let scaleCtl = L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
      const vectorRenderer = L.canvas({ padding: 0.5 });

      const TL = (url, opts) => L.tileLayer(url, Object.assign({ maxZoom: 21, crossOrigin: 'anonymous' }, opts || {}));
      const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
      const mk = (path, o) => TL(ESRI + path + '/MapServer/tile/{z}/{y}/{x}', o);
      // maxNativeZoom = deepest real tiles; beyond that Leaflet upscales instead of showing
      // blank "no data" tiles. detectRetina pulls double-resolution tiles on sharp screens.
      // Retina screens (phones, hi-dpi laptops) request tiles one zoom deeper; RZ lowers the
      // native cap by one there so requests never pass the deepest real tiles — this was the
      // cause of the "Map data not yet available" grey tiles.
      const RZ = nz => (L.Browser.retina ? nz - 1 : nz);
      const BASEMAPS = {
        hybrid: {
          credit: 'Imagery © Esri · Maxar · Earthstar Geographics', build: hd => [
            mk('World_Imagery', { zIndex: 1, maxNativeZoom: RZ(hd ? 19 : 18), detectRetina: true }),
            mk('Reference/World_Transportation', { zIndex: 3, maxNativeZoom: 17 }),
            mk('Reference/World_Boundaries_and_Places', { zIndex: 4, maxNativeZoom: 17 })]
        },
        sat: {
          credit: 'Imagery © Esri · Maxar · Earthstar Geographics', build: hd => [
            mk('World_Imagery', { zIndex: 1, maxNativeZoom: RZ(hd ? 19 : 18), detectRetina: true })]
        },
        esristreet: { credit: '© Esri · World Street Map', build: () => [mk('World_Street_Map', { zIndex: 1, maxNativeZoom: RZ(18), detectRetina: true })] },
        osm: { credit: '© OpenStreetMap contributors', build: () => [TL('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { zIndex: 1, maxNativeZoom: RZ(19), detectRetina: true })] },
        voyager: { credit: '© CARTO · © OpenStreetMap', build: () => [TL('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { zIndex: 1, maxNativeZoom: 20 })] },
        lightgray: {
          credit: '© Esri · Light Gray Canvas', build: () => [
            mk('Canvas/World_Light_Gray_Base', { zIndex: 1, maxNativeZoom: RZ(16), detectRetina: true }),
            mk('Canvas/World_Light_Gray_Reference', { zIndex: 3, maxNativeZoom: 16 })]
        },
        darkgray: {
          credit: '© Esri · Dark Gray Canvas', build: () => [
            mk('Canvas/World_Dark_Gray_Base', { zIndex: 1, maxNativeZoom: RZ(16), detectRetina: true }),
            mk('Canvas/World_Dark_Gray_Reference', { zIndex: 3, maxNativeZoom: 16 })]
        },
        positron: { credit: '© CARTO · © OpenStreetMap', build: () => [TL('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { zIndex: 1, maxNativeZoom: 20 })] },
        dark: { credit: '© CARTO · © OpenStreetMap', build: () => [TL('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { zIndex: 1, maxNativeZoom: 20 })] },
        topo: { credit: '© Esri · World Topo', build: () => [mk('World_Topo_Map', { zIndex: 1, maxNativeZoom: RZ(18), detectRetina: true })] },
        natgeo: { credit: '© Esri · National Geographic', build: () => [mk('NatGeo_World_Map', { zIndex: 1, maxNativeZoom: RZ(16), detectRetina: true })] },
        opentopo: { credit: '© OpenTopoMap · © OpenStreetMap', build: () => [TL('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { zIndex: 1, maxNativeZoom: 17, subdomains: 'abc' })] }
      };
      const hillshade = mk('Elevation/World_Hillshade', { maxNativeZoom: 15, opacity: .35, zIndex: 2 });
      let activeBase = [], activeKey = 'hybrid';
      function setBasemap(key) {
        activeKey = key;
        activeBase.forEach(l => map.removeLayer(l));
        activeBase = BASEMAPS[key].build($('hdTgl').checked);
        activeBase.forEach(l => l.addTo(map));
        $('mapCredit').textContent = BASEMAPS[key].credit;
      $('basemapSel').addEventListener('change', e => setBasemap(e.target.value));
      $('hdTgl').addEventListener('change', () => setBasemap(activeKey));
      $('hillTgl').addEventListener('change', e => { if (e.target.checked) hillshade.addTo(map); else map.removeLayer(hillshade); });
      setBasemap('hybrid');

      // ---------- 3D tilt (billboarded markers) ----------
      let tiltDeg = 0;
      function applyTilt() {
        $('tiltStage').style.transform = tiltDeg ? `rotateX(${tiltDeg}deg) scale(${(1 + tiltDeg / 120).toFixed(3)})` : '';
        $('tiltVal').textContent = tiltDeg + '°';
        scheduleRepaint();
      }
      $('tiltRange').addEventListener('input', e => { tiltDeg = +e.target.value; applyTilt(); });

      function warpPerspective(src, deg) {
        const t = deg * Math.PI / 180, W = src.width, H = src.height, d = 1.5 * H;
        const f = y => d / (d - y * Math.sin(t));
        const Yp = y => y * Math.cos(t) * f(y);
        const yT = -H / 2, yB = H / 2, YT = Yp(yT), YB = Yp(yB);
        const s0 = 1 / f(yB);
        const outH = Math.max(2, Math.round((YB - YT) * s0));
        const out = document.createElement('canvas');
        out.width = W; out.height = outH;
        const ctx = out.getContext('2d');
        ctx.fillStyle = '#0d1522'; ctx.fillRect(0, 0, W, outH);
        for (let row = 0; row < outH; row++) {
          const Yv = YT + (row / (outH - 1)) * (YB - YT);
          const y = Yv * d / (d * Math.cos(t) + Yv * Math.sin(t));
          const srcRow = Math.min(H - 1, Math.max(0, y + H / 2));
          const sc = f(y) * s0, dw = W * sc;
          ctx.drawImage(src, 0, srcRow, W, 1, (W - dw) / 2, row, dw, 1);
        }
        return out;
      }

      // ---------- icon library (SVGs; every icon inherits currentColor for tinting) ----------

      }

      // ---------- billboard layer: labels/markers live OUTSIDE the tilt stage ----------
      const bbLayer = $('billboardLayer');
      const leaderCanvas = document.createElement('canvas');
      leaderCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      bbLayer.appendChild(leaderCanvas);
      let bbW = 0, bbH = 0;
      function resizeBB() {
        bbW = bbLayer.clientWidth; bbH = bbLayer.clientHeight;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        leaderCanvas.width = bbW * dpr; leaderCanvas.height = bbH * dpr;
        leaderCanvas.style.width = bbW + 'px'; leaderCanvas.style.height = bbH + 'px';
        leaderCanvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
        scheduleRepaint();
      }
      window.addEventListener('resize', resizeBB);
      map.on('resize', resizeBB);
      setTimeout(resizeBB, 0);
      setTimeout(resizeBB, 200);   // second pass after fonts/layout settle

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
      function scheduleRepaint() {
        if (repaintScheduled) return;
        repaintScheduled = true;
        requestAnimationFrame(() => {
          repaintScheduled = false;
          repaintBillboard();
        });
      }
      map.on('move zoom moveend zoomend viewreset', scheduleRepaint);
      map.on('zoomend', () => { routes.forEach(rt => { if (rt.offsetPx) drawRoute(rt); }); });

      // ---------- label collision avoidance (radial nudge) ----------
      function autoAvoidCollisions(entries) {
        const items = entries.filter(e => e._labelEl && e.showLabel);
        if (items.length < 2) return;
        items.forEach(e => {
          const r = e._labelEl.getBoundingClientRect();
          e._w = r.width; e._h = r.height;
          const pin = projectPin(e.anchor);
          e._px = pin.x + (e.labelOffset.x || 0);
          e._py = pin.y + (e.labelOffset.y || 0);
        });
        const PAD = 3;
        for (let iter = 0; iter < 12; iter++) {
          let moved = false;
          for (let i = 0; i < items.length; i++) {
            for (let j = i + 1; j < items.length; j++) {
              const A = items[i], B = items[j];
              const ax1 = A._px, ay1 = A._py, ax2 = ax1 + A._w, ay2 = ay1 + A._h;
              const bx1 = B._px, by1 = B._py, bx2 = bx1 + B._w, by2 = by1 + B._h;
              const overlapX = Math.min(ax2, bx2) - Math.max(ax1, bx1);
              const overlapY = Math.min(ay2, by2) - Math.max(ay1, by1);
              if (overlapX > 0 && overlapY > 0) {
                // Nudge by the smaller overlap axis
                if (overlapX < overlapY) {
                  const shift = (overlapX + PAD) / 2;
                  if (ax1 < bx1) { A._px -= shift; B._px += shift; }
                  else { A._px += shift; B._px -= shift; }
                } else {
                  const shift = (overlapY + PAD) / 2;
                  if (ay1 < by1) { A._py -= shift; B._py += shift; }
                  else { A._py += shift; B._py -= shift; }
                }
                moved = true;
              }
            }
          }
          if (!moved) break;
        }
        // Write back to labelOffset when auto-avoidance is on
        items.forEach(e => {
          if (!e.labelPinned) {
            const pin = projectPin(e.anchor);
            e._autoOffsetX = e._px - pin.x;
            e._autoOffsetY = e._py - pin.y;
          }
        });
      }

      // ---------- main billboard repaint ----------
      function repaintBillboard() {
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
          } else if (loc.iconUseProjectLogo && projectLogo) {
            const img = document.createElement('img');
            img.src = projectLogo;
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
          if (addingMode) return;
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
          if (addingMode) return;
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

      // ---------- project logo (default site icon) ----------
      let projectLogo = null;
      let siteUsesProjLogo = false;

      // ---------- locations ----------
      function locLabelIconHtml(loc) {
        // Small icon shown inside the label badge itself
        if (loc.iconImage) return `<img src="${loc.iconImage}">`;
        if (loc.iconUseProjectLogo && projectLogo) return `<img src="${projectLogo}">`;
        return svgForKey(loc.iconKey || (loc.type === 'site' ? 'star' : 'pin'), '#FFFFFF');
      }
      function renderLocPin(loc) {
        const wasFirst = !loc._everRendered;
        if (loc._pinEl) removeBB(loc._pinEl);
        loc._pinEl = makePinEl(loc, wasFirst);
        loc._everRendered = true;
        loc.anchor = L.latLng(loc.lat, loc.lng);
        updateRings(loc);
        scheduleRepaint();
      }
      function updateRings(loc) {
        (loc.ringLayers || []).forEach(l => map.removeLayer(l));
        (loc._ringLabelEls || []).forEach(removeBB);
        loc.ringLayers = [];
        loc._ringLabelEls = [];
        loc.ringLabels = [];
        (loc.rings || []).forEach(r => {
          const km = parseFloat(r.km);
          if (!km || km <= 0) return;
          const circ = L.circle([loc.lat, loc.lng], { radius: km * 1000, color: r.color, weight: 2, dashArray: '6,8', fillColor: r.color, fillOpacity: r.op, opacity: .9, interactive: false, renderer: vectorRenderer }).addTo(map);
          loc.ringLayers.push(circ);
          const ringEnt = {
            anchor: L.latLng(loc.lat + km / 111.32, loc.lng),
            labelOffset: { x: 0, y: -14 }, labelPinned: true, showLabel: true,
            _leaderColor: r.color
          };
          const wrap = makeLabelEl(ringEnt, 'ring', { klass: 'ring', text: km + ' km' });
          ringEnt._labelEl = wrap;
          ringEnt._el = wrap.firstChild;
          loc._ringLabelEls.push(wrap);
          loc.ringLabels.push({ latlng: [loc.lat + km / 111.32, loc.lng], color: r.color, text: km + ' km', ent: ringEnt, wrap: wrap });
        });
        scheduleRepaint();
      }
      function updateLocLabel(loc) {
        const wasFirst = !loc._labelEverRendered;
        if (loc._labelEl) { removeBB(loc._labelEl); loc._labelEl = null; loc._el = null; }
        if (loc.showLabel && loc.type !== 'badge' && !loc.hideMarker) {
          const isSite = loc.type === 'site';
          const bg = loc.labelBg || (isSite ? '#0A1E3C' : '#FFFFFF');
          const el = makeLabelEl(loc, 'loc', {
            klass: isSite ? 'site' : '',
            bg: bg, color: textOn(bg), accent: loc.color,
            iconHtml: loc.labelShowIcon === false ? null : locLabelIconHtml(loc),
            iconPlain: !!loc.iconImage || (loc.iconUseProjectLogo && projectLogo),
            text: loc.name
          }, wasFirst);
          loc._labelEl = el;
          loc._labelEverRendered = true;
          loc._el = el.firstChild;
          loc._leaderColor = isSite ? '#FF7A1A' : loc.color;
          loc.onLabelDblclick = () => {
            const v = prompt('Location name:', loc.name);
            if (v !== null) { loc.name = v; loc.card.querySelector('.nm').value = v; locChanged(loc); }
          };
        }
      }
      function locChanged(loc) {
        renderLocPin(loc); updateLocLabel(loc);
        refreshRouteSelects(); rebuildLegend();
      }
      function addLocation(opts) {
        opts = opts || {};
        let rings = opts.rings;
        if (!rings && opts.ringKm) {
          const km = parseFloat(opts.ringKm);
          rings = km > 0 ? [{ km: km, color: opts.color || '#2563EB', op: .08 }] : [];
        }
        const loc = {
          id: opts.id || newId(),
          name: opts.name || ('Location ' + (locations.length + 1)),
          lat: opts.lat, lng: opts.lng,
          color: opts.color || (opts.type === 'badge' ? '#F7C948' : (opts.type === 'site' ? '#0A1E3C' : PALETTE[locations.length % PALETTE.length])),
          type: opts.type || 'pin',
          badgeText: opts.badgeText || 'NH 66',
          showLabel: opts.showLabel !== undefined ? opts.showLabel : true,
          labelOffset: opts.labelOffset || { x: 22, y: -40 },
          labelPinned: !!opts.labelPinned,
          labelBg: opts.labelBg || (opts.type === 'site' ? '#0A1E3C' : '#FFFFFF'),
          labelShowIcon: opts.labelShowIcon !== false,
          // Icon customization
          iconKey: opts.iconKey || (opts.type === 'site' ? 'star' : 'pin'),
          iconImage: opts.iconImage || null,
          iconUseProjectLogo: !!opts.iconUseProjectLogo,
          iconSize: opts.iconSize || (opts.type === 'site' ? 44 : 36),
          iconFrame: opts.iconFrame || 'circle',
          iconBg: opts.iconBg || '#FFFFFF',
          iconBorder: opts.iconBorder !== undefined ? opts.iconBorder : 2,
          iconBorderColor: opts.iconBorderColor || (opts.color || (opts.type === 'site' ? '#FF7A1A' : '#FFFFFF')),
          iconShadow: opts.iconShadow !== undefined ? opts.iconShadow : 6,
          iconGlow: !!opts.iconGlow,
          hideMarker: !!opts.hideMarker,
          rings: rings || [], photo: opts.photo || null,
          _pinEl: null, _labelEl: null, _el: null, _ringLabelEls: [], ringLayers: [], ringLabels: [], anchor: null, card: null
        };
        // If it's a Site and the "default site logo" setting is on, opt in by default
        if (loc.type === 'site' && siteUsesProjLogo && !opts.iconImage) loc.iconUseProjectLogo = true;
        bumpId(loc.id);
        locations.push(loc);
        buildLocCard(loc);
        renderLocPin(loc); updateLocLabel(loc);
        refreshRouteSelects(); rebuildLegend(); syncEmpties();
        return loc;
      }
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
      function buildLocCard(loc) {
        const card = document.createElement('div');
        card.className = 'item-card';
        const iconOpts = ICON_KEYS.map(k => `<option value="${k}" ${loc.iconKey === k ? 'selected' : ''}>${esc(ICON_LIBRARY[k].label)}</option>`).join('');
        card.innerHTML = `
    <div class="r">
      <input type="color" class="clr" value="${esc(loc.color)}" title="Pin / accent color">
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
        <select class="ico grow">${iconOpts}</select>
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

        const iconPanel = card.querySelector('.iconPanel');
        card.querySelector('.iconTgl').addEventListener('click', () => {
          iconPanel.style.display = iconPanel.style.display === 'none' ? 'block' : 'none';
        });

        card.querySelector('.clr').addEventListener('input', e => { loc.color = e.target.value; if (!loc.iconBorderColor || loc.iconBorderColor === loc.color) loc.iconBorderColor = e.target.value; locChanged(loc); });
        card.querySelector('.nm').addEventListener('change', e => { loc.name = e.target.value || 'Location'; locChanged(loc); });
        card.querySelector('.tp').addEventListener('change', e => {
          loc.type = e.target.value;
          card.querySelector('.bt-row').style.display = loc.type === 'badge' ? '' : 'none';
          if (loc.type === 'badge') { loc.color = '#F7C948'; card.querySelector('.clr').value = '#F7C948'; }
          if (loc.type === 'site') {
            loc.color = '#0A1E3C'; loc.labelBg = '#0A1E3C'; loc.iconBorderColor = '#FF7A1A';
            card.querySelector('.clr').value = '#0A1E3C'; card.querySelector('.lbg').value = '#0A1E3C'; card.querySelector('.bc').value = '#FF7A1A';
            if (!loc.iconImage) loc.iconKey = 'star';
            card.querySelector('.ico').value = loc.iconKey;
            if (siteUsesProjLogo) loc.iconUseProjectLogo = true;
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
        card.querySelector('.ico').addEventListener('change', e => { loc.iconKey = e.target.value; loc.iconImage = null; card.querySelector('.customPreview').style.display = 'none'; locChanged(loc); });
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
        $('locList').appendChild(card);
        renderRingRows(loc);
      }
      function deleteLocation(loc) {
        routes.filter(r => r.fromId === loc.id || r.toId === loc.id).forEach(deleteRoute);
        if (loc._pinEl) removeBB(loc._pinEl);
        if (loc._labelEl) removeBB(loc._labelEl);
        (loc._ringLabelEls || []).forEach(removeBB);
        (loc.ringLayers || []).forEach(l => map.removeLayer(l));
        loc.card.remove();
        locations.splice(locations.indexOf(loc), 1);
        refreshRouteSelects(); rebuildLegend(); syncEmpties();
        scheduleRepaint();
      }
      function recomputeRoutesTouching(locId) {
        routes.forEach(r => { if (r.fromId === locId || r.toId === locId) computeRoute(r); });
      }

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
        for (const base of ROUTERS[rt.mode] || ROUTERS.car) {
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
          alts: opts.saved ? [opts.saved] : null, altIndex: 0, approx: opts.saved ? !!opts.saved.approx : false,
          line: null, _labelEl: null, _el: null, _viaEls: [], anchor: null, card: null
        };
        bumpId(rt.id);
        routes.push(rt);
        buildRtCard(rt);
        syncEmpties();
        if (rt.alts) { drawRoute(rt); renderViaDots(rt); } else computeRoute(rt);
        rebuildLegend();
        return rt;
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
      function deleteRoute(rt) {
        if (rt.line) map.removeLayer(rt.line);
        if (rt._labelEl) removeBB(rt._labelEl);
        (rt._viaEls || []).forEach(removeBB);
        if (rt.card) rt.card.remove();
        routes.splice(routes.indexOf(rt), 1);
        rebuildLegend(); syncEmpties();
        scheduleRepaint();
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
        scheduleRepaint();
      }

      function armViaAdd(rt) {
        if (armingViaFor === rt) { armingViaFor = null; $('mapWrap').classList.remove('via-arming'); status('Via-point mode cancelled.'); return; }
        armingViaFor = rt;
        $('mapWrap').classList.add('via-arming');
        const A = locById(rt.fromId), B = locById(rt.toId);
        status(`Click on the map to force this route through a waypoint (${A ? A.name : '?'} → ${B ? B.name : '?'}). Esc to cancel.`, true);
      }
      function disarmVia() {
        armingViaFor = null;
        $('mapWrap').classList.remove('via-arming');
      }

      function showRouteContextMenu(rt, x, y, latlng) {
        const menu = $('ctxMenu');
        const A = locById(rt.fromId), B = locById(rt.toId);
        const routeName = (A ? A.name : '?') + ' → ' + (B ? B.name : '?');
        const vc = (rt.viaPoints || []).length;
        menu.innerHTML =
          '<div class="lbl">' + esc(routeName.length > 28 ? routeName.slice(0, 26) + '…' : routeName) + '</div>' +
          '<div class="mi" data-a="add"><span class="ico">+</span>Add via-point here</div>' +
          (vc ? '<div class="mi" data-a="clear"><span class="ico">×</span>Clear ' + vc + ' via-point' + (vc > 1 ? 's' : '') + '</div>' : '') +
          '<div class="sep"></div>' +
          '<div class="mi" data-a="zoom"><span class="ico">⌖</span>Zoom to this route</div>' +
          '<div class="mi" data-a="alt"><span class="ico">⇆</span>Cycle alternative</div>';
        const wrapRect = $('mapWrap').getBoundingClientRect();
        const px = Math.min(x - wrapRect.left, wrapRect.width - 210);
        const py = Math.min(y - wrapRect.top, wrapRect.height - 200);
        menu.style.left = Math.max(6, px) + 'px';
        menu.style.top = Math.max(6, py) + 'px';
        menu.classList.add('on');
        menu.querySelectorAll('.mi').forEach(mi => {
          mi.addEventListener('click', () => {
            const a = mi.getAttribute('data-a');
            menu.classList.remove('on');
            if (a === 'add') {
              rt.viaPoints = rt.viaPoints || [];
              rt.viaPoints.push({ lat: latlng.lat, lng: latlng.lng });
              computeRoute(rt); updateRtCardStats(rt);
            } else if (a === 'clear') {
              rt.viaPoints = [];
              computeRoute(rt); updateRtCardStats(rt);
              status('Via-points cleared — routing is back to auto.');
            } else if (a === 'zoom') {
              if (rt.line) map.fitBounds(rt.line.getBounds(), { padding: [70, 70] });
            } else if (a === 'alt') {
              if (!rt.alts || rt.alts.length < 2) { status('Only one route was found between these points.'); return; }
              rt.altIndex = (rt.altIndex + 1) % rt.alts.length;
              drawRoute(rt); rebuildLegend();
            }
          });
        });
      }
      document.addEventListener('click', e => {
        if (!e.target.closest('#ctxMenu')) $('ctxMenu').classList.remove('on');
      });

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

      // ---------- search: live suggestions, icons, recents, keyboard, coordinates ----------
      let searchTimer = null, resultsData = [], selIdx = -1, searching = 0;
      const recents = [];
      function iconFor(c, t) {
        if (c === 'railway' || t === 'station' || t === 'halt') return '🚉';
        if (c === 'aeroway' || t === 'aerodrome') return '✈️';
        if (t === 'hospital' || t === 'clinic' || t === 'doctors') return '🏥';
        if (t === 'school' || t === 'college' || t === 'university') return '🎓';
        if (c === 'highway') return '🛣️';
        if (t === 'bus_station' || t === 'bus_stop') return '🚌';
        if (c === 'shop' || t === 'mall' || t === 'marketplace') return '🛍️';
        if (c === 'leisure' || c === 'natural' || t === 'park') return '🌳';
        if (c === 'place' || t === 'suburb' || t === 'neighbourhood' || t === 'city' || t === 'town' || t === 'village') return '🏙️';
        if (c === 'building' || t === 'apartments' || t === 'residential') return '🏢';
        return '📍';
      }
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

      // ---------- click-to-add ----------
      let addingMode = false;
      function setAdding(on) {
        addingMode = on;
        $('mapWrap').classList.toggle('adding', on);
        $('clickAddBtn').classList.toggle('toggled', on);
        $('clickAddBtn').textContent = on ? 'Click-to-add: ON (Esc)' : 'Click map to add';
        if (on && tiltDeg > 0) status('Tip: set 3D tilt to 0° while placing points — clicks land at exact positions only on a flat view.', true);
      }
      $('clickAddBtn').addEventListener('click', () => setAdding(!addingMode));
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          setAdding(false);
          if (armingViaFor) { disarmVia(); status('Via-point mode cancelled.'); }
          $('ctxMenu').classList.remove('on');
        }
      });
      map.on('click', e => {
        // Via-point arming takes priority over add-location
        if (armingViaFor) {
          const rt = armingViaFor;
          rt.viaPoints = rt.viaPoints || [];
          rt.viaPoints.push({ lat: e.latlng.lat, lng: e.latlng.lng });
          disarmVia();
          computeRoute(rt);
          updateRtCardStats(rt);
          return;
        }
        if (!addingMode) return;
        const loc = addLocation({ lat: e.latlng.lat, lng: e.latlng.lng });
        fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${e.latlng.lat}&lon=${e.latlng.lng}`)
          .then(r => r.json())
          .then(j => {
            const nm = j.name || (j.display_name || '').split(',')[0];
            if (nm) { loc.name = nm; loc.card.querySelector('.nm').value = nm; locChanged(loc); }
          }).catch(() => { });
      });
      $('addLocBtn').addEventListener('click', () => {
        const c = map.getCenter();
        addLocation({ lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5) });
        status('Location added at map center — drag the pin or edit its coordinates.');
      });
      $('addRtBtn').addEventListener('click', () => {
        if (locations.length < 2) { status('Add at least two locations first — a route connects two of them.'); return; }
        addRoute();
      });

      // ---------- overlays / appearance ----------
      $('titleTgl').addEventListener('change', e => { $('titleCard').style.display = e.target.checked ? '' : 'none'; });
      $('legendTgl').addEventListener('change', rebuildLegend);
      $('scaleTgl').addEventListener('change', e => {
        if (e.target.checked) { scaleCtl = L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map); }
        else if (scaleCtl) { map.removeControl(scaleCtl); scaleCtl = null; }
      });
      $('creditTgl').addEventListener('change', e => document.body.classList.toggle('no-credit', !e.target.checked));
      $('glassTgl').addEventListener('change', e => document.body.classList.toggle('no-glass', !e.target.checked));
      $('brandTgl').addEventListener('change', e => document.body.classList.toggle('no-brand', !e.target.checked));
      $('northTgl').addEventListener('change', e => document.body.classList.toggle('no-north', !e.target.checked));
      let chipPct = 100, chipFont = 11.5;
      function applyChipScale() {
        chipFont = +(11.5 * chipPct / 100).toFixed(2);
        document.documentElement.style.setProperty('--chipFont', chipFont + 'px');
        $('chipVal').textContent = chipPct + '%';
        $('chipRange').value = chipPct;
      }
      $('chipRange').addEventListener('input', e => { chipPct = +e.target.value; applyChipScale(); });
      (function legendDraggable() {
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
      })();

      $('sideToggle').addEventListener('click', () => $('app').classList.toggle('side-hidden'));

      // Cursor spotlight: track pointer position over panel controls (hover-capable devices only)
      if (window.matchMedia('(hover:hover)').matches) {
        document.querySelector('.sidebar').addEventListener('pointermove', e => {
          const el = e.target.closest('.btn, .item-card, .tabs button');
          if (!el) return;
          const r = el.getBoundingClientRect();
          el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
          el.style.setProperty('--my', (e.clientY - r.top) + 'px');
        });
      }

      // ---------- view / export ----------
      function fitAll() {
        const pts = [];
        locations.forEach(l => {
          pts.push([l.lat, l.lng]);
          (l.rings || []).forEach(r => {
            const km = parseFloat(r.km);
            if (km > 0) { pts.push([l.lat + km / 111.32, l.lng]); pts.push([l.lat - km / 111.32, l.lng]); }
          });
        });
        routes.forEach(r => { const a = r.alts && r.alts[r.altIndex]; if (a) a.coords.forEach(c => pts.push(c)); });
        if (!pts.length) { status('Nothing to fit yet — add a location first.'); return; }
        map.fitBounds(pts, { padding: [80, 80] });
      }
      $('fitBtn').addEventListener('click', fitAll);

      async function captureMap(extraClass) {
        const wrap = $('mapWrap');
        const stage = $('tiltStage');
        const savedTransform = stage.style.transform;
        const wasTilted = wrap.classList.contains('tilted');
        stage.style.transform = '';
        wrap.classList.remove('tilted');            // billboard correction off for the flat pass
        wrap.classList.add('capturing');
        if (extraClass) wrap.classList.add(extraClass);
        try {
          // foreignObjectRendering delegates to the browser's own native rendering for
          // the captured subtree. Without it, html2canvas's own re-implemented CSS engine
          // fails to draw text inside elements positioned via a JS-applied CSS transform
          // (the location/route label chips) -- the chip's background/border render fine,
          // but the name/text inside is silently skipped. This was confirmed by direct
          // testing: switching this on is what makes labels actually appear in exports.
          //
          // BUT: foreignObjectRendering serialises the subtree to an SVG <foreignObject>,
          // and the browser refuses to draw *cross-origin images* (the map tiles) inside an
          // SVG-drawn-to-canvas -- so tiles come out as broken-image placeholders. For the
          // PPTX capture that does not matter and must be avoided: the label chips are
          // hidden (.pptx-capture) and re-added as native PowerPoint objects by the export
          // engine, so this pass only needs the tiles + route lines. Use the standard
          // renderer there so the basemap actually rasterises.
          const pptxPass = extraClass === 'pptx-capture';
          const opts = { useCORS: true, allowTaint: false, scale: 2, logging: false, backgroundColor: '#0d1522' };
          if (pptxPass) {
            return await html2canvas(wrap, opts);
          }
          try {
            return await html2canvas(wrap, { ...opts, foreignObjectRendering: true });
          } catch (foErr) {
            // Rare fallback: some older/locked-down browsers don't support foreignObjectRendering
            // well. Degrade to the standard renderer rather than failing the export outright.
            return await html2canvas(wrap, opts);
          }
        } finally {
          wrap.classList.remove('capturing');
          if (extraClass) wrap.classList.remove(extraClass);
          stage.style.transform = savedTransform;
          if (wasTilted) wrap.classList.add('tilted');
        }
      }

      $('pngBtn').addEventListener('click', async () => {
        status('Rendering PNG… (a few seconds)', true);
        try {
          let canvas = await captureMap();
          if (tiltDeg > 0) canvas = warpPerspective(canvas, tiltDeg);
          canvas.toBlob(blob => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'property-access-map.png';
            a.click();
            URL.revokeObjectURL(a.href);
            status(tiltDeg > 0 ? 'PNG downloaded with the 3D perspective applied.' : 'PNG downloaded.');
          });
        } catch (e) {
          status('PNG export failed on this basemap/browser — use Print / Save as PDF or a screenshot instead.');
        }
      });
      $('printBtn').addEventListener('click', () => window.print());
      window.addEventListener('beforeprint', () => $('mapWrap').classList.add('capturing'));
      window.addEventListener('afterprint', () => $('mapWrap').classList.remove('capturing'));

      $('fsBtn').addEventListener('click', () => {
        const w = $('mapWrap');
        if (document.fullscreenElement) document.exitFullscreen();
        else if (w.requestFullscreen) w.requestFullscreen();
      });

      // ---------- PPTX export ----------
      const mctx = document.createElement('canvas').getContext('2d');
      $('pptxBtn').addEventListener('click', async () => {
        if (!window.DBOTExport || !window.DBOTExport.exportDeck) {
          status('Export engine still loading — wait a moment and try again.');
          return;
        }
        status('Building editable PPTX… (several seconds)', true);
        const wrap = $('mapWrap');
        const wrapW = wrap.clientWidth, wrapH = wrap.clientHeight;

        const cp = ll => map.latLngToContainerPoint(ll);
        const wrapRectPPT = wrap.getBoundingClientRect();
        const bbToWrap = el => {
          const r = el.getBoundingClientRect();
          return { x: r.left - wrapRectPPT.left + r.width / 2, y: r.top - wrapRectPPT.top + r.height / 2, w: r.width, h: r.height };
        };
        const widgets = { locLabels: [], badges: [], rtLabels: [], rings: [], leaders: [], pins: [] };
        locations.forEach(l => {
          // Icon pin: capture position + image (skip entirely if this location's marker is hidden)
          if (l._pinEl && !l.hideMarker) {
            const wp = bbToWrap(l._pinEl);
            if (l.type === 'badge') {
              widgets.badges.push({ px: { x: wp.x, y: wp.y }, text: l.badgeText, color: l.color });
            } else {
              let iconData = l.iconImage || ((l.iconUseProjectLogo && projectLogo) ? projectLogo : null);
              let iconSvgMarkup = null;
              if (!iconData) {
                iconSvgMarkup = svgForKey(l.iconKey || (l.type === 'site' ? 'star' : 'pin'), l.color);
                iconData = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(iconSvgMarkup)));
              }
              widgets.pins.push({ px: { x: wp.x, y: wp.y }, size: l.iconSize, frame: l.iconFrame, bg: l.iconBg, border: l.iconBorder, borderColor: l.iconBorderColor, iconData, iconSvgMarkup, isImage: !!l.iconImage || !!(l.iconUseProjectLogo && projectLogo) });
            }
          }
          if (l.showLabel && l._labelEl && !l.hideMarker) {
            const lp = bbToWrap(l._labelEl);
            widgets.locLabels.push({ px: { x: lp.x - lp.w / 2, y: lp.y - lp.h / 2 }, text: l.name, site: l.type === 'site', color: l.color, bg: l.labelBg || (l.type === 'site' ? '#0A1E3C' : '#FFFFFF') });
            if (l._pinEl) {
              const pinP = bbToWrap(l._pinEl);
              widgets.leaders.push({ a: { x: pinP.x, y: pinP.y }, b: { x: lp.x, y: lp.y }, color: l.type === 'site' ? '#FF7A1A' : l.color });
            }
          }
          (l.ringLabels || []).forEach(rl => {
            if (rl.wrap) {
              const rp = bbToWrap(rl.wrap);
              widgets.rings.push({ px: { x: rp.x - rp.w / 2, y: rp.y - rp.h / 2 }, text: rl.text, color: rl.color });
            }
          });
        });
        routes.forEach(rt => {
          if (rt.showLabel && rt._labelEl) {
            const lp = bbToWrap(rt._labelEl);
            widgets.rtLabels.push({ px: { x: lp.x - lp.w / 2, y: lp.y - lp.h / 2 }, text: routeLabelText(rt), color: rt.color, bg: rt.labelBg || '#FFFFFF' });
            const aP = cp(rt.anchor);
            widgets.leaders.push({ a: { x: aP.x, y: aP.y }, b: { x: lp.x, y: lp.y }, color: rt.color });
          }
        });
        const titleVisible = $('titleTgl').checked && $('titleCard').style.display !== 'none';
        const titleText = $('titleCard').textContent.trim() || 'PROPERTY LOCATION & ACCESS';
        const wrapRect = wrap.getBoundingClientRect();
        const legendVisible = $('legendCard').style.display !== 'none';
        const legendRect = legendVisible ? $('legendCard').getBoundingClientRect() : null;
        const legendTitle = $('legendTitle').textContent.trim() || 'KEY DISTANCES';
        const lgRows = legendRows();
        const brandOn = $('brandTgl').checked;

        let canvas;
        try {
          canvas = await captureMap('pptx-capture');
        } catch (e) {
          status('Could not render the map image for PPTX on this browser — try the PNG export or Chrome/Edge.');
          return;
        }

        try {
          const dataUrl = canvas.toDataURL('image/png');
          const measurePx = (text, pxSize, bold) => {
            mctx.font = (bold ? '700 ' : '600 ') + pxSize + 'px Arial';
            return mctx.measureText(String(text)).width;
          };
          // Build the engine's deck spec from the widgets collected above. All the
          // pptxgenjs work, id-repair and radius clamping now live in js/export/*.
          const spec = {
            fileName: 'property-access-map.pptx',
            author: 'DBOT · Property Map Studio',
            geometry: { wrapW, wrapH, chipFont },
            slide: {
              background: '0A1E3C',
              map: { data: dataUrl },
              leaders: widgets.leaders,
              pins: widgets.pins,
              locationLabels: widgets.locLabels,
              routeLabels: widgets.rtLabels,
              badges: widgets.badges,
              rings: widgets.rings,
              title: { visible: titleVisible, text: titleText },
              legend: (legendRect && lgRows.length) ? {
                visible: legendVisible, title: legendTitle,
                pxLeft: legendRect.left - wrapRect.left,
                pxTop: legendRect.top - wrapRect.top,
                pxWidth: legendRect.width,
                rows: lgRows
              } : { visible: false },
              logo: brandOn ? { visible: true, data: 'data:image/png;base64,' + LOGO_B64, aspect: LOGO_AR } : { visible: false }
            }
          };
          const { log } = await window.DBOTExport.exportDeck(spec, { measurePx, output: 'download' });
          const skipped = (log && log.skipped) ? ' (' + log.skipped + ' invalid object(s) skipped)' : '';
          status('PPTX downloaded — flat map with native, editable labels, badges, leader lines, title, table and logo.' + skipped);
        } catch (e) {
          status('PPTX build failed: ' + (e && e.message ? e.message : 'unknown error') + ' — the PNG export still works.');
        }
      });

      // ---------- project save / load ----------
      $('saveBtn').addEventListener('click', () => {
        const proj = {
          v: 4.96, title: $('titleCard').textContent, legendTitle: $('legendTitle').textContent,
          view: { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() },
          basemap: activeKey, tilt: tiltDeg, hill: $('hillTgl').checked, chipPct: chipPct,
          hd: $('hdTgl').checked, brand: $('brandTgl').checked, north: $('northTgl').checked,
          projectLogo: projectLogo, siteUsesProjLogo: siteUsesProjLogo,
          locations: locations.map(l => ({
            id: l.id, name: l.name, lat: l.lat, lng: l.lng, color: l.color, type: l.type, badgeText: l.badgeText,
            showLabel: l.showLabel, labelOffset: l.labelOffset, labelPinned: l.labelPinned, labelBg: l.labelBg,
            iconKey: l.iconKey, iconImage: l.iconImage, iconUseProjectLogo: l.iconUseProjectLogo,
            iconSize: l.iconSize, iconFrame: l.iconFrame, iconBg: l.iconBg,
            iconBorder: l.iconBorder, iconBorderColor: l.iconBorderColor, iconShadow: l.iconShadow, iconGlow: l.iconGlow,
            hideMarker: l.hideMarker,
            rings: l.rings
          })),
          routes: routes.map(r => {
            const alt = r.alts && r.alts[r.altIndex];
            return {
              id: r.id, fromId: r.fromId, toId: r.toId, mode: r.mode, color: r.color, weight: r.weight, dash: r.dash, offsetPx: r.offsetPx, labelText: r.labelText, showLabel: r.showLabel, labelOffset: r.labelOffset, labelBg: r.labelBg,
              viaPoints: (r.viaPoints || []).map(v => ({ lat: v.lat, lng: v.lng })),
              saved: alt ? { d: alt.d, t: alt.t, coords: alt.coords, approx: r.approx } : null
            };
          })
        };
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(proj)], { type: 'application/json' }));
        a.download = 'property-map-project.json';
        a.click();
        URL.revokeObjectURL(a.href);
        status('Project saved — open it later with "Open project".');
      });
      $('loadBtn').addEventListener('click', () => $('loadInput').click());
      $('loadInput').addEventListener('change', e => {
        const f = e.target.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          try {
            const proj = JSON.parse(rd.result);
            clearAll();
            if (proj.title) $('titleCard').textContent = proj.title;
            if (proj.legendTitle) $('legendTitle').textContent = proj.legendTitle;
            if (proj.hd !== undefined) $('hdTgl').checked = !!proj.hd;
            if (proj.basemap && BASEMAPS[proj.basemap]) { $('basemapSel').value = proj.basemap; }
            setBasemap($('basemapSel').value);
            if (proj.tilt !== undefined) { tiltDeg = +proj.tilt || 0; $('tiltRange').value = tiltDeg; applyTilt(); }
            if (proj.hill) { $('hillTgl').checked = true; hillshade.addTo(map); }
            if (proj.chipPct) { chipPct = +proj.chipPct; }
            else if (proj.chipFont) { chipPct = Math.round(+proj.chipFont / 11.5 * 100); }
            applyChipScale();
            if (proj.brand !== undefined) { $('brandTgl').checked = !!proj.brand; document.body.classList.toggle('no-brand', !proj.brand); }
            if (proj.north !== undefined) { $('northTgl').checked = !!proj.north; document.body.classList.toggle('no-north', !proj.north); }
            if (proj.projectLogo) { setProjectLogo(proj.projectLogo); }
            if (proj.siteUsesProjLogo) { siteUsesProjLogo = true; $('siteUsesProjLogo').checked = true; }
            (proj.locations || []).forEach(l => addLocation(l));
            (proj.routes || []).forEach(r => addRoute(r));
            if (proj.view) map.setView(proj.view.c, proj.view.z); else fitAll();
            status('Project loaded.');
          } catch (err) { status('Could not read that file — is it a saved project (.json)?'); }
        };
        rd.readAsText(f);
        e.target.value = '';
      });
      function clearAll() {
        routes.slice().forEach(deleteRoute);
        locations.slice().forEach(deleteLocation);
      }

      // ---------- Brand tab wiring ----------
      function setProjectLogo(dataUrl) {
        projectLogo = dataUrl;
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
        siteUsesProjLogo = e.target.checked;
        locations.forEach(l => {
          if (l.type === 'site') {
            l.iconUseProjectLogo = siteUsesProjLogo;
            if (l.card) { const cb = l.card.querySelector('.uspl'); if (cb) cb.checked = siteUsesProjLogo; }
            renderLocPin(l); updateLocLabel(l);
          }
        });
        scheduleRepaint();
        status(siteUsesProjLogo ? 'All Site pins now use the project logo.' : 'Site pins reverted to their per-location icons.');
      });
      $('brandTitleInput').addEventListener('input', e => { $('titleCard').textContent = e.target.value || 'PROPERTY LOCATION & ACCESS'; });

      // ---------- tabs ----------
      const TABS = [['tabBtnLoc', 'paneLoc'], ['tabBtnRt', 'paneRt'], ['tabBtnBrand', 'paneBrand'], ['tabBtnMap', 'paneMap']];
      TABS.forEach(([b, p]) => {
        $(b).addEventListener('click', () => {
          TABS.forEach(([b2, p2]) => { $(b2).classList.toggle('active', b2 === b); $(p2).classList.toggle('active', p2 === p); });
        });
      });

      syncEmpties();
      status('Start blank: type in the search bar for live suggestions, paste "lat, lng" directly, or use Click-to-add.');
    })();
    /*JS-END*/
