/**
 * map/markers.js — location lifecycle: create/render pins, labels, distance
 * rings, change propagation, deletion.
 */









      // ---------- locations ----------
      function renderLocPin(loc) {
        loc.anchor = L.latLng(loc.lat, loc.lng);
        if (loc._hidden) {                       // hidden via Layer Manager
          if (loc._pinEl) { removeBB(loc._pinEl); loc._pinEl = null; }
          updateRings(loc);
          scheduleRepaint();
          return;
        }
        const wasFirst = !loc._everRendered;
        if (loc._pinEl) removeBB(loc._pinEl);
        loc._pinEl = makePinEl(loc, wasFirst);
        loc._everRendered = true;
        updateRings(loc);
        scheduleRepaint();
      }
      function updateRings(loc) {
        (loc.ringLayers || []).forEach(l => map.removeLayer(l));
        (loc._ringLabelEls || []).forEach(removeBB);
        loc.ringLayers = [];
        loc._ringLabelEls = [];
        loc.ringLabels = [];
        if (loc._hidden) { scheduleRepaint(); return; }   // hidden via Layer Manager
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
        if (loc._hidden) return;                 // hidden via Layer Manager
        if (loc.showLabel && loc.type !== 'badge' && !loc.hideMarker) {
          const isSite = loc.type === 'site';
          const bg = loc.labelBg || (isSite ? '#0A1E3C' : '#FFFFFF');
          const el = makeLabelEl(loc, 'loc', {
            klass: isSite ? 'site' : '',
            bg: bg, color: textOn(bg), accent: loc.color,
            // Labels are the name, full stop. The pin sitting next to the
            // label already carries the icon, so drawing it again inside the
            // badge said the same thing twice and made every label wider than
            // the name it exists to show.
            iconHtml: null,
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
      /** Show/hide a location (pin, label, rings) without deleting it. Used by the Layer Manager. @param {object} loc @param {boolean} on */
      function setLocVisible(loc, on) {
        loc._hidden = !on;
        renderLocPin(loc); updateLocLabel(loc);  // both honour loc._hidden
        scheduleRepaint();
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
          // Per-label size as a percentage of the global chip scale — 100 means
          // "follow Settings", which is what every existing location gets.
          labelScale: opts.labelScale == null ? 100 : +opts.labelScale,
          // No labelShowIcon: labels carry the name only, and nothing reads
          // the field any more. Keeping it would mean a project saved before
          // this change still arrived with icons in its labels — the exact
          // thing this removes — because opts comes straight from the file.
          // Icon customization

          // `dot`, not `pin`: the pin glyph is gone — see ICON_LIBRARY — because
          // `iconFrame: 'pin'` already draws the teardrop this would sit inside.
          iconKey: opts.iconKey || (opts.type === 'site' ? 'star' : 'dot'),
          iconImage: opts.iconImage || null,
          iconUseProjectLogo: !!opts.iconUseProjectLogo,
          iconSize: opts.iconSize || (opts.type === 'site' ? 44 : 36),
          // Frameless by default: the library's pins are already pin-shaped, so
          // wrapping one in a circle drew a badge around a badge and shrank the
          // glyph to 66% to fit. The bare icon reads as a map marker.
          iconFrame: opts.iconFrame || 'none',
          iconBg: opts.iconBg || '#FFFFFF',
          iconBorder: opts.iconBorder !== undefined ? opts.iconBorder : 2,
          iconBorderColor: opts.iconBorderColor || (opts.color || (opts.type === 'site' ? '#FF7A1A' : '#FFFFFF')),
          iconShadow: opts.iconShadow !== undefined ? opts.iconShadow : 6,
          iconGlow: !!opts.iconGlow,
          hideMarker: !!opts.hideMarker,
          // Scaffolding for a traced road, not a place somebody marked. Kept out
          // of every list and count via realLocations(); see map/roadDraw.js.
          routeAnchor: !!opts.routeAnchor,
          rings: rings || [], photo: opts.photo || null,
          _pinEl: null, _labelEl: null, _el: null, _ringLabelEls: [], ringLayers: [], ringLabels: [], anchor: null, card: null
        };
        // Where it came from, when it came from a ring scan. addLocation builds a
        // fixed shape rather than copying opts, so a flag passed in is dropped
        // unless it is carried across by hand — and this one has to survive a
        // save, or a reopened project cannot tell a scanned station from one
        // somebody typed.
        if (opts.fromRing) loc.fromRing = true;
        // If it's a Site and the "default site logo" setting is on, opt in by default
        if (loc.type === 'site' && brand.siteUsesProjLogo && !opts.iconImage) loc.iconUseProjectLogo = true;
        bumpId(loc.id);
        locations.push(loc);
        buildLocCard(loc);
        renderLocPin(loc); updateLocLabel(loc);
        refreshRouteSelects(); rebuildLegend(); syncEmpties();
        if (typeof refreshLayers === 'function') refreshLayers();
        return loc;
      }
      /**
       * Delete a location, and every route that runs to or from it.
       *
       * The cascade is why this offers an undo. Removing one pin can silently
       * take several routes with it — each of which cost a routing request and
       * whatever manual tuning went into its label, colour and via points —
       * and there was previously no confirmation and no way back. One misclick
       * on the × could undo an hour.
       *
       * The snapshot is taken with the project serialisers, so a restored
       * location and its routes carry exactly what a saved one would. Routes
       * are restored with their computed geometry, so undo re-draws them
       * without re-spending a routing request.
       *
       * @param {object} loc
       */
      function deleteLocation(loc) {
        const doomedRoutes = routes.filter(r => r.fromId === loc.id || r.toId === loc.id);
        const snapshot = {
          loc: serialiseLocation(loc),
          routes: doomedRoutes.map(serialiseRoute),
        };

        doomedRoutes.forEach(deleteRoute);
        if (loc._pinEl) removeBB(loc._pinEl);
        if (loc._labelEl) removeBB(loc._labelEl);
        (loc._ringLabelEls || []).forEach(removeBB);
        (loc.ringLayers || []).forEach(l => map.removeLayer(l));
        loc.card.remove();
        locations.splice(locations.indexOf(loc), 1);
        refreshRouteSelects(); rebuildLegend(); syncEmpties();
        scheduleRepaint();
        if (typeof refreshLayers === 'function') refreshLayers();

        const n = snapshot.routes.length;
        status(
          `Deleted "${snapshot.loc.name}"` + (n ? ` and ${n} route${n > 1 ? 's' : ''}` : '') + '.',
          false,
          { label: 'Undo', onClick: () => restoreDeletedLocation(snapshot) }
        );
      }

      /**
       * Put back a location and its routes from a deleteLocation() snapshot.
       *
       * Ids are restored, not regenerated — the routes reference the location
       * by id, so a fresh id would leave them pointing at nothing. addLocation
       * and addRoute both honour an incoming id for exactly this reason.
       *
       * @param {{loc:object, routes:object[]}} snapshot
       */
      function restoreDeletedLocation(snapshot) {
        addLocation(snapshot.loc);
        snapshot.routes.forEach(r => addRoute(r));
        refreshRouteSelects(); rebuildLegend(); syncEmpties();
        scheduleRepaint();
        if (typeof refreshLayers === 'function') refreshLayers();
        const n = snapshot.routes.length;
        status(`Restored "${snapshot.loc.name}"` + (n ? ` and ${n} route${n > 1 ? 's' : ''}` : '') + '.');
      }
