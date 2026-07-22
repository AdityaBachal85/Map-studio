/**
 * pptUtils.js — pure, dependency-free helpers shared by the PPTX export engine.
 *
 * Everything here is environment-agnostic (no DOM, no pptxgenjs) so the whole
 * module can be unit-tested in Node exactly as it runs in the browser.
 */

const HEX6 = /^[0-9A-Fa-f]{6}$/;

/**
 * Normalise any CSS colour string to a bare 6-digit uppercase hex (no `#`),
 * the form pptxgenjs expects. Falls back to a neutral grey when the input is
 * missing or not a plain hex colour.
 * @param {string} [c] CSS colour, e.g. `#0A1E3C` or `0a1e3c`.
 * @returns {string} Six uppercase hex chars, e.g. `0A1E3C`.
 */
function hexColor(c) {
  const raw = String(c == null ? '' : c).replace('#', '').trim().toUpperCase();
  if (HEX6.test(raw)) return raw;
  if (/^[0-9A-F]{3}$/.test(raw)) return raw.split('').map(ch => ch + ch).join('');
  return '888888';
}

/**
 * Split a hex colour into its red/green/blue channels.
 * @param {string} hex A colour accepted by {@link hexColor}.
 * @returns {[number, number, number]} `[r, g, b]`, each 0–255.
 */
function channelsOf(hex) {
  const h = hexColor(hex);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Pick a readable text colour (dark ink or white) for a given background,
 * using the same luminance threshold as the v4.9 app.
 * @param {string} bg Background colour.
 * @returns {string} `17202B` (dark) or `FFFFFF` (white), no `#`.
 */
function pptTextOn(bg) {
  const [r, g, b] = channelsOf(bg);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '17202B' : 'FFFFFF';
}

/** @returns {boolean} true when `n` is a real, finite number. */
function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Clamp a roundRect corner radius so pptxgenjs never emits an out-of-range
 * `<a:gd>` adjustment. pptxgenjs computes `adj = rectRadius / min(w,h) * 100000`,
 * and PowerPoint 365 rejects the file ("can't read content" / repair) when
 * `adj > 50000` — i.e. when the radius exceeds half the shorter side — even
 * though python-pptx and LibreOffice accept it. The margin keeps adj just under
 * the cap. Visually a fully-rounded pill stays fully rounded.
 * @param {number} desiredIn Requested radius in inches.
 * @param {number} wIn Shape width in inches.
 * @param {number} hIn Shape height in inches.
 * @returns {number} A safe radius in inches (0 ≤ r ≤ 0.49·min(w,h)).
 */
function safeRectRadius(desiredIn, wIn, hIn) {
  const maxIn = Math.min(wIn, hIn) * 0.5 * 0.98;
  return Math.max(0, Math.min(desiredIn, maxIn));
}

/**
 * Fit a source rectangle (the map capture) inside the slide, letterboxed and
 * centred — the same maths the v4.9 export used, extracted so both the engine
 * and its tests share one implementation.
 * @param {number} slideW Slide width in inches.
 * @param {number} slideH Slide height in inches.
 * @param {number} wrapW  Source width in CSS px.
 * @param {number} wrapH  Source height in CSS px.
 * @returns {{offX:number, offY:number, imgW:number, imgH:number, rr:number}}
 *          Placement in inches plus `rr`, the px→inch ratio.
 */
function computeFit(slideW, slideH, wrapW, wrapH) {
  const imgAspect = wrapW / wrapH;
  const slideAspect = slideW / slideH;
  let imgW, imgH, offX, offY;
  if (imgAspect >= slideAspect) {
    imgW = slideW; imgH = slideW / imgAspect; offX = 0; offY = (slideH - imgH) / 2;
  } else {
    imgH = slideH; imgW = slideH * imgAspect; offY = 0; offX = (slideW - imgW) / 2;
  }
  return { offX, offY, imgW, imgH, rr: imgW / wrapW };
}

/**
 * Build coordinate transforms from a {@link computeFit} result.
 * @param {{offX:number, offY:number, rr:number}} fit
 * @returns {{X:(px:number)=>number, Y:(px:number)=>number, pt:(px:number)=>number}}
 *          `X`/`Y` map source px to slide inches; `pt` maps a CSS px font size
 *          to points (floored at 7.5pt, as the app did).
 */
function makeTransform(fit) {
  const { offX, offY, rr } = fit;
  return {
    X: px => offX + px * rr,
    Y: px => offY + px * rr,
    pt: cssPx => Math.max(7.5, cssPx * rr * 72),
  };
}

/**
 * Create a tiny structured logger that records skipped/invalid objects so the
 * orchestrator can report *why* something was dropped instead of silently
 * corrupting the deck.
 * @returns {{skip:(kind:string,reason:string,detail?:*)=>void, note:(m:string)=>void, entries:Array, skipped:number}}
 */
function makeLogger() {
  const entries = [];
  return {
    entries,
    get skipped() { return entries.filter(e => e.level === 'skip').length; },
    skip(kind, reason, detail) { entries.push({ level: 'skip', kind, reason, detail }); },
    note(message) { entries.push({ level: 'note', message }); },
  };
}
