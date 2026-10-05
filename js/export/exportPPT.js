/**
 * exportPPT.js — orchestrator for the editable PowerPoint export.
 *
 * Consumes a plain "deck spec" (built by the app from the current map) and
 * produces a .pptx in which the map is a background image and everything else —
 * leader lines, icon pins, labels, badges, rings, title, legend table, logo —
 * is a native, editable PowerPoint object. The finished package is run through
 * {@link ensureUniqueShapeIds} to repair pptxgenjs's duplicate-id defect.
 *
 * Environment-agnostic: `import`s resolve under Node (tests) and under the Vite
 * browser build alike. The only browser-specific path is the download helper,
 * which is feature-detected.
 */







const DEFAULT_SLIDE = { slideW: 13.333, slideH: 7.5 };
const PPT_LOGO_AR = 0.4026;

/** Default text measurer (Arial heuristic) used when the caller supplies none. */
function heuristicMeasurePx(text, pxSize, bold) {
  return String(text).length * pxSize * (bold ? 0.56 : 0.52);
}

/**
 * Build the per-export context (transforms, colour helpers, chip sizing).
 * @param {object} geometry `{slideW, slideH, wrapW, wrapH, chipFont}`.
 * @param {(t:string,px:number,bold:boolean)=>number} measurePx Text measurer.
 * @returns {object} ctx passed to every builder.
 */
function makeContext(geometry, measurePx) {
  const fit = computeFit(geometry.slideW, geometry.slideH, geometry.wrapW, geometry.wrapH);
  const tf = { ...makeTransform(fit), rr: fit.rr };
  const chipWidth = (text, px, bold) =>
    measurePx(text, px, bold) * fit.rr + tf.pt(px) * 2.2 / 72 * 0.55 + 0.1;
  return { fit, tf, chipWidth, hex: hexColor, textOn: pptTextOn, chipFont: geometry.chipFont, slideW: geometry.slideW };
}

/**
 * Compute the logo card + image placement from the slide size and logo aspect.
 * @returns {{data:string, x:number, y:number, w:number, h:number, card:object}}
 */
function logoPlacement(logo, slideW, slideH) {
  const w = 1.15, h = w * (logo.aspect || PPT_LOGO_AR), pad = 0.09;
  const bx = slideW - w - pad * 2 - 0.15, by = slideH - h - pad * 2 - 0.12;
  return { data: logo.data, x: bx + pad, y: by + pad, w, h, card: { x: bx, y: by, w: w + pad * 2, h: h + pad * 2 } };
}

/**
 * Populate a pptxgenjs slide from the deck spec, in z-order.
 * @param {object} slide pptxgenjs slide.
 * @param {object} s The `spec.slide` object.
 * @param {object} ctx Build context from {@link makeContext}.
 * @param {object} log Logger.
 */
function buildSlide(slide, s, ctx, log) {
  const { tf, hex } = ctx;
  slide.background = { color: hex(s.background || '0A1E3C') };
  const fit = ctx.fit;
  if (s.map && s.map.data) {
    addBackground(slide, { data: s.map.data, x: fit.offX, y: fit.offY, w: fit.imgW, h: fit.imgH }, log);
  }

  // Routes, boundaries, rings and measurements go in before the pins and labels
  // so they sit under them, matching the on-screen z-order. They are native
  // shapes, not part of the map picture, so they stay editable in PowerPoint.
  (s.paths || []).forEach(p => addVectorPath(slide, p, tf, log, hex));
  (s.leaders || []).forEach(l => addLeaderLine(slide, l, tf, log, hex));
  (s.pins || []).forEach(p => addIconPin(slide, p, tf, log, hex));
  (s.routeLabels || []).forEach(w => addRouteLabel(slide, w, ctx, log));
  (s.locationLabels || []).forEach(w => addLocationLabel(slide, w, ctx, log));
  (s.badges || []).forEach(w => addBadge(slide, w, ctx, log));
  (s.rings || []).forEach(w => addRingLabel(slide, w, ctx, log));

  if (s.title && s.title.visible && String(s.title.text || '').trim()) addTitle(slide, s.title, ctx, log);
  if (s.legend && s.legend.visible && (s.legend.rows || []).length) addLegend(slide, s.legend, ctx, log);
  if (s.colorKey && s.colorKey.visible && (s.colorKey.rows || []).length) addColorKey(slide, s.colorKey, ctx, log);
  if (s.logo && s.logo.visible && s.logo.data) {
    addLogo(slide, logoPlacement(s.logo, ctx.slideW, DEFAULT_SLIDE.slideH), log, hex);
  }
}

/**
 * Build the deck (no I/O). Exposed for tests that need to inspect the instance.
 * @param {object} spec Full deck spec.
 * @param {object} [opts] `{measurePx}`.
 * @returns {{pptx:object, log:object}}
 */
function buildDeck(spec, opts = {}) {
  const geometry = { ...DEFAULT_SLIDE, ...(spec.geometry || {}) };
  const log = makeLogger();
  const ctx = makeContext(geometry, opts.measurePx || heuristicMeasurePx);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = spec.author || 'DBOT · Property Map Studio';
  buildSlide(pptx.addSlide(), spec.slide, ctx, log);
  return { pptx, log };
}

/**
 * Build, repair, and output the deck.
 * @param {object} spec Full deck spec.
 * @param {object} [opts] `{measurePx, output}` where `output` is
 *        `'download'` (browser), `'nodebuffer'`, or `'arraybuffer'` (default).
 * @returns {Promise<{data:*, log:object, fileName:string}>}
 */
async function exportDeck(spec, opts = {}) {
  const { pptx, log } = buildDeck(spec, opts);
  const raw = await pptx.write({ outputType: 'arraybuffer' });
  const fileName = spec.fileName || 'property-access-map.pptx';
  const output = opts.output || 'arraybuffer';
  const jszipType = output === 'download' ? 'blob' : output;
  const data = await ensureUniqueShapeIds(raw, { outputType: jszipType });
  if (output === 'download') triggerDownload(data, fileName);
  return { data, log, fileName };
}

/**
 * Trigger a browser download of the finished package.
 * @param {Blob} blob @param {string} fileName
 */
function triggerDownload(blob, fileName) {
  if (typeof document === 'undefined') return;
  const file = blob instanceof Blob ? blob : new Blob([blob], { type: PPTX_MIME });
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = fileName; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
