/**
 * ui/geometryPanel.js — sidebar cards for drawn/imported shapes (Draw tab):
 * name, description, notes, fill/border color+width+opacity, created/modified
 * dates, zoom, delete. Mirrors ui/propertyPanel.js's location-card pattern.
 */

/** Build a geometry card's DOM (markup only, no event wiring). @param {object} g @returns {HTMLDivElement} */
function geomCardMarkup(g) {
  const card = document.createElement('div');
  card.className = 'item-card geom-card';
  card.innerHTML = `
    <div class="r">
      <input type="color" class="gclr" value="${esc(g.fillColor)}" title="Fill color">
      <input type="text" class="gnm grow" value="${esc(g.name)}" placeholder="Name">
      <button class="x-btn" title="Delete">&times;</button>
    </div>
    <div class="r">
      <span class="sub" style="width:52px;">Border</span>
      <input type="color" class="gbc" value="${esc(g.borderColor)}" title="Border color">
      <input type="range" class="gbw" min="0" max="10" step="1" value="${g.borderWidth}" style="flex:1;" title="Border width">
      <span class="pct gbw-v" style="width:22px;">${g.borderWidth}</span>
    </div>
    <div class="r">
      <span class="sub" style="width:52px;">Fill</span>
      <input type="range" class="gop" min="0" max="100" step="5" value="${Math.round(g.fillOpacity * 100)}" style="flex:1;" title="Fill opacity">
      <span class="pct gop-v" style="width:32px;">${Math.round(g.fillOpacity * 100)}%</span>
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
  return card;
}

/** Wire up every control in a geometry card built by geomCardMarkup(). @param {HTMLDivElement} card @param {object} g */
function wireGeomCard(card, g) {
  card.querySelector('.gclr').addEventListener('input', e => { g.fillColor = e.target.value; applyGeomStyle(g); touchGeom(g); });
  card.querySelector('.gnm').addEventListener('change', e => { g.name = e.target.value || nextGeomName(g.shape); touchGeom(g); });
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
