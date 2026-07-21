/**
 * map/mapEngine.js — Leaflet map creation, basemap catalogue & switching,
 * hillshade, scale control, HD toggle, and the 3D tilt (CSS transform + the
 * perspective warp used by PNG export).
 */
import L from 'leaflet';
import { scheduleRepaint } from '../map/billboard.js';
import { $ } from '../utils/dom.js';

      // ---------- map + basemaps ----------
      export const map = L.map('map', { zoomControl: false, attributionControl: false, maxZoom: 21 }).setView([21.5, 78.5], 5);
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      export let scaleCtl = L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
      export const vectorRenderer = L.canvas({ padding: 0.5 });

      const TL = (url, opts) => L.tileLayer(url, Object.assign({ maxZoom: 21, crossOrigin: 'anonymous' }, opts || {}));
      const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
      const mk = (path, o) => TL(ESRI + path + '/MapServer/tile/{z}/{y}/{x}', o);
      // maxNativeZoom = deepest real tiles; beyond that Leaflet upscales instead of showing
      // blank "no data" tiles. detectRetina pulls double-resolution tiles on sharp screens.
      // Retina screens (phones, hi-dpi laptops) request tiles one zoom deeper; RZ lowers the
      // native cap by one there so requests never pass the deepest real tiles — this was the
      // cause of the "Map data not yet available" grey tiles.
      const RZ = nz => (L.Browser.retina ? nz - 1 : nz);
      export const BASEMAPS = {
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
      export const hillshade = mk('Elevation/World_Hillshade', { maxNativeZoom: 15, opacity: .35, zIndex: 2 });
      let activeBase = [];
      export let activeKey = 'hybrid';
      export function setBasemap(key) {
        activeKey = key;
        activeBase.forEach(l => map.removeLayer(l));
        activeBase = BASEMAPS[key].build($('hdTgl').checked);
        activeBase.forEach(l => l.addTo(map));
        $('mapCredit').textContent = BASEMAPS[key].credit;
      }
      $('basemapSel').addEventListener('change', e => setBasemap(e.target.value));
      $('hdTgl').addEventListener('change', () => setBasemap(activeKey));
      $('hillTgl').addEventListener('change', e => { if (e.target.checked) hillshade.addTo(map); else map.removeLayer(hillshade); });
      setBasemap('hybrid');

      // ---------- 3D tilt (billboarded markers) ----------
      export let tiltDeg = 0;
      export function applyTilt() {
        $('tiltStage').style.transform = tiltDeg ? `rotateX(${tiltDeg}deg) scale(${(1 + tiltDeg / 120).toFixed(3)})` : '';
        $('tiltVal').textContent = tiltDeg + '°';
        scheduleRepaint();
      }
      $('tiltRange').addEventListener('input', e => { tiltDeg = +e.target.value; applyTilt(); });

      export function warpPerspective(src, deg) {
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

      $('scaleTgl').addEventListener('change', e => {
        if (e.target.checked) { scaleCtl = L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map); }
        else if (scaleCtl) { map.removeControl(scaleCtl); scaleCtl = null; }
      });
      /** Set the 3D tilt angle (degrees) — used by project load. @param {number} v */
      export function setTiltDeg(v) { tiltDeg = v; }

