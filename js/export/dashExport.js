/**
 * export/dashExport.js — the board, out of the browser.
 *
 * TWO PROBLEMS, ONE PIPELINE. The cards are ordinary DOM and html2canvas
 * handles them. The map tile is not: html2canvas cannot rasterise Leaflet's
 * transformed tile images or its overlay pane, and an export that quietly
 * dropped the map would be the one thing nobody would forgive. So the map is
 * drawn separately — its tiles and its vector canvases copied straight onto a
 * 2D context, which is what js/export/hiResRender.js already does for the map
 * export — and the result is pasted into the board bitmap at the tile's
 * position.
 *
 * PDF WITHOUT A PDF LIBRARY. A single-page PDF wrapping one JPEG is a handful
 * of objects and an xref table; jsPDF is ~300KB to do that. This writes the
 * bytes directly. It is not a general PDF writer and does not pretend to be —
 * one page, one image, sized to the paper with the margins the page needs.
 *
 * Chrome is left out on purpose: the edit handles, the drag grips, the add bar
 * and the format pane are tools, not content.
 */

/** Paper sizes, in PDF points (72 per inch), landscape. */
const DASH_PAPER = {
  a4: { w: 841.89, h: 595.28, label: 'A4 landscape' },
  a3: { w: 1190.55, h: 841.89, label: 'A3 landscape' },
};

/** Quality of the JPEG inside the PDF, and of the JPEG export. */
const DASH_JPEG_Q = 0.92;

/**
 * Paint the live map tile onto the board canvas.
 *
 * THREE PASSES, because no single one can do it. The basemap is transformed
 * <img> tiles, which html2canvas cannot rasterise — those are copied straight
 * onto a 2D context. Routes and shapes are already in the overlay pane's own
 * canvas, so that is one drawImage. Pins, labels and the key-distances card are
 * ordinary HTML and only html2canvas can draw them — run with
 * `.hires-overlay-pass`, which hides the two panes above and makes every
 * surface behind them transparent, so what comes back is the furniture alone on
 * nothing. (That class already existed for the map's own export; this reuses it
 * rather than inventing a second way to say the same thing.)
 *
 * @param {CanvasRenderingContext2D} ctx the board canvas context
 * @param {DOMRect} boardRect the canvas element's rect, to offset against
 * @param {number} scale
 * @returns {Promise<boolean>} whether the ground drew
 */
async function dashPaintMap(ctx, boardRect, scale) {
  const wrap = document.getElementById('mapWrap');
  if (!wrap || !wrap.closest('#dashGrid')) return false;
  const r = wrap.getBoundingClientRect();
  const W = Math.round(r.width), H = Math.round(r.height);
  if (W < 4 || H < 4) return false;

  const ground = rasteriseTileLayers(wrap, W, H, () => true, '#0b1220');
  const vec = rasteriseVectorCanvases(wrap, W, H);

  let furniture = null;
  const stage = document.getElementById('tiltStage');
  const savedTransform = stage ? stage.style.transform : null;
  const wasTilted = wrap.classList.contains('tilted');
  try {
    if (stage) stage.style.transform = '';
    wrap.classList.remove('tilted');
    wrap.classList.add('capturing', 'hires-overlay-pass');
    if (typeof flattenBillboardForCapture === 'function') flattenBillboardForCapture();
    furniture = await html2canvas(wrap, {
      useCORS: true, allowTaint: false, logging: false,
      backgroundColor: null, width: W, height: H, scale,
    });
  } catch (e) {
    console.warn('Dashboard export: the map furniture pass failed —', e && e.message);
  } finally {
    if (typeof restoreBillboardAfterCapture === 'function') restoreBillboardAfterCapture();
    wrap.classList.remove('capturing', 'hires-overlay-pass');
    if (stage) stage.style.transform = savedTransform;
    if (wasTilted) wrap.classList.add('tilted');
  }

  const x = (r.left - boardRect.left) * scale;
  const y = (r.top - boardRect.top) * scale;
  const w = W * scale, h = H * scale;

  // Rounded, to match the tile's own corner radius — a square-cornered map in
  // a board of rounded cards looks like a mistake.
  ctx.save();
  // html2canvas leaves its own `scale` transform on the context it hands back,
  // so coordinates already multiplied by `scale` get multiplied a second time:
  // the map painted at roughly double size, over the whole board. Reset to the
  // identity and work in device pixels.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  const rad = 14 * scale;
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(ground.canvas, x, y, w, h);
  if (vec.drawn) ctx.drawImage(vec.canvas, x, y, w, h);
  if (furniture) ctx.drawImage(furniture, x, y, w, h);
  ctx.restore();

  return ground.drawn > 0;
}

/**
 * Render the whole board to a canvas.
 *
 * @param {number} scale device pixels per CSS pixel
 * @returns {Promise<HTMLCanvasElement>}
 */
async function dashRenderBoard(scale) {
  const grid = document.getElementById('dashGrid');
  if (!grid) throw new Error('The board is not open.');

  const app = document.getElementById('app');
  const wasEditing = typeof dashEditing !== 'undefined' && dashEditing;
  // Tools are not content. Turning edit mode off for the capture also settles
  // the cards into their non-editing height, which is the layout somebody
  // actually wants to hand over.
  if (wasEditing && typeof setDashEditing === 'function') setDashEditing(false);
  grid.classList.add('exporting');
  // Let the layout and the charts settle at their new sizes before measuring.
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 260)));

  const rect = grid.getBoundingClientRect();
  const W = Math.round(rect.width), H = Math.round(grid.scrollHeight || rect.height);

  try {
    const surface = getComputedStyle(app || document.body).getPropertyValue('--bg0').trim() || '#ffffff';
    const shot = await html2canvas(grid, {
      backgroundColor: surface,
      scale,
      width: W,
      height: H,
      windowWidth: document.documentElement.clientWidth,
      useCORS: true,
      logging: false,
      // The map is painted in by hand afterwards; html2canvas would render an
      // empty box there and, worse, sometimes throw on the transformed panes.
      ignoreElements: el => el.id === 'mapWrap' || el.id === 'dashAdd' || el.id === 'dashGhost',
    });
    await dashPaintMap(shot.getContext('2d'), rect, scale);
    return shot;
  } finally {
    grid.classList.remove('exporting');
    if (wasEditing && typeof setDashEditing === 'function') setDashEditing(true);
  }
}

/* ---------------------------------------------------------------------------
 * A one-page, one-image PDF
 * ------------------------------------------------------------------------ */

/** @param {string} dataUrl a data: JPEG @returns {Uint8Array} its bytes */
function dashJpegBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Assemble a minimal PDF around one JPEG.
 *
 * The image is placed with `/DCTDecode`, which means the JPEG goes in as-is
 * rather than being re-encoded — so the file is barely larger than the image
 * and there is no second generation of compression artefacts.
 *
 * @param {Uint8Array} jpeg @param {number} iw @param {number} ih
 * @param {{w:number,h:number}} paper in points
 * @returns {Blob}
 */
function dashBuildPdf(jpeg, iw, ih, paper) {
  const margin = 18;
  const availW = paper.w - margin * 2, availH = paper.h - margin * 2;
  const fit = Math.min(availW / iw, availH / ih);
  const dw = iw * fit, dh = ih * fit;
  const dx = (paper.w - dw) / 2, dy = (paper.h - dh) / 2;

  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = bytes => { parts.push(bytes); len += bytes.length; };
  const pushStr = s => push(enc.encode(s));
  const obj = (n, body) => { offsets[n] = len; pushStr(n + ' 0 obj\n' + body + '\nendobj\n'); };

  pushStr('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + paper.w.toFixed(2) + ' ' + paper.h.toFixed(2) + ']'
    + ' /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');

  // The image object: header, raw JPEG bytes, trailer.
  offsets[4] = len;
  pushStr('4 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + iw + ' /Height ' + ih
    + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n');
  push(jpeg);
  pushStr('\nendstream\nendobj\n');

  const content = 'q\n' + dw.toFixed(2) + ' 0 0 ' + dh.toFixed(2) + ' ' + dx.toFixed(2) + ' '
    + dy.toFixed(2) + ' cm\n/Im0 Do\nQ\n';
  obj(5, '<< /Length ' + enc.encode(content).length + ' >>\nstream\n' + content + 'endstream');

  const xref = len;
  let table = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  pushStr(table + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

  return new Blob(parts, { type: 'application/pdf' });
}

/* ---------------------------------------------------------------------------
 * The menu
 * ------------------------------------------------------------------------ */

/** @param {Blob} blob @param {string} name */
function dashSaveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * @returns {string} a filename stem
 *
 * The project's name first — that is what someone recognises in a downloads
 * folder. The map's title card is the fallback, and it is only a fallback now
 * that the card is off by default: naming every export after a title nobody
 * turned on would give three different boards the same filename.
 */
function dashExportName() {
  const pb = document.getElementById('pbName');
  const t = (pb && pb.textContent.trim())
    || ((document.getElementById('titleCard') || {}).textContent || '').trim()
    || 'dashboard';
  return t.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 48).toLowerCase() || 'dashboard';
}

/**
 * Run one export.
 * @param {string} kind 'png' | 'jpeg' | 'pdf-a4' | 'pdf-a3'
 */
async function dashExport(kind) {
  if (typeof html2canvas !== 'function') { status('The export library did not load — reload the page.'); return; }
  const isPdf = kind.indexOf('pdf') === 0;
  status(isPdf ? 'Building the PDF…' : 'Rendering the board…', true);

  try {
    // 2× for the raster formats, 2.5× for print — enough for a page without
    // producing a file nobody can email.
    const canvas = await dashRenderBoard(isPdf ? 2.5 : 2);
    const stem = dashExportName();

    if (kind === 'png') {
      canvas.toBlob(b => {
        dashSaveBlob(b, stem + '-dashboard.png');
        status('Saved ' + stem + '-dashboard.png (' + (b.size / 1048576).toFixed(1) + ' MB).');
      }, 'image/png');
      return;
    }
    if (kind === 'jpeg') {
      canvas.toBlob(b => {
        dashSaveBlob(b, stem + '-dashboard.jpg');
        status('Saved ' + stem + '-dashboard.jpg (' + (b.size / 1048576).toFixed(1) + ' MB).');
      }, 'image/jpeg', DASH_JPEG_Q);
      return;
    }

    const paper = DASH_PAPER[kind === 'pdf-a3' ? 'a3' : 'a4'];
    const jpeg = dashJpegBytes(canvas.toDataURL('image/jpeg', DASH_JPEG_Q));
    const blob = dashBuildPdf(jpeg, canvas.width, canvas.height, paper);
    dashSaveBlob(blob, stem + '-dashboard.pdf');
    status('Saved ' + stem + '-dashboard.pdf — ' + paper.label + ', '
      + (blob.size / 1048576).toFixed(1) + ' MB.');
  } catch (e) {
    console.error('Dashboard export failed:', e);
    status('The board could not be exported: ' + (e && e.message ? e.message : 'unknown error'));
  }
}

const DASH_EXPORT_ITEMS = [
  ['pdf-a4', 'PDF — A4 landscape', 'One page, sized to the paper.'],
  ['pdf-a3', 'PDF — A3 landscape', 'For a wide board with a lot on it.'],
  ['png', 'PNG — 2×', 'Lossless. The biggest file.'],
  ['jpeg', 'JPEG — 2×', 'Much smaller, fine for sending.'],
];

(function wireDashExport() {
  const btn = document.getElementById('dashExportBtn');
  const menu = document.getElementById('dashExportMenu');
  if (!btn || !menu) return;

  menu.innerHTML = '<h4>Export the board</h4>' + DASH_EXPORT_ITEMS.map(i =>
    '<div class="dt-rep" role="menuitem"><div class="dt-rep-main">'
    + '<div class="dt-rep-name">' + esc(i[1]) + '</div>'
    + '<div class="dt-rep-meta">' + esc(i[2]) + '</div></div>'
    + '<a href="#" data-dexp="' + i[0] + '">Save</a></div>').join('');

  menu.addEventListener('click', e => {
    const a = e.target.closest('[data-dexp]');
    if (!a) return;
    e.preventDefault();
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    dashExport(a.dataset.dexp);
  });
})();
