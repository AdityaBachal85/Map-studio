/**
 * ui/toolbar.js — toolbar actions and overlay toggles: click-to-add (and the
 * map-click dispatch that lets via-point placement pre-empt it), add
 * location/route, overlay visibility toggles, label-chip size scale, and
 * fullscreen.
 */








      function setAdding(on) {
        uiState.addingMode = on;
        $('mapWrap').classList.toggle('adding', on);
        $('clickAddBtn').classList.toggle('toggled', on);
        $('clickAddBtn').textContent = on ? 'Click-to-add: ON (Esc)' : 'Click map to add';
        if (on) {
          if (typeof disableAllDrawModes === 'function') disableAllDrawModes();
          if (typeof disableAllEditModes === 'function') disableAllEditModes();
        }
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
      let chipPct = 100;
      let chipFont = 11.5;
      function applyChipScale() {
        chipFont = +(11.5 * chipPct / 100).toFixed(2);
        document.documentElement.style.setProperty('--chipFont', chipFont + 'px');
        $('chipVal').textContent = chipPct + '%';
        $('chipRange').value = chipPct;
      }
      $('chipRange').addEventListener('input', e => { chipPct = +e.target.value; applyChipScale(); });

      // ---------- imagery look ----------
      /**
       * Build the imagery-grading selector from IMAGERY_LOOKS and reflect the
       * active choice. Grading only affects photographic basemaps, so the
       * control explains itself rather than appearing to do nothing on a
       * street map.
       */
      function buildImageryLookControl() {
        const seg = $('imageryLook');
        if (!seg) return;
        seg.innerHTML = '';
        Object.keys(IMAGERY_LOOKS).forEach(id => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'seg-btn';
          b.dataset.v = id;
          b.textContent = IMAGERY_LOOKS[id].label;
          b.addEventListener('click', () => setImageryLook(id));
          seg.appendChild(b);
        });
        syncImageryLookControl();
      }

      function syncImageryLookControl() {
        const seg = $('imageryLook');
        if (!seg) return;
        const id = getImageryLook();
        seg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.v === id));
        const spec = BASEMAP_CATALOGUE[activeKey];
        const hint = $('imageryLookHint');
        if (hint) {
          hint.textContent = (spec && spec.imagery)
            ? IMAGERY_LOOKS[id].hint + ' — applied to the satellite imagery and carried into exports.'
            : 'Only affects photographic basemaps; the current basemap is drawn cartography and is left as designed.';
        }
      }

      /** Choose an imagery look, persist it, and re-render. @param {string} id */
      function setImageryLook(id) {
        const spec = BASEMAP_CATALOGUE[activeKey];
        applyImageryLook(id, !!(spec && spec.imagery));
        if (typeof setPref === 'function') setPref('imageryLook', getImageryLook());
        syncImageryLookControl();
      }
      /** Set the label-chip scale (%) and re-apply it. Used by project load. @param {number} v */
      function setChipPct(v) { chipPct = v; applyChipScale(); }
      $('fsBtn').addEventListener('click', () => {
        const w = $('mapWrap');
        if (document.fullscreenElement) document.exitFullscreen();
        else if (w.requestFullscreen) w.requestFullscreen();
      });

