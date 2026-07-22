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
      }

