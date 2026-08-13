/**
 * map/tileScrub.js — the same OpenStreetMap tiles, minus the red medical icons.
 *
 * THE REQUEST THIS ANSWERS, precisely: "the OpenStreetMap map only, same map,
 * just without the red symbols." Swapping to a clean-styled ground (Positron)
 * removes the symbols by changing the whole cartography, which was rejected —
 * rightly, because the beige buildings, yellow roads and green parks ARE the
 * map the user wants. And no public server offers OSM Carto with the POI layer
 * off; the crosses are baked into the same PNG as the roads.
 *
 * SO THE TILE ITSELF IS CLEANED, in the browser, before Leaflet shows it. Each
 * tile is drawn to a canvas, pixels matching OSM Carto's healthcare red are
 * found, and the holes are filled from the surrounding map colour. OSM tiles
 * are served with `Access-Control-Allow-Origin: *` — the export pipeline
 * already depends on that — so the canvas stays readable and exportable.
 *
 * WHY THE COLOUR TEST IS SO NARROW. OSM Carto draws healthcare (hospitals,
 * clinics, pharmacies, doctors, dentists) in one dedicated red, #BF0000, used
 * for both the icon and its name text. True red has green ≈ blue, both far
 * below red. That inequality is what separates it from everything else warm on
 * the map: the amenity brown #734A08 and food orange #C77400 have g and b far
 * apart, road yellows have g near r, shop purples have b high. So the mask is
 * hue-shaped, not "reddish": r dominant AND g≈b. The known cost: the rare
 * level-crossing marker and other pure-red glyphs go too. They are accepted
 * losses on a property map.
 *
 * WHY INPAINTING, NOT TRANSPARENCY. Punching the pixels to transparent leaves
 * white confetti holes over buildings. Filling each hole by repeatedly
 * averaging its unmasked neighbours grows the surrounding colour inward —
 * an icon sits on building-beige or road-white, so the smudge left behind is
 * the background it was printed on, invisible at map scale.
 */

/**
 * Is this pixel OSM Carto healthcare red (or its anti-aliased fringe)?
 * @param {number} r @param {number} g @param {number} b
 * @param {boolean} loose widened test for edge pixels next to a core match
 * @returns {boolean}
 */
function isMedicalRed(r, g, b, loose) {
  if (loose) return r - g >= 18 && r - b >= 18 && Math.abs(g - b) <= 60;
  return r >= 100 && r - g >= 45 && r - b >= 45 && Math.abs(g - b) <= 50;
}

/**
 * Remove the healthcare-red marks from one canvas, in place.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w @param {number} h
 * @returns {boolean} whether anything was removed
 */
function scrubMedicalRed(ctx, w, h) {
  let img;
  try { img = ctx.getImageData(0, 0, w, h); }
  catch (e) { return false; }                  // tainted (non-CORS tile): leave it
  const px = img.data;
  const n = w * h;
  const mask = new Uint8Array(n);
  let queue = [];

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (isMedicalRed(px[p], px[p + 1], px[p + 2], false)) { mask[i] = 1; queue.push(i); }
  }
  if (!queue.length) return false;

  // One ring of anti-aliased fringe: pixels beside a core match that lean red.
  // Without this every icon leaves a pink halo the exact shape of itself.
  const fringe = [];
  for (const i of queue) {
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (mask[j]) continue;
      const q = j * 4;
      if (isMedicalRed(px[q], px[q + 1], px[q + 2], true)) { mask[j] = 1; fringe.push(j); }
    }
  }
  queue = queue.concat(fringe);

  // Inpaint: sweep the still-masked set, filling any pixel that has at least
  // one clean neighbour with the average of its clean neighbours. Each sweep
  // fills one boundary ring, so the pass count is the largest blob's radius —
  // icons are ~14px, so this converges in a handful of sweeps.
  let remaining = queue;
  for (let pass = 0; pass < 40 && remaining.length; pass++) {
    const next = [];
    const filled = [];
    for (const i of remaining) {
      const x = i % w, y = (i / w) | 0;
      let sr = 0, sg = 0, sb = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (mask[j]) continue;
        const q = j * 4;
        sr += px[q]; sg += px[q + 1]; sb += px[q + 2]; c++;
      }
      if (!c) { next.push(i); continue; }
      const p = i * 4;
      px[p] = sr / c; px[p + 1] = sg / c; px[p + 2] = sb / c; px[p + 3] = 255;
      filled.push(i);
    }
    // Cleared only after the sweep: a pixel filled this pass must not feed its
    // neighbours until the next one, or the fill smears directionally.
    for (const i of filled) mask[i] = 0;
    if (next.length === remaining.length) break;   // isolated — cannot happen, but never loop
    remaining = next;
  }

  ctx.putImageData(img, 0, 0);
  return true;
}

/**
 * A tile layer whose tiles are scrubbed before display.
 *
 * Tiles come back as <canvas> elements instead of <img>. Everything downstream
 * that walks the DOM for tiles has to accept both — hiResRender's
 * rasteriseTileLayers selected `img.leaflet-tile` and would have exported a
 * blank ground.
 */
const ScrubbedTileLayer = L.TileLayer.extend({
  createTile: function (coords, done) {
    const size = this.getTileSize();
    const tile = document.createElement('canvas');
    tile.width = size.x;
    tile.height = size.y;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const ctx = tile.getContext('2d');
        ctx.drawImage(img, 0, 0, size.x, size.y);
        scrubMedicalRed(ctx, size.x, size.y);
        done(null, tile);
      } catch (e) {
        done(null, tile);       // shown unscrubbed rather than not at all
      }
    };
    // Leaflet's own error path, so the basemap-fallback machinery in mapEngine
    // sees a scrubbed layer fail exactly the way it sees a plain one fail.
    img.onerror = e => done(e || new Error('tile failed'), tile);
    img.src = this.getTileUrl(coords);
    return tile;
  },
});
