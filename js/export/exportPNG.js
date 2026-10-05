/**
 * export/exportPNG.js — PNG export: rasterise the map at true export
 * resolution, apply the 3D perspective warp if tilted, and download.
 *
 * The actual rendering lives in export/hiResRender.js; this file is the button
 * wiring, the resolution menu and the download. See that file for why the map
 * is re-rendered at a deeper zoom rather than simply scaled up.
 */

/**
 * Quality for the JPEG presets.
 *
 * Measured on a 10-megapixel export with the statistics of satellite imagery —
 * fine detail everywhere, no flat areas, which is PNG's worst case and the only
 * case this app produces:
 *
 *   PNG          20.18 MB   1023 ms
 *   JPEG q0.95    4.73 MB    295 ms
 *   JPEG q0.92    3.79 MB    215 ms
 *   JPEG q0.85    2.68 MB    188 ms
 *   WebP q0.92    3.72 MB   2630 ms
 *
 * 0.92 is where the artefacts stop being findable against imagery at this
 * resolution while the file is a fifth of the PNG. WebP saves nothing over it
 * and costs twelve times the encode, so it is not offered.
 */
const PNG_JPEG_QUALITY = 0.92;

/**
 * Presets offered in the Export Centre.
 *
 * JPEG by default, which is a change: this export is a photograph of the
 * ground with some lines drawn on it, and PNG stores photographs badly. A
 * twenty-megabyte attachment that will not send is not a better deliverable
 * than a four-megabyte one nobody can tell apart. PNG stays for the cases that
 * genuinely want it — a map that is mostly flat colour, or one going into
 * something that will re-encode it again.
 */
const PNG_PRESETS = [
  { id: 'standard', scale: 2, format: 'image/jpeg', label: 'Standard — 2×', hint: 'screen & email' },
  { id: 'print', scale: 3, format: 'image/jpeg', label: 'Print — 3×', hint: 'decks & A4 reports' },
  { id: 'max', scale: 4, format: 'image/jpeg', label: 'Maximum — 4×', hint: 'large-format / posters' },
  { id: 'lossless', scale: 3, format: 'image/png', label: 'Lossless PNG — 3×', hint: 'flat-colour maps · ~5× the file' },
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
async function runPngExport(scale, format, quality) {
  const type = format === 'image/png' ? 'image/png' : 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : 'jpg';
  const label = ext.toUpperCase();
  // A basemap that cannot be put in a file is no longer a dead end: the ground
  // pass renders its licensed equivalent instead. Saying so beats both refusing
  // and swapping silently.
  if (!exportReady(activeKey)) {
    status('This basemap’s tiles block canvas export (no CORS header). Switch to an Esri or Carto basemap to export.');
    return;
  }
  status(exportSubstituteNote('Rendering ' + label + '…'), true);
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
      a.download = 'property-access-map.' + ext;
      a.click();
      URL.revokeObjectURL(a.href);
      // The megabytes are named, not just the pixels. "How big is it" is the
      // question people ask of an export they are about to email, and it was
      // the one thing the message did not answer.
      const mb = (blob.size / 1048576).toFixed(blob.size > 10485760 ? 0 : 1);
      const size = canvas.width + ' × ' + canvas.height + ' px, ' + mb + ' MB';
      if (res.complete) {
        status(label + ' downloaded at ' + size + (tiltDeg > 0 ? ', with the 3D perspective applied.' : '.'));
      } else {
        // Sticky, and phrased as what the file actually looks like. This used
        // to be a tail on the success message that scrolled past in seconds —
        // so a half-loaded, mostly-dark export read as "the export is broken"
        // rather than "the imagery did not arrive in time".
        status(label + ' downloaded at ' + size + ' — but the imagery did not finish loading, so parts of the map are dark. '
          + 'Check your connection and export again.', true);
      }
    }, type, type === 'image/jpeg' ? (quality || PNG_JPEG_QUALITY) : undefined);
  } catch (e) {
    status(label + ' export failed: ' + ((e && e.message) || 'unknown error') + ' — try Print / Save as PDF instead.');
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
  if (btn) btn.addEventListener('click', () => runPngExport(EXPORT_SCALES.print, 'image/jpeg'));
}
