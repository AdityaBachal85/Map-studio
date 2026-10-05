/**
 * utils/dom.js — tiny DOM helpers used everywhere.
 */

/** Shorthand for document.getElementById. @param {string} id @returns {HTMLElement|null} */
const $ = id => document.getElementById(id);
/** Escape a string for safe interpolation into HTML. @param {*} s @returns {string} */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
