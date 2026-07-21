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

import { initBillboard } from './map/billboard.js';
import { ROUTERS } from './config.js';
import { LOGO_AR, LOGO_B64, PALETTE } from './constants.js';
import { brand, bumpId, locById, locations, newId, routes, uiState } from './core/state.js';
import { scheduleRepaint } from './map/billboard.js';
import { ICON_KEYS, ICON_LIBRARY, svgForKey } from './map/icons.js';
import { BASEMAPS, activeKey, applyTilt, hillshade, map, setBasemap, setTiltDeg, tiltDeg, warpPerspective } from './map/mapEngine.js';
import { addLocation, deleteLocation, locChanged, renderLocPin, updateLocLabel } from './map/markers.js';
import { addRoute, armingViaFor, computeRoute, deleteRoute, disarmVia, routeLabelText } from './map/routes.js';
import { status } from './ui/notifications.js';
import { legendRows, rebuildLegend, syncEmpties, updateRtCardStats } from './ui/propertyPanel.js';
import { chan, hex, lighten, textOn } from './utils/colors.js';
import { $, esc } from './utils/dom.js';
import { fmtCoord, haversineKm, parseCoord } from './utils/math.js';
window.DBOTExport = { exportDeck };

// Wire the billboard overlay to the map (see billboard.js).
initBillboard();

    /*JS-START*/

      // ---------- DBOT brand asset ----------
      document.querySelectorAll('.dbotLogo').forEach(i => { i.src = 'data:image/png;base64,' + LOGO_B64; });

      // ---------- helpers ----------

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
      function setAdding(on) {
        uiState.addingMode = on;
        $('mapWrap').classList.toggle('adding', on);
        $('clickAddBtn').classList.toggle('toggled', on);
        $('clickAddBtn').textContent = on ? 'Click-to-add: ON (Esc)' : 'Click map to add';
        if (on && tiltDeg > 0) status('Tip: set 3D tilt to 0° while placing points — clicks land at exact positions only on a flat view.', true);
      }
      $('clickAddBtn').addEventListener('click', () => setAdding(!uiState.addingMode));
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
        if (!uiState.addingMode) return;
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
              let iconData = l.iconImage || ((l.iconUseProjectLogo && brand.projectLogo) ? brand.projectLogo : null);
              let iconSvgMarkup = null;
              if (!iconData) {
                iconSvgMarkup = svgForKey(l.iconKey || (l.type === 'site' ? 'star' : 'pin'), l.color);
                iconData = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(iconSvgMarkup)));
              }
              widgets.pins.push({ px: { x: wp.x, y: wp.y }, size: l.iconSize, frame: l.iconFrame, bg: l.iconBg, border: l.iconBorder, borderColor: l.iconBorderColor, iconData, iconSvgMarkup, isImage: !!l.iconImage || !!(l.iconUseProjectLogo && brand.projectLogo) });
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
          projectLogo: brand.projectLogo, siteUsesProjLogo: brand.siteUsesProjLogo,
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
            if (proj.tilt !== undefined) { setTiltDeg(+proj.tilt || 0); $('tiltRange').value = tiltDeg; applyTilt(); }
            if (proj.hill) { $('hillTgl').checked = true; hillshade.addTo(map); }
            if (proj.chipPct) { chipPct = +proj.chipPct; }
            else if (proj.chipFont) { chipPct = Math.round(+proj.chipFont / 11.5 * 100); }
            applyChipScale();
            if (proj.brand !== undefined) { $('brandTgl').checked = !!proj.brand; document.body.classList.toggle('no-brand', !proj.brand); }
            if (proj.north !== undefined) { $('northTgl').checked = !!proj.north; document.body.classList.toggle('no-north', !proj.north); }
            if (proj.projectLogo) { setProjectLogo(proj.projectLogo); }
            if (proj.siteUsesProjLogo) { brand.siteUsesProjLogo = true; $('siteUsesProjLogo').checked = true; }
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

      // ---------- tabs ----------
      const TABS = [['tabBtnLoc', 'paneLoc'], ['tabBtnRt', 'paneRt'], ['tabBtnBrand', 'paneBrand'], ['tabBtnMap', 'paneMap']];
      TABS.forEach(([b, p]) => {
        $(b).addEventListener('click', () => {
          TABS.forEach(([b2, p2]) => { $(b2).classList.toggle('active', b2 === b); $(p2).classList.toggle('active', p2 === p); });
        });
      });

      syncEmpties();
      status('Start blank: type in the search bar for live suggestions, paste "lat, lng" directly, or use Click-to-add.');
    /*JS-END*/
