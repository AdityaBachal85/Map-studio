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
  if (!basemapExportSafe(activeKey)) {
    status('This basemap’s tiles block canvas export (no CORS header). Switch to an Esri or Carto basemap to export.');
    return;
  }
  status('Rendering PNG…', true);
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
      const partial = res.complete ? '' : ' Some tiles were still loading — re-export for full detail.';
      status('PNG downloaded at ' + size + (tiltDeg > 0 ? ' with the 3D perspective applied.' : '.') + partial);
    }, 'image/png');
  } catch (e) {
    status('PNG export failed: ' + ((e && e.message) || 'unknown error') + ' — try Print / Save as PDF instead.');
  }
}

function wirePngExport() {
  const btn = $('pngBtn');
  const menu = document.createElement('div');
  menu.className = 'export-menu frost';
  menu.hidden = true;
  PNG_PRESETS.forEach(p => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'export-menu-item';
    item.innerHTML = `<span class="em-label">${p.label}</span><span class="em-hint">${p.hint}</span><span class="em-dim"></span>`;
    item.addEventListener('click', () => {
      menu.hidden = true;
      if (typeof setPref === 'function') setPref('pngScale', p.scale);
      runPngExport(p.scale);
    });
    menu.appendChild(item);
  });
  btn.parentNode.insertBefore(menu, btn.nextSibling);

  btn.addEventListener('click', () => {
    // Fill in the live pixel dimensions each time — they depend on the window.
    Array.from(menu.querySelectorAll('.export-menu-item')).forEach((el, i) => {
      el.querySelector('.em-dim').textContent = pngPresetDimensions(PNG_PRESETS[i].scale);
    });
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', e => {
    if (!menu.hidden && !e.target.closest('.export-menu') && e.target !== btn && !btn.contains(e.target)) menu.hidden = true;
  });
}
