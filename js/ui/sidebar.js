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

      /** Index of the tab currently shown. */
      const tabIndex = () => TABS.findIndex(([b]) => $(b).classList.contains('active'));

      /**
       * Switch to a tab.
       *
       * The direction matters: Kokonut's Smooth Tab slides the incoming panel in
       * from the side you came from, which is what turns a swap into a movement
       * you can follow. `--pane-dir` carries the sign to the keyframes.
       * @param {number} to index into TABS
       */
      function selectTab(to) {
        const from = tabIndex();
        if (to === from || to < 0 || to >= TABS.length) return;
        const dir = to > from ? 1 : -1;
        TABS.forEach(([b2, p2], i) => {
          const on = i === to;
          const btn = $(b2), pane = $(p2);
          btn.classList.toggle('active', on);
          btn.setAttribute('aria-selected', on ? 'true' : 'false');
          // Roving tabindex: one stop for the whole bar, then arrow keys inside
          // it. Five separate tab stops is what the plain buttons gave before.
          btn.tabIndex = on ? 0 : -1;
          pane.style.setProperty('--pane-dir', dir);
          pane.classList.toggle('active', on);
        });
        moveTabIndicator();
      }

      TABS.forEach(([b, p], i) => {
        const btn = $(b), pane = $(p);
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-controls', p);
        btn.setAttribute('aria-selected', btn.classList.contains('active') ? 'true' : 'false');
        btn.tabIndex = btn.classList.contains('active') ? 0 : -1;
        pane.setAttribute('role', 'tabpanel');
        pane.setAttribute('aria-labelledby', b);
        btn.addEventListener('click', () => selectTab(i));
        // A tablist owns its arrow keys — the roving tabindex above means Tab no
        // longer walks the bar, so without these the tabs are unreachable by
        // keyboard past the first one. Home/End jump to the ends.
        btn.addEventListener('keydown', e => {
          const last = TABS.length - 1;
          let to = null;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = i === last ? 0 : i + 1;
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = i === 0 ? last : i - 1;
          else if (e.key === 'Home') to = 0;
          else if (e.key === 'End') to = last;
          if (to === null) return;
          e.preventDefault();
          selectTab(to);
          $(TABS[to][0]).focus();
        });
      });
      const tabsBar = document.querySelector('.tabs');
      if (tabsBar) tabsBar.setAttribute('role', 'tablist');

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
        hd.addEventListener('click', () => {
          const acc = hd.parentElement;
          animateAccordion(acc, !acc.classList.contains('open'));
        });
      });

