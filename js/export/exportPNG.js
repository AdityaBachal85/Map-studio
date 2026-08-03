/**
 * export/exportPNG.js — PNG export: rasterise the map at true export
 * resolution, apply the 3D perspective warp if tilted, and download.
 *
 * The actual rendering lives in export/hiResRender.js; this file is the button
 * wiring, the resolution menu and the download. See that file for why the map
 * is re-rendered at a deeper zoom rather than simply scaled up.
 */

/** Resolution presets offered on the export button. */
const PNG_PRESETS = [
  { id: 'standard', scale: 2, label: 'Standard — 2×', hint: 'screen & email' },
  { id: 'print', scale: 3, label: 'Print — 3×', hint: 'decks & A4 reports' },
  { id: 'max', scale: 4, label: 'Maximum — 4×', hint: 'large-format / posters' },
];

/**
 * Describe the pixel size a preset will produce, so the operator can pick with
 * the actual output in mind rather than guessing at a multiplier.
 * @param {number} scale
 * @returns {string} e.g. `5120 × 2880 px`
 */
function pngPresetDimensions(scale) {
  const wrap = $('mapWrap');
  const s = safeExportScale(scale, wrap.clientWidth, wrap.clientHeight);
  return Math.round(wrap.clientWidth * s) + ' × ' + Math.round(wrap.clientHeight * s) + ' px';
}

/**
 * Render and download a PNG at the given supersample factor.
 * @param {number} scale
 */
async function runPngExport(scale) {
  // A basemap that cannot be put in a file is no longer a dead end: the ground
  // pass renders its licensed equivalent instead. Saying so beats both refusing
  // and swapping silently.
  if (!exportReady(activeKey)) {
    status('This basemap’s tiles block canvas export (no CORS header). Switch to an Esri or Carto basemap to export.');
    return;
  }
  status(exportSubstituteNote('Rendering PNG…'), true);
  try {
    const res = await captureMapHiRes({
      scale,
      onProgress: msg => status(msg, true),
    });
    let canvas = res.canvas;
    if (tiltDeg > 0) canvas = warpPerspective(canvas, tiltDeg);
    canvas.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'property-access-map.png';
      a.click();
      URL.revokeObjectURL(a.href);
      const size = canvas.width + ' × ' + canvas.height + ' px';
      if (res.complete) {
        status('PNG downloaded at ' + size + (tiltDeg > 0 ? ' with the 3D perspective applied.' : '.'));
      } else {
        // Sticky, and phrased as what the file actually looks like. This used
        // to be a tail on the success message that scrolled past in seconds —
        // so a half-loaded, mostly-dark export read as "the export is broken"
        // rather than "the imagery did not arrive in time".
        status('PNG downloaded at ' + size + ' — but the imagery did not finish loading, so parts of the map are dark. '
          + 'Check your connection and export again.', true);
      }
    }, 'image/png');
  } catch (e) {
    status('PNG export failed: ' + ((e && e.message) || 'unknown error') + ' — try Print / Save as PDF instead.');
  }
}

/**
 * Legacy entry point. The resolution presets now live in the Export Centre
 * (ui/exportCenter.js), which calls runPngExport() directly; this remains so
 * app.js's wiring block keeps its shape and an older layout with a #pngBtn
 * still works.
 */
function wirePngExport() {
  const btn = $('pngBtn');
  if (btn) btn.addEventListener('click', () => runPngExport(EXPORT_SCALES.print));
}
