/**
 * map/icons.js — the built-in SVG icon library for location pins.
 *
 * Each entry is `{label, cat, d}` where `d` is one path string or an array of
 * them, all on a 24×24 viewBox. Storing path data rather than whole `<svg>`
 * documents keeps this file readable and lets callers wrap the same glyph in
 * whatever chrome they need — a bare tinted glyph on the map, or a pin-shaped
 * swatch in the picker grid (ui/iconPicker.js).
 *
 * `cat` groups icons in the picker. Adding an icon is a one-line change here;
 * the picker builds its sections from whatever categories it finds.
 *
 * Keys are permanent: they are written into saved project files
 * (`loc.iconKey`), so renaming one silently breaks every project that used it.
 * Add new keys freely, but never repurpose an existing one.
 */

/** Category order in the picker. Anything not listed still renders, at the end. */
const ICON_CATEGORIES = ['Basics', 'Property', 'Places', 'Transport', 'Nature & leisure', 'Infrastructure'];

const ICON_LIBRARY = {
  /* ---------------- Basics ---------------- */
  pin: { label: 'Pin', cat: 'Basics', d: 'M12 2C7.58 2 4 5.58 4 10c0 5.5 8 12 8 12s8-6.5 8-12c0-4.42-3.58-8-8-8zm0 11a3 3 0 110-6 3 3 0 010 6z' },
  dot: { label: 'Dot', cat: 'Basics', d: 'M12 7a5 5 0 100 10 5 5 0 000-10z' },
  circle: { label: 'Circle', cat: 'Basics', d: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 3a7 7 0 110 14 7 7 0 010-14z' },
  square: { label: 'Square', cat: 'Basics', d: 'M4 4h16v16H4V4zm3 3v10h10V7H7z' },
  diamond: { label: 'Diamond', cat: 'Basics', d: 'M12 2l10 10-10 10L2 12 12 2zm0 4.2L6.2 12 12 17.8 17.8 12 12 6.2z' },
  star: { label: 'Star / Site', cat: 'Basics', d: 'M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z' },
  heart: { label: 'Heart', cat: 'Basics', d: 'M12 21s-8-4.9-8-10.4A4.6 4.6 0 0112 7a4.6 4.6 0 018 3.6C20 16.1 12 21 12 21z' },
  flag: { label: 'Flag', cat: 'Basics', d: 'M5 2h2v20H5V2zm3 1h11l-2.5 4L19 11H8V3z' },
  check: { label: 'Check', cat: 'Basics', d: 'M9.5 17.5l-5-5 2.1-2.1 2.9 2.9 7.9-7.9L19.5 7.5l-10 10z' },
  cross: { label: 'Cross', cat: 'Basics', d: 'M18.3 7.8L13.4 12l4.9 4.2-1.9 1.9L12 13.4l-4.4 4.7-1.9-1.9L10.6 12 5.7 7.8l1.9-1.9L12 10.6l4.4-4.7 1.9 1.9z' },
  info: { label: 'Info', cat: 'Basics', d: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z' },
  alert: { label: 'Alert', cat: 'Basics', d: 'M12 2l10 18H2L12 2zm1 13h-2v2h2v-2zm0-6h-2v5h2V9z' },

  /* ---------------- Property ---------------- */
  home: { label: 'Residential', cat: 'Property', d: 'M12 3l9 8h-3v10h-5v-6H11v6H6V11H3l9-8z' },
  apartment: { label: 'Apartment', cat: 'Property', d: 'M4 21V3h10v6h6v12H4zm3-3h2v2H7v-2zm0-4h2v2H7v-2zm0-4h2v2H7v-2zm0-4h2v2H7V6zm4 12h2v2h-2v-2zm0-4h2v2h-2v-2zm0-4h2v2h-2v-2zm0-4h2v2h-2V6zm5 8h2v2h-2v-2zm0 4h2v2h-2v-2zm0-8h2v2h-2v-2z' },
  villa: { label: 'Villa', cat: 'Property', d: 'M3 11l9-7 9 7v10h-6v-5H9v5H3V11zm2 1v7h2v-5h10v5h2v-7l-7-5.4L5 12z' },
  building: { label: 'Office', cat: 'Property', d: 'M4 21V3h9v6h7v12H4zm2-2h5V5H6v14zm7 0h5v-8h-5v8zm-5-9h1v2H8v-2zm0-4h1v2H8V6zm2 4h1v2h-1v-2zm0-4h1v2h-1V6zm4 6h1v2h-1v-2zm2 0h1v2h-1v-2zm-2 4h1v2h-1v-2zm2 0h1v2h-1v-2z' },
  industry: { label: 'Industrial', cat: 'Property', d: 'M2 21V9l5 3V9l5 3V9l10 5v7H2zm4-2h2v-3H6v3zm4 0h2v-3h-2v3zm4 0h2v-3h-2v3zm4 0h2v-3h-2v3z' },
  warehouse: { label: 'Warehouse', cat: 'Property', d: 'M2 21V9l10-5 10 5v12H2zm3-2h14v-8H5v8zm2-6h10v6H7v-6z' },
  plot: { label: 'Land / plot', cat: 'Property', d: 'M3 4h18v16H3V4zm2 2v12h14V6H5zm2 2h10v8H7V8zm2 2v4h6v-4H9z' },
  construction: { label: 'Under construction', cat: 'Property', d: 'M3 21v-2h18v2H3zM6 3h3l1 5h4l1-5h3l-2 14H8L6 3zm3.6 4l1.2 8h2.4l1.2-8H9.6z' },
  hotel: { label: 'Hotel', cat: 'Property', d: 'M2 20V9a2 2 0 012-2h5a4 4 0 014 4v3h5a2 2 0 012 2v4h2v2H0v-2h2zm4-6a2 2 0 100-4 2 2 0 000 4z' },
  key: { label: 'For sale / key', cat: 'Property', d: 'M14 2a6 6 0 100 12 6 6 0 000-12zm0 3a3 3 0 110 6 3 3 0 010-6zM9.8 12.8L3 19.6V22h3.4l1-1v-2h2v-2h2l1.4-1.4-3-2.8z' },

  /* ---------------- Places ---------------- */
  school: { label: 'School', cat: 'Places', d: 'M12 3L1 9l4 2.18v6L12 21l7-3.82v-6l2-1.09V17h2V9L12 3zm6.82 6L12 12.72 5.18 9 12 5.28 18.82 9zM17 15.99l-5 2.73-5-2.73v-3.72L12 15l5-2.73v3.72z' },
  college: { label: 'College', cat: 'Places', d: 'M4 10l8-5 8 5-8 5-8-5zm2 6v-3l6 3.8L18 13v3l-6 3.8L6 16zM3 11v6H1v-6h2z' },
  hospital: { label: 'Hospital', cat: 'Places', d: 'M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6V4z' },
  pharmacy: { label: 'Pharmacy', cat: 'Places', d: 'M6 2h12v3H6V2zm-1 5h14l-1.5 14h-11L5 7zm6 2v3H8v2h3v3h2v-3h3v-2h-3V9h-2z' },
  bank: { label: 'Bank', cat: 'Places', d: 'M12 2l10 5v2H2V7l10-5zM4 11h2v7H4v-7zm5 0h2v7H9v-7zm5 0h2v7h-2v-7zm5 0h2v7h-2v-7zM2 20h20v2H2v-2z' },
  mall: { label: 'Mall', cat: 'Places', d: 'M4 8h16l-1 12H5L4 8zm3-3a5 5 0 0110 0v3h-2V5a3 3 0 00-6 0v3H7V5z' },
  shop: { label: 'Shop', cat: 'Places', d: 'M4 3h16l1.5 5a3 3 0 01-5.5 1.7A3 3 0 0112 10a3 3 0 01-4 -0.3A3 3 0 012.5 8L4 3zm0 9.5V21h16v-8.5a5 5 0 01-4-1.1 5 5 0 01-8 0 5 5 0 01-4 1.1zM7 15h5v4H7v-4z' },
  restaurant: { label: 'Restaurant', cat: 'Places', d: 'M7 2v8a3 3 0 002 2.8V22h2V12.8A3 3 0 0013 10V2h-2v7H10V2H8v7H7V2zm10 0c-1.7 0-3 2.7-3 6 0 2.6.9 4.4 2 5V22h2V2z' },
  cafe: { label: 'Cafe', cat: 'Places', d: 'M3 5h14v8a5 5 0 01-5 5H8a5 5 0 01-5-5V5zm14 2h2a3 3 0 010 6h-2V7zm0 2v2h2a1 1 0 000-2h-2zM2 20h16v2H2v-2z' },
  gym: { label: 'Gym', cat: 'Places', d: 'M2 9h2v6H2V9zm3-2h3v10H5V7zm4 4h6v2H9v-2zm7-4h3v10h-3V7zm4 2h2v6h-2V9z' },
  cinema: { label: 'Cinema', cat: 'Places', d: 'M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm0 3v2h2V7H4zm14 0v2h2V7h-2zM4 11v2h2v-2H4zm14 0v2h2v-2h-2zM4 15v2h2v-2H4zm14 0v2h2v-2h-2zM8 7v10h8V7H8z' },
  police: { label: 'Police', cat: 'Places', d: 'M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5l8-3zm0 5l-1.2 2.6L8 10l2 2-.5 3 2.5-1.4L14.5 15 14 12l2-2-2.8-.4L12 7z' },
  fire: { label: 'Fire station', cat: 'Places', d: 'M12 2s5 5 5 9a5 5 0 01-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 1.5 0 1.5-2 1-3.5-.5-1.5 0-3 0-4zM6 20h12v2H6v-2z' },
  temple: { label: 'Temple', cat: 'Places', d: 'M12 2l7 5H5l7-5zM4 8h16v2H4V8zm2 3h12v9h-3v-5h-2v5h-2v-5H9v5H6v-9z' },
  church: { label: 'Church', cat: 'Places', d: 'M11 2h2v3h3v2h-3v3.2l6 3.4V22h-6v-5h-2v5H3v-8.4l6-3.4V7H6V5h3V2h2z' },
  mosque: { label: 'Mosque', cat: 'Places', d: 'M12 2c2 2.5 4 4 4 6.5 0 1-.4 1.9-1 2.5h2v11H7V11h2a3.5 3.5 0 01-1-2.5C8 6 10 4.5 12 2zM3 9h2v13H3V9zm16 0h2v13h-2V9z' },
  library: { label: 'Library', cat: 'Places', d: 'M4 3h5a3 3 0 013 2 3 3 0 013-2h5v16h-5a3 3 0 00-3 2 3 3 0 00-3-2H4V3zm2 2v12h3a5 5 0 012 .4V7a2 2 0 00-2-2H6zm12 0h-3a2 2 0 00-2 2v10.4A5 5 0 0115 17h3V5z' },
  museum: { label: 'Museum', cat: 'Places', d: 'M12 2l10 5v2H2V7l10-5zM5 11h2v7H5v-7zm4.5 0h2v7h-2v-7zm4.5 0h2v7h-2v-7zm4.5 0h2v7h-2v-7zM3 20h18v2H3v-2z' },
  post: { label: 'Post office', cat: 'Places', d: 'M2 5h20v14H2V5zm2.5 2L12 12l7.5-5h-15zM4 8.4V17h16V8.4l-8 5.3-8-5.3z' },
  office_gov: { label: 'Government', cat: 'Places', d: 'M12 2l9 4v2H3V6l9-4zm-7 8h2v8H5v-8zm4.5 0h2v8h-2v-8zm4.5 0h2v8h-2v-8zm4.5 0h2v8h-2v-8zM3 19h18v3H3v-3z' },
  market: { label: 'Supermarket', cat: 'Places', d: 'M2 3h3l3 12h10l2-8H8m10 12a2 2 0 11-4 0 2 2 0 014 0zm-8 0a2 2 0 11-4 0 2 2 0 014 0z' },

  /* ---------------- Transport ---------------- */
  airport: { label: 'Airport', cat: 'Transport', d: 'M21 16v-2l-8-5V3.5a1.5 1.5 0 00-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1L15 22v-1.5L13 19v-5.5l8 2.5z' },
  railway: { label: 'Railway', cat: 'Transport', d: 'M12 2c-4 0-8 .5-8 4v9.5a3.5 3.5 0 003.5 3.5L6 20v1h12v-1l-1.5-1a3.5 3.5 0 003.5-3.5V6c0-3.5-4-4-8-4zm-4.5 15a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm3.5-7H6V6h5v4zm2 0V6h5v4h-5zm3.5 7a1.5 1.5 0 110-3 1.5 1.5 0 010 3z' },
  metro: { label: 'Metro', cat: 'Transport', d: 'M12 2a10 10 0 100 20 10 10 0 000-20zM8 8h2l2 4 2-4h2v8h-2v-4l-2 3-2-3v4H8V8z' },
  bus: { label: 'Bus', cat: 'Transport', d: 'M6 3h12a2 2 0 012 2v11a2 2 0 01-2 2v2h-2v-2H8v2H6v-2a2 2 0 01-2-2V5a2 2 0 012-2zm1 4v5h10V7H7zm1 8a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm8 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z' },
  car: { label: 'Car', cat: 'Transport', d: 'M5 11l1.5-4.5A2 2 0 018.4 5h7.2a2 2 0 011.9 1.5L19 11h1a1 1 0 011 1v5h-2v2h-3v-2H8v2H5v-2H3v-5a1 1 0 011-1h1zm2.2 0h9.6l-1-3H8.2l-1 3zM6.5 16a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm11 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z' },
  taxi: { label: 'Taxi', cat: 'Transport', d: 'M9 2h6v2h-2v1h2.6a2 2 0 011.9 1.4L19 11h1a1 1 0 011 1v5h-2v2h-3v-2H8v2H5v-2H3v-5a1 1 0 011-1h1l1.5-4.6A2 2 0 018.4 5H11V4H9V2zm-1.8 9h9.6l-1-3H8.2l-1 3zM6.5 16a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm11 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z' },
  parking: { label: 'Parking', cat: 'Transport', d: 'M4 3h16v18H4V3zm5 4v10h2.5v-3H13a3.5 3.5 0 000-7H9zm2.5 2H13a1.5 1.5 0 010 3h-1.5V9z' },
  fuel: { label: 'Fuel', cat: 'Transport', d: 'M3 3h10v18H3V3zm2 2v6h6V5H5zm10 1.5l2 2V17a1 1 0 002 0v-6h-2V8l-3-3 1-1 3 3v9a3 3 0 01-6 0V6.5z' },
  highway: { label: 'Highway', cat: 'Transport', d: 'M9 2h6l3 20h-4l-.5-4h-3L10 22H6L9 2zm2.2 2l-.4 3h2.4l-.4-3h-1.6zm-.7 5l-.4 3h3.8l-.4-3h-3zm-.7 5l-.4 3h4.6l-.4-3h-3.8z' },
  port: { label: 'Port', cat: 'Transport', d: 'M11 2h2v3h3v2h-3v9.9a6 6 0 004.9-4.9H16l3-4 3 4h-2a8 8 0 01-16 0H2l3-4 3 4H6.1A6 6 0 0011 16.9V7H8V5h3V2z' },
  bike: { label: 'Bike', cat: 'Transport', d: 'M6 13a4 4 0 100 8 4 4 0 000-8zm12 0a4 4 0 100 8 4 4 0 000-8zM14 4h4v2h-2.6l1 2.4L14 11l-3-3-2 3H6v-2h2l3-4.5L14 7V4z' },
  truck: { label: 'Truck', cat: 'Transport', d: 'M2 5h11v10H2V5zm12 3h3.5l2.5 3.5V15h-6V8zM6 20a2 2 0 100-4 2 2 0 000 4zm11 0a2 2 0 100-4 2 2 0 000 4z' },
  walk: { label: 'Walking', cat: 'Transport', d: 'M13 2a2 2 0 110 4 2 2 0 010-4zm-1.5 5h3l2.5 5-2 1-1-2v11h-2v-5h-1.5v5h-2V13l-2 3-1.7-1 3.2-6 3.5-2z' },

  /* ---------------- Nature & leisure ---------------- */
  tree: { label: 'Park / tree', cat: 'Nature & leisure', d: 'M12 2L5 12h4v3l-3 5h12l-3-5v-3h4L12 2z' },
  garden: { label: 'Garden', cat: 'Nature & leisure', d: 'M12 2a4 4 0 014 4c0 1.5-.8 2.8-2 3.4V12h4a4 4 0 01-4 4h-1v6h-2v-6H10a4 4 0 01-4-4h4V9.4A4 4 0 018 6a4 4 0 014-4z' },
  water: { label: 'Water', cat: 'Nature & leisure', d: 'M12 2s7 7.6 7 12a7 7 0 01-14 0c0-4.4 7-12 7-12zm0 4.6C10.2 9 7 13 7 14a5 5 0 0010 0c0-1-3.2-5-5-7.4z' },
  beach: { label: 'Beach', cat: 'Nature & leisure', d: 'M13 3a8 8 0 018 8l-8-2 3 13h-2L11 9 3 11a8 8 0 018-8h2z' },
  mountain: { label: 'Hill / mountain', cat: 'Nature & leisure', d: 'M12 4l5 8-2.5 1.5L12 9.6 6 20H2L12 4zm3 8.5L22 20h-8.5l-2-3.2L15 12.5z' },
  golf: { label: 'Golf', cat: 'Nature & leisure', d: 'M10 2l9 4-9 4V2zm-1 9.2V19a3 3 0 003 3h5v-2h-5a1 1 0 01-1-1v-7.8h-2z' },
  pool: { label: 'Pool', cat: 'Nature & leisure', d: 'M7 3h2v4h6V3h2v11H7V3zm2 6v3h6V9H9zM2 17c1.5 0 1.5 1.5 3.3 1.5S7 17 8.6 17s1.5 1.5 3.3 1.5S13.5 17 15.2 17s1.5 1.5 3.3 1.5S20 17 22 17v2c-1.5 0-1.5 1.5-3.3 1.5S17 19 15.2 19s-1.5 1.5-3.3 1.5S10.5 19 8.6 19s-1.5 1.5-3.3 1.5S3.5 19 2 19v-2z' },
  playground: { label: 'Playground', cat: 'Nature & leisure', d: 'M12 2l9 4v2l-3-1.3V22h-2V12H8v10H6V6.7L3 8V6l9-4zm-4 8h8V6.6l-4-1.8-4 1.8V10z' },
  stadium: { label: 'Stadium', cat: 'Nature & leisure', d: 'M12 4c5.5 0 10 1.8 10 4v4c0 2.2-4.5 4-10 4S2 14.2 2 12V8c0-2.2 4.5-4 10-4zm0 2C7.6 6 4 7.3 4 8s3.6 2 8 2 8-1.3 8-2-3.6-2-8-2z' },
  camp: { label: 'Camp', cat: 'Nature & leisure', d: 'M12 2l10 18h-9l-1-2-1 2H2L12 2zm0 4.5L6.3 18h3.2l2.5-4.6 2.5 4.6h3.2L12 6.5z' },

  /* ---------------- Infrastructure ---------------- */
  power: { label: 'Power', cat: 'Infrastructure', d: 'M13 2L4 14h6l-1 8 9-12h-6l1-8z' },
  tower: { label: 'Telecom tower', cat: 'Infrastructure', d: 'M12 2a3 3 0 013 3 3 3 0 01-1.2 2.4L18 22h-2.2l-1.1-4H9.3l-1.1 4H6l4.2-14.6A3 3 0 019 5a3 3 0 013-3zm0 8.6L10 16h4l-2-5.4z' },
  solar: { label: 'Solar', cat: 'Infrastructure', d: 'M2 4h20l-2.5 11H4.5L2 4zm3 2l.7 3h12.6l.7-3H5zm1.2 5l.7 4h10.2l.7-4H6.2zM11 17h2v3h4v2H7v-2h4v-3z' },
  watertank: { label: 'Water tank', cat: 'Infrastructure', d: 'M6 2h12v3H6V2zm1 4h10v7a5 5 0 01-10 0V6zm2 2v5a3 3 0 006 0V8H9zm2 10h2v4h-2v-4z' },
  sewage: { label: 'Sewage / drain', cat: 'Infrastructure', d: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 2.5A7.5 7.5 0 0119.5 12H15a3 3 0 00-6 0H4.5A7.5 7.5 0 0112 4.5zM4.5 14h5.2a3 3 0 004.6 0h5.2A7.5 7.5 0 014.5 14z' },
  crane: { label: 'Crane / development', cat: 'Infrastructure', d: 'M3 3h11v2h6v2h-4v3h-2V7h-1v14h-2V7H5v14H3V3zm2 2v2h5V5H5zm11 6h3v6h-3v-6z' },
  bridge: { label: 'Bridge', cat: 'Infrastructure', d: 'M2 8h20v2h-3v3a4 4 0 00-4 4H9a4 4 0 00-4-4V10H2V8zm5 2v3.5A6 6 0 019 17h6a6 6 0 012-3.5V10H7zM2 19h20v2H2v-2z' },
  factory: { label: 'Plant', cat: 'Infrastructure', d: 'M2 21V11l5 3V11l5 3V6h3v8l5-3v10H2zm3-2h3v-3H5v3zm5 0h3v-3h-3v3zm5 0h3v-3h-3v3z' },
};

const ICON_KEYS = Object.keys(ICON_LIBRARY);

/**
 * @param {string} key @param {string} [color] fill
 * @param {string} [outline] draw a keyline in this colour around the glyph
 * @returns {string} the raw path markup for one icon.
 */
function iconPaths(key, color, outline) {
  const icon = ICON_LIBRARY[key] || ICON_LIBRARY.pin;
  const fill = esc(color || '#0A1E3C');
  // paint-order="stroke" puts the stroke *behind* the fill, so the keyline
  // grows outward instead of eating half its width into the shape. Without it
  // a 2px stroke visibly thins every glyph it is applied to.
  const stroke = outline
    ? ` stroke="${esc(outline)}" stroke-width="1.4" stroke-linejoin="round" paint-order="stroke"`
    : '';
  return (Array.isArray(icon.d) ? icon.d : [icon.d])
    .map(d => `<path fill="${fill}"${stroke} d="${d}"/>`)
    .join('');
}

/**
 * A complete tinted `<svg>` for one icon key — what the map markers use.
 * @param {string} key @param {string} [color] @param {string} [outline]
 */
function svgForKey(key, color, outline) {
  const stroked = outline ? ' overflow="visible"' : '';
  return `<svg viewBox="0 0 24 24"${stroked} xmlns="http://www.w3.org/2000/svg">${iconPaths(key, color, outline)}</svg>`;
}

/**
 * Icon keys grouped by category, in ICON_CATEGORIES order, with any category
 * not named there appended rather than dropped.
 * @returns {Array<{cat:string, keys:string[]}>}
 */
function iconsByCategory() {
  const groups = new Map();
  for (const key of ICON_KEYS) {
    const cat = ICON_LIBRARY[key].cat || 'Other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(key);
  }
  const ordered = [];
  for (const cat of ICON_CATEGORIES) if (groups.has(cat)) { ordered.push({ cat, keys: groups.get(cat) }); groups.delete(cat); }
  for (const [cat, keys] of groups) ordered.push({ cat, keys });
  return ordered;
}
