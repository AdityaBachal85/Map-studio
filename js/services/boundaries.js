/**
 * services/boundaries.js — the real outline of a named place.
 *
 * "Airoli" is not a point. It is a suburb with an edge, and a property brief
 * that shows a pin where the locality should be is answering a different
 * question from the one being asked. This fetches the administrative boundary
 * OpenStreetMap holds for a place and hands back a polygon.
 *
 * WHY NOT GOOGLE. Asked for, and it genuinely cannot do this. The Geocoding
 * and Places APIs return a *viewport* — an axis-aligned rectangle around the
 * place — which is not a boundary and looks obviously wrong drawn over a
 * coastline or a curved village edge. Google does hold the real outlines, but
 * exposes them only through data-driven styling in the Maps JavaScript SDK,
 * which *paints* a boundary onto a Google vector map and never hands over the
 * coordinates. There is nothing to put in a Leaflet layer, nothing to save into
 * a project, and nothing to export to PowerPoint. A rectangle is the most
 * Google can give, so Google is not in this chain.
 *
 * WHY TWO PROVIDERS. Nominatim alone was one donated service with no fallback,
 * and when a browser could not reach it — corporate DNS, an ad blocker, its own
 * rate limiter — the feature was simply dead with a network error. Geoapify
 * serves the same OpenStreetMap boundary data over a keyed endpoint this app
 * already talks to successfully for search and reverse geocoding, so it is the
 * primary; Nominatim stays as the fallback for anything Geoapify has not
 * imported. Two independent hosts, one of which is already proven reachable.
 *
 * WHAT NEITHER CAN DO, and the UI must say so rather than fail quietly:
 * plenty of places exist in OSM only as a node. A village, a new township, an
 * informal neighbourhood — all real places, none with an outline anyone has
 * drawn. `ok:false, reason:'no-polygon'` is a normal answer here, not an
 * error, and it is far more common in India than in Europe.
 *
 * NOMINATIM'S USAGE POLICY IS A CONDITION, NOT A SUGGESTION. It is a donated
 * service, and the published limits are one request per second and no bulk
 * work. So: one place at a time, driven by a click, results cached for a week,
 * and an in-flight guard so an impatient double-click is one request. A
 * boundary does not move; asking twice is waste.
 */

const BOUNDARY_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const BOUNDARY_GEOAPIFY_ENDPOINT = 'https://api.geoapify.com/v1/boundaries/part-of';

/**
 * Geoapify's simplification level, named for the viewport width the geometry is
 * meant to survive. `geometry_5000` is a boundary that still reads correctly on
 * a 5000-pixel canvas — more than any screen here, and enough that a PowerPoint
 * export at full-slide width does not show the corners being cut.
 */
const BOUNDARY_GEOAPIFY_DETAIL = 'geometry_5000';

/** Bumped from v1: entries now carry a provider, and old ones lack it. */
const BOUNDARY_CACHE_KEY = 'dbot.boundaryCache.v2';
const BOUNDARY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Simplification tolerance in degrees, passed to Nominatim as
 * polygon_threshold. Roughly 20 m at this latitude.
 *
 * A raw municipal boundary can carry tens of thousands of vertices — enough to
 * make dragging the map stutter and to bloat a saved project past what
 * localStorage will hold. At this tolerance a suburb comes back in the low
 * hundreds of points and is visually identical at any zoom anyone will use it
 * at. Ask for less detail than you can see and nobody notices; ask for all of
 * it and everything gets slower for a difference nothing renders.
 */
const BOUNDARY_SIMPLIFY_DEG = 0.0002;

/** Requests in flight, so a double-click is one request. */
const _boundaryPending = new Map();

/** @returns {object} the cache object, or an empty one */
function boundaryCacheRead() {
  try { return JSON.parse(localStorage.getItem(BOUNDARY_CACHE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}

/** @param {string} key @param {object} value */
function boundaryCacheWrite(key, value) {
  try {
    const all = boundaryCacheRead();
    all[key] = { at: Date.now(), value };
    // A boundary is a few hundred coordinate pairs; a dozen of them is already
    // a meaningful slice of a 5 MB budget shared with the autosaved project.
    const keys = Object.keys(all);
    if (keys.length > 24) {
      keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
      keys.slice(0, keys.length - 24).forEach(k => delete all[k]);
    }
    localStorage.setItem(BOUNDARY_CACHE_KEY, JSON.stringify(all));
  } catch (e) { /* quota or private mode — the network still works */ }
}

/** @param {string} key @returns {object|null} */
function boundaryCacheGet(key) {
  const hit = boundaryCacheRead()[key];
  if (!hit || (Date.now() - (hit.at || 0)) > BOUNDARY_CACHE_TTL_MS) return null;
  return hit.value;
}

/**
 * Turn a GeoJSON Polygon or MultiPolygon into Leaflet's latlng nesting.
 *
 * GeoJSON is [lng, lat]; Leaflet is [lat, lng]. Getting this backwards puts
 * Navi Mumbai in the Indian Ocean, which at least fails visibly — but only if
 * someone is looking at the right part of the world.
 *
 * @param {object} geojson @returns {Array|null} rings, or null if unusable
 */
function boundaryToLatLngs(geojson) {
  if (!geojson || !geojson.coordinates) return null;
  const flip = ring => ring.map(p => [p[1], p[0]]);

  if (geojson.type === 'Polygon') {
    // [outer, ...holes] — Leaflet reads the same nesting, so holes survive.
    return geojson.coordinates.map(flip);
  }
  if (geojson.type === 'MultiPolygon') {
    return geojson.coordinates.map(poly => poly.map(flip));
  }
  return null;
}

/** @param {Array} latlngs @returns {number} total vertex count, at any nesting */
function boundaryPointCount(latlngs) {
  if (!Array.isArray(latlngs)) return 0;
  if (latlngs.length && typeof latlngs[0][0] === 'number') return latlngs.length;
  return latlngs.reduce((n, x) => n + boundaryPointCount(x), 0);
}

/* ---------------------------------------------------------------------------
 * Geoapify — the primary provider
 * ------------------------------------------------------------------------ */

/** @param {object} f a GeoJSON feature @returns {object} its OSM passthrough */
function boundaryRawOf(f) {
  const p = (f && f.properties) || {};
  return (p.datasource && p.datasource.raw) || {};
}

/**
 * How local a boundary is, higher being more local.
 *
 * `part-of` answers with every administrative area containing the point —
 * country, state, district, city, ward — and the one somebody means when they
 * click a village is the innermost, not the first in the array. OSM's
 * admin_level already ranks exactly this (2 country … 10 suburb), so use it
 * when it survived the import and fall back to the category taxonomy when it
 * did not.
 *
 * @param {object} f @returns {number}
 */
function boundarySpecificity(f) {
  const lvl = Number(boundaryRawOf(f).admin_level);
  if (isFinite(lvl) && lvl > 0) return lvl;

  const cats = (((f && f.properties && f.properties.categories) || [])).join(' ');
  if (/suburb|neighbourhood|neighborhood|quarter|village|hamlet|ward/.test(cats)) return 10;
  if (/city|town|municipal/.test(cats)) return 8;
  if (/county|district/.test(cats)) return 6;
  if (/state|province|region/.test(cats)) return 4;
  if (/country/.test(cats)) return 2;
  return 7;   // unknown: between a city and a district, so it never wins a tie outright
}

/**
 * Bounding-box area in square degrees — the tie-breaker when two areas claim
 * the same admin_level, which happens when a village and its gram panchayat are
 * both level 8. The smaller one is the one that was clicked.
 * @param {object} geom a GeoJSON geometry @returns {number}
 */
function boundarySpan(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = a => {
    if (!Array.isArray(a)) return;
    if (typeof a[0] === 'number') {
      if (a[0] < minX) minX = a[0];
      if (a[0] > maxX) maxX = a[0];
      if (a[1] < minY) minY = a[1];
      if (a[1] > maxY) maxY = a[1];
      return;
    }
    a.forEach(walk);
  };
  walk(geom && geom.coordinates);
  if (!isFinite(minX)) return Infinity;
  return Math.abs((maxX - minX) * (maxY - minY));
}

/** @param {object} f @returns {string} a human name for the area */
function geoapifyBoundaryLabel(f) {
  const p = (f && f.properties) || {};
  const raw = boundaryRawOf(f);
  const name = p.name || raw['name:en'] || raw.name || p.address_line1
    || p.suburb || p.village || p.city || p.county || p.state || p.formatted || 'Boundary';
  return String(name).split(',')[0].trim();
}

/**
 * A stable identity for the area, so clicking the same village twice does not
 * stack two polygons. Geoapify carries the OSM id through, which keeps the id
 * comparable with whatever Nominatim would have returned for the same place.
 * @param {object} f @returns {string|null}
 */
function geoapifyBoundaryId(f) {
  const raw = boundaryRawOf(f);
  if (raw.osm_id) {
    const t = String(raw.osm_type || 'relation').toLowerCase()[0];
    return (t === 'w' ? 'way' : t === 'n' ? 'node' : 'relation') + '/' + raw.osm_id;
  }
  const pid = f && f.properties && f.properties.place_id;
  return pid ? 'geoapify/' + pid : null;
}

/**
 * The innermost administrative area containing a point, from Geoapify.
 *
 * One request answers both halves of the question — which place is here, and
 * what shape is it — the same way Nominatim's reverse does, so a click never
 * costs two round trips.
 *
 * @param {number} lat @param {number} lng
 * @returns {Promise<object>} a normalised result, ok or not
 */
async function geoapifyBoundaryAt(lat, lng) {
  if (typeof GEOAPIFY_API_KEY !== 'string' || !GEOAPIFY_API_KEY) {
    return { ok: false, reason: 'no-provider' };
  }
  const params = new URLSearchParams({
    lon: String(lng),
    lat: String(lat),
    geometry: BOUNDARY_GEOAPIFY_DETAIL,
    apiKey: GEOAPIFY_API_KEY,
  });

  let data;
  try {
    const res = await fetch(BOUNDARY_GEOAPIFY_ENDPOINT + '?' + params.toString(),
      { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return { ok: false, reason: 'http-' + res.status };
    data = await res.json();
  } catch (e) {
    return { ok: false, reason: 'network' };
  }

  const all = (data && Array.isArray(data.features)) ? data.features : [];
  const drawable = all.filter(f => f && f.geometry
    && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));

  if (!drawable.length) {
    // A point inside a country but inside no imported outline is a real answer,
    // not a failure — and it is the common case for a new township.
    return all.length
      ? { ok: false, reason: 'no-polygon', label: geoapifyBoundaryLabel(all[0]) }
      : { ok: false, reason: 'not-found' };
  }

  drawable.sort((a, b) =>
    boundarySpecificity(b) - boundarySpecificity(a)
    || boundarySpan(a.geometry) - boundarySpan(b.geometry));

  const best = drawable[0];
  const latlngs = boundaryToLatLngs(best.geometry);
  if (!latlngs) return { ok: false, reason: 'no-polygon' };

  return {
    ok: true,
    latlngs,
    label: geoapifyBoundaryLabel(best),
    points: boundaryPointCount(latlngs),
    osm: geoapifyBoundaryId(best),
    provider: 'Geoapify',
  };
}

/**
 * Which of several failures to show the user.
 *
 * A definite answer beats a transport failure: if Geoapify says the place has
 * no outline and Nominatim could not be reached, "nobody has drawn this" is the
 * true and useful sentence, and "check your connection" would send someone off
 * to debug a network that is working.
 *
 * @param {string[]} reasons @returns {string}
 */
function boundaryWorstReason(reasons) {
  const rank = r => r === 'no-polygon' ? 5
    : r === 'not-found' ? 4
    : String(r).startsWith('http-') ? 3
    : r === 'network' ? 2 : 1;
  return reasons.slice().sort((a, b) => rank(b) - rank(a))[0] || 'network';
}

/**
 * Nominatim, searched by name — the fallback half of fetchBoundary().
 *
 * Coordinates are used to bias the search rather than filter it: "Airoli"
 * matches more than one place on earth, and the one being asked about is the
 * one under the pin. Nominatim's `viewbox` without `bounded=1` prefers results
 * in the box while still answering if the true match sits just outside it.
 *
 * @param {string} name @param {number} lat @param {number} lng
 * @returns {Promise<object>} a normalised result, ok or not
 */
async function nominatimBoundaryByName(name, lat, lng) {
  const params = new URLSearchParams({
    q: name,
    format: 'jsonv2',
    polygon_geojson: '1',
    polygon_threshold: String(BOUNDARY_SIMPLIFY_DEG),
    limit: '5',
    addressdetails: '0',
  });
  if (isFinite(lat) && isFinite(lng)) {
    const d = 0.4;   // ~45 km, comfortably around a suburb without excluding it
    params.set('viewbox', [lng - d, lat + d, lng + d, lat - d].join(','));
  }

  let rows;
  try {
    const res = await fetch(BOUNDARY_ENDPOINT + '?' + params.toString(), {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return { ok: false, reason: 'http-' + res.status };
    rows = await res.json();
  } catch (e) {
    return { ok: false, reason: 'network' };
  }
  if (!Array.isArray(rows) || !rows.length) return { ok: false, reason: 'not-found' };

  // Prefer a result that actually has an outline. Nominatim ranks by its own
  // relevance, which puts a well-known node above a lesser-known area — and
  // a node cannot be drawn.
  const withPolygon = rows.filter(r => r.geojson
    && (r.geojson.type === 'Polygon' || r.geojson.type === 'MultiPolygon'));
  if (!withPolygon.length) {
    return { ok: false, reason: 'no-polygon', label: rows[0].display_name || name };
  }

  const best = withPolygon[0];
  const latlngs = boundaryToLatLngs(best.geojson);
  if (!latlngs) return { ok: false, reason: 'no-polygon' };

  return {
    ok: true,
    latlngs,
    label: (best.display_name || name).split(',').slice(0, 2).join(',').trim(),
    points: boundaryPointCount(latlngs),
    adminLevel: (best.address && best.address.admin_level) || best.place_rank || null,
    osm: best.osm_type && best.osm_id ? best.osm_type + '/' + best.osm_id : null,
    provider: 'OpenStreetMap',
  };
}

/**
 * Find the administrative outline of a place.
 *
 * The location's own coordinates are asked first, not its name. A pin dropped
 * inside Muthaval is unambiguous evidence of which Muthaval is meant; the
 * string "Muthaval" is not, and a name search has to guess. The name search
 * stays as the second attempt because it still rescues the case where the pin
 * sits just outside the area it is named for.
 *
 * @param {{name:string, lat:number, lng:number}} place
 * @returns {Promise<{ok:boolean, latlngs?:Array, label?:string, reason?:string,
 *                    points?:number, adminLevel?:string, cached?:boolean}>}
 */
async function fetchBoundary(place) {
  const name = String((place && place.name) || '').trim();
  const lat = Number(place && place.lat), lng = Number(place && place.lng);
  const hasPoint = isFinite(lat) && isFinite(lng);
  if (!name && !hasPoint) return { ok: false, reason: 'no-name' };

  const key = 'named|' + name.toLowerCase() + '|'
    + (hasPoint ? lat.toFixed(2) + ',' + lng.toFixed(2) : '');

  const cached = boundaryCacheGet(key);
  if (cached) return Object.assign({}, cached, { cached: true });
  if (_boundaryPending.has(key)) return _boundaryPending.get(key);

  const job = (async () => {
    const failures = [];
    let label = '';

    for (const attempt of [
      () => hasPoint ? geoapifyBoundaryAt(lat, lng) : { ok: false, reason: 'no-name' },
      () => name ? nominatimBoundaryByName(name, lat, lng) : { ok: false, reason: 'no-name' },
    ]) {
      let r;
      try { r = await attempt(); }
      catch (e) { r = { ok: false, reason: 'network' }; }
      if (r.ok) { boundaryCacheWrite(key, r); return r; }
      failures.push(r.reason);
      label = label || r.label || '';
    }

    const out = { ok: false, reason: boundaryWorstReason(failures), label: label || name };
    // A place with no outline still has no outline tomorrow. A network that was
    // down for one request tells us nothing about the next one, so it is never
    // written — caching it would make one blip look permanent.
    if (out.reason === 'no-polygon' || out.reason === 'not-found') boundaryCacheWrite(key, out);
    return out;
  })();

  _boundaryPending.set(key, job);
  try { return await job; }
  finally { _boundaryPending.delete(key); }
}

/**
 * A sentence for each failure, because "could not fetch boundary" tells nobody
 * whether to retry, rename, or give up.
 * @param {string} reason @param {string} name @returns {string}
 */
function boundaryMessage(reason, name) {
  if (reason === 'no-polygon') {
    return `“${name}” is on the map but nobody has drawn its outline — it exists `
      + 'only as a point. Try a larger area it sits inside, or draw the boundary by hand.';
  }
  if (reason === 'not-found') {
    return `No administrative area was found at “${name}”. Try the name as locals write it, `
      + 'or add the city after it.';
  }
  if (reason === 'network') {
    return 'Could not reach either boundary service (Geoapify or OpenStreetMap). '
      + 'An office firewall or an ad blocker will do this as surely as being offline.';
  }
  if (reason === 'no-provider') {
    return 'No boundary provider is configured — GEOAPIFY_API_KEY is empty in js/config.js.';
  }
  if (reason === 'no-name') return 'Give this location a name first — the boundary is looked up by name.';
  if (String(reason).startsWith('http-')) {
    return 'The boundary service refused the request (' + reason.slice(5) + '). '
      + 'Both providers rate-limit heavy use; wait a moment and try again.';
  }
  return 'The boundary could not be fetched.';
}

/**
 * Where the shape came from, written onto the shape itself rather than left in
 * a status line that scrolls away. It matters once a boundary reaches a client
 * document and someone asks what the dashed line is — and both providers serve
 * OpenStreetMap data, whose licence asks to be credited.
 *
 * @param {object} r a successful boundary result @returns {string}
 */
function boundaryCredit(r) {
  const via = (r && r.provider && r.provider !== 'OpenStreetMap') ? ' via ' + r.provider : '';
  return 'Administrative boundary from OpenStreetMap' + via
    + (r && r.osm && r.osm.indexOf('geoapify/') !== 0 ? ' (' + r.osm + ')' : '');
}

/* ---------------------------------------------------------------------------
 * The Boundary toggle on a location card
 * ------------------------------------------------------------------------ */

/**
 * The boundary shape belonging to a location, if it is on the map.
 * @param {number} locId @returns {object|undefined}
 */
function boundaryForLocation(locId) {
  return geometries.find(g => g.boundaryFor === locId);
}

/**
 * Paint every Boundary button to match what is actually on the map.
 *
 * Called after this file changes anything, and after a shape is removed
 * anywhere else — deleting the polygon from the Draw tab has to leave the
 * button saying "add", or the next click reads as broken.
 */
function syncBoundaryButtons() {
  document.querySelectorAll('.item-card .bnd').forEach(btn => {
    const card = btn.closest('[data-loc-id]');
    const id = card ? +card.getAttribute('data-loc-id') : NaN;
    const on = !!boundaryForLocation(id);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on
      ? "Remove this place's boundary from the map"
      : "Draw this place's real boundary from OpenStreetMap";
  });
}

/**
 * Remove a boundary, and offer it straight back.
 * @param {object} loc @param {object} g the boundary geometry
 */
function removeBoundaryForLocation(loc, g) {
  const name = g.name;
  removeGeomById(g.id);
  syncBoundaryButtons();
  status(`Removed the boundary of ${loc.name || 'this location'}.`, false, {
    label: 'Undo',
    onClick: () => { toggleBoundaryForLocation(loc); },
  });
}

/**
 * Add the boundary, or take it away — one control, both directions.
 *
 * WHY A TOGGLE. The first version added on the first click and, on a second,
 * zoomed to what was already there. That reads as a dead button: the thing you
 * asked for is on screen, you press again to take it off, and the map just
 * moves. Removing it meant finding the polygon in the Draw tab, which is a
 * different pane, a different mental model, and a shape whose name you did not
 * choose. A control that adds a thing should take it away.
 *
 * @param {object} loc a location record
 * @param {HTMLElement} [btn] the button, disabled while a fetch is in flight
 * @returns {Promise<void>}
 */
async function toggleBoundaryForLocation(loc, btn) {
  if (!loc) return;

  const existing = boundaryForLocation(loc.id);
  if (existing) { removeBoundaryForLocation(loc, existing); return; }

  const label = loc.name || 'this location';
  const restore = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Looking…'; }
  status(`Looking up the boundary of ${label}…`, true);

  let r;
  try {
    r = await fetchBoundary({ name: loc.name, lat: loc.lat, lng: loc.lng });
  } catch (e) {
    r = { ok: false, reason: 'network' };
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = restore; }
  }

  if (!r.ok) {
    const msg = boundaryMessage(r.reason, label);
    if (r.reason === 'network' || String(r.reason).startsWith('http-')) {
      status(msg, true, { label: 'Try again', onClick: () => { toggleBoundaryForLocation(loc, btn); } });
    } else {
      status(msg, true);
    }
    return;
  }

  // The location's own colour when it has been given one, so a boundary reads
  // as belonging to its pin. The default navy is skipped: it is the palette's
  // "unset", and near-invisible as a hairline over dark satellite imagery.
  const accent = (loc.color && loc.color !== '#0A1E3C') ? loc.color : '#FF7A1A';

  let layer;
  try {
    layer = L.polygon(r.latlngs);
  } catch (e) {
    status('That boundary came back in a shape this map could not draw.', true);
    return;
  }

  // 'Polygon' with a capital P: SHAPE_LABEL and the per-shape counters in
  // drawing.js key off these exact strings, and an unrecognised one names the
  // shape after itself.
  const g = registerGeom(layer, 'Polygon', {
    name: r.label || label,
    description: boundaryCredit(r),
    // Outline, not fill: it frames the site rather than burying it, which is
    // how a boundary is drawn on every planning document this will sit beside.
    // Property names taken from defaultGeomStyle() — borderColor, not stroke.
    borderColor: accent,
    borderWidth: 2.5,
    lineStyle: 'dashed',
    fillColor: accent,
    fillOpacity: 0.06,
    corner: 'round',
    // Which location this belongs to, so the toggle can find it again.
    // Survives save/load with the rest of the geometry.
    boundaryFor: loc.id,
    boundaryOsm: r.osm || null,
    boundaryLabel: r.label || null,
  });

  syncBoundaryButtons();
  try { map.fitBounds(layer.getBounds(), { padding: [40, 40] }); } catch (e) { /* degenerate ring */ }

  // Counted off the layer, not the response: GeoJSON rings repeat their first
  // point to close, Leaflet drops it, and quoting the raw figure would put a
  // number in front of someone that the shape does not have.
  let drawn = 0;
  try {
    const walk = a => Array.isArray(a) ? (a[0] && a[0].lat !== undefined ? a.length : a.reduce((n, x) => n + walk(x), 0)) : 0;
    drawn = walk(layer.getLatLngs());
  } catch (e) { drawn = r.points || 0; }

  const cached = r.cached ? ' (from cache)' : '';
  status(`Added the boundary of ${r.label || label} — ${drawn} points${cached}. `
    + 'Press Boundary again to remove it, or restyle it in the Draw tab.');
}

/**
 * Keep the buttons honest when a shape is removed elsewhere.
 *
 * Wrapping rather than editing drawing.js: that file owns shapes and knows
 * nothing about boundaries, and it should stay that way. Same composition the
 * project bridge uses over autosaveNow() — if this file is absent, removal
 * behaves exactly as it always did.
 */
(function watchGeomRemoval() {
  if (typeof removeGeomById !== 'function') return;
  const original = removeGeomById;
  // eslint-disable-next-line no-global-assign
  removeGeomById = function boundaryAwareRemoveGeomById(id) {
    const out = original.apply(this, arguments);
    try { syncBoundaryButtons(); } catch (e) { /* never block a delete */ }
    return out;
  };
})();

/* ---------------------------------------------------------------------------
 * Click the map, see the boundary
 * ------------------------------------------------------------------------ */

const BOUNDARY_REVERSE_ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';

/**
 * Zoom level Nominatim resolves a click to.
 *
 * Its `zoom` is a granularity, not a map zoom: 18 is a building, 16 a street,
 * 14 a suburb or neighbourhood, 10 a city. 14 is the level a property brief
 * actually talks about — "Airoli", not "Plot 42" and not "Navi Mumbai" — and
 * it is the one whose edge people picture when they say boundary.
 */
const BOUNDARY_REVERSE_ZOOM = 14;

/**
 * The outline of whatever locality contains a point.
 *
 * One request, not two: reverse geocoding with polygon_geojson returns the
 * matched feature *and* its geometry together, so a click does not have to
 * resolve a name and then go looking for its shape.
 *
 * @param {number} lat @param {number} lng
 * @returns {Promise<{ok:boolean, latlngs?:Array, label?:string, reason?:string,
 *                    points?:number, osm?:string, cached?:boolean}>}
 */
async function nominatimBoundaryAt(lat, lng) {
  const params = new URLSearchParams({
    lat: String(lat), lon: String(lng),
    format: 'jsonv2',
    zoom: String(BOUNDARY_REVERSE_ZOOM),
    polygon_geojson: '1',
    polygon_threshold: String(BOUNDARY_SIMPLIFY_DEG),
  });

  let row;
  try {
    const res = await fetch(BOUNDARY_REVERSE_ENDPOINT + '?' + params.toString(),
      { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return { ok: false, reason: 'http-' + res.status };
    row = await res.json();
  } catch (e) {
    return { ok: false, reason: 'network' };
  }
  if (!row || row.error) return { ok: false, reason: 'not-found' };

  const latlngs = boundaryToLatLngs(row.geojson);
  if (!latlngs) {
    return { ok: false, reason: 'no-polygon', label: row.name || row.display_name || 'that place' };
  }

  return {
    ok: true,
    latlngs,
    label: (row.name || row.display_name || 'Boundary').split(',')[0].trim(),
    points: boundaryPointCount(latlngs),
    osm: row.osm_type && row.osm_id ? row.osm_type + '/' + row.osm_id : null,
    provider: 'OpenStreetMap',
  };
}

async function fetchBoundaryAt(lat, lng) {
  if (!isFinite(lat) || !isFinite(lng)) return { ok: false, reason: 'no-name' };

  // Coarse key: two clicks a few metres apart are the same locality, and
  // asking twice for the same suburb is exactly the waste the cache exists to
  // prevent. ~1 km at this latitude.
  const key = 'at|' + lat.toFixed(2) + ',' + lng.toFixed(2);
  const cached = boundaryCacheGet(key);
  if (cached) return Object.assign({}, cached, { cached: true });
  if (_boundaryPending.has(key)) return _boundaryPending.get(key);

  const job = (async () => {
    const failures = [];
    let label = '';

    for (const attempt of [
      () => geoapifyBoundaryAt(lat, lng),
      () => nominatimBoundaryAt(lat, lng),
    ]) {
      let r;
      try { r = await attempt(); }
      catch (e) { r = { ok: false, reason: 'network' }; }
      if (r.ok) { boundaryCacheWrite(key, r); return r; }
      failures.push(r.reason);
      label = label || r.label || '';
    }

    const out = { ok: false, reason: boundaryWorstReason(failures), label: label || 'this point' };
    if (out.reason === 'no-polygon' || out.reason === 'not-found') boundaryCacheWrite(key, out);
    return out;
  })();

  _boundaryPending.set(key, job);
  try { return await job; }
  finally { _boundaryPending.delete(key); }
}

/** Whether the map is armed to outline the next place clicked. */
let boundaryPickMode = false;

/**
 * Arm or disarm click-to-outline.
 *
 * Mutually exclusive with click-to-add: two modes both waiting for the same
 * click is a coin toss, and the one that loses feels broken.
 *
 * @param {boolean} on
 */
function setBoundaryPickMode(on) {
  boundaryPickMode = !!on;
  const btn = document.getElementById('boundaryPickBtn');
  if (btn) {
    btn.classList.toggle('toggled', boundaryPickMode);
    btn.lastChild.textContent = boundaryPickMode ? ' Click a place… (Esc)' : ' Click map for a boundary';
  }
  document.getElementById('mapWrap').classList.toggle('picking-boundary', boundaryPickMode);
  if (boundaryPickMode) {
    if (typeof uiState === 'object' && uiState.addingMode && typeof setAdding === 'function') setAdding(false);
    if (typeof disableAllDrawModes === 'function') disableAllDrawModes();
    if (typeof disableAllEditModes === 'function') disableAllEditModes();
    status('Click any place on the map to outline it. Esc to stop.', true);
  }
}

/**
 * Draw the outline of the locality under a click.
 * @param {number} lat @param {number} lng
 */
async function addBoundaryAt(lat, lng) {
  status('Finding the place here…', true);
  let r;
  try { r = await fetchBoundaryAt(lat, lng); }
  catch (e) { r = { ok: false, reason: 'network' }; }

  if (!r.ok) {
    const msg = boundaryMessage(r.reason, r.label || 'this point');
    // A transport failure is the one worth offering back, because the fix is
    // often just waiting a moment. "No outline exists" is not retryable and a
    // button saying otherwise would be a lie.
    if (r.reason === 'network' || String(r.reason).startsWith('http-')) {
      status(msg, true, { label: 'Try again', onClick: () => { addBoundaryAt(lat, lng); } });
    } else {
      status(msg, true);
    }
    return;
  }

  // Already on the map — outlining the same suburb twice stacks identical
  // polygons that only reveal themselves when you delete one. Matched on the
  // area's id where there is one, and on its name otherwise, because the two
  // providers can answer the same click with different ids for the same place.
  const dup = geometries.find(g =>
    (g.boundaryOsm && r.osm && g.boundaryOsm === r.osm)
    || (g.boundaryLabel && r.label && g.boundaryLabel === r.label));
  if (dup) {
    try { map.fitBounds(dup.layer.getBounds(), { padding: [40, 40] }); } catch (e) { /* ignore */ }
    status(`${r.label} is already outlined — ${dup.name}.`);
    return;
  }

  let layer;
  try { layer = L.polygon(r.latlngs); }
  catch (e) { status('That boundary came back in a shape this map could not draw.', true); return; }

  const g = registerGeom(layer, 'Polygon', {
    name: r.label,
    description: boundaryCredit(r),
    borderColor: '#FF7A1A',
    borderWidth: 2.5,
    lineStyle: 'dashed',
    fillColor: '#FF7A1A',
    fillOpacity: 0.06,
    corner: 'round',
    boundaryOsm: r.osm || null,
    boundaryLabel: r.label || null,
  });

  try { map.fitBounds(layer.getBounds(), { padding: [40, 40] }); } catch (e) { /* ignore */ }
  status(`Outlined ${r.label}.`, false, {
    label: 'Undo',
    onClick: () => { removeGeomById(g.id); status('Boundary removed.'); },
  });
}

// Wiring. Kept in this file rather than toolbar.js so the whole feature —
// service, toggle, mode and its one click handler — reads in one place.
(function wireBoundaryPicking() {
  const btn = document.getElementById('boundaryPickBtn');
  if (!btn) return;
  btn.addEventListener('click', () => setBoundaryPickMode(!boundaryPickMode));

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && boundaryPickMode) { setBoundaryPickMode(false); status('Boundary picking off.'); }
  });

  // Click-to-add is armed from toolbar.js on the same event. Its handler
  // returns early unless uiState.addingMode is set, and setBoundaryPickMode
  // clears that, so the two can never both act on one click.
  map.on('click', e => {
    if (!boundaryPickMode) return;
    addBoundaryAt(e.latlng.lat, e.latlng.lng);
  });
})();
