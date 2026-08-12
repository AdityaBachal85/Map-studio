/**
 * export/pptxHandler.js — the browser-side adapter for the PPTX export
 * engine: walks the DOM billboard layer to collect widget positions/text,
 * captures the flat map, builds the engine's deck spec, and calls
 * exportDeck(). All pptxgenjs work, id-repair and radius clamping live in
 * ../export/exportPPT.js and its pptShapes/pptImages/pptLabels/pptTables/
 * pptValidation/pptUtils siblings — this file only assembles the spec.
 */











      const mctx = document.createElement('canvas').getContext('2d');
      function wirePptxExport() {
      $('pptxBtn').addEventListener('click', async () => {
        if (!window.DBOTExport || !window.DBOTExport.exportDeck) {
          status('Export engine still loading — wait a moment and try again.');
          return;
        }
        if (!exportReady(activeKey)) {
          status('This basemap’s tiles block canvas export (no CORS header). Switch to an Esri or Carto basemap to export.');
          return;
        }
        status(exportSubstituteNote('Building editable PPTX… (several seconds)'), true);
        const wrap = $('mapWrap');
        const wrapW = wrap.clientWidth, wrapH = wrap.clientHeight;

        const cp = ll => map.latLngToContainerPoint(ll);
        const wrapRectPPT = wrap.getBoundingClientRect();
        const bbToWrap = el => {
          const r = el.getBoundingClientRect();
          return { x: r.left - wrapRectPPT.left + r.width / 2, y: r.top - wrapRectPPT.top + r.height / 2, w: r.width, h: r.height };
        };
        const widgets = { locLabels: [], badges: [], rtLabels: [], rings: [], leaders: [], pins: [] };
        /**
         * Build a leader descriptor with the same edge-anchored, shouldered
         * geometry the canvas renderer draws, so the deck matches the screen
         * instead of running a bare diagonal into the middle of the chip.
         * @param {{x:number,y:number}} pin
         * @param {{x:number,y:number,w:number,h:number}} lab Label centre + size.
         * @param {string} color
         */
        const pushLeader = (pin, lab, color) => {
          const box = { x: lab.x - lab.w / 2, y: lab.y - lab.h / 2, w: lab.w, h: lab.h };
          const pts = leaderPathPoints(pin, box);
          if (!pts) return;
          widgets.leaders.push({ a: pts[0], b: pts[pts.length - 1], points: pts, color });
        };
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
              pushLeader({ x: pinP.x, y: pinP.y }, lp, l.type === 'site' ? '#FF7A1A' : l.color);
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
            pushLeader({ x: aP.x, y: aP.y }, lp, rt.color);
          }
        });
        const titleVisible = $('titleTgl').checked && $('titleCard').style.display !== 'none';
        const titleText = $('titleCard').textContent.trim() || 'PROPERTY LOCATION & ACCESS';
        const wrapRect = wrap.getBoundingClientRect();
        const legendVisible = $('legendCard').style.display !== 'none';
        const legendRect = legendVisible ? $('legendCard').getBoundingClientRect() : null;
        const legendTitle = $('legendTitle').textContent.trim() || 'KEY DISTANCES';
        const lgRows = legendRows();
        const ckEl = $('colorKeyCard');
        const ckVisible = !!ckEl && ckEl.style.display !== 'none';
        const ckRect = ckVisible ? ckEl.getBoundingClientRect() : null;
        const ckTitle = ($('colorKeyTitle') || {}).textContent;
        const ckRows = (typeof colorKeyRows === 'function' ? colorKeyRows() : [])
          .filter(r => !r.hidden);
        const brandOn = $('brandTgl').checked;

        // Native, editable geometry for everything that used to be flattened
        // into the background picture.
        const paths = mapPathsForExport(map);

        let canvas, renderScale = 1, tilesComplete = true;
        try {
          // Target ~300 DPI across the 13.333in slide (≈4000px) so the picture
          // is still sharp after PowerPoint scales it to the slide and again
          // when the deck is projected or printed. This is the fix for "the
          // exported image quality is poor / the map image becomes soft": the
          // old export handed PowerPoint a 2×-upscaled screenshot.
          const targetPx = 4000;
          const res = await captureMapHiRes({
            scale: Math.max(2, Math.min(4, targetPx / Math.max(1, wrapW))),
            extraClass: 'pptx-capture',
            includeVectors: false,          // re-emitted natively below
            onProgress: msg => status(msg, true),
          });
          canvas = res.canvas;
          renderScale = res.scale;
          tilesComplete = res.complete !== false;
        } catch (e) {
          status('Could not render the map image for PPTX on this browser — try the PNG export or Chrome/Edge.');
          return;
        }

        try {
          // Photographic basemaps compress far better as JPEG and show no
          // visible artefacts — labels and lines are native shapes, so nothing
          // with a hard edge is inside this image. Cartographic basemaps keep
          // PNG, where flat colour and crisp boundaries matter more than size.
          const bmSpec = BASEMAP_CATALOGUE[activeKey];
          const photographic = !!(bmSpec && bmSpec.imagery);
          const dataUrl = photographic
            ? canvas.toDataURL('image/jpeg', 0.94)
            : canvas.toDataURL('image/png');
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
              paths: paths,
              leaders: widgets.leaders,
              pins: widgets.pins,
              locationLabels: widgets.locLabels,
              routeLabels: widgets.rtLabels,
              badges: widgets.badges,
              rings: widgets.rings,
              title: { visible: titleVisible, text: titleText },
              colorKey: (ckRect && ckRows.length) ? {
                visible: ckVisible, title: (ckTitle || 'LEGEND').trim(),
                pxLeft: ckRect.left - wrapRect.left,
                pxTop: ckRect.top - wrapRect.top,
                pxWidth: ckRect.width,
                rows: ckRows.map(r => ({ color: r.color, label: r.label })),
              } : null,
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
          if (tilesComplete) {
            status('PPTX downloaded at ' + canvas.width + ' × ' + canvas.height + ' px (' + renderScale.toFixed(1) +
              '×) — routes, shapes, labels, badges, leader lines, title, table and logo are all native editable objects.' + skipped);
          } else {
            // The slide's map is one flat image, so unloaded tiles are baked in
            // and cannot be repaired in PowerPoint. Say so, and make it stick.
            status('PPTX downloaded at ' + canvas.width + ' × ' + canvas.height + ' px, but the imagery did not finish '
              + 'loading — parts of the map image are dark. Check your connection and export again.' + skipped, true);
          }
        } catch (e) {
          status('PPTX build failed: ' + (e && e.message ? e.message : 'unknown error') + ' — the PNG export still works.');
        }
      });
      }

