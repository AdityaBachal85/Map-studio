/**
 * map/contourRamps.js — the hypsometric colour vocabulary.
 *
 * One table, and everything else derives from it — the fill, the legend bar,
 * the legend's tick labels, the ramp picker's thumbnails and the 3D drape all
 * read these stops rather than carrying colours of their own. That is the same
 * arrangement map/connectivityStandard.js uses for line colours, and for the
 * same reason: the moment a second place writes down what "Rainbow" means, the
 * two drift and the legend stops describing the map.
 *
 * A ramp is a list of `[t, hex]` stops with `t` from 0 to 1, where 0 is the
 * lowest elevation in the selected area and 1 the highest. The stops are
 * RELATIVE, not absolute metres: a ramp has to work over a 40 m river plain and
 * a 3,000 m hill range without being redefined, and a reader compares colours
 * against the legend beside them rather than against a remembered scale.
 *
 * Interpolation is in plain sRGB. HSV would give more vivid mid-tones on the
 * rainbow, and would also swing the hue the long way round between two stops
 * that happen to sit either side of red — magenta appearing in the middle of a
 * green-to-orange blend is worse than a slightly duller blend.
 */

/**
 * @typedef {object} ContourRamp
 * @property {string} id
 * @property {string} label
 * @property {Array<[number, string]>} stops  `[position 0..1, hex]`, ascending.
 * @property {string} [note] Shown in the picker when the choice needs a word.
 */

/** @type {ContourRamp[]} */
const CONTOUR_RAMPS = [
  {
    // The one on screen in every contour app, and the one the operator asked
    // for. It is not a good scientific ramp — the eye reads yellow as a step
    // change rather than a smooth rise — but it is what a client expects a
    // contour map to look like, and it separates adjacent bands hard, which is
    // exactly what you want when the bands ARE the information.
    id: 'rainbow',
    label: 'Rainbow',
    stops: [
      [0.00, '#2B1A9E'], [0.14, '#1E5FE0'], [0.30, '#12B5D6'],
      [0.45, '#1CD46A'], [0.58, '#8CE81F'], [0.70, '#E8DC1F'],
      [0.82, '#F09A18'], [0.92, '#E2461A'], [1.00, '#8C1111'],
    ],
  },
  {
    // What a printed survey sheet looks like: lowland green, upland brown,
    // rock and snow at the top. Reads as terrain without a legend, which the
    // rainbow does not.
    id: 'terrain',
    label: 'Terrain',
    stops: [
      [0.00, '#2E6B3E'], [0.22, '#6E9B4A'], [0.42, '#B9B067'],
      [0.62, '#A57C4E'], [0.80, '#7C5A44'], [0.92, '#B9AFA8'],
      [1.00, '#FFFFFF'],
    ],
  },
  {
    // Perceptually uniform: equal steps in elevation look like equal steps in
    // colour, and it survives being printed in greyscale or read by someone
    // with red-green colour blindness. The honest default for anything the
    // reader is meant to measure rather than admire.
    id: 'viridis',
    label: 'Viridis',
    note: 'Even steps, colour-blind safe',
    stops: [
      [0.00, '#440154'], [0.25, '#3B528B'], [0.50, '#21918C'],
      [0.75, '#5EC962'], [1.00, '#FDE725'],
    ],
  },
  {
    // For when the contours are the subject and the ground under them is
    // context — over satellite imagery especially, where a saturated fill
    // fights the photograph.
    id: 'mono',
    label: 'Greyscale',
    stops: [[0.00, '#1B1B1B'], [0.50, '#8A8A8A'], [1.00, '#F5F5F5']],
  },
  {
    // The four logo colours, in the order they run light-to-dark, so a contour
    // map drops into a DBOT deck without looking borrowed from another tool.
    // Same four hexes as the connectivity standard and the colour presets.
    id: 'dbot',
    label: 'DBOT brand',
    stops: [
      [0.00, '#002166'], [0.38, '#0073C6'], [0.72, '#7ED236'], [1.00, '#E2BD60'],
    ],
  },
];

/** @param {string} id @returns {ContourRamp} the ramp, or the first one. */
function contourRamp(id) {
  return CONTOUR_RAMPS.find(r => r.id === id) || CONTOUR_RAMPS[0];
}

/**
 * The colour at a position along a ramp.
 *
 * @param {ContourRamp} ramp
 * @param {number} t 0..1; anything outside is clamped rather than extrapolated,
 *   because a NaN elevation (a void in the DEM) would otherwise paint a colour
 *   from nowhere on the scale.
 * @returns {{r:number, g:number, b:number}}
 */
function rampRgbAt(ramp, t) {
  const stops = ramp.stops;
  const x = !isFinite(t) ? 0 : Math.max(0, Math.min(1, t));

  let i = 0;
  while (i < stops.length - 2 && x > stops[i + 1][0]) i++;

  const [t0, c0] = stops[i];
  const [t1, c1] = stops[i + 1];
  const a = hexToRgb(c0) || { r: 0, g: 0, b: 0 };
  const b = hexToRgb(c1) || { r: 0, g: 0, b: 0 };
  // Two stops at the same position would divide by zero. That is a typo in the
  // table rather than a real case, but it would show up as a black band and
  // send someone hunting through the renderer for it.
  const span = t1 - t0;
  const f = span > 0 ? (x - t0) / span : 0;

  return {
    r: Math.round(a.r + (b.r - a.r) * f),
    g: Math.round(a.g + (b.g - a.g) * f),
    b: Math.round(a.b + (b.b - a.b) * f),
  };
}

/** @param {ContourRamp} ramp @param {number} t @returns {string} `#rrggbb` */
function rampHexAt(ramp, t) {
  const c = rampRgbAt(ramp, t);
  return rgbToHex(c.r, c.g, c.b);
}

/**
 * A 256-entry lookup table for the ramp.
 *
 * The fill colours one pixel per DEM sample — a 900x900 grid is 810,000
 * `rampRgbAt` calls, each of them a stop search plus two hex parses. Resolving
 * the ramp once into a byte array turns that into an array index.
 *
 * @param {ContourRamp} ramp
 * @returns {Uint8ClampedArray} 256 * 3 bytes, r,g,b per step.
 */
function rampLut(ramp) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const c = rampRgbAt(ramp, i / 255);
    lut[i * 3] = c.r; lut[i * 3 + 1] = c.g; lut[i * 3 + 2] = c.b;
  }
  return lut;
}

/**
 * The exact colour the fill paints at a position, read from the same table.
 *
 * `rampRgbAt` and the fill would agree to within a 255th, which is invisible —
 * and still wrong. The legend's whole job is to say what a colour on the map
 * means, so it reads the lookup the map was painted from, including its
 * rounding, rather than recomputing something almost identical.
 *
 * @param {Uint8ClampedArray} lut from rampLut()
 * @param {number} t 0..1
 * @returns {string} `#rrggbb`
 */
function rampLutHexAt(lut, t) {
  const x = !isFinite(t) ? 0 : Math.max(0, Math.min(1, t));
  const s = (x * 255) | 0;
  return rgbToHex(lut[s * 3], lut[s * 3 + 1], lut[s * 3 + 2]);
}

/**
 * A CSS gradient for the ramp, for the legend bar and the picker thumbnails.
 *
 * @param {ContourRamp} ramp
 * @param {string} [dir] gradient direction; the legend bar runs bottom-to-top
 *   because high ground belongs at the top of a scale.
 * @returns {string}
 */
function rampGradientCss(ramp, dir) {
  const stops = ramp.stops.map(([t, hex]) => hex + ' ' + (t * 100).toFixed(1) + '%');
  return 'linear-gradient(' + (dir || 'to top') + ',' + stops.join(',') + ')';
}

// Node (the headless maths diagnostic) has no <script> tags; the browser has no
// module system here. Exporting only when `module` exists satisfies both.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CONTOUR_RAMPS, contourRamp, rampRgbAt, rampHexAt, rampLut, rampLutHexAt, rampGradientCss };
}
