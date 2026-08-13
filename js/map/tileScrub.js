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
 * ONLY WHILE ZOOMED OUT. See PLACE_ICON_MIN_TILE_Z: past a ~300 m scale the
 * tiles are left alone. A wall of crosses across a locality overview is
 * clutter; the same crosses when you have zoomed into one street are the answer
 * to "what is next door".
 *
 * WHY THE COLOUR TEST IS SO NARROW. OSM Carto draws healthcare (hospitals,
 * clinics, pharmacies, doctors, dentists) in one dedicated red, #BF0000 —
 * (191, 0, 0) — used for both the icon and its name text. Green and blue are
 * not merely lower than red there, they are near *zero*, and that absolute
 * floor is the whole test.
 *
 * Relative dominance alone is not enough, and shipping it that way ate a road:
 * OSM Carto draws under-construction and proposed highways as pink dashes,
 * around (230, 145, 160). Red dominates there too — r-g is 85, r-b is 70, and
 * g≈b — so a "red is much higher than green and blue" rule matches the pink
 * dash of the Thane–Borivali Twin Tunnel exactly as readily as a hospital
 * cross, and quietly deleted an upcoming road from a property map. The ceilings
 * below are what separate them: healthcare has g,b under ~90; construction pink
 * has both over 130. Nothing else on the map lives in the gap.
 *
 * The known cost: the rare level-crossing marker and other near-black-red
 * glyphs go too. They are accepted losses on a property map; a road is not.
 *
 * WHY INPAINTING, NOT TRANSPARENCY. Punching the pixels to transparent leaves
 * white confetti holes over buildings. Filling each hole by repeatedly
 * averaging its unmasked neighbours grows the surrounding colour inward —
 * an icon sits on building-beige or road-white, so the smudge left behind is
 * the background it was printed on, invisible at map scale.
 */

/**
 * The shallowest tile zoom that keeps its place icons.
 *
 * OSM Carto starts drawing healthcare icons at z15, which is why they appear
 * at all around a 500 m scale bar and not at 600 m — the threshold is the
 * style's, not ours. Scrubbing every zoom hid them even when you had deliberately
 * zoomed in to look at a specific building, which is the one moment they are
 * worth having.
 *
 * So the scrub stops at z16. Metres per pixel is 156543 * cos(lat) / 2^z, so
 * near Mumbai (lat 19.2, cos 0.944) that is 4.5 m/px at z15 and 2.3 m/px at
 * z16 — a scale bar around 300 m and below. Above that the map is a locality
 * overview and the crosses are clutter; below it you are looking at individual
 * plots and they are information.
 */
const PLACE_ICON_MIN_TILE_Z = 16;

/**
 * Is this pixel OSM Carto healthcare red (or its anti-aliased fringe)?
 * @param {number} r @param {number} g @param {number} b
 * @param {boolean} loose widened test for edge pixels next to a core match
 * @returns {boolean}
 */
function isMedicalRed(r, g, b, tier) {
  // Tier 2 is the faintest ring: 9px red text anti-aliases almost all the way
  // to the beige ground, and pixels at (240, 220, 218) are barely red at all.
  // Left behind they read as a grey smudge in the shape of the words — quieter
  // than red, and still obviously a scar. Every tier keeps the ceilings, and
  // every tier can only be reached by growing outward from a tier-0 pixel, so
  // the pink of a construction dash is never a starting point.
  if (tier === 2) return r >= 150 && g <= 245 && b <= 245 && r - g >= 12 && r - b >= 12
    && Math.abs(g - b) <= 30;
  if (tier === 1) return r >= 110 && g <= 150 && b <= 150 && r - g >= 30 && r - b >= 30
    && Math.abs(g - b) <= 55;
  return r >= 120 && g <= 90 && b <= 90 && r - g >= 70 && r - b >= 70
    && Math.abs(g - b) <= 45;
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

  // Two rings of anti-aliased fringe, each looser than the last. Without them
  // an icon leaves a halo the exact shape of itself, and text leaves legible
  // grey words. Growth is strictly outward from the previous ring, so the reach
  // is bounded at two pixels from a confirmed healthcare pixel — which is what
  // keeps a nearby construction dash out of it even where they touch.
  let ring = queue;
  for (let tier = 1; tier <= 2; tier++) {
    const next = [];
    for (const i of ring) {
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (mask[j]) continue;
        const q = j * 4;
        if (isMedicalRed(px[q], px[q + 1], px[q + 2], tier)) { mask[j] = 1; next.push(j); }
      }
    }
    queue = queue.concat(next);
    ring = next;
  }

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

    // Per tile, from its own zoom — not from the map's current zoom. Leaflet
    // keeps tiles from other levels around during a zoom animation and reuses
    // cached ones, so a decision made from map.getZoom() would scrub or spare
    // the wrong level whenever those disagree.
    const keepIcons = coords.z >= PLACE_ICON_MIN_TILE_Z;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const ctx = tile.getContext('2d');
        ctx.drawImage(img, 0, 0, size.x, size.y);
        if (!keepIcons) scrubMedicalRed(ctx, size.x, size.y);
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
