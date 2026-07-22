/**
 * ui/dialogs.js — the right-click route context menu.
 */






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

