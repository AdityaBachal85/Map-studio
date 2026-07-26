/**
 * map/mapEngine.js — Leaflet map creation, basemap catalogue & switching,
 * hillshade, scale control, HD toggle, and the 3D tilt (CSS transform + the
 * perspective warp used by PNG export).
 */





      // ---------- map + basemaps ----------
      // MAX_MAP_ZOOM matches the deepest basemap in the catalogue (Esri Clarity,
      // z22). Individual layers stop at their own maxNativeZoom; Leaflet upscales
      // the parent tile past that rather than requesting a level that doesn't exist.
      const MAX_MAP_ZOOM = 22;
      const map = L.map('map', { zoomControl: false, attributionControl: false, maxZoom: MAX_MAP_ZOOM }).setView([21.5, 78.5], 5);
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      let scaleCtl = L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
      const vectorRenderer = L.canvas({ padding: 0.5 });

      /**
       * Turn one LayerSpec from the basemap catalogue into a Leaflet tile layer.
       *
       * `hd` off trades sharpness for bandwidth: it gives up retina tiles and
       * backs the native depth off by two levels, which roughly quarters the
       * bytes on a slow connection. `hd` on (the default) asks each service for
       * everything it actually publishes.
       *
       * @param {object} lyr LayerSpec from BASEMAP_CATALOGUE.
       * @param {object} spec The owning BasemapSpec (for token substitution).
       * @param {boolean} hd  HD imagery toggle.
       * @returns {L.TileLayer}
       */
      function buildTileLayer(lyr, spec, hd) {
        const retina = !!lyr.retina && hd;
        const opts = {
          maxZoom: MAX_MAP_ZOOM,
          crossOrigin: spec.corsSafe === false ? undefined : 'anonymous',
          maxNativeZoom: hd ? lyr.maxNative : Math.max(1, lyr.maxNative - 2),
          zIndex: lyr.zIndex,
          // Reference overlays must not paint an opaque background over the imagery.
          updateWhenIdle: false,
          keepBuffer: 3,
        };
        if (lyr.tileSize) opts.tileSize = lyr.tileSize;
        if (lyr.zoomOffset != null) opts.zoomOffset = lyr.zoomOffset;
        if (lyr.subdomains) opts.subdomains = lyr.subdomains;
        if (lyr.opacity != null) opts.opacity = lyr.opacity;
        // Two different retina mechanisms: CARTO-style `{r}` → `@2x` filename
        // suffix, and Leaflet's detectRetina which fetches one zoom deeper and
        // paints it at half size. Never both — that would double-count density.
        if (lyr.retinaSuffix) opts.r = (retina && L.Browser.retina) ? lyr.retinaSuffix : '';
        else if (retina) opts.detectRetina = true;
        const layer = L.tileLayer(basemapUrl(lyr.url, spec), opts);
        if (lyr.adaptive && hd) attachAdaptiveDepth(layer, lyr);
        return layer;
      }

      /**
       * Walk a layer's native depth back when the service starts answering with
       * its "Map data not yet available" placeholder. See the long note on
       * looksLikeNoDataTile() in map/basemapProviders.js for why this exists
       * instead of a blanket zoom cap.
       * @param {L.TileLayer} layer @param {object} lyr LayerSpec
       */
      function attachAdaptiveDepth(layer, lyr) {
        const probe = document.createElement('canvas');
        probe.width = probe.height = 4;
        const pctx = probe.getContext('2d', { willReadFrequently: true });
        const floor = Math.max(17, lyr.maxNative - 4);   // never degrade below usable detail
        let strikes = 0, disabled = false;
        layer.on('tileload', ev => {
          if (disabled || !ev.coords) return;
          if (ev.coords.z < layer.options.maxNativeZoom) return;   // only judge the deepest level
          let flat;
          try {
            pctx.drawImage(ev.tile, 0, 0, 4, 4);
            flat = looksLikeNoDataTile(Array.from(pctx.getImageData(0, 0, 4, 4).data));
          } catch (e) {
            disabled = true;                                        // tainted canvas — stop probing
            return;
          }
          if (!flat) { strikes = 0; return; }
          if (++strikes < 3) return;                                // one blank tile is just water/desert
          strikes = 0;
          const next = layer.options.maxNativeZoom - 1;
          if (next < floor) { disabled = true; return; }
          layer.options.maxNativeZoom = next;
          layer.redraw();
        });
      }

      /**
       * Legacy-shaped basemap map (`{ credit, build(hd) }`) generated from the
       * catalogue. Kept so basemapSwitcher.js, project load/save and anything
       * else holding a basemap key keep working unchanged.
       * @type {Object<string, {credit:string, build:(hd:boolean)=>L.TileLayer[], spec:object}>}
       */
      const BASEMAPS = {};
      availableBasemaps().forEach(spec => {
        BASEMAPS[spec.id] = {
          spec,
          credit: spec.credit,
          build: hd => spec.layers.map(l => buildTileLayer(l, spec, hd)),
        };
      });

      const hillshade = L.tileLayer(HILLSHADE_LAYER.url, {
        maxZoom: MAX_MAP_ZOOM, crossOrigin: 'anonymous',
        maxNativeZoom: HILLSHADE_LAYER.maxNative, opacity: HILLSHADE_LAYER.opacity, zIndex: HILLSHADE_LAYER.zIndex,
      });

      let activeBase = [];
      let activeKey = preferredBasemapId();
      function setBasemap(key) {
        const entry = BASEMAPS[key] || BASEMAPS[preferredBasemapId()];
        activeKey = entry.spec.id;
        activeBase.forEach(l => map.removeLayer(l));
        activeBase = entry.build($('hdTgl').checked);
        activeBase.forEach(l => l.addTo(map));
        $('mapCredit').textContent = entry.credit;
        $('mapWrap').classList.toggle('basemap-unsafe', entry.spec.corsSafe === false);
        if (typeof syncBasemapSwitcher === 'function') syncBasemapSwitcher(activeKey);   // update the floating switcher UI
      }
      $('basemapSel').addEventListener('change', e => setBasemap(e.target.value));
      $('hdTgl').addEventListener('change', () => setBasemap(activeKey));
      $('hillTgl').addEventListener('change', e => { if (e.target.checked) hillshade.addTo(map); else map.removeLayer(hillshade); });
      setBasemap(activeKey);

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

      $('scaleTgl').addEventListener('change', e => {
        if (e.target.checked) { scaleCtl = L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map); }
        else if (scaleCtl) { map.removeControl(scaleCtl); scaleCtl = null; }
      });
      /** Set the 3D tilt angle (degrees) — used by project load. @param {number} v */
      function setTiltDeg(v) { tiltDeg = v; }
      /** Fit the map view to every location (+ its rings) and route. */
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

