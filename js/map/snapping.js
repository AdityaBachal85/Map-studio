/**
 * map/snapping.js — label collision avoidance (radial nudge) applied on every
 * billboard repaint.
 */

      // ---------- label collision avoidance (radial nudge) ----------
      function autoAvoidCollisions(entries) {
        const items = entries.filter(e => e._labelEl && e.showLabel);
        if (items.length < 2) return;
        items.forEach(e => {
          const r = e._labelEl.getBoundingClientRect();
          e._w = r.width; e._h = r.height;
          const pin = projectPin(e.anchor);
          e._px = pin.x + (e.labelOffset.x || 0);
          e._py = pin.y + (e.labelOffset.y || 0);
        });
        const PAD = 3;
        /*
         * HOW FAR A LABEL MAY BE SHOVED, which used to be "as far as it takes".
         *
         * The solver pushes overlapping boxes apart and iterates, and with
         * nothing to stop it a crowded sheet walks a label right across the
         * map: each pass moves it half an overlap, each neighbour it lands on
         * moves it again, and ten labels stacked in one band compound into
         * hundreds of pixels. The result is a road name floating over open
         * ground with a leader line reaching back to the road — which is not a
         * solution to an overlap. It is a worse problem, because the reader
         * now has to work out which line the name belongs to, and the obvious
         * guess is whatever is underneath it.
         *
         * This went from a rounding error to the first thing you notice when
         * drawn shapes joined the billboard: a station chip is 90px wide, and
         * "Mumbai-Ahmedabad High-Speed Rail Corridor" is 263px, so road names
         * overlap far more and shove far harder.
         *
         * Capped, and overlap accepted past the cap — which is what every
         * cartographic label placer does, because a legible collision beats an
         * illegible attribution. Anything still colliding can be dragged, and
         * a dragged label is pinned and exempt from this entirely.
         */
        const MAX_SHOVE = 40;
        for (let iter = 0; iter < 12; iter++) {
          let moved = false;
          for (let i = 0; i < items.length; i++) {
            for (let j = i + 1; j < items.length; j++) {
              const A = items[i], B = items[j];
              const ax1 = A._px, ay1 = A._py, ax2 = ax1 + A._w, ay2 = ay1 + A._h;
              const bx1 = B._px, by1 = B._py, bx2 = bx1 + B._w, by2 = by1 + B._h;
              const overlapX = Math.min(ax2, bx2) - Math.max(ax1, bx1);
              const overlapY = Math.min(ay2, by2) - Math.max(ay1, by1);
              if (overlapX > 0 && overlapY > 0) {
                // Nudge by the smaller overlap axis
                if (overlapX < overlapY) {
                  const shift = (overlapX + PAD) / 2;
                  if (ax1 < bx1) { A._px -= shift; B._px += shift; }
                  else { A._px += shift; B._px -= shift; }
                } else {
                  const shift = (overlapY + PAD) / 2;
                  if (ay1 < by1) { A._py -= shift; B._py += shift; }
                  else { A._py += shift; B._py -= shift; }
                }
                moved = true;
              }
            }
          }
          if (!moved) break;
        }
        // Write back to labelOffset when auto-avoidance is on
        items.forEach(e => {
          if (!e.labelPinned) {
            const pin = projectPin(e.anchor);
            let ox = e._px - pin.x, oy = e._py - pin.y;
            // Measured from where the label WANTED to be, not from the anchor:
            // the base offset already lifts a chip clear of its own pin, and
            // charging that against the budget would leave nothing to avoid
            // with.
            const dx = ox - (e.labelOffset.x || 0), dy = oy - (e.labelOffset.y || 0);
            const d = Math.hypot(dx, dy);
            if (d > MAX_SHOVE) {
              const k = MAX_SHOVE / d;
              ox = (e.labelOffset.x || 0) + dx * k;
              oy = (e.labelOffset.y || 0) + dy * k;
            }
            e._autoOffsetX = ox;
            e._autoOffsetY = oy;
          }
        });
      }

