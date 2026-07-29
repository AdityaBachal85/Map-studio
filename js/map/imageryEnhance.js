/**
 * map/imageryEnhance.js — imagery colour grading.
 *
 * Esri World Imagery is supplied close to as-captured: accurate, but flat and
 * slightly hazy next to Google's satellite view, which is noticeably graded for
 * contrast and saturation. That difference is most of what "the satellite
 * imagery does not feel premium" describes — the resolution is comparable, the
 * processing is not.
 *
 * Grading is applied as a filter rather than baked into the pixels, so it costs
 * one GPU shader on screen and one canvas filter on export, and can be turned
 * off entirely. It is deliberately restrained: these are property maps, and an
 * over-graded aerial reads as a photo filter rather than a survey. `natural` is
 * the default because it is the strongest setting that still looks untouched.
 *
 * Only photographic basemaps are graded. Street and canvas basemaps are already
 * designed cartography — grading them just makes them look wrong.
 */

/**
 * @typedef {object} ImageryLook
 * @property {string} label   Shown in the UI.
 * @property {string} hint    One-line description of the intent.
 * @property {string} filter  CSS/canvas filter string; `''` means no filtering.
 */

/** @type {Object<string, ImageryLook>} */
const IMAGERY_LOOKS = {
  off: {
    label: 'Off',
    hint: 'raw provider imagery',
    filter: '',
  },
  natural: {
    label: 'Natural',
    hint: 'lifts haze, keeps true colour',
    filter: 'saturate(1.07) contrast(1.04)',
  },
  vivid: {
    label: 'Vivid',
    hint: 'stronger greens and water',
    filter: 'saturate(1.24) contrast(1.08) brightness(1.02)',
  },
  crisp: {
    label: 'Crisp',
    hint: 'maximum edge definition for print',
    filter: 'saturate(1.12) contrast(1.16) brightness(1.01)',
  },
};

const DEFAULT_IMAGERY_LOOK = 'natural';

/** CSS custom property the tile pane reads. */
const IMAGERY_FILTER_VAR = '--imageryFilter';

/** The look currently in effect. Persisted through prefs. */
let currentImageryLook = DEFAULT_IMAGERY_LOOK;

/**
 * Resolve a look id to its filter string, or `'none'` when it should not apply.
 * @param {string} id
 * @param {boolean} isImagery True when the active basemap is photographic.
 * @returns {string} A value valid for both CSS `filter` and canvas `ctx.filter`.
 */
function imageryFilterFor(id, isImagery) {
  const look = IMAGERY_LOOKS[id] || IMAGERY_LOOKS[DEFAULT_IMAGERY_LOOK];
  if (!isImagery || !look.filter) return 'none';
  return look.filter;
}

/**
 * Apply a look to the live map.
 * @param {string} id Look id.
 * @param {boolean} isImagery True when the active basemap is photographic.
 */
function applyImageryLook(id, isImagery) {
  currentImageryLook = IMAGERY_LOOKS[id] ? id : DEFAULT_IMAGERY_LOOK;
  document.documentElement.style.setProperty(
    IMAGERY_FILTER_VAR, imageryFilterFor(currentImageryLook, isImagery));
}

/** @returns {string} The active look id. */
function getImageryLook() { return currentImageryLook; }

/**
 * The filter to apply when rasterising for export, so a PNG or PPTX matches
 * what is on screen. Returns `'none'` when nothing should be applied.
 * @param {boolean} isImagery
 * @returns {string}
 */
function imageryExportFilter(isImagery) {
  return imageryFilterFor(currentImageryLook, isImagery);
}

// Adopt the saved choice before mapEngine's first setBasemap() call, so the
// map never paints ungraded and then flicker-corrects itself.
if (typeof getPref === 'function') {
  const saved = getPref('imageryLook');
  if (IMAGERY_LOOKS[saved]) currentImageryLook = saved;
}

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IMAGERY_LOOKS, DEFAULT_IMAGERY_LOOK, imageryFilterFor };
}
