/**
 * ui/sidebar.js — sidebar chrome: collapse toggle, cursor-spotlight hover
 * effect, and the four-tab pane switcher (Locations/Routes/Brand/Map).
 */

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

      // ---------- tabs ----------
      // ---------- tabs ----------
      const TABS = [['tabBtnLoc', 'paneLoc'], ['tabBtnRt', 'paneRt'], ['tabBtnBrand', 'paneBrand'], ['tabBtnMap', 'paneMap']];
      TABS.forEach(([b, p]) => {
        $(b).addEventListener('click', () => {
          TABS.forEach(([b2, p2]) => { $(b2).classList.toggle('active', b2 === b); $(p2).classList.toggle('active', p2 === p); });
        });
      });

      /** Re-apply the active tab's pane visibility (no-op helper for symmetry with other UI setup). */
      function initTabs() { /* tabs wire themselves above at module load */ }

