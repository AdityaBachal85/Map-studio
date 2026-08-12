/**
 * map/connectivityStandard.js — one colour per road class, everywhere, forever.
 *
 * THE PROBLEM THIS SOLVES. Route colours came from `PALETTE[routes.length % n]`
 * — a rotating palette keyed on how many routes happened to exist when you
 * drew one. So the Outer Ring Road is blue in one report and red in the next,
 * and the metro is whatever was left. Two people mapping the same city produce
 * two documents that share nothing, and a reader who learned "green is the
 * expressway" on page 3 is misled on page 9. A rotating palette is the right
 * default for "these are N unrelated things"; it is the wrong one for "these
 * are road classes", which is a fixed vocabulary.
 *
 * THE CLASS IS THE COLOUR. A route or a shape carries `cls`, and the class
 * decides colour, weight and dash. Change a colour here and every map that
 * uses that class changes with it — which is the whole point, and also the
 * reason this table lives in exactly one place.
 *
 * WHY THESE COLOURS. They start from the DBOT logo, decoded from LOGO_B64
 * rather than taken from the app's theme tokens — the theme's `--navy #0A1E3C`
 * and `--orange #FF7A1A` are the *interface's* colours and are not in the logo
 * at all. The logo is navy #002166, blue #0073C6, green #7ED236, gold #E2BD60.
 *
 * Two of those four are unusable as-is for a 4-5px line on a light
 * OpenStreetMap ground: #7ED236 and #E2BD60 are bright and low-contrast
 * against pale terrain, and a connectivity map that cannot be read is not on
 * brand either. They are darkened to the same hue at usable luminance. The
 * remaining classes need hues the logo does not contain; they were chosen to
 * stay apart from each other and from the four above, including under the
 * common colour-vision deficiencies.
 *
 * DEFAULT, NOT LAW. `connApplyToRoute` sets a route's style from its class,
 * but the per-route colour picker still works. Deviating is allowed and the
 * card says when a route has deviated, so it is a visible choice rather than
 * an accident. See map/layouts.js for when the standard is on at all.
 */

/**
 * The vocabulary. `kind` is 'line' for things drawn as routes/lines and 'mark'
 * for point features, which matters only to the legend.
 */
const CONNECTIVITY_CLASSES = [
  { id: 'site', label: 'Site / subject property', color: '#002166', weight: 5, dash: false, kind: 'mark' },
  { id: 'expressway', label: 'Expressway / National Highway', color: '#0073C6', weight: 6, dash: false, kind: 'line' },
  { id: 'ring', label: 'Outer Ring Road / arterial', color: '#4E9E1F', weight: 5, dash: false, kind: 'line' },
  { id: 'major', label: 'Major road', color: '#FF7A1A', weight: 4, dash: false, kind: 'line' },
  { id: 'airportRoad', label: 'Airport road', color: '#B5179E', weight: 4, dash: false, kind: 'line' },
  { id: 'metro', label: 'Metro', color: '#C9971F', weight: 4, dash: false, kind: 'line' },
  { id: 'railway', label: 'Railway', color: '#3D4451', weight: 3, dash: true, kind: 'line' },
  { id: 'water', label: 'River / stream', color: '#2C9CC4', weight: 3, dash: false, kind: 'line' },
  { id: 'airport', label: 'Airport', color: '#0369A1', weight: 4, dash: false, kind: 'mark' },
  { id: 'station', label: 'Railway station', color: '#3D4451', weight: 4, dash: false, kind: 'mark' },
  { id: 'metroStation', label: 'Metro station', color: '#C9971F', weight: 4, dash: false, kind: 'mark' },
  { id: 'hub', label: 'Employment hub', color: '#0E7490', weight: 4, dash: false, kind: 'mark' },

  /* ---- power ------------------------------------------------------------
   * An HT line is not an amenity, it is a constraint. It carries a statutory
   * right-of-way that cannot be built in, and the corridor's width depends on
   * the line's voltage — so a transmission line across a plot changes what the
   * plot is worth and what can go on it.
   *
   * Coloured as a warning rather than fitted into the road palette, because it
   * is the one thing on the map that says "you cannot build here", and a
   * reader must never mistake it for another road. Towers share the line's
   * colour: they are the same object.
   */
  { id: 'powerLine', label: 'HT / transmission line', color: '#D62246', weight: 3, dash: false, kind: 'line' },
  { id: 'powerMinor', label: 'LT / distribution line', color: '#E08A9B', weight: 2, dash: true, kind: 'line' },
  { id: 'powerTower', label: 'Transmission tower', color: '#D62246', weight: 3, dash: false, kind: 'mark' },
  { id: 'substation', label: 'Substation', color: '#A4243B', weight: 2, dash: false, kind: 'area', fill: 0.3 },

  /* ---- ground cover ----------------------------------------------------
   * The land itself, not what crosses it: where the built-up area ends, where
   * the industrial belt is, what is still farmland. On a property map that is
   * half the argument — a site is worth what its surroundings are.
   *
   * Deliberately muted where the line classes are saturated. These are washes
   * covering large parts of the sheet, and a road has to stay readable *over*
   * them; an area that competes with the lines drawn on top of it is an area
   * that has buried the drawing. They also read as ground rather than as
   * something drawn, which is what they are.
   *
   * `fill` is the fill opacity. Buildings get more because they are small and
   * would otherwise vanish; farmland gets less because it can cover the whole
   * sheet.
   */
  { id: 'builtUp', label: 'Built-up / residential', color: '#B0736A', weight: 1, dash: false, kind: 'area', fill: 0.22 },
  { id: 'industrial', label: 'Industrial / warehousing', color: '#8D7B9C', weight: 1, dash: false, kind: 'area', fill: 0.24 },
  { id: 'commercial', label: 'Commercial / retail', color: '#C97B4A', weight: 1, dash: false, kind: 'area', fill: 0.22 },
  { id: 'green', label: 'Park / green cover', color: '#5C9A5C', weight: 1, dash: false, kind: 'area', fill: 0.24 },
  { id: 'farmland', label: 'Farmland / open land', color: '#B5A34C', weight: 1, dash: false, kind: 'area', fill: 0.16 },
  { id: 'building', label: 'Buildings', color: '#7A6E66', weight: 1, dash: false, kind: 'area', fill: 0.42 },
];

/** What a classed line gets when nobody has said which class it is. */
const CONNECTIVITY_DEFAULT_CLASS = 'major';

/**
 * A line class may additionally be marked "proposed" — same colour, dashed.
 * A modifier rather than a class of its own: a proposed metro is still the
 * metro, and giving it a separate colour would say it is a different thing.
 */
const CONNECTIVITY_PROPOSED_DASH = '10,7';

/** @param {string} id @returns {object|null} */
function connClass(id) {
  return CONNECTIVITY_CLASSES.find(c => c.id === id) || null;
}

/** @returns {Array<[string,string]>} [id, label] pairs for the line classes */
function connLineClasses() {
  return CONNECTIVITY_CLASSES.filter(c => c.kind === 'line').map(c => [c.id, c.label]);
}

/**
 * Has this route been styled away from its class?
 *
 * Compared against the class rather than tracked with a flag, so it stays true
 * after an undo, after a project reload, and after somebody sets the colour
 * back to the class colour by hand — all of which a flag would get wrong.
 *
 * @param {object} rt @returns {boolean}
 */
function connRouteDeviates(rt) {
  const c = connClass(rt && rt.cls);
  if (!c) return false;
  return String(rt.color).toUpperCase() !== c.color.toUpperCase()
    || +rt.weight !== c.weight;
}

/**
 * Style a route from its class.
 *
 * @param {object} rt
 * @param {object} [opts] `{force}` to overwrite a deviation
 * @returns {boolean} whether anything changed
 */
function connApplyToRoute(rt, opts) {
  const c = connClass(rt && rt.cls);
  if (!c) return false;
  if (!(opts && opts.force) && connRouteDeviates(rt)) return false;
  const before = rt.color + '|' + rt.weight + '|' + rt.dash;
  rt.color = c.color;
  rt.weight = c.weight;
  rt.dash = rt.proposed ? true : c.dash;
  return before !== (rt.color + '|' + rt.weight + '|' + rt.dash);
}

/**
 * Style a drawn or fetched shape from its class.
 *
 * Lines take the class colour as their stroke; areas take it as fill with the
 * stroke a step darker, because a translucent fill in the class colour is what
 * reads as "this is that class" on a polygon.
 *
 * @param {object} g a `geometries` entry @returns {boolean} changed
 */
function connApplyToGeom(g, opts) {
  const c = connClass(g && g.cls);
  if (!c) return false;
  const area = g.shape === 'Polygon' || g.shape === 'Rectangle' || g.shape === 'Circle';
  const before = g.borderColor + '|' + g.fillColor + '|' + g.borderWidth + '|' + g.lineStyle;
  g.borderColor = c.color;
  // The class's own fill opacity when it has one. A building at farmland's
  // opacity is invisible; farmland at a building's opacity is a solid slab
  // over the whole map. One number for every area class cannot serve both.
  if (area) {
    g.fillColor = c.color;
    if (g.fillOpacity == null) g.fillOpacity = c.fill == null ? 0.18 : c.fill;
  }
  g.borderWidth = c.weight;
  g.lineStyle = (c.dash || g.proposed) ? 'dashed' : 'solid';
  if (!(opts && opts.silent) && typeof applyGeomStyle === 'function') applyGeomStyle(g);
  return before !== (g.borderColor + '|' + g.fillColor + '|' + g.borderWidth + '|' + g.lineStyle);
}

/**
 * The road-type key, built from the classes actually on the map.
 *
 * Generated rather than typed, so the legend cannot contradict the drawing —
 * which is exactly what the report sheet's hand-written `lines` array did: it
 * shipped four colours that appear nowhere in the app, so a route would never
 * match its own legend swatch except by accident.
 *
 * @returns {Array<{color:string,label:string,cls:string,kind:string}>}
 */
function connLegendRows() {
  const used = new Map();

  const note = (cls, proposed) => {
    const c = connClass(cls);
    if (!c) return;
    const key = c.id + (proposed ? ':proposed' : '');
    if (used.has(key)) return;
    used.set(key, {
      cls: c.id,
      color: c.color,
      label: proposed ? c.label + ' (proposed)' : c.label,
      kind: c.kind,
    });
  };

  if (typeof routes !== 'undefined') routes.forEach(r => note(r.cls, r.proposed));
  if (typeof geometries !== 'undefined') geometries.forEach(g => note(g.cls, g.proposed));
  if (typeof locations !== 'undefined') locations.forEach(l => { if (l.type === 'site') note('site'); });

  // Ordered by the table above, not by when each first appeared — a legend
  // whose order depends on drawing order is a different legend every time.
  const order = CONNECTIVITY_CLASSES.map(c => c.id);
  return [...used.values()].sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls));
}

/**
 * Re-style everything that carries a class. Called when the standard is turned
 * on, and after a project loads into a standardised layout.
 *
 * @param {object} [opts] `{force}` to overwrite deviations too
 * @returns {number} how many objects changed
 */
function connApplyAll(opts) {
  let n = 0;
  if (typeof routes !== 'undefined') {
    routes.forEach(rt => {
      if (connApplyToRoute(rt, opts)) { n++; if (typeof drawRoute === 'function') drawRoute(rt); }
    });
  }
  if (typeof geometries !== 'undefined') {
    geometries.forEach(g => { if (connApplyToGeom(g, opts)) n++; });
  }
  if (n && typeof rebuildLegend === 'function') rebuildLegend();
  return n;
}
