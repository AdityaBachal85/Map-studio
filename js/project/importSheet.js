/**
 * project/importSheet.js — the bulk location importer: template, parsing, checks.
 *
 * The problem this solves: twenty landmarks entered by hand is twenty chances
 * to mistype a coordinate, and a mistyped coordinate does not look like an
 * error — it looks like a pin in the Arabian Sea, or worse, a pin three streets
 * away that nobody notices until the deck is with the client.
 *
 * So the import is deliberately not a single click. A sheet is read, every row
 * is checked, and the operator is shown what will happen *before* anything is
 * added. Rows that are fine import; rows that are not are named, with the
 * reason, and can be skipped without holding up the rest.
 *
 * THE TEMPLATE
 *
 *   Name | Lat, Long | Type | Route to | Mode
 *
 * `Route to` holds the *name of another row* rather than a yes/no, which is
 * what makes landmark-to-landmark routes possible without a second sheet. In
 * the generated .xlsx it is a dropdown listing the Name column, so it is picked
 * rather than retyped — a retyped name that differs by one space is a route
 * that silently does not appear.
 */

/* ---------------------------------------------------------------------------
 * Column model
 * ------------------------------------------------------------------------- */

/**
 * Recognised columns and the header spellings accepted for each.
 *
 * Aliases exist because the sheet that comes back is rarely the sheet that went
 * out: columns get renamed, translated, or pasted in from someone else's list.
 * Matching on a normalised form costs nothing and avoids rejecting a file whose
 * only sin is saying "Latitude/Longitude" instead of "Lat, Long".
 */
const SHEET_COLUMNS = Object.freeze({
  name: { label: 'Name', required: true, aliases: ['name', 'location', 'locationname', 'place', 'placename', 'title', 'label'] },
  coords: { label: 'Lat, Long', required: true, aliases: ['latlong', 'latlng', 'latitudelongitude', 'coordinates', 'coords', 'coordinate', 'latlon', 'position'] },
  lat: { label: 'Latitude', aliases: ['lat', 'latitude', 'y'] },
  lng: { label: 'Longitude', aliases: ['lng', 'long', 'lon', 'longitude', 'x'] },
  type: { label: 'Type', aliases: ['type', 'kind', 'category', 'pintype'] },
  routeTo: { label: 'Route to', aliases: ['routeto', 'route', 'routes', 'connectto', 'linkto', 'routetarget', 'destination'] },
  mode: { label: 'Mode', aliases: ['mode', 'travel', 'travelmode', 'by', 'transport'] },
});

/** Header text → comparable key: case, spaces and punctuation all ignored. */
const normHeader = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Sheet `Type` value → the app's location type. */
function sheetTypeToLoc(v) {
  const s = String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return 'pin';
  if (s.indexOf('site') >= 0 || s.indexOf('subject') >= 0 || s.indexOf('property') >= 0) return 'site';
  if (s.indexOf('badge') >= 0 || s.indexOf('highway') >= 0 || s.indexOf('hwy') >= 0 || s.indexOf('shield') >= 0) return 'badge';
  return 'pin';
}

/** The app's location type → the sheet's wording. */
const LOC_TYPE_LABEL = { site: 'Site', badge: 'Highway badge', pin: 'Location' };

/** Sheet `Mode` value → an OSRM profile. */
function sheetModeToProfile(v) {
  const s = String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return 'car';
  if (s.indexOf('bike') >= 0 || s.indexOf('cycl') >= 0) return 'bike';
  if (s.indexOf('walk') >= 0 || s.indexOf('foot') >= 0 || s.indexOf('ped') >= 0) return 'foot';
  return 'car';
}

const MODE_LABEL = { car: 'Car', bike: 'Bike', foot: 'Walk' };

/* ---------------------------------------------------------------------------
 * Coordinate parsing
 * ------------------------------------------------------------------------- */

/**
 * Parse a coordinate pair from whatever form it arrived in.
 *
 * The realistic inputs are wider than "two numbers with a comma", because the
 * usual source is a right-click in Google Maps and a paste into Excel:
 *
 *   19.076090, 72.877426          the common case
 *   19.076090 72.877426           space or tab separated
 *   19.0760° N, 72.8774° E        copied from a page rather than the map
 *   19.076090,72.877426           no space
 *   N19.076 E72.877               some GPS exports
 *
 * Degrees-minutes-seconds is deliberately *not* accepted. It is rare in this
 * workflow and parsing it silently wrong is worse than saying "I cannot read
 * this" — a decimal misread as DMS lands the pin a hundred kilometres away.
 *
 * @param {string} raw
 * @returns {{lat:number, lng:number}|null}
 */
function parseLatLngPair(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (/\d\s*°\s*\d+\s*['′]/.test(s)) return null;          // looks like DMS — refuse rather than guess

  // Hemisphere letters carry the sign; strip them and remember what they said.
  let latSign = 1, lngSign = 1;
  s = s.replace(/([NSEW])/gi, (m, d) => {
    const u = d.toUpperCase();
    if (u === 'S') latSign = -1;
    if (u === 'W') lngSign = -1;
    return ' ';
  });
  s = s.replace(/[°º]/g, ' ');

  const nums = s.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 2) return null;
  const lat = parseFloat(nums[0]), lng = parseFloat(nums[1]);
  if (isNaN(lat) || isNaN(lng)) return null;
  // A hemisphere letter overrides the sign rather than multiplying it, so
  // "-19.07 S" is 19.07 south and not accidentally north.
  return {
    lat: latSign < 0 ? -Math.abs(lat) : lat,
    lng: lngSign < 0 ? -Math.abs(lng) : lng,
  };
}

/** Format for the template / export. Six decimals ≈ 0.1 m, well past what a map needs. */
const formatLatLng = (lat, lng) => Number(lat).toFixed(6) + ', ' + Number(lng).toFixed(6);

/**
 * Does this pair look like it was entered the wrong way round?
 *
 * Two strengths of evidence, kept apart because they deserve different
 * treatment. A latitude outside ±90 is not a judgement call — it cannot be a
 * latitude. The regional test is a heuristic: India spans roughly 6–37 N and
 * 68–98 E, and those ranges barely overlap, so `72.8, 19.0` is almost certainly
 * reversed. The first is offered as a fix; the second only as a question.
 *
 * @param {number} lat @param {number} lng
 * @returns {'certain'|'likely'|null}
 */
function looksSwapped(lat, lng) {
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) return 'certain';
  const inIndiaLat = v => v >= 6 && v <= 37;
  const inIndiaLng = v => v >= 68 && v <= 98;
  if (!inIndiaLat(lat) && inIndiaLng(lat) && inIndiaLat(lng) && !inIndiaLng(lng)) return 'likely';
  return null;
}

/** Great-circle distance in metres — used to spot a row far from the others. */
function haversineM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* ---------------------------------------------------------------------------
 * Parsing a grid into records
 * ------------------------------------------------------------------------- */

/**
 * Map the header row onto known columns.
 * @param {string[]} header
 * @returns {{map:Object<string,number>, unknown:string[]}}
 */
function mapSheetHeaders(header) {
  const map = {};
  const unknown = [];
  header.forEach((h, i) => {
    const n = normHeader(h);
    if (!n) return;
    const hit = Object.keys(SHEET_COLUMNS).find(k => SHEET_COLUMNS[k].aliases.indexOf(n) >= 0);
    if (hit && map[hit] === undefined) map[hit] = i;
    else if (!hit) unknown.push(h);
  });
  return { map, unknown };
}

/**
 * Turn a grid into records, with per-row problems attached.
 *
 * Everything here is a *judgement about one row in isolation*; anything that
 * needs to compare rows (duplicate names, unresolved route targets, outliers)
 * belongs to validateImport so that the two stay separable and testable.
 *
 * @param {string[][]} grid Row 0 is the header.
 * @returns {{ok:boolean, error?:string, columns?:object, records?:object[]}}
 */
function parseSheetGrid(grid) {
  if (!grid || !grid.length) return { ok: false, error: 'That file has no rows in it.' };
  const { map, unknown } = mapSheetHeaders(grid[0]);

  if (map.name === undefined) {
    return {
      ok: false,
      error: 'No “Name” column found. The first row of the sheet has to be the header row — ' +
        'download the template if you are not sure of the wording.',
    };
  }
  if (map.coords === undefined && (map.lat === undefined || map.lng === undefined)) {
    return {
      ok: false,
      error: 'No coordinates column found. Use one “Lat, Long” column, or separate ' +
        '“Latitude” and “Longitude” columns.',
    };
  }

  const records = grid.slice(1).map((row, i) => {
    const cell = k => (map[k] === undefined ? '' : String(row[map[k]] || '').trim());
    const rec = {
      row: i + 2,                                  // 1-based, and the header is row 1
      name: cell('name'),
      rawCoords: '',
      type: sheetTypeToLoc(cell('type')),
      typeGiven: cell('type'),
      routeTo: cell('routeTo'),
      mode: sheetModeToProfile(cell('mode')),
      modeGiven: cell('mode'),
      lat: null, lng: null,
      errors: [], warnings: [], fixes: [],
    };

    if (map.coords !== undefined) {
      rec.rawCoords = cell('coords');
    } else {
      const la = cell('lat'), ln = cell('lng');
      rec.rawCoords = (la && ln) ? la + ', ' + ln : (la || ln);
    }

    if (!rec.name) rec.errors.push('No name.');
    if (rec.name.length > 34) rec.warnings.push('Long name — the map label will be wide.');

    if (!rec.rawCoords) {
      rec.errors.push('No coordinates.');
    } else {
      const p = parseLatLngPair(rec.rawCoords);
      if (!p) {
        rec.errors.push('Cannot read “' + rec.rawCoords + '” as a latitude and longitude.');
      } else {
        rec.lat = p.lat; rec.lng = p.lng;
        const swap = looksSwapped(p.lat, p.lng);
        if (swap === 'certain') {
          rec.errors.push('Latitude ' + p.lat.toFixed(4) + ' is outside ±90 — the two values are the wrong way round.');
          rec.fixes.push('swap');
        } else if (swap === 'likely') {
          rec.warnings.push('These look reversed — that would put it outside India.');
          rec.fixes.push('swap');
        } else if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
          rec.errors.push('Coordinates out of range.');
        } else if (p.lat === 0 && p.lng === 0) {
          rec.errors.push('0, 0 is in the Atlantic — this row is probably empty.');
        }
      }
    }

    if (rec.typeGiven && !/^(site|location|pin|highway badge|badge|hwy|hwy badge|highway|shield|subject|property)$/i
      .test(rec.typeGiven.trim())) {
      rec.warnings.push('Type “' + rec.typeGiven + '” not recognised — treated as Location.');
    }
    if (rec.modeGiven && !/^(car|drive|driving|bike|cycle|cycling|walk|foot|walking|pedestrian)$/i
      .test(rec.modeGiven.trim())) {
      rec.warnings.push('Mode “' + rec.modeGiven + '” not recognised — treated as Car.');
    }

    // Snapshot the problems that belong to this row alone. Cross-row checks run
    // repeatedly — after an inline fix, or when the map underneath changes —
    // and rebuild from this baseline, so a resolved problem cannot leave its
    // message behind and a re-run cannot report the same thing twice.
    rec.baseErrors = rec.errors.slice();
    rec.baseWarnings = rec.warnings.slice();
    return rec;
  }).filter(r => r.name || r.rawCoords);        // drop wholly blank rows silently

  if (!records.length) return { ok: false, error: 'The sheet has a header but no data rows.' };
  return { ok: true, columns: map, unknown, records };
}

/* ---------------------------------------------------------------------------
 * Cross-row validation
 * ------------------------------------------------------------------------- */

/** Comparable form of a name, so "Ring Road " matches "ring road". */
const nameKey = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Check the sheet as a whole and produce the summary the review dialog shows.
 *
 * @param {object[]} records From parseSheetGrid.
 * @param {object[]} [existing] Locations already on the map, so a route can
 *                              target one of them when importing additively.
 * @returns {object} summary
 */
function validateImport(records, existing) {
  // Rebuild from the per-row baseline so this is safe to run again after a fix.
  records.forEach(r => {
    r.errors = (r.baseErrors || []).slice();
    r.warnings = (r.baseWarnings || []).slice();
  });

  const byName = {};
  records.forEach(r => {
    const k = nameKey(r.name);
    if (!k) return;
    (byName[k] = byName[k] || []).push(r);
  });

  // Duplicate names matter because they are how routes are addressed and how
  // the Key-distances legend reads — two rows called "Highway" make both
  // meaningless. But only the *later* rows are rejected. Failing all of them
  // would let one stray paste take out the original as well, and then every
  // route pointing at that name, which is one mistake turning into four. First
  // occurrence wins, which is also what someone building the sheet expects.
  Object.keys(byName).forEach(k => {
    byName[k].slice(1).forEach(r =>
      r.errors.push('Duplicate of “' + byName[k][0].name + '” on row ' + byName[k][0].row + '.'));
  });

  const existingNames = {};
  (existing || []).forEach(l => { existingNames[nameKey(l.name)] = l; });

  const good = () => records.filter(r => !r.errors.length);

  // Route targets: resolvable against this sheet first, then against the map.
  records.forEach(r => {
    r.routeTarget = null;
    if (!r.routeTo) return;
    const k = nameKey(r.routeTo);
    if (k === nameKey(r.name)) { r.errors.push('“Route to” points at this same row.'); return; }
    if (byName[k]) {
      // The first row with that name is the one that will be imported, so it is
      // also the one a route must point at.
      const target = byName[k][0];
      r.routeTarget = { kind: 'row', rec: target };
      if (target.errors.length) {
        // Downgraded to a warning on purpose: this row's own data is fine, and
        // importing the location without its route is better than losing both.
        r.routeTarget = null;
        r.warnings.push('No route drawn — “' + r.routeTo + '” is being skipped.');
      }
      return;
    }
    if (existingNames[k]) { r.routeTarget = { kind: 'existing', loc: existingNames[k] }; return; }
    r.errors.push('“Route to: ' + r.routeTo + '” does not match any row in the sheet.');
  });

  // Outliers: a row far from the cluster is nearly always a dropped digit.
  // Measured against the median point rather than the mean so that one bad row
  // cannot drag the centre out to meet itself.
  const pts = good().filter(r => r.lat != null);
  if (pts.length >= 4) {
    const lats = pts.map(p => p.lat).sort((a, b) => a - b);
    const lngs = pts.map(p => p.lng).sort((a, b) => a - b);
    const mid = { lat: lats[lats.length >> 1], lng: lngs[lngs.length >> 1] };
    const d = pts.map(p => haversineM(mid, p)).sort((a, b) => a - b);
    const median = d[d.length >> 1] || 1;
    pts.forEach(p => {
      const dist = haversineM(mid, p);
      // Ten times the typical spread, and at least 50 km, before saying anything.
      if (dist > Math.max(50000, median * 10)) {
        p.warnings.push('This is ' + (dist / 1000).toFixed(0) + ' km from the others — check the coordinates.');
      }
    });
  }

  // Two rows on the same spot: legal, but almost always a copy-paste slip.
  const seen = {};
  good().forEach(r => {
    if (r.lat == null) return;
    const k = r.lat.toFixed(5) + '/' + r.lng.toFixed(5);
    if (seen[k]) r.warnings.push('Same coordinates as “' + seen[k].name + '”.');
    else seen[k] = r;
  });

  const sites = records.filter(r => r.type === 'site' && !r.errors.length);
  if (sites.length > 1) {
    sites.slice(1).forEach(r => r.warnings.push('More than one row is marked Site.'));
  }

  const ready = good();
  const withRoutes = ready.filter(r => r.routeTarget);
  const extent = ready.length && ready[0].lat != null ? extentOf(ready) : null;

  return {
    records,
    total: records.length,
    ready: ready.length,
    skipped: records.length - ready.length,
    warned: ready.filter(r => r.warnings.length).length,
    routes: withRoutes.length,
    sites: sites.length,
    extent,
    fixable: records.filter(r => r.fixes.indexOf('swap') >= 0).length,
  };
}

/**
 * Bounding box and span of a set of records — the one line that makes a whole
 * sheet checkable at a glance ("20 points spanning 6.4 km").
 * @param {object[]} recs
 */
function extentOf(recs) {
  const pts = recs.filter(r => r.lat != null);
  if (!pts.length) return null;
  let n = -90, s = 90, e = -180, w = 180;
  pts.forEach(p => {
    n = Math.max(n, p.lat); s = Math.min(s, p.lat);
    e = Math.max(e, p.lng); w = Math.min(w, p.lng);
  });
  const span = haversineM({ lat: s, lng: w }, { lat: n, lng: e });
  return { north: n, south: s, east: e, west: w, span, centre: { lat: (n + s) / 2, lng: (e + w) / 2 } };
}

/**
 * Apply the "swap latitude and longitude" fix to every row that offered it.
 *
 * The baseline is edited rather than the derived list, so the next
 * validateImport() cannot resurrect the message the swap just resolved.
 */
function swapFlaggedRows(records) {
  let n = 0;
  const stale = /wrong way round|out of range|look reversed/;
  records.forEach(r => {
    if (r.fixes.indexOf('swap') < 0 || r.lat == null) return;
    const t = r.lat; r.lat = r.lng; r.lng = t;
    r.rawCoords = formatLatLng(r.lat, r.lng);
    r.baseErrors = (r.baseErrors || []).filter(e => !stale.test(e));
    r.baseWarnings = (r.baseWarnings || []).filter(w => !stale.test(w));
    r.fixes = r.fixes.filter(f => f !== 'swap');
    n++;
  });
  return n;
}

/* ---------------------------------------------------------------------------
 * The template
 * ------------------------------------------------------------------------- */

/** Header row shared by the template, the export and the reader. */
const SHEET_HEADER = ['Name', 'Lat, Long', 'Type', 'Route to', 'Mode'];

/** How many rows of dropdowns to pre-arm in the template. */
const TEMPLATE_ROWS = 200;

/** The "How to use" sheet — kept in the workbook so it travels with the file. */
const TEMPLATE_HELP = [
  ['Map Studio — location import template'],
  [''],
  ['Fill in the Locations sheet, then import it with Settings → Import locations.'],
  ['Nothing is added to your map until you have seen the check report.'],
  [''],
  ['Name', 'Required. Must be unique — routes and the distance legend refer to it.'],
  ['Lat, Long', 'Required. Paste straight from Google Maps: right-click a point → click the coordinates to copy.'],
  ['', 'Examples that all work:  19.076090, 72.877426   ·   19.0760° N, 72.8774° E   ·   19.076090 72.877426'],
  ['Type', 'Location (default), Site, or Highway badge. Mark the property itself as Site.'],
  ['Route to', 'Leave blank for no route. Otherwise pick another row’s name — a road route is drawn between the two.'],
  ['Mode', 'Car (default), Bike or Walk. Only used when Route to is filled in.'],
  [''],
  ['Tips'],
  ['', 'The Type, Route to and Mode cells are dropdowns — click the cell and pick.'],
  ['', 'Rows with a problem are listed in the report and skipped; the rest still import.'],
  ['', 'You can export your current map back to this same layout, edit it, and import it again.'],
];

/**
 * Build the workbook: a data sheet and a help sheet.
 * @param {Array<Array<string>>} [rows] Data rows; omitted for a blank template.
 * @returns {Promise<Blob>}
 */
function buildSheetWorkbook(rows) {
  const data = [SHEET_HEADER].concat(rows && rows.length ? rows : [
    ['Sunrise Estate', '19.076090, 72.877426', 'Site', '', ''],
    ['Chhatrapati Shivaji Airport', '19.089560, 72.865614', 'Location', 'Sunrise Estate', 'Car'],
    ['Bandra Kurla Complex', '19.066523, 72.868622', 'Location', 'Sunrise Estate', 'Car'],
  ]);
  const last = Math.max(data.length, TEMPLATE_ROWS);

  return writeXlsx([
    {
      name: 'Locations',
      rows: data,
      widths: [30, 26, 16, 30, 10],
      freezeHeader: true,
      validations: [
        { col: 2, rows: [2, last], list: ['Location', 'Site', 'Highway badge'] },
        // The list *is* the Name column, so "Route to" offers the other rows.
        // A name picked from a list cannot differ from the row it refers to by
        // a stray space, which is the whole failure mode this avoids.
        { col: 3, rows: [2, last], formula: '$A$2:$A$' + last },
        { col: 4, rows: [2, last], list: ['Car', 'Bike', 'Walk'] },
      ],
    },
    { name: 'How to use', rows: TEMPLATE_HELP, widths: [18, 96] },
  ]);
}

/** Current map → template rows, for the round trip. */
function currentMapAsSheetRows() {
  const nameOf = id => {
    const l = (typeof locations !== 'undefined' ? locations : []).find(x => x.id === id);
    return l ? l.name : '';
  };
  // A location's outgoing route, if it has one. Where a location is the target
  // of several routes the sheet still round-trips, because each route is
  // written on the row it starts from.
  const outgoing = {};
  (typeof routes !== 'undefined' ? routes : []).forEach(r => {
    if (!outgoing[r.fromId]) outgoing[r.fromId] = r;
  });

  // realLocations(), not locations: routing anchors are scaffolding and must
  // never reach a spreadsheet somebody sends to a client.
  return (typeof realLocations === 'function' ? realLocations() : []).map(l => {
    const rt = outgoing[l.id];
    return [
      l.name,
      formatLatLng(l.lat, l.lng),
      LOC_TYPE_LABEL[l.type] || 'Location',
      rt ? nameOf(rt.toId) : '',
      rt ? (MODE_LABEL[rt.mode] || 'Car') : '',
    ];
  });
}

/* ---------------------------------------------------------------------------
 * Reading a file of any supported kind
 * ------------------------------------------------------------------------- */

/**
 * Read a picked file into a grid.
 * @param {File} file
 * @returns {Promise<string[][]>}
 */
async function readSheetFile(file) {
  const name = String(file.name || '').toLowerCase();
  if (/\.(xlsx|xlsm)$/.test(name)) {
    return readXlsx(await file.arrayBuffer());
  }
  if (/\.xls$/.test(name)) {
    throw new Error('That is the old .xls format. Open it in Excel and save as .xlsx or .csv.');
  }
  return parseCsv(await file.text());
}

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SHEET_COLUMNS, SHEET_HEADER, normHeader, sheetTypeToLoc, sheetModeToProfile,
    parseLatLngPair, formatLatLng, looksSwapped, haversineM,
    mapSheetHeaders, parseSheetGrid, validateImport, extentOf, swapFlaggedRows, nameKey,
  };
}
