/**
 * ui/colorKey.js — the map's colour key: what each colour on this map means.
 *
 * DIFFERENT FROM THE KEY-DISTANCES TABLE. `ui/legendTable.js` answers "how far
 * is it" — a table of places and distances. This answers "what am I looking
 * at" — purple is industrial land, red is residential. They are two different
 * questions and they belong on two cards; merging them produces a table with
 * two columns that are never both filled in.
 *
 * GENERATED, THEN EDITABLE. The rows come from the classes actually on the map,
 * so the key cannot contradict the drawing — which is exactly what the report
 * sheet's hand-written `lines` array did before it was removed: it shipped four
 * colours that appear nowhere in the app, so a route would never match its own
 * swatch except by accident.
 *
 * But a generated label is not always the right label. "Industrial /
 * warehousing" is what the class is; "MIDC Phase II" is what this particular
 * purple means on this particular map, and only the person making the map
 * knows that. So every row can be renamed, hidden, or added by hand, and the
 * edits are stored against the class id rather than the row's position — a
 * rename must survive the moment you draw one more road and the row order
 * changes underneath it.
 *
 * Renaming here does NOT rename the class. The class is shared by every map in
 * the company; the label is this map's caption for it.
 */

/** Per-class overrides: `{ [classId]: {label, hidden} }`. Saved with the project. */
let colorKeyEdits = {};

/** Rows that exist only in the key — a colour used outside the class system. */
let colorKeyExtras = [];

/** Whether the card is in edit mode. */
let colorKeyEditing = false;

/** Guards the contenteditable listeners while innerHTML is being replaced. */
let colorKeyRebuilding = false;

/** @returns {HTMLElement|null} */
function colorKeyCard() { return document.getElementById('colorKeyCard'); }

/**
 * The rows to show: generated ones with their edits applied, then custom ones.
 *
 * @returns {Array<{key:string, color:string, label:string, kind:string, extra:boolean}>}
 */
function colorKeyRows() {
  const auto = (typeof connLegendRows === 'function' ? connLegendRows() : []).map(r => {
    const e = colorKeyEdits[r.cls] || {};
    return {
      key: r.cls,
      color: e.color || r.color,
      label: e.label != null ? e.label : r.label,
      kind: r.kind,
      hidden: !!e.hidden,
      extra: false,
    };
  });
  const extra = colorKeyExtras.map((x, i) => ({
    key: 'x' + i, color: x.color, label: x.label, kind: x.kind || 'area', hidden: false, extra: true,
  }));
  return auto.concat(colorKeyUnclassedRows(), extra)
    .filter(r => colorKeyEditing || !r.hidden);
}

/**
 * Rows for everything drawn that never went through a class.
 *
 * Without these the key describes only *classed* objects — so a project made
 * before the standard existed, or anything drawn under the Satellite layout
 * where colours are free, produces zero rows and the card hides itself. The
 * map is covered in meaningful colour and the legend says nothing, which reads
 * as the legend being broken rather than as it having nothing to say.
 *
 * Grouped by colour, because that is the question a legend answers: not "what
 * objects exist" but "what does this colour mean". Ten roads sharing an orange
 * are one row, and the row is editable like any other.
 *
 * @returns {Array<object>}
 */
function colorKeyUnclassedRows() {
  const byColor = new Map();

  const note = (color, kind, name) => {
    if (!color) return;
    const k = String(color).toUpperCase();
    if (!byColor.has(k)) byColor.set(k, { color, kind, names: [] });
    const e = byColor.get(k);
    if (name && e.names.indexOf(name) < 0) e.names.push(name);
    // A colour used by both a line and an area is shown as a line: the stroke
    // is what carries the colour in that pairing.
    if (kind === 'line') e.kind = 'line';
  };

  if (typeof routes !== 'undefined') {
    routes.forEach(r => { if (!r.cls) note(r.color, 'line', r.labelText || ''); });
  }
  if (typeof geometries !== 'undefined') {
    geometries.forEach(g => {
      if (g.cls || g._hidden) return;
      const area = g.shape === 'Polygon' || g.shape === 'Rectangle' || g.shape === 'Circle';
      const point = g.shape === 'Marker' || g.shape === 'CircleMarker' || g.shape === 'Label';
      note(area ? (g.fillColor || g.borderColor) : g.borderColor,
        point ? 'mark' : (area ? 'area' : 'line'), g.name || '');
    });
  }

  return [...byColor.entries()].map(([k, e]) => {
    const edit = colorKeyEdits[k] || {};
    // Named after what carries it when they agree on a name, else by shape.
    const auto = e.names.length === 1 ? e.names[0]
      : (e.kind === 'line' ? 'Road / line' : e.kind === 'mark' ? 'Marked point' : 'Area');
    return {
      key: k, color: e.color, kind: e.kind,
      label: edit.label != null ? edit.label : auto,
      hidden: !!edit.hidden, extra: false,
    };
  });
}

/**
 * The swatch. A line class gets a line, an area gets a filled block, a point
 * gets a dot — because the shape is half the information. Two classes that
 * differ only in being a line or an area are indistinguishable on a colour-only
 * key, and "the red line" and "the red block" are different things on the map.
 *
 * @param {object} r @returns {string}
 */
function colorKeyMark(r) {
  const c = esc(r.color);
  if (r.kind === 'line') return '<span class="ck-mark ck-line" style="background:' + c + '"></span>';
  if (r.kind === 'mark') return '<span class="ck-mark ck-dot" style="background:' + c + '"></span>';
  return '<span class="ck-mark ck-area" style="background:' + c + '"></span>';
}

/** Draw the card from the current rows. */
function rebuildColorKey() {
  const body = document.getElementById('colorKeyBody');
  const card = colorKeyCard();
  if (!body || !card) return;

  // Commit whatever is being typed before the element holding it is destroyed —
  // a rebuild can be triggered by a route finishing its measurement while
  // somebody is halfway through renaming a row.
  const active = document.activeElement;
  if (active && active.isContentEditable && body.contains(active)) colorKeyCommit(active);

  colorKeyRebuilding = true;
  const rows = colorKeyRows();
  body.innerHTML = rows.map(r =>
    '<div class="ck-row' + (r.hidden ? ' ck-off' : '') + '" data-ck-key="' + esc(r.key) + '">'
    + '<button class="ck-sw" ' + (colorKeyEditing ? '' : 'disabled ')
      + 'title="' + (colorKeyEditing ? 'Change this colour' : '') + '">' + colorKeyMark(r) + '</button>'
    + '<span class="ck-label"' + (colorKeyEditing ? ' contenteditable="true" spellcheck="false"' : '')
      + '>' + esc(r.label) + '</span>'
    + (colorKeyEditing
      ? '<button class="ck-x" title="' + (r.extra ? 'Delete this row' : (r.hidden ? 'Show this row' : 'Hide this row'))
        + '">' + (r.hidden ? '👁' : '&times;') + '</button>'
      : '')
    + '</div>').join('');
  colorKeyRebuilding = false;

  const tgl = document.getElementById('colorKeyTgl');
  const wanted = (!tgl || tgl.checked) && (rows.length || colorKeyEditing);
  card.style.display = wanted ? '' : 'none';
  card.classList.toggle('editing', colorKeyEditing);

  if (wanted) positionColorKey();

  const foot = document.getElementById('colorKeyFoot');
  if (foot) foot.style.display = colorKeyEditing ? '' : 'none';
  const btn = document.getElementById('colorKeyEditBtn');
  if (btn) {
    btn.classList.toggle('on', colorKeyEditing);
    btn.setAttribute('aria-pressed', String(colorKeyEditing));
    btn.title = colorKeyEditing ? 'Done editing' : 'Rename rows, change colours, add your own';
  }
}

/**
 * Sit the key below the key-distances card instead of at a fixed offset.
 *
 * Both cards are top-right and the distances card grows a row at a time, so any
 * constant top lands underneath it on exactly the maps that have enough content
 * to need a legend. Recomputed on every rebuild, and abandoned the moment the
 * card is dragged — once somebody has placed it, moving it is the app being
 * wrong, not helpful.
 */
function positionColorKey() {
  const card = colorKeyCard();
  if (!card || card._moved) return;
  const wrap = document.getElementById('mapWrap');
  if (!wrap) return;

  // Hand the card back to the stylesheet first, and only override if stacking
  // genuinely improves on it. Setting `top`/`right` inline unconditionally beat
  // the responsive rules, which bottom-anchor the distances card on short
  // viewports — so "10px below it" was 10px below the bottom of the map and the
  // legend left the screen entirely.
  card.style.left = '';
  card.style.top = '';
  card.style.right = '';
  card.style.bottom = '';

  const above = document.getElementById('legendCard');
  if (!above || above.style.display === 'none' || !above.offsetHeight) return;

  const wr = wrap.getBoundingClientRect();
  const ar = above.getBoundingClientRect();
  const top = (ar.bottom - wr.top) + 10;

  // Only stack when the whole card fits below with room to spare. Otherwise the
  // stylesheet's own placement is the better answer, and it is already applied.
  if (top < 0 || top + card.offsetHeight + 12 > wr.height) return;

  card.style.left = 'auto';
  card.style.bottom = 'auto';
  card.style.top = top + 'px';
  card.style.right = Math.max(0, Math.round(wr.right - ar.right)) + 'px';
}

/**
 * Write a renamed label back to wherever it came from.
 * @param {HTMLElement} el the contenteditable
 */
function colorKeyCommit(el) {
  if (colorKeyRebuilding) return;
  const row = el.closest('.ck-row');
  if (!row) return;
  const key = row.dataset.ckKey;
  const text = el.textContent.trim();
  if (key.charAt(0) === 'x' && /^x\d+$/.test(key)) {
    const i = +key.slice(1);
    if (colorKeyExtras[i]) colorKeyExtras[i].label = text;
  } else {
    colorKeyEdits[key] = Object.assign({}, colorKeyEdits[key], { label: text });
    // An edit back to the generated label is a *removal* of the override, not
    // an override that happens to match. Otherwise the row is frozen: change
    // the class label in the standard and every map that ever touched this row
    // keeps showing the old one.
    const auto = (typeof connLegendRows === 'function' ? connLegendRows() : [])
      .find(r => r.cls === key);
    if (auto && auto.label === text) delete colorKeyEdits[key].label;
  }
  if (typeof markDirty === 'function') markDirty();
}

/** Toggle edit mode. */
function setColorKeyEditing(on) {
  colorKeyEditing = !!on;
  rebuildColorKey();
}

/** Put every row back to what the map says it is. */
function resetColorKey() {
  colorKeyEdits = {};
  colorKeyExtras = [];
  rebuildColorKey();
  if (typeof markDirty === 'function') markDirty();
  if (typeof status === 'function') status('Colour key back to what is on the map.');
}

(function wireColorKey() {
  const card = colorKeyCard();
  if (!card) return;

  card.addEventListener('click', e => {
    if (e.target.closest('#colorKeyEditBtn')) { setColorKeyEditing(!colorKeyEditing); return; }
    if (e.target.closest('#colorKeyReset')) { resetColorKey(); return; }
    if (e.target.closest('#colorKeyAdd')) {
      colorKeyExtras.push({ color: '#7E57C2', label: 'New row', kind: 'area' });
      rebuildColorKey();
      // Straight into renaming it: a row called "New row" is not a row anybody
      // wanted, it is a row waiting to be told what it is.
      const last = card.querySelector('.ck-row:last-child .ck-label');
      if (last) { last.focus(); document.execCommand && document.execCommand('selectAll', false, null); }
      return;
    }

    const row = e.target.closest('.ck-row');
    if (!row) return;
    const key = row.dataset.ckKey;
    const isExtra = /^x\d+$/.test(key);

    if (e.target.closest('.ck-x')) {
      if (isExtra) colorKeyExtras.splice(+key.slice(1), 1);
      else colorKeyEdits[key] = Object.assign({}, colorKeyEdits[key],
        { hidden: !(colorKeyEdits[key] || {}).hidden });
      rebuildColorKey();
      if (typeof markDirty === 'function') markDirty();
      return;
    }

    if (e.target.closest('.ck-sw') && colorKeyEditing) {
      // Reuses the app's own colour popover rather than a native <input
      // type=color>, so it looks like every other colour control here.
      const cur = isExtra ? colorKeyExtras[+key.slice(1)].color
        : (colorKeyRows().find(r => r.key === key) || {}).color;
      if (typeof openColorPresets === 'function') {
        const swBtn = e.target.closest('.ck-sw');
        openColorPresets(swBtn, cur, hex => {
          if (isExtra) colorKeyExtras[+key.slice(1)].color = hex;
          else colorKeyEdits[key] = Object.assign({}, colorKeyEdits[key], { color: hex });
          // Repaint this one mark, do NOT rebuild the card. The picker commits
          // live as you drag, and rebuilding replaces body.innerHTML — which
          // destroys the very button the popover is anchored to. The popover
          // then loses its anchor mid-drag and the colour appears to snap back
          // to what it was, which is exactly what "cannot change the colour of
          // an added row" looks like from the outside.
          const mk = swBtn.querySelector('.ck-mark');
          if (mk) mk.style.background = hex;
          if (typeof markDirty === 'function') markDirty();
        });
      }
    }
  });

  card.addEventListener('input', e => {
    if (e.target.classList && e.target.classList.contains('ck-label')) colorKeyCommit(e.target);
  });
  card.addEventListener('blur', e => {
    if (e.target.classList && e.target.classList.contains('ck-label')) colorKeyCommit(e.target);
  }, true);

  const tgl = document.getElementById('colorKeyTgl');
  if (tgl) tgl.addEventListener('change', rebuildColorKey);

  // The stacking decision depends on the viewport, and the breakpoint that
  // bottom-anchors the card above can be crossed by a resize alone.
  window.addEventListener('resize', () => { if (!card._moved) positionColorKey(); });

  /* The drag handle, same behaviour as the key-distances card. */
  // The whole header, not just the ⠿ glyph. The grip is a 12px target, and the
  // map's search button floats at the top-left with a higher z-index — park the
  // card anywhere near it and the button swallows the pointerdown, so the card
  // becomes unmovable with no sign of why. Dragging from the bar sidesteps the
  // problem entirely and is a bigger target besides.
  const hd = document.querySelector('#colorKeyCard .hd');
  const wrap = document.getElementById('mapWrap');
  // Raised while dragging so the card comes out from under the map controls it
  // may have been parked beneath.
  if (hd && wrap) {
    hd.style.cursor = 'move';
    let sx = 0, sy = 0, ox = 0, oy = 0, armed = false, dragging = false;

    // A movement threshold rather than a reserved handle. The title fills most
    // of the header, so excluding it — as the first version did — left only a
    // 12px grip to aim at, and the map's search button floats over that corner
    // and swallows the pointerdown. Arming on press and only starting the drag
    // after 4px means a click still places the caret in the title, while any
    // actual drag from anywhere on the bar moves the card.
    hd.addEventListener('pointerdown', e => {
      if (e.target.closest('#colorKeyEditBtn')) return;   // a button, not a bar
      const r = card.getBoundingClientRect(), w = wrap.getBoundingClientRect();
      ox = r.left - w.left; oy = r.top - w.top; sx = e.clientX; sy = e.clientY;
      armed = true; dragging = false;
    });

    hd.addEventListener('pointermove', e => {
      if (!armed) return;
      if (!dragging) {
        if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 4) return;
        dragging = true;
        card._moved = true;              // stop auto-placing it from here on
        card.style.right = 'auto';
        card.style.bottom = 'auto';
        // Let go of the caret, or the browser selects the title text as the
        // pointer travels across it.
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        try { hd.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
      }
      card.style.left = (ox + e.clientX - sx) + 'px';
      card.style.top = (oy + e.clientY - sy) + 'px';
      e.preventDefault();
    });

    const stop = () => { armed = false; dragging = false; };
    hd.addEventListener('pointerup', stop);
    hd.addEventListener('pointercancel', stop);
  }
})();
