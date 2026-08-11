/**
 * map/textLabels.js — free-standing text you can put anywhere on the map.
 *
 * Every piece of text the app could draw was previously owned by something
 * else: a location's chip, a shape's name label, a route's distance. Which
 * means a word that belongs to the *place* rather than to any one object —
 * "Kalyan", "Phase II", "proposed alignment", "NH-61" — had nowhere to live. On
 * the reference maps this tool is measured against, most of the type on the
 * page is exactly that: names of areas, not names of pins.
 *
 * WHY IT IS A SHAPE AND NOT A NEW COLLECTION. A label is a marker with words
 * on it, and making it a fifth kind of geometry means it inherits everything
 * the Draw tab already does — a card, undo and redo, save and load, delete,
 * drag, the colour-group editor, KML and GeoJSON export, and the PNG and PPTX
 * passes. A parallel `labels` array would have meant re-implementing every one
 * of those, and forgetting one of them is how a feature ends up not surviving
 * a save.
 *
 * `g.name` is the label's text. That is not a shortcut: the card's name field
 * is already the thing you type into, it is already what the KML exporter
 * writes into `<name>`, and it is already what the shape list shows. A separate
 * `text` field would have been the same string stored twice, drifting apart the
 * first time one of them was edited.
 *
 * PLATE OR HALO, NEVER NEITHER. Text laid straight onto satellite imagery
 * disappears over anything the same tone as itself — which, somewhere in a
 * frame, it always is. So a label either sits on a plate (fill opacity above
 * zero) or, with the plate off, carries a halo in the opposite luminance to its
 * ink. That is how every mapping product does it, and it is the difference
 * between type that reads over a bright rooftop and type that does not.
 */

/** Font sizes offered, in px. Below 10 nothing is readable in an export. */
const TEXT_LABEL_MIN = 10;
const TEXT_LABEL_MAX = 44;

/** Whether the map is armed to drop a label on the next click. */
let textLabelPlacing = false;

/**
 * A halo colour that contrasts with the ink.
 *
 * Relative luminance, not a hue guess: the question is only "is this ink light
 * or dark", and the answer decides whether the outline behind it is near-black
 * or near-white.
 *
 * @param {string} hex @returns {string}
 */
function textLabelHalo(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return 'rgba(0,0,0,.85)';
  const lin = v => {
    v = parseInt(v, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
  return L > 0.45 ? 'rgba(6,10,20,.9)' : 'rgba(255,255,255,.92)';
}

/** @param {string} hex @param {number} alpha @returns {string} */
function textLabelRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return 'rgba(0,0,0,' + alpha + ')';
  return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + alpha + ')';
}

/** @param {object} g @returns {number} the label's font size in px, clamped */
function textLabelSize(g) {
  const n = Number(g.labelSize);
  return Math.min(TEXT_LABEL_MAX, Math.max(TEXT_LABEL_MIN, isFinite(n) ? n : 15));
}

/**
 * The divIcon a text label draws as.
 *
 * Sized [0,0] with the span translated to its own centre, the same trick the
 * shape-name labels use: a divIcon with real dimensions would have Leaflet
 * anchor it by a box whose size depends on the text, so a label would shift
 * sideways as you typed.
 *
 * @param {object} g @returns {L.DivIcon}
 */
function geomTextIcon(g) {
  const size = textLabelSize(g);
  const ink = g.borderColor || '#EAF0F9';
  const plated = (g.fillOpacity || 0) > 0.02;

  const box = plated
    ? 'background:' + textLabelRgba(g.fillColor, g.fillOpacity)
      + ';padding:' + Math.round(size * 0.22) + 'px ' + Math.round(size * 0.5) + 'px'
      + ';border-radius:' + Math.round(size * 0.34) + 'px'
    // 4-way shadow rather than -webkit-text-stroke: the stroke property thins
    // the glyph from the inside at small sizes, and is not honoured by every
    // rasteriser the export path runs through.
    : 'text-shadow:0 0 3px ' + textLabelHalo(ink)
      + ',1px 1px 2px ' + textLabelHalo(ink)
      + ',-1px -1px 2px ' + textLabelHalo(ink)
      + ',1px -1px 2px ' + textLabelHalo(ink);

  const style = 'color:' + ink
    + ';font-size:' + size + 'px'
    + ';font-weight:' + (g.labelBold === false ? 600 : 800)
    + ';' + box;

  return L.divIcon({
    className: 'map-text-wrap',
    html: '<span class="map-text" style="' + style + '">' + esc(g.name || ' ') + '</span>',
    iconSize: [0, 0],
  });
}

/**
 * Arm or disarm click-to-place.
 *
 * Mutually exclusive with drawing, editing and click-to-add: two modes waiting
 * on the same click is a coin toss, and whichever loses reads as broken.
 *
 * @param {boolean} on
 */
function setTextLabelPlacing(on) {
  textLabelPlacing = !!on;

  // Every other mode is stood down FIRST. disableAllDrawModes() clears the
  // `toggled` class from every button in GEOM_SHAPES — which now includes this
  // one — so highlighting the button before that call was highlighting it and
  // then immediately wiping it: the mode was armed but looked off.
  if (textLabelPlacing) {
    if (typeof disableAllDrawModes === 'function') disableAllDrawModes();
    if (typeof disableAllEditModes === 'function') disableAllEditModes();
    if (typeof uiState === 'object' && uiState.addingMode && typeof setAdding === 'function') setAdding(false);
    if (typeof setBoundaryPickMode === 'function' && typeof boundaryPickMode !== 'undefined' && boundaryPickMode) {
      setBoundaryPickMode(false);
    }
  }

  const btn = document.getElementById('drawLabelBtn');
  if (btn) btn.classList.toggle('toggled', textLabelPlacing);
  const wrap = document.getElementById('mapWrap');
  if (wrap) wrap.classList.toggle('placing-label', textLabelPlacing);

  if (textLabelPlacing) status('Click the map where the text should go. Esc to stop.', true);
}

/**
 * Drop a label at a point and put the cursor in its text field.
 *
 * Straight into editing, because a label that says "Label" is never what
 * anyone wanted — placing it and naming it are one action, and splitting them
 * leaves a map covered in placeholders.
 *
 * @param {number} lat @param {number} lng @param {string} [text]
 * @returns {object} the new geometry
 */
function addTextLabel(lat, lng, text) {
  const g = registerGeom(L.marker([lat, lng], { icon: L.divIcon({ className: 'map-text-wrap', html: '', iconSize: [0, 0] }) }), 'Label', {
    name: text || 'Text',
    // Ink light enough to read over satellite; no plate by default, so the
    // halo does the work and the imagery still shows through.
    borderColor: '#FFFFFF',
    fillColor: '#0A1E3C',
    fillOpacity: 0,
    labelSize: 15,
    labelBold: true,
  });

  if (typeof pushUndo === 'function') pushUndo({ type: 'create', snap: snapshotGeom(g) });

  // Draw is where the card lives; opening the pane is part of "now type".
  const drawTab = document.getElementById('tabBtnDraw');
  if (drawTab && !drawTab.classList.contains('on')) drawTab.click();

  setTimeout(() => focusTextLabelField(g), 60);
  return g;
}

/** Put the caret in a label's text field, selecting what is there. @param {object} g */
function focusTextLabelField(g) {
  const input = g.card && g.card.querySelector('.gnm');
  if (!input) return;
  g.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  input.focus();
  input.select();
}

/* ---------------------------------------------------------------------------
 * The card
 * ------------------------------------------------------------------------ */

/**
 * A label's own card.
 *
 * Deliberately not the shape card with rows hidden. Border width, corner style,
 * line style and fill pattern have no meaning for a word on a map, and a card
 * full of controls that do nothing is worse than a shorter one — someone will
 * try them, and conclude the feature is broken when nothing happens.
 *
 * @param {object} g @returns {HTMLDivElement}
 */
function textLabelCardMarkup(g) {
  const card = document.createElement('div');
  card.className = 'item-card geom-card label-card';
  const size = textLabelSize(g);
  const plate = Math.round((g.fillOpacity || 0) * 100);

  card.innerHTML = `
    <div class="r">
      <input type="color" class="gbc" value="${esc(g.borderColor)}" title="Text colour" aria-label="Text colour">
      <input type="text" class="gnm grow" value="${esc(g.name)}" placeholder="Type the label" aria-label="Label text">
      <button class="x-btn" title="Delete this label" aria-label="Delete this label">&times;</button>
    </div>
    <div class="r">
      <span class="sub gg-lbl">Size</span>
      <input type="range" class="lsize" min="${TEXT_LABEL_MIN}" max="${TEXT_LABEL_MAX}" step="1" value="${size}" style="flex:1;" title="Text size" aria-label="Text size">
      <span class="pct lsize-v">${size}px</span>
    </div>
    <div class="r">
      <span class="sub gg-lbl">Plate</span>
      <input type="color" class="gclr" value="${esc(g.fillColor)}" title="Plate colour behind the text" aria-label="Plate colour behind the text">
      <input type="range" class="gop" min="0" max="100" step="5" value="${plate}" style="flex:1;" title="Plate opacity — at 0 the text carries a halo instead" aria-label="Plate opacity">
      <span class="pct gop-v">${plate ? plate + '%' : 'Halo'}</span>
    </div>
    <div class="r">
      <label class="chk"><input type="checkbox" class="lbold" ${g.labelBold === false ? '' : 'checked'}> Bold</label>
      <span class="grow"></span>
      <span class="sub" style="font-size:10px;">Drag mode moves it</span>
    </div>
    <div class="r"><textarea class="gnotes grow" rows="2" placeholder="Notes">${esc(g.notes)}</textarea></div>
    <div class="r">
      <span class="sub grow geom-modified" style="font-size:10px;">Modified ${new Date(g.modifiedAt).toLocaleString()}</span>
      <button class="mini-btn gzoom" title="Zoom to this label" aria-label="Zoom to this label">⌖</button>
    </div>`;

  if (typeof enhanceColorInputs === 'function') enhanceColorInputs(card);
  return card;
}

/** Wire a label card. @param {HTMLDivElement} card @param {object} g */
function wireTextLabelCard(card, g) {
  const restyle = () => { applyGeomStyle(g); touchGeom(g); };

  card.querySelector('.gnm').addEventListener('input', e => {
    // 'input', not 'change': the label on the map is the preview, and waiting
    // for blur to show what you typed makes the two feel disconnected.
    g.name = e.target.value;
    restyle();
  });
  card.querySelector('.gnm').addEventListener('change', e => {
    if (!e.target.value.trim()) { g.name = nextGeomName('Label'); e.target.value = g.name; restyle(); }
  });
  card.querySelector('.gbc').addEventListener('input', e => { g.borderColor = e.target.value; restyle(); });
  card.querySelector('.gclr').addEventListener('input', e => { g.fillColor = e.target.value; restyle(); });

  const size = card.querySelector('.lsize');
  size.addEventListener('input', e => {
    g.labelSize = +e.target.value;
    card.querySelector('.lsize-v').textContent = g.labelSize + 'px';
    restyle();
  });

  const op = card.querySelector('.gop');
  op.addEventListener('input', e => {
    g.fillOpacity = (+e.target.value) / 100;
    card.querySelector('.gop-v').textContent = +e.target.value ? e.target.value + '%' : 'Halo';
    restyle();
  });

  card.querySelector('.lbold').addEventListener('change', e => { g.labelBold = e.target.checked; restyle(); });
  card.querySelector('.gnotes').addEventListener('change', e => { g.notes = e.target.value; touchGeom(g); });
  card.querySelector('.gzoom').addEventListener('click', () => {
    map.flyTo(g.layer.getLatLng(), Math.max(map.getZoom(), 15));
  });
  card.querySelector('.x-btn').addEventListener('click', () => deleteGeom(g));

  g.card = card;
  $('geomList').appendChild(card);
}

/** Re-sync a label card after undo/redo. @param {object} g */
function syncTextLabelCard(g) {
  const c = g.card;
  if (!c) return;
  const size = textLabelSize(g);
  const plate = Math.round((g.fillOpacity || 0) * 100);
  c.querySelector('.gnm').value = g.name;
  c.querySelector('.gbc').value = g.borderColor;
  c.querySelector('.gclr').value = g.fillColor;
  c.querySelector('.lsize').value = size;
  c.querySelector('.lsize-v').textContent = size + 'px';
  c.querySelector('.gop').value = plate;
  c.querySelector('.gop-v').textContent = plate ? plate + '%' : 'Halo';
  c.querySelector('.lbold').checked = g.labelBold !== false;
  if (typeof syncColorSwatch === 'function') {
    syncColorSwatch(c.querySelector('.gbc'));
    syncColorSwatch(c.querySelector('.gclr'));
  }
}

// Wiring. Kept here so the whole feature — icon, placement, card — reads in
// one file, the same way boundaries.js owns its own button.
(function wireTextLabels() {
  // No listener on #drawLabelBtn here. drawing.js wires every entry in
  // GEOM_SHAPES to startDrawShape(), which now routes 'Label' to
  // setTextLabelPlacing() — adding a second listener made one click toggle the
  // mode twice, on then straight back off, so the button appeared dead.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && textLabelPlacing) { setTextLabelPlacing(false); status('Text placing off.'); }
  });

  map.on('click', e => {
    if (!textLabelPlacing) return;
    setTextLabelPlacing(false);          // one click, one label — not a stamp tool
    const g = addTextLabel(e.latlng.lat, e.latlng.lng);
    status(`Text added. Type to name it, then use Drag mode to move it.`, false, {
      label: 'Undo',
      onClick: () => { removeGeomById(g.id); status('Text removed.'); },
    });
  });
})();
