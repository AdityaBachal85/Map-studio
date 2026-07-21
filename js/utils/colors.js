/**
 * utils/colors.js — colour conversion and contrast helpers.
 */

/** Normalise a CSS colour to bare 6-digit uppercase hex (no #). @param {string} c */
export const hex = c => String(c || '#888888').replace('#', '').toUpperCase();
export function chan(h) { h = h.replace('#', ''); return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)]; }
export function textOn(bg) { const [r, g, b] = chan(bg); return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#17202B' : '#FFFFFF'; }
export function lighten(bg, amt) {
  const [r, g, b] = chan(bg);
  const f = v => Math.min(255, Math.round(v + (255 - v) * amt)).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}
