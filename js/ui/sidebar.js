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
      const TABS = [['tabBtnLoc', 'paneLoc'], ['tabBtnRt', 'paneRt'], ['tabBtnDraw', 'paneDraw'], ['tabBtnNearby', 'paneNearby'], ['tabBtnMap', 'paneMap']];
      TABS.forEach(([b, p]) => {
        $(b).addEventListener('click', () => {
          TABS.forEach(([b2, p2]) => { $(b2).classList.toggle('active', b2 === b); $(p2).classList.toggle('active', p2 === p); });
          moveTabIndicator();
        });
      });

      /**
       * Slide the shared tab indicator under the active tab.
       *
       * A single travelling indicator rather than one underline per tab: the
       * movement gives the switch a direction, which is what makes the tab bar
       * feel responsive. Cross-fading a background between two static elements
       * reads as sluggish however fast it is, because nothing moves.
       * Position is written as CSS variables so the transition stays on the
       * compositor (transform + width) instead of triggering layout.
       */
      function moveTabIndicator() {
        const active = TABS.map(([b]) => $(b)).find(el => el && el.classList.contains('active'));
        const bar = document.querySelector('.tabs');
        if (!active || !bar) return;
        const a = active.getBoundingClientRect(), r = bar.getBoundingClientRect();
        bar.style.setProperty('--tab-w', a.width + 'px');
        bar.style.setProperty('--tab-x', (a.left - r.left) + 'px');
      }

      /** Place the indicator once the sidebar has its final width. */
      function initTabs() {
        moveTabIndicator();
        // Fonts and the scrollbar can both change tab widths after first paint.
        setTimeout(moveTabIndicator, 220);
        window.addEventListener('resize', moveTabIndicator);
      }

      // ---------- collapsible accordion sections (Settings tab) ----------
      // Each .acc header toggles its own .open state independently, so users can
      // open exactly the groups they need instead of scrolling one long list.
      document.querySelectorAll('.acc .acc-hd').forEach(hd => {
        hd.addEventListener('click', () => hd.parentElement.classList.toggle('open'));
      });

