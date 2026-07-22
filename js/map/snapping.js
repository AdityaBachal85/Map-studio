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
            e._autoOffsetX = e._px - pin.x;
            e._autoOffsetY = e._py - pin.y;
          }
        });
      }

