/**
 * services/elevation.js — ground height, as data rather than as a picture.
 *
 * The app already draws an Esri hillshade (map/basemapProviders.js), but that
 * is a rendered image: you can look at it and you cannot measure it. Contours
 * need the numbers, so this fetches a real digital elevation model and decodes
 * it into a grid of metres.
 *
 * THE SOURCE is the AWS Open Data "Terrain Tiles" set, in Mapzen's terrarium
 * encoding. It was chosen over the alternatives for three reasons that all
 * matter to this app: it needs no API key (every keyed provider in this
 * codebase has a whole file of key-gating behind it), it serves
 * `Access-Control-Allow-Origin: *` so a browser can read its pixels back out of
 * a canvas without tainting it, and it is global. Mapbox and MapTiler serve a
 * comparable Terrain-RGB and both require an account.
 *
 *   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 *   elevation = (R * 256 + G + B / 256) - 32768        metres
 *
 * WHAT IT IS AND IS NOT. Under India this is largely SRTM: roughly 30 m between
 * real samples, vertically accurate to about 10 m. Tiles exist down to zoom 15
 * (about 4.5 m per pixel at Mumbai's latitude) but the extra pixels are
 * interpolated, not measured — zoom 16 is a 404, which is the source being
 * honest about where its data stops. A 5 m contour interval off this is a
 * reasonable picture of the shape of the ground and is not a survey, and the
 * panel says so rather than letting the precision of the number imply
 * otherwise.
 */

const TERRAIN_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const TERRAIN_MAX_ZOOM = 15;
const TERRAIN_TILE_PX = 256;
const TERRAIN_CREDIT = 'Elevation: AWS Terrain Tiles (SRTM, USGS, and others)';

/** One tile can be slow; a wall of them must not hang the whole generate. */
const DEM_TILE_TIMEOUT_MS = 20000;
/** Decoded tiles, keyed z/x/y. Re-contouring at a new interval must not refetch. */
const DEM_TILE_CACHE_MAX = 220;
const _demTiles = new Map();
/** Two callers asking for the same tile share one request. */
const _demPending = new Map();

/** Sample counts along the longest edge of the grid, per Detail Level. */
const DEM_DETAIL_SAMPLES = { standard: 600, high: 950, ultra: 1400 };
/** Above this the grid stops being worth its memory and its render time. */
const DEM_MAX_SAMPLES = 2400;

/* ---------------------------------------------------------------------------
 * Web Mercator, in the DEM's own pixel space
 * ------------------------------------------------------------------------- */

const demWorldPx = z => TERRAIN_TILE_PX * Math.pow(2, z);

function demLngToPx(lng, z) { return (lng + 180) / 360 * demWorldPx(z); }
function demLatToPx(lat, z) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const s = Math.sin(clamped * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * demWorldPx(z);
}
function demPxToLng(px, z) { return px / demWorldPx(z) * 360 - 180; }
function demPxToLat(py, z) {
  const n = Math.PI * (1 - 2 * py / demWorldPx(z));
  return Math.atan(Math.sinh(n)) * 180 / Math.PI;
}

/**
 * Ground distance between two adjacent samples, in metres.
 * Mercator stretches with latitude, so this is only right near `lat` — which
 * is all the hillshade needs, since a selection never spans enough latitude
 * for the difference to show.
 */
function demMetresPerSample(lat, z) {
  return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
}

/**
 * The zoom that gives a grid of about the requested size, capped by what the
 * source actually has.
 *
 * Choosing by output size rather than by a fixed zoom per detail level is what
 * makes "Standard" mean the same thing over a city block and over a district:
 * a small selection gets the deepest tiles that exist, a large one is stepped
 * back until the grid is a size the browser can contour without stalling.
 *
 * @param {{north:number,south:number,east:number,west:number}} b
 * @param {string} detail 'standard' | 'high' | 'ultra'
 * @returns {number}
 */
function demZoomFor(b, detail) {
  const want = DEM_DETAIL_SAMPLES[detail] || DEM_DETAIL_SAMPLES.standard;
  for (let z = TERRAIN_MAX_ZOOM; z > 4; z--) {
    const w = Math.abs(demLngToPx(b.east, z) - demLngToPx(b.west, z));
    const h = Math.abs(demLatToPx(b.south, z) - demLatToPx(b.north, z));
    if (Math.max(w, h) <= want) return z;
  }
  return 5;
}

/* ---------------------------------------------------------------------------
 * Tiles
 * ------------------------------------------------------------------------- */

function demTileUrl(z, x, y) {
  return TERRAIN_TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/** Trim the decoded-tile cache to its budget, oldest first. */
function demTrimCache() {
  while (_demTiles.size > DEM_TILE_CACHE_MAX) {
    const oldest = _demTiles.keys().next().value;
    _demTiles.delete(oldest);
  }
}

/**
 * One decoded tile: 256*256 metres, or null if it could not be had.
 *
 * A missing tile is a hole in the grid rather than a failure of the whole
 * request — the source genuinely has gaps over some ocean, and one 404 at the
 * corner of a selection should not refuse to draw the other fifteen tiles.
 *
 * @returns {Promise<Float32Array|null>}
 */
function demTile(z, x, y) {
  const key = z + '/' + x + '/' + y;
  const hit = _demTiles.get(key);
  if (hit) {
    _demTiles.delete(key); _demTiles.set(key, hit);      // touch: most-recent last
    return Promise.resolve(hit);
  }
  if (_demPending.has(key)) return _demPending.get(key);

  const run = new Promise(resolve => {
    const img = new Image();
    // Without this the canvas is tainted and getImageData throws — the same
    // requirement every tile layer in this app has, for the same reason.
    img.crossOrigin = 'anonymous';
    let settled = false;
    const done = v => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(null), DEM_TILE_TIMEOUT_MS);

    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = TERRAIN_TILE_PX; c.height = TERRAIN_TILE_PX;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, TERRAIN_TILE_PX, TERRAIN_TILE_PX);
        const px = ctx.getImageData(0, 0, TERRAIN_TILE_PX, TERRAIN_TILE_PX).data;
        const out = new Float32Array(TERRAIN_TILE_PX * TERRAIN_TILE_PX);
        for (let i = 0; i < out.length; i++) {
          const o = i * 4;
          out[i] = (px[o] * 256 + px[o + 1] + px[o + 2] / 256) - 32768;
        }
        _demTiles.set(key, out);
        demTrimCache();
        done(out);
      } catch (e) {
        done(null);           // tainted or undecodable: a hole, not a crash
      }
    };
    img.onerror = () => done(null);
    img.src = demTileUrl(z, x, y);
  });

  _demPending.set(key, run);
  return run.finally(() => _demPending.delete(key));
}

/* ---------------------------------------------------------------------------
 * The grid
 * ------------------------------------------------------------------------- */

/**
 * @typedef {object} ElevationGrid
 * @property {number} w @property {number} h
 * @property {Float32Array} data metres, NaN where the source has no answer
 * @property {number} zoom the DEM zoom it was read at
 * @property {number} x0 @property {number} y0 origin in that zoom's pixel space
 * @property {number} min @property {number} max metres, ignoring voids
 * @property {number} metresPerSample
 * @property {boolean} partial true when some tiles could not be fetched
 */

/**
 * Fetch and mosaic an elevation grid covering a bounding box.
 *
 * @param {{north:number,south:number,east:number,west:number}} b
 * @param {object} [o] `{detail}`
 * @returns {Promise<{ok:boolean, grid?:ElevationGrid, reason?:string, tiles?:number}>}
 */
async function fetchElevationGrid(b, o) {
  const opts = o || {};
  if (!b || !(b.north > b.south) || !(b.east > b.west)) return { ok: false, reason: 'no-area' };

  let z = demZoomFor(b, opts.detail);
  let x0, y0, w, h;
  // Step back if the requested detail would build a grid too big to contour
  // interactively. Reported, not silent — the panel says which detail it
  // actually used.
  for (;;) {
    x0 = Math.floor(demLngToPx(b.west, z));
    y0 = Math.floor(demLatToPx(b.north, z));
    w = Math.ceil(demLngToPx(b.east, z)) - x0;
    h = Math.ceil(demLatToPx(b.south, z)) - y0;
    if (Math.max(w, h) <= DEM_MAX_SAMPLES || z <= 5) break;
    z--;
  }
  if (!(w > 1 && h > 1)) return { ok: false, reason: 'too-small' };

  const tx0 = Math.floor(x0 / TERRAIN_TILE_PX), tx1 = Math.floor((x0 + w - 1) / TERRAIN_TILE_PX);
  const ty0 = Math.floor(y0 / TERRAIN_TILE_PX), ty1 = Math.floor((y0 + h - 1) / TERRAIN_TILE_PX);
  const span = Math.pow(2, z);

  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      // Wrapped in x so a selection crossing the antimeridian still reads;
      // clamped in y because there are no tiles above the pole.
      const wx = ((tx % span) + span) % span;
      jobs.push({ tx, ty, p: (ty < 0 || ty >= span) ? Promise.resolve(null) : demTile(z, wx, ty) });
    }
  }

  const data = new Float32Array(w * h).fill(NaN);
  let missing = 0;
  await Promise.all(jobs.map(async job => {
    const tile = await job.p;
    if (!tile) { missing++; return; }
    const ox = job.tx * TERRAIN_TILE_PX - x0;
    const oy = job.ty * TERRAIN_TILE_PX - y0;
    // Only the part of the tile that lands inside the grid.
    const sx0 = Math.max(0, -ox), sx1 = Math.min(TERRAIN_TILE_PX, w - ox);
    const sy0 = Math.max(0, -oy), sy1 = Math.min(TERRAIN_TILE_PX, h - oy);
    for (let sy = sy0; sy < sy1; sy++) {
      const dst = (oy + sy) * w + ox;
      const src = sy * TERRAIN_TILE_PX;
      for (let sx = sx0; sx < sx1; sx++) data[dst + sx] = tile[src + sx];
    }
  }));

  if (missing === jobs.length) return { ok: false, reason: 'no-tiles', tiles: jobs.length };

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v !== v) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!isFinite(min)) return { ok: false, reason: 'no-data', tiles: jobs.length };

  const midLat = (b.north + b.south) / 2;
  return {
    ok: true,
    tiles: jobs.length,
    grid: {
      w, h, data, zoom: z, x0, y0, min, max,
      metresPerSample: demMetresPerSample(midLat, z),
      partial: missing > 0,
    },
  };
}

/* ---------------------------------------------------------------------------
 * Grid coordinates <-> the world
 * ------------------------------------------------------------------------- */

/** @param {ElevationGrid} g @returns {{lat:number, lng:number}} */
function gridToLatLng(g, gx, gy) {
  return { lat: demPxToLat(g.y0 + gy, g.zoom), lng: demPxToLng(g.x0 + gx, g.zoom) };
}

/** @param {ElevationGrid} g @returns {{x:number, y:number}} grid coordinates */
function latLngToGrid(g, lat, lng) {
  return { x: demLngToPx(lng, g.zoom) - g.x0, y: demLatToPx(lat, g.zoom) - g.y0 };
}

/**
 * Height at a point, in metres, or NaN outside the grid.
 * @param {ElevationGrid} g
 */
function elevationAt(g, lat, lng) {
  if (!g) return NaN;
  const p = latLngToGrid(g, lat, lng);
  return sampleGrid(g, p.x, p.y);
}

/** Forget every decoded tile. For tests, and for a project that has moved on. */
function clearElevationCache() { _demTiles.clear(); }
