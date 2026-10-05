/**
 * utils/color.js — hex/RGB/HSV conversions for the in-app colour picker.
 *
 * HSV rather than HSL because the picker's shape follows it directly: the
 * square is saturation across and value down, the slider is hue. HSL would
 * need the square remapped on every hue change to keep the corners meaningful.
 */

/** @param {string} hex @returns {{r:number,g:number,b:number}|null} */
function hexToRgb(hex) {
  const h = String(hex || '').trim().replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** @param {number} r @param {number} g @param {number} b @returns {string} `#rrggbb` */
function rgbToHex(r, g, b) {
  const p = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + p(r) + p(g) + p(b);
}

/** @returns {{h:number,s:number,v:number}} h 0–360, s/v 0–1 */
function rgbToHsv(r, g, b) {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

/** @param {number} h 0–360 @param {number} s 0–1 @param {number} v 0–1 */
function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return { r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255 };
}

/** @param {number} h @param {number} s @param {number} v @returns {string} */
function hsvToHex(h, s, v) {
  const { r, g, b } = hsvToRgb(h, s, v);
  return rgbToHex(r, g, b);
}

/**
 * Whether black or white text reads better on a background.
 * Uses relative luminance rather than a plain average — the eye is far more
 * sensitive to green than to blue, and averaging picks white text on yellow.
 * @param {string} hex @returns {boolean} true when the colour is light
 */
function isLightColor(hex) {
  const c = hexToRgb(hex);
  if (!c) return true;
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) > 150;
}
