/**
 * map/icons.js — the built-in SVG icon library for location pins.
 * Every glyph uses currentColor so it can be tinted per location.
 */
import { esc } from '../utils/dom.js';

export const ICON_LIBRARY = {
  pin: { label: 'Pin', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M12 2C7.58 2 4 5.58 4 10c0 5.5 8 12 8 12s8-6.5 8-12c0-4.42-3.58-8-8-8zm0 11a3 3 0 110-6 3 3 0 010 6z"/></svg>` },
  building: { label: 'Office', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M4 21V3h9v6h7v12H4zm2-2h5V5H6v14zm7 0h5v-8h-5v8zm-5-9h1v2H8v-2zm0-4h1v2H8V6zm2 4h1v2h-1v-2zm0-4h1v2h-1V6zm4 6h1v2h-1v-2zm2 0h1v2h-1v-2zm-2 4h1v2h-1v-2zm2 0h1v2h-1v-2z"/></svg>` },
  home: { label: 'Residential', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M12 3l9 8h-3v10h-5v-6H11v6H6V11H3l9-8z"/></svg>` },
  industry: { label: 'Industrial', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M2 21V9l5 3V9l5 3V9l10 5v7H2zm4-2h2v-3H6v3zm4 0h2v-3h-2v3zm4 0h2v-3h-2v3zm4 0h2v-3h-2v3z"/></svg>` },
  hotel: { label: 'Hotel', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M2 20V9a2 2 0 012-2h5a4 4 0 014 4v3h5a2 2 0 012 2v4h2v2H0v-2h2zm4-6a2 2 0 100-4 2 2 0 000 4z"/></svg>` },
  mall: { label: 'Mall', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M4 8h16l-1 12H5L4 8zm3-3a5 5 0 0110 0v3h-2V5a3 3 0 00-6 0v3H7V5z"/></svg>` },
  school: { label: 'School', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M12 3L1 9l4 2.18v6L12 21l7-3.82v-6l2-1.09V17h2V9L12 3zm6.82 6L12 12.72 5.18 9 12 5.28 18.82 9zM17 15.99l-5 2.73-5-2.73v-3.72L12 15l5-2.73v3.72z"/></svg>` },
  hospital: { label: 'Hospital', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6V4z"/></svg>` },
  airport: { label: 'Airport', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 00-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1L15 22v-1.5L13 19v-5.5l8 2.5z"/></svg>` },
  railway: { label: 'Railway', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M12 2c-4 0-8 .5-8 4v9.5a3.5 3.5 0 003.5 3.5L6 20v1h12v-1l-1.5-1a3.5 3.5 0 003.5-3.5V6c0-3.5-4-4-8-4zm-4.5 15a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm3.5-7H6V6h5v4zm2 0V6h5v4h-5zm3.5 7a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/></svg>` },
  metro: { label: 'Metro', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="currentColor"/><path fill="#fff" d="M8 8h2l2 4 2-4h2v8h-2v-4l-2 3-2-3v4H8V8z"/></svg>` },
  bus: { label: 'Bus', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M6 3h12a2 2 0 012 2v11a2 2 0 01-2 2v2h-2v-2H8v2H6v-2a2 2 0 01-2-2V5a2 2 0 012-2zm1 4v5h10V7H7zm1 8a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm8 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/></svg>` },
  tree: { label: 'Park', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M12 2L5 12h4v3l-3 5h12l-3-5v-3h4L12 2z"/></svg>` },
  star: { label: 'Site ★', svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>` }
};
export const ICON_KEYS = Object.keys(ICON_LIBRARY);

export function svgForKey(key, color) { return (ICON_LIBRARY[key] || ICON_LIBRARY.pin).svg.replace('currentColor', esc(color || '#0A1E3C')); }
