/**
 * services/boundaries.js — the real outline of a named place.
 *
 * "Airoli" is not a point. It is a suburb with an edge, and a property brief
 * that shows a pin where the locality should be is answering a different
 * question from the one being asked. This fetches the administrative boundary
 * OpenStreetMap holds for a place and hands back a polygon.
 *
 * WHY NOMINATIM. It is the only free source that returns a locality outline
 * for one request with no key. Google's Places API returns a *viewport* — an
 * axis-aligned rectangle around the place — which is not a boundary and looks
 * obviously wrong drawn over a coastline or a curved municipal edge. Overpass
 * can do better but needs a relation id we would have to look up first, which
 * is two round trips to answer one question.
 *
 * WHAT IT CANNOT DO, and the UI must say so rather than fail quietly:
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
const BOUNDARY_CACHE_KEY = 'dbot.boundaryCache.v1';
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

/**
 * Find the administrative outline of a place.
 *
 * Coordinates are used to bias the search rather than filter it: "Airoli"
 * matches more than one place on earth, and the one being asked about is the
 * one under the pin. Nominatim's `viewbox` without `bounded=1` prefers results
 * in the box while still answering if the true match sits just outside it.
 *
 * @param {{name:string, lat:number, lng:number}} place
 * @returns {Promise<{ok:boolean, latlngs?:Array, label?:string, reason?:string,
 *                    points?:number, adminLevel?:string, cached?:boolean}>}
 */
async function fetchBoundary(place) {
  const name = String((place && place.name) || '').trim();
  if (!name) return { ok: false, reason: 'no-name' };

  const lat = Number(place.lat), lng = Number(place.lng);
  const key = name.toLowerCase() + '|' + (isFinite(lat) ? lat.toFixed(2) : '') + ',' + (isFinite(lng) ? lng.toFixed(2) : '');

  const cached = boundaryCacheGet(key);
  if (cached) return Object.assign({}, cached, { cached: true });
  if (_boundaryPending.has(key)) return _boundaryPending.get(key);

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

  const job = (async () => {
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
      const out = { ok: false, reason: 'no-polygon', label: rows[0].display_name || name };
      boundaryCacheWrite(key, out);     // a place with no outline still has no outline tomorrow
      return out;
    }

    const best = withPolygon[0];
    const latlngs = boundaryToLatLngs(best.geojson);
    if (!latlngs) return { ok: false, reason: 'no-polygon' };

    const out = {
      ok: true,
      latlngs,
      label: (best.display_name || name).split(',').slice(0, 2).join(',').trim(),
      points: boundaryPointCount(latlngs),
      adminLevel: (best.address && best.address.admin_level) || best.place_rank || null,
      osm: best.osm_type && best.osm_id ? best.osm_type + '/' + best.osm_id : null,
    };
    boundaryCacheWrite(key, out);
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
    return `OpenStreetMap knows “${name}” but nobody has drawn its outline — it exists there `
      + 'only as a point. Try a larger area it sits inside, or draw the boundary by hand.';
  }
  if (reason === 'not-found') {
    return `OpenStreetMap has no place called “${name}”. Try the name as locals write it, `
      + 'or add the city after it.';
  }
  if (reason === 'network') {
    return 'Could not reach OpenStreetMap. Check the connection and try again.';
  }
  if (reason === 'no-name') return 'Give this location a name first — the boundary is looked up by name.';
  if (String(reason).startsWith('http-')) {
    return 'OpenStreetMap refused the request (' + reason.slice(5) + '). It rate-limits heavy use; '
      + 'wait a moment and try again.';
  }
  return 'The boundary could not be fetched.';
}

/* ---------------------------------------------------------------------------
 * The action behind the Boundary button on a location card
 * ------------------------------------------------------------------------ */

/**
 * Fetch a location's outline and add it to the map as an ordinary shape.
 *
 * WHY IT BECOMES A SHAPE RATHER THAN A NEW KIND OF OBJECT. Everything the
 * drawing tools already give a polygon — restyling, reshaping a vertex,
 * renaming, hiding from the Layer Manager, area measurement, export to PPT and
 * KML, undo — applies the moment this is a geometry. A dedicated "boundary"
 * type would arrive with none of it and would have to earn each one back.
 *
 * An OSM boundary is also a starting point, not gospel: municipal edges are
 * disputed, occasionally out of date, and sometimes drawn to a different
 * standard than a client brief needs. Making it editable is the honest form.
 *
 * @param {object} loc a location record
 * @param {HTMLElement} [btn] the button, disabled while in flight
 * @returns {Promise<void>}
 */
async function addBoundaryForLocation(loc, btn) {
  if (!loc) return;
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

  if (!r.ok) { status(boundaryMessage(r.reason, label), true); return; }

  // Already drawn. Clicking again should take you to it, not stack a second
  // identical polygon on the first — where the duplicate is invisible until
  // you delete one and the outline stubbornly remains.
  const existing = geometries.find(g => g.boundaryFor === loc.id);
  if (existing) {
    try { map.fitBounds(existing.layer.getBounds(), { padding: [40, 40] }); } catch (e) { /* ignore */ }
    status(`${label} already has its boundary on the map — ${existing.name}. `
      + 'Delete it in the Draw tab first if you want to fetch it again.');
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
    // Where it came from, carried on the object rather than in a status line
    // that scrolls away — this matters when the shape ends up in a client
    // document and someone asks what the line is.
    description: 'Administrative boundary from OpenStreetMap'
      + (r.osm ? ' (' + r.osm + ')' : ''),
    // Outline, not fill: it frames the site rather than burying it, which is
    // how a boundary is drawn on every planning document this will sit beside.
    // Property names taken from defaultGeomStyle() — borderColor, not stroke.
    borderColor: accent,
    borderWidth: 2.5,
    lineStyle: 'dashed',
    fillColor: accent,
    fillOpacity: 0.06,
    corner: 'round',
    // Which location this belongs to, so a second click finds it rather than
    // drawing over it. Survives save/load with the rest of the geometry.
    boundaryFor: loc.id,
  });

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
    + 'It is a normal shape: restyle it, reshape it, or delete it in the Draw tab.', false, {
      label: 'Undo',
      onClick: () => { removeGeomById(g.id); status('Boundary removed.'); },
    });
}
