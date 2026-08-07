/**
 * project/importFiles.js — one door for every file a map can arrive in.
 *
 * The Open button used to take .json, .kml and .geojson. That misses the format
 * Google Earth actually saves by default: **.kmz**, which is a zip with a .kml
 * inside it and, in Earth's own Save Place As dialog, the first option. Someone
 * exporting their work from Earth and dragging it here found the file greyed
 * out, with nothing to tell them the fix was to re-export as the second option
 * in a dropdown.
 *
 * So this file routes every format the app can plausibly be handed:
 *
 *   .kmz        Google Earth's default save — unzipped here, then read as KML
 *   .kml        Google Earth, My Maps, most surveying software
 *   .gpx        GPS units, survey walkers, Strava-style tracks
 *   .geojson    GIS tools, and what this app itself exports
 *   .json       a saved Map Studio project — or GeoJSON someone renamed
 *   .csv .tsv .txt   a spreadsheet of places with latitude/longitude columns
 *
 * NOT shapefiles. A .shp is a set of several files that must travel together
 * (.shp/.shx/.dbf/.prj) and carries its own coordinate system to reproject
 * from — that is a real library, not an afternoon, and pretending to support it
 * by reading one file of the set would fail in ways nobody could diagnose.
 * Google Earth Pro converts one to KML in two clicks, which is the better
 * answer until there is demand for the real thing.
 *
 * EXTENSION FIRST, CONTENT SECOND. Routing on the extension keeps failure
 * messages specific — "that is not valid KML" is more use than "could not read
 * that file". But files get renamed, and a browser will hand over a .txt that
 * is plainly XML, so an unrecognised extension falls through to sniffing the
 * first non-blank character rather than refusing outright.
 *
 * ADDITIVE, EXCEPT FOR PROJECTS. A KML carries places and shapes; a project
 * file carries a whole session — basemap, brand, view, everything. So a project
 * replaces the map and everything else merges into it. Losing an afternoon's
 * work to a file someone meant to add is not a recoverable mistake, and the
 * return value says which happened so the caller can say so too.
 */

/** Extensions offered in the file picker, and the ones dispatched below. */
const IMPORT_EXTENSIONS = ['.json', '.geojson', '.kml', '.kmz', '.gpx', '.csv', '.tsv', '.txt'];

/**
 * The `accept` attribute for every import control in the app.
 *
 * MIME types are listed alongside the extensions because macOS Safari and some
 * Android pickers filter on type and ignore the extension list entirely — with
 * extensions alone, a .kmz on an iPad is unselectable.
 */
const IMPORT_ACCEPT = IMPORT_EXTENSIONS.concat([
  'application/json',
  'application/geo+json',
  'application/vnd.google-earth.kml+xml',
  'application/vnd.google-earth.kmz',
  'application/gpx+xml',
  'text/csv',
]).join(',');

/** @param {string} name @returns {string} the lowercased extension, with its dot */
function importExtensionOf(name) {
  const m = /\.[a-z0-9]+$/i.exec(String(name || ''));
  return m ? m[0].toLowerCase() : '';
}

/** @param {File} f @returns {Promise<string>} */
function importReadText(f) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(String(rd.result || ''));
    rd.onerror = () => reject(new Error('unreadable'));
    rd.readAsText(f);
  });
}

/** @param {File} f @returns {Promise<ArrayBuffer>} */
function importReadBuffer(f) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(rd.result);
    rd.onerror = () => reject(new Error('unreadable'));
    rd.readAsArrayBuffer(f);
  });
}

/* ---------------------------------------------------------------------------
 * KMZ — Google Earth's default
 * ------------------------------------------------------------------------ */

/**
 * Unwrap a .kmz and import the KML inside it.
 *
 * A KMZ is a zip whose main document is conventionally `doc.kml` at the root,
 * but the spec only requires that *a* .kml exists, and My Maps exports name it
 * after the map. So: prefer doc.kml, otherwise take the first .kml found, and
 * ignore anything else in the archive.
 *
 * Overlays and custom icons are dropped, deliberately. They are packed inside
 * the zip as images with relative hrefs, and putting them on the map would mean
 * inventing an image-overlay feature this app does not have. The count of what
 * was skipped is returned so the message can say so instead of silently losing
 * half the file.
 *
 * @param {ArrayBuffer} buf
 * @returns {Promise<{locations:number, shapes:number, skipped:number, error?:string}>}
 */
async function importKMZ(buf) {
  if (typeof JSZip === 'undefined') {
    return { locations: 0, shapes: 0, skipped: 0, error: 'KMZ support needs JSZip, which did not load on this page.' };
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (e) {
    return { locations: 0, shapes: 0, skipped: 0, error: 'That .kmz could not be opened — it may be damaged or not really a zip.' };
  }

  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  const kmlNames = names.filter(n => /\.kml$/i.test(n));
  if (!kmlNames.length) {
    return { locations: 0, shapes: 0, skipped: 0, error: 'That .kmz contains no .kml document.' };
  }
  const pick = kmlNames.find(n => /(^|\/)doc\.kml$/i.test(n)) || kmlNames[0];

  let text;
  try {
    text = await zip.files[pick].async('string');
  } catch (e) {
    return { locations: 0, shapes: 0, skipped: 0, error: 'The KML inside that .kmz could not be read.' };
  }

  const r = importKML(text);
  // Images the archive carried that this app has nowhere to put.
  r.skipped = names.filter(n => /\.(png|jpe?g|gif|bmp|tiff?|dae)$/i.test(n)).length;
  return r;
}

/* ---------------------------------------------------------------------------
 * GPX — what a GPS unit or a survey walk produces
 * ------------------------------------------------------------------------ */

/**
 * Import a GPX document.
 *
 * Waypoints become locations for the same reason KML points do: a named
 * waypoint is a place, and places are what routes, legends and exports reason
 * about. Tracks and routes become lines.
 *
 * A track's segments are joined into one line rather than kept separate. A GPX
 * splits a segment wherever the receiver lost its fix, so a walk around a plot
 * boundary can arrive as nine fragments of one perimeter — nine cards in the
 * Draw tab for what the surveyor thinks of as a single line.
 *
 * @param {string} text
 * @returns {{locations:number, shapes:number, error?:string}}
 */
function importGPX(text) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch (e) {
    return { locations: 0, shapes: 0, error: 'That file could not be parsed as XML.' };
  }
  if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagName('gpx').length) {
    return { locations: 0, shapes: 0, error: 'That does not look like a GPX file.' };
  }

  const nameOf = el => {
    const n = el.getElementsByTagName('name')[0];
    return n && n.textContent ? n.textContent.trim() : '';
  };
  const pointsOf = el => Array.from(el.childNodes)
    .filter(n => n.nodeType === 1 && /^(trkpt|rtept)$/.test(n.nodeName))
    .map(n => [parseFloat(n.getAttribute('lat')), parseFloat(n.getAttribute('lon'))])
    .filter(p => isFinite(p[0]) && isFinite(p[1]));

  let nLoc = 0, nShape = 0;

  Array.from(doc.getElementsByTagName('wpt')).forEach(w => {
    const lat = parseFloat(w.getAttribute('lat'));
    const lng = parseFloat(w.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lng)) return;
    addLocation({ lat, lng, name: nameOf(w) || undefined });
    nLoc++;
  });

  const addLine = (pts, name) => {
    if (pts.length < 2) return;
    registerGeom(L.polyline(pts), 'Line', { name: name || undefined });
    nShape++;
  };

  Array.from(doc.getElementsByTagName('trk')).forEach(trk => {
    const pts = [];
    Array.from(trk.getElementsByTagName('trkseg')).forEach(seg => { pts.push.apply(pts, pointsOf(seg)); });
    addLine(pts, nameOf(trk));
  });

  Array.from(doc.getElementsByTagName('rte')).forEach(rte => addLine(pointsOf(rte), nameOf(rte)));

  return { locations: nLoc, shapes: nShape };
}

/* ---------------------------------------------------------------------------
 * Delimited text — a spreadsheet of places
 * ------------------------------------------------------------------------ */

/**
 * Split one delimited line, honouring quotes.
 *
 * Written out rather than `split(delim)` because a place name with a comma in
 * it — "Sector 7, Airoli" — is not exotic, it is what half a real address list
 * looks like, and a naive split shifts every column after it.
 *
 * @param {string} line @param {string} delim @returns {string[]}
 */
function importSplitDelimited(line, delim) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }   // "" is an escaped quote
        else quoted = false;
      } else cur += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === delim) {
      out.push(cur); cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/**
 * Import a CSV/TSV/delimited list of places.
 *
 * The header row is matched against the names people actually use — `lat`,
 * `latitude`, `y`; `lng`, `lon`, `long`, `longitude`, `x` — because requiring
 * one exact spelling means every export needs editing before it can be opened.
 *
 * @param {string} text
 * @returns {{locations:number, shapes:number, error?:string}}
 */
function importDelimited(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 2) return { locations: 0, shapes: 0, error: 'That file has no rows under its header.' };

  // Whichever separator appears more often in the header is the one in use.
  const head = lines[0];
  const delim = (head.split('\t').length > head.split(',').length) ? '\t'
    : (head.split(';').length > head.split(',').length) ? ';' : ',';

  const cols = importSplitDelimited(head, delim).map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
  const find = names => cols.findIndex(c => names.indexOf(c) !== -1);

  const iLat = find(['lat', 'latitude', 'y', 'ycoord']);
  const iLng = find(['lng', 'lon', 'long', 'longitude', 'x', 'xcoord']);
  if (iLat < 0 || iLng < 0) {
    return {
      locations: 0, shapes: 0,
      error: 'No latitude/longitude columns found. The header needs a column called '
        + 'lat (or latitude) and one called lng, lon or longitude.',
    };
  }
  const iName = find(['name', 'title', 'label', 'place', 'location', 'site', 'description']);

  let n = 0, bad = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = importSplitDelimited(lines[i], delim);
    const lat = parseFloat(cells[iLat]), lng = parseFloat(cells[iLng]);
    // Range-checked, not just parsed: a column of plot numbers is full of
    // finite values and would scatter pins across the Atlantic.
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { bad++; continue; }
    addLocation({ lat, lng, name: (iName >= 0 && cells[iName]) || undefined });
    n++;
  }

  if (!n) return { locations: 0, shapes: 0, error: 'No usable coordinates were found in that file.' };
  return { locations: n, shapes: 0, skippedRows: bad };
}

/* ---------------------------------------------------------------------------
 * GeoJSON
 * ------------------------------------------------------------------------ */

/**
 * @param {object} parsed already-parsed JSON
 * @returns {{locations:number, shapes:number, error?:string}}
 */
function importGeoJSONObject(parsed) {
  const features = parsed && parsed.type === 'FeatureCollection' ? (parsed.features || [])
    : (parsed && parsed.type === 'Feature' ? [parsed] : []);
  if (!features.length) return { locations: 0, shapes: 0, error: 'That file holds no GeoJSON features.' };

  let n = 0;
  features.forEach(feat => { if (importGeoJSONFeature(feat)) n++; });
  if (!n) return { locations: 0, shapes: 0, error: 'None of the features in that file could be drawn.' };
  return { locations: 0, shapes: n };
}

/** @param {object} o @returns {boolean} whether this parsed JSON is a saved project */
function importLooksLikeProject(o) {
  return !!(o && typeof o === 'object' && Array.isArray(o.locations));
}

/* ---------------------------------------------------------------------------
 * The one entry point
 * ------------------------------------------------------------------------ */

/**
 * Import any supported file into the current map.
 *
 * @param {File} file
 * @returns {Promise<{ok:boolean, kind:string, locations:number, shapes:number,
 *                    replaced:boolean, skipped?:number, skippedRows?:number,
 *                    error?:string}>}
 */
async function importMapFile(file) {
  const fail = (kind, error) => ({ ok: false, kind, locations: 0, shapes: 0, replaced: false, error });
  if (!file) return fail('', 'No file was chosen.');

  const ext = importExtensionOf(file.name);
  const done = (kind, r) => (r.error
    ? fail(kind, r.error)
    : { ok: true, kind, locations: r.locations || 0, shapes: r.shapes || 0, replaced: false,
        skipped: r.skipped || 0, skippedRows: r.skippedRows || 0 });

  try {
    if (ext === '.kmz') return done('KMZ', await importKMZ(await importReadBuffer(file)));
    if (ext === '.kml') return done('KML', importKML(await importReadText(file)));
    if (ext === '.gpx') return done('GPX', importGPX(await importReadText(file)));
    if (ext === '.geojson') {
      let parsed;
      try { parsed = JSON.parse(await importReadText(file)); }
      catch (e) { return fail('GeoJSON', 'That file is not valid JSON, so it cannot be GeoJSON.'); }
      return done('GeoJSON', importGeoJSONObject(parsed));
    }
    if (ext === '.csv' || ext === '.tsv') return done('CSV', importDelimited(await importReadText(file)));

    if (ext === '.json') {
      // Two very different files share this extension. A saved project replaces
      // the session; GeoJSON someone renamed merges into it.
      let parsed;
      try { parsed = JSON.parse(await importReadText(file)); }
      catch (e) { return fail('project', 'That file is not valid JSON, so it is neither a project nor GeoJSON.'); }
      if (importLooksLikeProject(parsed)) {
        applyProject(parsed);
        return { ok: true, kind: 'project', locations: parsed.locations.length,
          shapes: (parsed.geometries || []).length, replaced: true };
      }
      if (parsed && (parsed.type === 'FeatureCollection' || parsed.type === 'Feature')) {
        return done('GeoJSON', importGeoJSONObject(parsed));
      }
      return fail('project', 'That JSON is neither a Map Studio project nor GeoJSON — it has no locations array and no features.');
    }

    // Unknown or missing extension: read it and decide from what is inside.
    const text = await importReadText(file);
    const first = text.replace(/^﻿/, '').trimStart()[0];
    if (first === '<') {
      if (/<gpx[\s>]/i.test(text)) return done('GPX', importGPX(text));
      return done('KML', importKML(text));
    }
    if (first === '{' || first === '[') {
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (e) { return fail('', 'That file looks like JSON but could not be parsed.'); }
      if (importLooksLikeProject(parsed)) {
        applyProject(parsed);
        return { ok: true, kind: 'project', locations: parsed.locations.length,
          shapes: (parsed.geometries || []).length, replaced: true };
      }
      return done('GeoJSON', importGeoJSONObject(parsed));
    }
    return done('CSV', importDelimited(text));
  } catch (e) {
    return fail('', 'That file could not be read.');
  }
}

/**
 * Import a file and narrate the result, which is what every caller wants.
 *
 * The sentence counts both halves — "4 locations and 2 shapes" — because a KML
 * that imported its pins but dropped its polygons looks identical to a
 * successful import until someone goes looking for the polygons.
 *
 * @param {File} file
 * @returns {Promise<object>} the result from importMapFile
 */
async function importMapFileAndReport(file) {
  const r = await importMapFile(file);

  if (!r.ok) {
    if (typeof status === 'function') status(r.error, true);
    return r;
  }

  if (r.replaced) {
    if (typeof status === 'function') status('Opened “' + file.name + '”.');
    return r;
  }

  const bits = [];
  if (r.locations) bits.push(r.locations + ' location' + (r.locations === 1 ? '' : 's'));
  if (r.shapes) bits.push(r.shapes + ' shape' + (r.shapes === 1 ? '' : 's'));

  if (!bits.length) {
    if (typeof status === 'function') status('Nothing importable was found in that ' + (r.kind || 'file') + '.', true);
    return r;
  }

  let msg = 'Imported ' + bits.join(' and ') + ' from ' + (r.kind || 'that file') + '.';
  if (r.skipped) {
    msg += ' ' + r.skipped + (r.skipped === 1 ? ' image overlay was' : ' image overlays were') + ' skipped.';
  }
  if (r.skippedRows) {
    msg += ' ' + r.skippedRows + (r.skippedRows === 1 ? ' row had' : ' rows had') + ' no usable coordinates.';
  }

  // Fit first, then speak. fitAll() writes its own status line when there is
  // nothing to fit — which is exactly the case for a GeoJSON of pure shapes —
  // and doing it the other way round replaced "Imported 1 shape" with "Nothing
  // to fit yet", so a successful import read as a failure.
  if (typeof fitAll === 'function') fitAll();
  if (typeof status === 'function') status(msg);
  return r;
}

/**
 * Import the file the projects page handed over, if there is one.
 *
 * Saved immediately rather than left to the autosave timer: someone who imports
 * a KML and closes the tab within the minute would otherwise find the project
 * they just created sitting empty, with the file already consumed and no way to
 * get it back short of picking it again.
 *
 * @returns {Promise<void>}
 */
async function runPendingImport() {
  if (typeof importHandoffTake !== 'function') return;

  let file = null;
  try { file = importHandoffTake(); } catch (e) { file = null; }
  if (!file) return;

  const r = await importMapFileAndReport(file);
  if (!r.ok) return;

  if (typeof projectBridgeSave === 'function') {
    try { await projectBridgeSave(); } catch (e) { console.warn('Import: could not save —', e && e.message); }
  }
}
