/**
 * export/captureMap.js — legacy single-pass map rasteriser.
 *
 * Superseded by export/hiResRender.js, which renders the basemap from deeper
 * tiles instead of upscaling what is on screen. This wrapper is kept so any
 * caller still holding the old signature keeps working; it now delegates to the
 * new pipeline rather than maintaining a second, worse renderer.
 *
 * @deprecated Call {@link captureMapHiRes} directly and pass an explicit scale.
 */

/**
 * Rasterise the map + overlays to a canvas.
 * @param {string} [extraClass] Extra CSS class applied to #mapWrap during
 *   capture (e.g. 'pptx-capture' to hide the DOM label chips).
 * @param {number} [scale=2] Supersample factor.
 * @returns {Promise<HTMLCanvasElement>}
 */
async function captureMap(extraClass, scale) {
  const res = await captureMapHiRes({ scale: scale || 2, extraClass });
  return res.canvas;
}
