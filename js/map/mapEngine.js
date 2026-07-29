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
          crossOrigin: crossOriginFor(spec),
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
        attachExportSafetyProbe(layer, spec);
        attachTileAuthDiagnostic(layer, spec);
        if (lyr.zIndex === 1) layer.once('tileload', () => rememberBasemapWorks(spec.id));
        return layer;
      }

      /**
       * The `crossOrigin` attribute to request tiles with.
       *
       * This is a genuine fork, not a formality. With `anonymous`, a server that
       * omits `Access-Control-Allow-Origin` refuses the image outright and the
       * map goes blank; without it, the image loads but permanently taints any
       * canvas it touches, killing export. So we cannot simply always ask for
       * it — and we must not guess, because guessing "unsafe" and dropping the
       * attribute is self-fulfilling: the tile then taints the canvas even when
       * the provider would have allowed the read. Measured evidence wins, and
       * until it arrives we start optimistic for everything except providers the
       * catalogue explicitly flags.
       *
       * @param {object} spec BasemapSpec
       * @returns {string|undefined}
       */
      function crossOriginFor(spec) {
        const observed = EXPORT_SAFETY_OBSERVED[spec.provider];
        if (observed === true) return 'anonymous';
        if (observed === false) return undefined;      // display-only, but at least it displays
        return spec.corsSafe === false ? undefined : 'anonymous';
      }

      /**
       * Load one tile from a template and report whether an image came back.
       * @param {string} url Fully-substituted tile URL.
       * @param {boolean} anon Request it with `crossOrigin="anonymous"`.
       * @returns {Promise<boolean>}
       */
      function tryTileUrl(url, anon) {
        return new Promise(res => {
          const img = new Image();
          if (anon) img.crossOrigin = 'anonymous';
          const done = ok => { img.onload = img.onerror = null; res(ok); };
          img.onload = () => done(img.naturalWidth > 0);
          img.onerror = () => done(false);
          setTimeout(() => done(false), 12000);
          img.src = url;
        });
      }

      /**
       * Substitute a tile template for a concrete tile near the current view.
       * @param {string} tpl @param {object} spec @param {object} lyr LayerSpec
       * @returns {string}
       */
      function sampleTileUrl(tpl, spec, lyr) {
        const z = Math.max(1, Math.min(lyr.maxNative, Math.round(map.getZoom())));
        const pt = map.project(map.getCenter(), z).divideBy(lyr.tileSize || 256).floor();
        return basemapUrl(tpl, spec)
          .replace('{z}', z).replace('{x}', pt.x).replace('{y}', pt.y)
          .replace('{-y}', pt.y).replace('{s}', (lyr.subdomains || 'a')[0]).replace('{r}', '');
      }

      /**
       * Resolve a layer whose tile template is not known in advance.
       *
       * Mappls documents the URL *shape* — the layer is a path segment of
       * `advancedmaps/v1/<key>/<layer>/{z}/{x}/{y}.png` — but not which layer
       * name serves the standard road basemap, and it cannot be checked from a
       * build environment without network access to their API. Rather than ship
       * another guess, the candidates from config.js are tried in order against
       * the live service and the first that returns an actual image wins.
       *
       * The winner is cached in prefs so this costs one request per device, and
       * reported in the status line so it can be pinned in config.js and
       * discovery skipped entirely.
       *
       * @param {object} spec BasemapSpec
       * @returns {Promise<boolean>} true when a template is in place.
       */
      async function resolveTileCandidates(spec) {
        const lyr = spec.layers[0];
        if (lyr.url) return true;                               // pinned or already resolved
        const candidates = lyr.urlCandidates || [];
        if (!candidates.length) return false;

        const cacheKey = 'tileTemplate:' + spec.id;
        const cached = (typeof getPref === 'function') ? getPref(cacheKey) : null;
        if (cached && candidates.indexOf(cached) >= 0) { lyr.url = cached; return true; }

        if (typeof status === 'function') status('Finding the Mappls tile endpoint…', true);
        for (const tpl of candidates) {
          if (await tryTileUrl(sampleTileUrl(tpl, spec, lyr), false)) {
            lyr.url = tpl;
            if (typeof setPref === 'function') setPref(cacheKey, tpl);
            const name = (tpl.match(/\/([^/]+)\/\{z\}/) || [])[1] || tpl;
            if (typeof status === 'function') {
              status('Mappls tiles resolved to the “' + name + '” layer. Pin it as MAPPLS_TILE_URL in js/config.js to skip this check.');
            }
            return true;
          }
        }
        revertBasemap(spec.id, 'No “' + spec.label + '” tile endpoint responded. Set MAPPLS_TILE_URL in js/config.js — the shape is ' +
          'apis.mappls.com/advancedmaps/v1/<key>/<layer>/{z}/{x}/{y}.png, and the List Styles API on your account lists the valid layer names.');
        return false;
      }

      /**
       * Ask a provider's tile server two questions with two image loads:
       * is the tile there at all, and can it be read cross-origin?
       *
       * One load without `crossOrigin` answers "does this URL and key work" —
       * it succeeds whether or not CORS headers are present. A second load with
       * `crossOrigin='anonymous'` succeeds only if the server sends the header.
       * Comparing the two separates a bad key or wrong URL template from a
       * working service that simply will not permit canvas reads, which are very
       * different problems with very different fixes.
       *
       * The second request carries a cache-buster: a response already cached
       * from the first (header-less) load would fail the CORS check regardless
       * of what the server is willing to send.
       *
       * @param {object} spec BasemapSpec
       * @returns {Promise<{reachable:boolean, corsOk:boolean}>}
       */
      function probeProviderTiles(spec) {
        const lyr = spec.layers[0];
        if (!lyr.url) return Promise.resolve({ reachable: false, corsOk: false });
        const url = sampleTileUrl(lyr.url, spec, lyr);
        return tryTileUrl(url, false).then(reachable => {
          if (!reachable) return { reachable: false, corsOk: false };
          const bust = url + (url.indexOf('?') >= 0 ? '&' : '?') + '_cors=' + Date.now();
          return tryTileUrl(bust, true).then(corsOk => ({ reachable: true, corsOk }));
        });
      }

      /**
       * Probe a provider once, then re-apply the basemap if the answer means we
       * can do better than the assumption we started with.
       * @param {object} spec BasemapSpec
       */
      function maybeProbeProvider(spec) {
        if (EXPORT_SAFETY_OBSERVED[spec.provider] !== undefined) return;
        if (spec.corsSafe !== false) return;   // optimistic already; the tileload probe confirms
        probeProviderTiles(spec).then(r => {
          recordExportSafety(spec.provider, r.corsOk);
          if (activeKey !== spec.id) return;
          $('mapWrap').classList.toggle('basemap-unsafe', !r.corsOk);
          if (r.corsOk) {
            // The provider does allow canvas reads — rebuild with crossOrigin so
            // exports work, instead of leaving it needlessly display-only.
            setBasemap(spec.id);
            if (typeof status === 'function') status('“' + spec.label + '” supports image export.');
          } else if (r.reachable) {
            // Usable on screen, just not exportable — worth saying, not worth
            // abandoning the basemap over.
            if (typeof status === 'function') {
              status('“' + spec.label + '” loads on screen but its tiles cannot be exported (the server sends no CORS header). Switch basemap before exporting.', true);
            }
          } else {
            revertBasemap(spec.id, '“' + spec.label + '” tiles are not loading — check the key and tile URL in js/config.js.');
          }
        });
      }

      /**
       * Measure — rather than assume — whether a provider's tiles can be
       * rasterised into an export.
       *
       * Whether a tile taints the canvas comes down to one response header we
       * cannot inspect from JavaScript. Rather than hard-code a belief about
       * each provider, draw the first tile that loads into a 1×1 scratch canvas
       * and try to read it back: `getImageData` throws a SecurityError on a
       * tainted canvas and returns pixels otherwise. That single call is a
       * definitive answer from the live service, it costs one tile, and it means
       * a provider is never blocked from export on a guess — nor allowed
       * through on one.
       *
       * @param {L.TileLayer} layer @param {object} spec BasemapSpec
       */
      function attachExportSafetyProbe(layer, spec) {
        if (EXPORT_SAFETY_OBSERVED[spec.provider] !== undefined) return;   // already answered
        const probe = document.createElement('canvas');
        probe.width = probe.height = 1;
        const pctx = probe.getContext('2d', { willReadFrequently: true });
        const judge = ev => {
          layer.off('tileload', judge);
          let safe = true;
          try {
            pctx.drawImage(ev.tile, 0, 0, 1, 1);
            pctx.getImageData(0, 0, 1, 1);
          } catch (e) {
            safe = false;
          }
          recordExportSafety(spec.provider, safe);
          if (activeKey === spec.id) {
            $('mapWrap').classList.toggle('basemap-unsafe', !basemapExportSafe(spec.id));
          }
        };
        layer.on('tileload', judge);
      }

      /**
       * Surface tile authentication failures instead of leaving a blank map.
       *
       * This matters most for Mappls, which issues four separate credentials —
       * Map SDK key, REST API key, client id and client secret — that are not
       * interchangeable. Tiles need the Map SDK key, so a key copied from the
       * REST API console authenticates geocoding fine and then silently returns
       * nothing for every tile. Counting errors and naming the likely cause
       * turns a mystifying grey rectangle into an actionable message.
       *
       * @param {L.TileLayer} layer @param {object} spec BasemapSpec
       */
      function attachTileAuthDiagnostic(layer, spec) {
        if (!spec.needsKey) return;
        let errors = 0, reported = false;
        layer.on('tileerror', () => {
          if (reported || ++errors < 4) return;
          reported = true;
          const which = spec.needsKey === 'mappls'
            ? 'Mappls tiles need the Map SDK key, not the REST API key — check MAP_PROVIDER_KEYS.mappls in js/config.js.'
            : 'Check the ' + spec.needsKey + ' key in js/config.js.';
          revertBasemap(spec.id, '“' + spec.label + '” tiles are not loading. ' + which);
        });
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

      /**
       * The last basemap that actually drew a tile. A basemap is only written to
       * prefs once it proves it can render, so a broken choice cannot be
       * remembered and re-applied on the next visit.
       */
      let lastGoodBasemap = null;

      /** Record that a basemap really works, and make it the remembered choice. */
      function rememberBasemapWorks(key) {
        if (key !== activeKey) return;
        lastGoodBasemap = key;
        if (typeof setPref === 'function') setPref('basemap', key);
      }

      /**
       * Abandon a basemap that cannot draw and go back to one that can.
       *
       * Without this a failed provider leaves an empty grey rectangle with no
       * tiles, no explanation once the status line auto-clears, and — because
       * the choice had already been persisted — the same empty map on the next
       * reload. Falling back automatically and saying why keeps a provider
       * experiment from breaking the app.
       *
       * @param {string} key The basemap that failed.
       * @param {string} reason Sentence explaining the failure, shown sticky.
       */
      /** Basemaps already abandoned this session — keeps one failure to one message. */
      const revertedBasemaps = {};

      function revertBasemap(key, reason) {
        // A failing basemap trips several detectors at once (the tile probe, the
        // auth diagnostic). They are all correct, but the user needs one
        // sentence, not a pile-up.
        if (revertedBasemaps[key]) return;
        revertedBasemaps[key] = true;
        if (key !== activeKey) return;
        const fallback = (lastGoodBasemap && lastGoodBasemap !== key) ? lastGoodBasemap : preferredBasemapId();
        if (fallback === key) { if (typeof status === 'function') status(reason, true); return; }
        const label = (BASEMAP_CATALOGUE[fallback] || {}).label || fallback;
        setBasemap(fallback);
        if (typeof status === 'function') status(reason + ' Switched back to “' + label + '”.', true);
      }
      function setBasemap(key) {
        const entry = BASEMAPS[key] || BASEMAPS[preferredBasemapId()];
        activeKey = entry.spec.id;
        activeBase.forEach(l => map.removeLayer(l));
        // Providers with an undetermined tile template resolve it once, then
        // re-enter here with a usable URL. Until then nothing is added, so the
        // map shows its background rather than a grid of broken tiles.
        if (!entry.spec.layers[0].url && (entry.spec.layers[0].urlCandidates || []).length) {
          activeBase = [];
          $('mapCredit').textContent = entry.credit;
          resolveTileCandidates(entry.spec).then(ok => { if (ok && activeKey === entry.spec.id) setBasemap(entry.spec.id); });
          if (typeof syncBasemapSwitcher === 'function') syncBasemapSwitcher(activeKey);
          return;
        }
        activeBase = entry.build($('hdTgl').checked);
        activeBase.forEach(l => l.addTo(map));
        $('mapCredit').textContent = entry.credit;
        $('mapWrap').classList.toggle('basemap-unsafe', !basemapExportSafe(activeKey));
        // Grading follows the basemap: photographic imagery gets it, designed
        // cartography does not.
        // Map labels drawn over the basemap (nearby POIs) flip their ink to
        // suit the surface: light text on imagery and dark canvases, dark text
        // on pale cartography.
        $('mapWrap').classList.toggle('np-light', !(entry.spec.imagery || entry.spec.dark));
        applyImageryLook(getImageryLook(), !!entry.spec.imagery);
        if (typeof syncImageryLookControl === 'function') syncImageryLookControl();
        maybeProbeProvider(entry.spec);
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

