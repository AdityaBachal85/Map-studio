/**
 * export/dashExport.js — the board, out of the browser.
 *
 * TWO PROBLEMS, ONE PIPELINE. The cards are ordinary DOM and html2canvas
 * handles them. The map tile is not: html2canvas cannot rasterise Leaflet's
 * transformed tile images or its overlay pane, and an export that quietly
 * dropped the map would be the one thing nobody would forgive. So the map is
 * rendered separately, by captureMapHiRes() in js/export/hiResRender.js — the
 * same renderer the map's own export uses — and pasted into the board bitmap
 * at the tile's position.
 *
 * THIS FILE MAKES THE PICTURE; export/dashPdf.js MAKES THE DOCUMENT. PNG and
 * JPEG want exactly the bitmap below and nothing else. The PDF used to want it
 * too — one page, one image — which is why it had no selectable text, no page
 * furniture, and a portrait board letterboxed onto a landscape sheet with forty
 * per cent of the page left blank. It now reads export/dashExportModel.js and
 * draws a real document, cropping only the pictorial cards out of this bitmap.
 * The split is the point: one rasteriser, several writers.
 *
 * Chrome is left out on purpose: the edit handles, the drag grips, the add bar
 * and the format pane are tools, not content.
 */

/** Quality of the JPEG inside the PDF, and of the JPEG export. */
const DASH_JPEG_Q = 0.92;

/** What an export is printed on. See the note in dashRenderBoard. */
const DASH_EXPORT_GROUND = '#FFFFFF';

/**
 * Quiet around the board, in CSS pixels.
 *
 * On screen the board never touches anything: the nav rail is to its left and
 * the window to its right, so it always has air. Captured on its own it went
 * straight to the edge of the file, and the map — which is usually the tile in
 * the top-left corner — came out bleeding off two sides of the page. This is
 * the margin the screen was giving it for free.
 */
const DASH_EXPORT_PAD = 26;

/**
 * Which way this export comes out.
 *
 * @returns {'light'|'dark'}
 */
function dashExportTheme() {
  const t = typeof getPref === 'function' ? getPref('exportTheme') : 'light';
  return t === 'dark' ? 'dark' : 'light';
}

/**
 * The ground the file is drawn on.
 *
 * White for a light export rather than the light theme's own --bg0: paper is
 * white, and the cards carry a border of their own so they still read as cards
 * against it. A dark export takes the theme's real background, because there is
 * no equivalent convention to appeal to — the honest answer is "what the board
 * actually looks like".
 *
 * @returns {string}
 */
function dashExportGround() {
  if (dashExportTheme() === 'light') return DASH_EXPORT_GROUND;
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--bg0').trim();
    if (v) return v;
  } catch (e) { /* fall through */ }
  return '#070C16';
}

/**
 * Elements html2canvas must not draw.
 *
 * The map because it is painted in afterwards at a higher resolution; the rest
 * because they are the tools for building the board rather than any part of it.
 */
const DASH_EXPORT_SKIP = ['mapWrap', 'dashAdd', 'dashGhost',
  'dashNav', 'dashTop', 'dashFormat', 'dashGallery'];

/**
 * Paint the map tile onto the board canvas, through the map export's own
 * high-resolution renderer.
 *
 * html2canvas cannot rasterise Leaflet's transformed tile images or its overlay
 * pane, which is why the map is excluded from the board pass and drawn here
 * instead. What it is drawn WITH changed: see the note in the body.
 *
 * @param {CanvasRenderingContext2D} ctx the board canvas context
 * @param {DOMRect} boardRect the canvas element's rect, to offset against
 * @param {number} scale
 * @returns {Promise<{drawn:boolean, complete:boolean, failed?:boolean}>}
 */
async function dashPaintMap(ctx, boardRect, scale) {
  const wrap = document.getElementById('mapWrap');
  if (!wrap || !wrap.closest('#dashGrid')) return { drawn: false, complete: true };
  const r = wrap.getBoundingClientRect();
  const W = Math.round(r.width), H = Math.round(r.height);
  if (W < 4 || H < 4) return { drawn: false, complete: true };

  // THE MAP EXPORT'S OWN RENDERER, not a copy of the screen.
  //
  // This used to call rasteriseTileLayers / rasteriseVectorCanvases straight at
  // the live map, which copies whatever pixels are already on screen and scales
  // them up — the exact defect hiResRender.js was written to fix, quoted in its
  // own header: "Every export was therefore a blown-up screenshot — the imagery
  // could never be sharper than what was already on screen." The map export
  // stopped doing that and the board carried on doing it, so the same map came
  // out sharp from one button and soft from the other.
  //
  // captureMapHiRes builds a throwaway Leaflet map at zoom + log2(scale), so
  // the ground is composed from genuinely more tile pixels rather than
  // interpolated from fewer. It also brings the pixel budget with it
  // (safeExportScale), which this path never had.
  let shot = null;
  try {
    shot = await captureMapHiRes({ scale });
  } catch (e) {
    // Loud, because the map is the one thing nobody would forgive losing, and
    // a silent console line is how that goes unnoticed until a client asks.
    console.error('Dashboard export: the map could not be rendered —', e && e.message);
    return { drawn: false, complete: false, failed: true };
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
  // The capture is at its own clamped scale, which need not be the board's —
  // drawImage resolves the difference, and it is always downward, so no
  // sharpness is invented on the way in.
  ctx.drawImage(shot.canvas, x, y, w, h);
  ctx.restore();

  // The board bitmap holds the map at the BOARD's scale, so the extra
  // resolution just fetched is spent on a better downsample and then thrown
  // away. That is right for PNG and JPEG, which are the board at that scale.
  // It is wasteful for the PDF, which places the map as its own image and can
  // carry every pixel of it — so the full-size canvas is handed on rather than
  // being re-cropped out of the flattened board.
  return { drawn: true, complete: shot.complete !== false, canvas: shot.canvas };
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

  const wasEditing = typeof dashEditing !== 'undefined' && dashEditing;
  // Tools are not content. Turning edit mode off for the capture also settles
  // the cards into their non-editing height, which is the layout somebody
  // actually wants to hand over.
  if (wasEditing && typeof setDashEditing === 'function') setDashEditing(false);
  grid.classList.add('exporting');

  // ONE THEME PER FILE, AND THE OPERATOR PICKS IT.
  //
  // The board follows the app's theme, and the app is usually dark. The PDF
  // draws its text cards itself, so before this it drew them light while the
  // pictorial cards were cropped from a dark bitmap — a white page with the map
  // and every chart sitting on it as black rectangles. Two themes in one
  // document, which reads as a mistake because it is one.
  //
  // The fix then was to force light everywhere. That is right for paper and
  // wrong for a board built to be read on a screen, so it is now a choice: the
  // whole capture, and every writer's palette, follow dashExportTheme(). What
  // must not happen is the two disagreeing again.
  //
  // The app already has both themes and it is one attribute, so the capture
  // borrows one rather than a second set of export-only colours being invented
  // and kept in step by hand. Restored in the `finally` below, and the frame
  // after the swap is waited for so the browser has actually restyled before
  // anything is measured or drawn.
  const themeWas = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = dashExportTheme();

  // Let the layout, the charts and the theme swap settle before measuring.
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 260)));

  const rect = grid.getBoundingClientRect();
  const W = Math.round(rect.width), H = Math.round(grid.scrollHeight || rect.height);
  const ground = dashExportGround();
  // The board is composed onto a slightly larger canvas so it has air around
  // it. Every rectangle below is shifted by the same amount, because the PDF
  // and the deck crop cards out of this bitmap by those rectangles and a rect
  // that disagrees with the pixels by 26px cuts a card's title off.
  const pad = DASH_EXPORT_PAD;

  // Where every tile sits on the bitmap about to be made. Measured here, from
  // the settled layout, rather than recomputed from the grid constants later:
  // the PDF crops cards out of this bitmap by these rectangles, and a rect
  // derived a second way is a rect that can disagree with the pixels.
  const rects = {};
  const note = (id, el) => {
    const r = el.getBoundingClientRect();
    rects[id] = {
      x: (r.left - rect.left + pad) * scale,
      y: (r.top - rect.top + grid.scrollTop + pad) * scale,
      w: r.width * scale, h: r.height * scale,
    };
  };
  grid.querySelectorAll('.dash-card[data-card]').forEach(el => note(el.dataset.card, el));
  const mapEl = document.getElementById('mapWrap');
  if (mapEl && mapEl.closest('#dashGrid')) {
    note(typeof DASH_MAP_ID !== 'undefined' ? DASH_MAP_ID : '__map', mapEl);
  }

  try {
    const shot = await html2canvas(grid, {
      // For a light export, white rather than the light theme's own --bg0
      // (#EDF1F7): the reports these sit alongside are on white, and the cards
      // carry a border of their own, so they still read as cards against it.
      // For a dark one there is no such convention, so it is the board's real
      // ground — see dashExportGround().
      backgroundColor: ground,
      scale,
      width: W,
      height: H,
      windowWidth: document.documentElement.clientWidth,
      useCORS: true,
      logging: false,
      // The map is painted in by hand afterwards; html2canvas would render an
      // empty box there and, worse, sometimes throw on the transformed panes.
      //
      // The board's own chrome is on this list for a different reason. It is
      // outside #dashGrid and should therefore be outside the crop entirely —
      // but html2canvas renders the document and crops it, and the left nav was
      // coming out as a 210px grey column standing in the middle of the board,
      // over whichever cards were behind it. Naming it here is both the fix and
      // the correct statement: a navigation rail is not part of a deliverable.
      ignoreElements: el => DASH_EXPORT_SKIP.indexOf(el.id) >= 0,
    });
    // Composed onto a larger ground, so the board has the air the screen gave
    // it for free. Done here rather than by padding #dashGrid, because padding
    // the grid would move every tile and the board on screen is not what is
    // being changed.
    const out = document.createElement('canvas');
    out.width = shot.width + Math.round(pad * scale) * 2;
    out.height = shot.height + Math.round(pad * scale) * 2;
    const g = out.getContext('2d');
    g.fillStyle = ground;
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(shot, Math.round(pad * scale), Math.round(pad * scale));

    // The map is painted against a board rect shifted by the same margin, so it
    // lands on the tile the rects above describe rather than beside it.
    const map = await dashPaintMap(g,
      { left: rect.left - pad, top: rect.top - pad }, scale);
    out._dashRects = rects;
    out._dashMap = map;
    out._dashGround = ground;
    out._dashTheme = dashExportTheme();
    return out;
  } finally {
    grid.classList.remove('exporting');
    if (themeWas) document.documentElement.dataset.theme = themeWas;
    else delete document.documentElement.dataset.theme;
    if (wasEditing && typeof setDashEditing === 'function') setDashEditing(true);
  }
}

/** The map's title card as it ships. Anything still reading exactly this has
 *  not been named, whatever it says. */
const DASH_TITLE_PLACEHOLDER = 'property location & access';

/**
 * What to call this board — on the page header and in the filename.
 *
 * The open project's name first: that is the one thing somebody has definitely
 * chosen, and it is what they will look for in a downloads folder.
 *
 * Then the SITE's name, which is new here and is what makes the fallback worth
 * having. A board is about one property, the site pin is that property, and it
 * is nearly always named. Falling back to it means an unsaved board still
 * exports as "ashoka-site" rather than as "dashboard".
 *
 * The map's title card comes last and only when it has been edited. It ships
 * reading "PROPERTY LOCATION & ACCESS" and it is off by default, so using it
 * unconditionally — which is what happened — titles every unnamed board with
 * the same placeholder and gives three different boards one filename. That is
 * the exact failure its own comment warned about.
 *
 * @returns {string}
 */
function dashBoardTitle() {
  const pb = document.getElementById('pbName');
  const named = pb && pb.textContent.trim();
  if (named) return named;

  if (typeof locations !== 'undefined' && locations) {
    const site = locations.find(l => l.type === 'site' && l.name && l.name.trim());
    if (site) return site.name.trim();
  }

  const card = document.getElementById('titleCard');
  const t = card ? card.textContent.trim() : '';
  if (t && t.toLowerCase() !== DASH_TITLE_PLACEHOLDER) return t;

  return '';
}

/**
 * The model, with the two live cards' rows read off the map.
 *
 * dashExportModel() may not touch the DOM, so the rows it cannot fetch for
 * itself are fetched here and handed in. The colour resolver is the same
 * arrangement: what `var(--viz-3)` means is a question only a live stylesheet
 * can answer.
 *
 * @returns {object}
 */
function dashCurrentModel() {
  const cs = getComputedStyle(document.documentElement);
  return dashExportModel({
    title: dashBoardTitle(),
    resolveColor: name => cs.getPropertyValue(name).trim(),
    liveRows: {
      access: (typeof legendRows === 'function') ? legendRows() : [],
      legend: (typeof colorKeyRows === 'function') ? colorKeyRows().filter(r => !r.hidden) : [],
    },
  });
}

/* ---------------------------------------------------------------------------
 * JPEG bytes, shared with the document writer
 * ------------------------------------------------------------------------ */

/** @param {string} dataUrl a data: JPEG @returns {Uint8Array} its bytes */
function dashJpegBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
 * Same title the page header carries — see dashBoardTitle() for the order it
 * resolves in and why the placeholder is excluded. One resolver, so the file on
 * disk and the heading inside it can never disagree.
 */
function dashExportName() {
  const t = dashBoardTitle() || 'dashboard';
  return t.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 48).toLowerCase() || 'dashboard';
}

/**
 * What to say about the cards nobody typed into.
 *
 * The export never drops them — a card on the board is a card in the file, and
 * silently removing content is a worse surprise than an empty box. But it does
 * say so, because four blank cards in a client's PDF is usually somebody having
 * forgotten rather than having decided.
 *
 * @param {object} model @returns {string} a sentence to append, or ''
 */
function dashMapNote(canvas) {
  const m = canvas && canvas._dashMap;
  if (!m || !m.drawn) return m && m.failed ? ' The map could not be rendered into it.' : '';
  // rasteriseTileLayers has always counted the tiles it could not decode, and
  // this path has always thrown that count away — so a board exported before
  // the imagery finished loading came out with dark patches and reported
  // success. runPngExport says so; now this does too.
  return m.complete ? '' : ' Some imagery had not finished loading, so parts of the map are dark.';
}

/**
 * What to say about the cards nobody typed into.
 *
 * @param {object} model @returns {string} a sentence to append, or ''
 */
function dashEmptyNote(model) {
  const n = model.emptyCount;
  if (!n) return '';
  const named = model.emptyTitles.slice(0, 3).join(', ');
  return ' ' + n + ' card' + (n === 1 ? '' : 's')
    + ' had no data in ' + (n === 1 ? 'it' : 'them')
    + (named ? ' — ' + named + (model.emptyTitles.length > 3 ? '…' : '') : '') + '.';
}

/**
 * Run one export.
 * @param {string} kind 'png' | 'jpeg' | 'pdf-a4' | 'pdf-a3'
 */
async function dashExport(kind) {
  if (typeof html2canvas !== 'function') { status('The export library did not load — reload the page.'); return; }
  // Everything except the two raster formats is a document, and documents are
  // rendered at print scale.
  const isDoc = kind === 'pptx' || kind === 'docx' || kind.indexOf('pdf') === 0;
  const label = kind === 'pptx' ? 'Building the deck…'
    : kind === 'docx' ? 'Building the document…'
      : kind.indexOf('pdf') === 0 ? 'Building the PDF…' : 'Rendering the board…';
  status(label, true);

  try {
    // 2× for the raster formats, 2.5× for print — enough for a page without
    // producing a file nobody can email.
    const canvas = await dashRenderBoard(isDoc ? 2.5 : 2);
    const stem = dashExportName();

    if (kind === 'png') {
      canvas.toBlob(b => {
        dashSaveBlob(b, stem + '-dashboard.png');
        status('Saved ' + stem + '-dashboard.png (' + (b.size / 1048576).toFixed(1) + ' MB).' + dashMapNote(canvas));
      }, 'image/png');
      return;
    }
    if (kind === 'jpeg') {
      canvas.toBlob(b => {
        dashSaveBlob(b, stem + '-dashboard.jpg');
        status('Saved ' + stem + '-dashboard.jpg (' + (b.size / 1048576).toFixed(1) + ' MB).' + dashMapNote(canvas));
      }, 'image/jpeg', DASH_JPEG_Q);
      return;
    }

    const model = dashCurrentModel();
    const rects = canvas._dashRects || {};

    if (kind === 'pptx') {
      const deck = await dashBuildPptx(model, canvas, rects, 2.5);
      dashSaveBlob(deck.blob, stem + '-dashboard.pptx');
      status('Saved ' + stem + '-dashboard.pptx — ' + deck.slides + ' slide'
        + (deck.slides === 1 ? '' : 's') + ', ' + (deck.blob.size / 1048576).toFixed(1) + ' MB.'
        + dashMapNote(canvas) + dashEmptyNote(model));
      return;
    }
    if (kind === 'docx') {
      const docx = await dashBuildDocx(model, canvas, rects, 2.5);
      dashSaveBlob(docx.blob, stem + '-dashboard.docx');
      status('Saved ' + stem + '-dashboard.docx — '
        + (docx.blob.size / 1048576).toFixed(1) + ' MB.'
        + dashMapNote(canvas) + dashEmptyNote(model));
      return;
    }

    const doc = dashBuildDocument(model, canvas, rects, 2.5,
      kind === 'pdf-a3' ? 'a3' : 'a4');
    dashSaveBlob(doc.blob, stem + '-dashboard.pdf');
    status('Saved ' + stem + '-dashboard.pdf — ' + doc.paper.label + ', '
      + doc.pages + ' page' + (doc.pages === 1 ? '' : 's') + ', '
      + (doc.blob.size / 1048576).toFixed(1) + ' MB.' + dashMapNote(canvas) + dashEmptyNote(model));
  } catch (e) {
    console.error('Dashboard export failed:', e);
    status('The board could not be exported: ' + (e && e.message ? e.message : 'unknown error'));
  }
}

const DASH_EXPORT_ITEMS = [
  ['pdf-a4', 'PDF — A4', 'Selectable text. Turns and paginates to suit the board.'],
  ['pdf-a3', 'PDF — A3', 'The same, on bigger paper.'],
  ['pptx', 'PowerPoint', 'Editable shapes and native tables, one slide per page.'],
  ['docx', 'Word', 'Headings, paragraphs and tables — the version you edit.'],
  ['png', 'PNG — 2×', 'A picture of the board. Lossless, the biggest file.'],
  ['jpeg', 'JPEG — 2×', 'Much smaller, fine for sending.'],
];

(function wireDashExport() {
  const btn = document.getElementById('dashExportBtn');
  const menu = document.getElementById('dashExportMenu');
  if (!btn || !menu) return;

  /* The ground every format comes out on. At the top of the menu rather than in
     Preferences, because it is a property of the file being saved and the
     decision is made at the moment of saving — not a setting somebody goes
     looking for afterwards, having already sent the wrong one. */
  const draw = () => {
    const t = dashExportTheme();
    menu.innerHTML = '<h4>Export the board</h4>'
      + '<div class="dt-ground">'
      + '<span>Ground</span>'
      + '<div class="dt-seg" role="group" aria-label="Export background">'
      + [['light', 'Light'], ['dark', 'Dark']].map(([v, lbl]) =>
        '<button type="button" data-dground="' + v + '"' + (t === v ? ' class="on"' : '')
        + ' aria-pressed="' + (t === v) + '">' + lbl + '</button>').join('')
      + '</div></div>'
      + DASH_EXPORT_ITEMS.map(i =>
        '<div class="dt-rep" role="menuitem"><div class="dt-rep-main">'
        + '<div class="dt-rep-name">' + esc(i[1]) + '</div>'
        + '<div class="dt-rep-meta">' + esc(i[2]) + '</div></div>'
        + '<a href="#" data-dexp="' + i[0] + '">Save</a></div>').join('');
  };
  draw();

  menu.addEventListener('click', e => {
    const g = e.target.closest('[data-dground]');
    if (g) {
      e.preventDefault();
      if (typeof setPref === 'function') setPref('exportTheme', g.dataset.dground);
      draw();                       // the menu stays open: this is not the save
      return;
    }
    const a = e.target.closest('[data-dexp]');
    if (!a) return;
    e.preventDefault();
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    dashExport(a.dataset.dexp);
  });
})();
