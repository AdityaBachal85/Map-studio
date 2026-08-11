/**
 * ui/geometryPanel.js — sidebar cards for drawn/imported shapes (Draw tab):
 * name, description, notes, fill/border color+width+opacity, line style, corner
 * style, on-map label, glow, created/modified dates, edit, zoom, delete.
 * Mirrors ui/propertyPanel.js's location-card pattern.
 */

const LINE_STYLE_OPTS = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']];
const CORNER_OPTS = [['round', 'Round'], ['sharp', 'Sharp'], ['square', 'Square']];

function optionList(opts, sel) {
  return opts.map(([v, label]) => `<option value="${v}" ${sel === v ? 'selected' : ''}>${label}</option>`).join('');
}

/** Build a geometry card's DOM (markup only, no event wiring). @param {object} g @returns {HTMLDivElement} */
function geomCardMarkup(g) {
  // A label's controls are a different set, not this set with rows hidden —
  // see map/textLabels.js.
  if (g.shape === 'Label') return textLabelCardMarkup(g);
  const card = document.createElement('div');
  card.className = 'item-card geom-card';
  const isLine = g.shape === 'Line' || g.shape === 'Marker' || g.shape === 'CircleMarker';
  // A pattern needs an SVG path with a fill to hang on. A Line has no fill, and
  // a Marker is a divIcon rather than a path — CircleMarker is neither, so it
  // is deliberately not lumped in with `isLine` here the way opacity is.
  const noFill = g.shape === 'Line' || g.shape === 'Marker';
  card.innerHTML = `
    <div class="r">
      <input type="color" class="gclr" value="${esc(g.fillColor)}" title="Fill color">
      <input type="text" class="gnm grow" value="${esc(g.name)}" placeholder="Name">
      <button class="x-btn" title="Delete">&times;</button>
    </div>
    <div class="r">
      <span class="sub" style="width:52px;">Border</span>
      <input type="color" class="gbc" value="${esc(g.borderColor)}" title="Border / line color">
      <input type="range" class="gbw" min="0" max="10" step="1" value="${g.borderWidth}" style="flex:1;" title="Border / line width">
      <span class="pct gbw-v" style="width:22px;">${g.borderWidth}</span>
    </div>
    <div class="r">
      <span class="sub" style="width:52px;">Fill</span>
      <select class="gfp" style="flex:0 0 94px;" title="Fill pattern — ruled lines read as water or land use, and let the imagery show through"${noFill ? ' disabled' : ''}>${optionList(FILL_PATTERN_OPTS, g.fillPattern || 'none')}</select>
      <input type="range" class="gop" min="0" max="100" step="5" value="${Math.round(g.fillOpacity * 100)}" style="flex:1;" title="Fill opacity">
      <span class="pct gop-v" style="width:32px;">${Math.round(g.fillOpacity * 100)}%</span>
    </div>
    <div class="r">
      <span class="sub" style="width:52px;">Line</span>
      <select class="gls grow" title="Line style">${optionList(LINE_STYLE_OPTS, g.lineStyle)}</select>
      <select class="gcorner grow" title="Corner style">${optionList(CORNER_OPTS, g.corner)}</select>
    </div>
    <div class="r">
      <label class="chk"><input type="checkbox" class="glbl" ${g.showLabel ? 'checked' : ''}> Label on map</label>
      <span class="grow"></span>
      <label class="chk"><input type="checkbox" class="gglow" ${g.glow ? 'checked' : ''}> Glow</label>
    </div>
    <div class="r"><textarea class="gdesc grow" rows="2" placeholder="Description">${esc(g.description)}</textarea></div>
    <div class="r"><textarea class="gnotes grow" rows="2" placeholder="Notes">${esc(g.notes)}</textarea></div>
    <div class="r"><span class="sub geom-measure"></span></div>
    <div class="r">
      <span class="sub" style="font-size:10px;">Created ${new Date(g.createdAt).toLocaleString()}</span>
    </div>
    <div class="r">
      <span class="sub grow geom-modified" style="font-size:10px;">Modified ${new Date(g.modifiedAt).toLocaleString()}</span>
      <button class="mini-btn gedit" title="Edit this shape (drag vertices) — or double-click it on the map">✎ Edit</button>
      <button class="mini-btn gzoom" title="Zoom to shape">⌖</button>
    </div>`;
  if (isLine) { const op = card.querySelector('.gop'); if (op) op.closest('.r').style.opacity = g.shape === 'Line' ? '.5' : '1'; }
  enhanceColorInputs(card);
  return card;
}

/** Re-sync a card's style controls from its geometry (used after undo/redo). @param {object} g */
function syncGeomCardStyleControls(g) {
  const c = g.card; if (!c) return;
  if (g.shape === 'Label') { syncTextLabelCard(g); return; }
  c.querySelector('.gclr').value = g.fillColor;
  c.querySelector('.gbc').value = g.borderColor;
  c.querySelector('.gbw').value = g.borderWidth;
  c.querySelector('.gbw-v').textContent = g.borderWidth;
  c.querySelector('.gop').value = Math.round(g.fillOpacity * 100);
  c.querySelector('.gop-v').textContent = Math.round(g.fillOpacity * 100) + '%';
  c.querySelector('.gfp').value = g.fillPattern || 'none';
  c.querySelector('.gls').value = g.lineStyle;
  c.querySelector('.gcorner').value = g.corner;
  c.querySelector('.glbl').checked = !!g.showLabel;
  c.querySelector('.gglow').checked = !!g.glow;
}

/** Wire up every control in a geometry card built by geomCardMarkup(). @param {HTMLDivElement} card @param {object} g */
function wireGeomCard(card, g) {
  if (g.shape === 'Label') { wireTextLabelCard(card, g); return; }
  card.querySelector('.gclr').addEventListener('input', e => { g.fillColor = e.target.value; applyGeomStyle(g); touchGeom(g); });
  card.querySelector('.gnm').addEventListener('change', e => { g.name = e.target.value || nextGeomName(g.shape); ensureGeomLabel(g); touchGeom(g); });
  card.querySelector('.gbc').addEventListener('input', e => { g.borderColor = e.target.value; applyGeomStyle(g); touchGeom(g); });
  card.querySelector('.gbw').addEventListener('input', e => {
    g.borderWidth = +e.target.value;
    card.querySelector('.gbw-v').textContent = g.borderWidth;
    applyGeomStyle(g); touchGeom(g);
  });
  card.querySelector('.gop').addEventListener('input', e => {
    g.fillOpacity = (+e.target.value) / 100;
    card.querySelector('.gop-v').textContent = e.target.value + '%';
    applyGeomStyle(g); touchGeom(g);
  });
  card.querySelector('.gfp').addEventListener('change', e => {
    g.fillPattern = e.target.value;
    // A pattern is mostly gaps, so the 25% that suits a solid wash leaves it
    // nearly invisible over imagery. Move the slider rather than overriding it
    // behind the slider's back — the jump is visible, and dragging it back
    // does exactly what it looks like it does.
    if (isFillPattern(g.fillPattern)) {
      const want = fillPatternOpacityFor(g.fillOpacity);
      if (want !== g.fillOpacity) {
        g.fillOpacity = want;
        card.querySelector('.gop').value = Math.round(want * 100);
        card.querySelector('.gop-v').textContent = Math.round(want * 100) + '%';
      }
    }
    applyGeomStyle(g); touchGeom(g);
  });
  card.querySelector('.gls').addEventListener('change', e => { g.lineStyle = e.target.value; applyGeomStyle(g); touchGeom(g); });
  card.querySelector('.gcorner').addEventListener('change', e => { g.corner = e.target.value; applyGeomStyle(g); touchGeom(g); });
  card.querySelector('.glbl').addEventListener('change', e => { g.showLabel = e.target.checked; ensureGeomLabel(g); touchGeom(g); });
  card.querySelector('.gglow').addEventListener('change', e => { g.glow = e.target.checked; ensureGlow(g); touchGeom(g); });
  card.querySelector('.gdesc').addEventListener('change', e => { g.description = e.target.value; touchGeom(g); });
  card.querySelector('.gnotes').addEventListener('change', e => { g.notes = e.target.value; touchGeom(g); });
  card.querySelector('.gedit').addEventListener('click', () => enableSingleShapeEdit(g));
  card.querySelector('.gzoom').addEventListener('click', () => {
    if (g.layer.getBounds) map.fitBounds(g.layer.getBounds(), { padding: [60, 60] });
    else if (g.layer.getLatLng) map.flyTo(g.layer.getLatLng(), Math.max(map.getZoom(), 16));
  });
  card.querySelector('.x-btn').addEventListener('click', () => deleteGeom(g));
  g.card = card;
  $('geomList').appendChild(card);
  updateGeomMeasurement(g);
}

/** Build and wire a geometry's sidebar card, then append it to the list. @param {object} g */
function buildGeomCard(g) {
  const card = geomCardMarkup(g);
  wireGeomCard(card, g);
}
