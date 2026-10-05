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

/**
 * Road / label overlay treatments.
 *
 * Esri's reference tiles paint roads as broad, strongly saturated salmon bands
 * with dark road names on top. Over aerial imagery that reads as paint laid on
 * the photograph rather than as an annotation of it — the overlay wins the
 * image, which is the opposite of what a satellite basemap is for. Google draws
 * the same information thin, desaturated and slightly transparent, so the
 * imagery still carries the map and the roads only orient you.
 *
 * The geometry is baked into the raster, so line width cannot be changed. What
 * can be changed is weight of colour: pulling the saturation down turns the
 * salmon toward neutral grey, and a little transparency lets the ground show
 * through. That gets most of the way to the same effect.
 *
 * `subtle` is the default because the complaint about the stock rendering is
 * that it is overbearing. `bold` preserves the original Esri look for anyone
 * who wants maximum road legibility over a busy image.
 *
 * @type {Object<string, {label:string, hint:string, filter:string, opacity:number}>}
 */
const ROAD_LOOKS = {
  subtle: {
    label: 'Subtle',
    hint: 'desaturated and translucent, like Google over satellite',
    filter: 'saturate(0.18) brightness(1.06)',
    opacity: 0.78,
  },
  balanced: {
    label: 'Balanced',
    hint: 'muted, but roads still clearly coloured',
    filter: 'saturate(0.55)',
    opacity: 0.9,
  },
  bold: {
    label: 'Bold',
    hint: 'stock Esri rendering — strongest road legibility',
    filter: '',
    opacity: 1,
  },
  off: {
    label: 'Off',
    hint: 'pure imagery, no roads or labels',
    filter: '',
    opacity: 0,
  },
};

const DEFAULT_ROAD_LOOK = 'subtle';

/** CSS custom properties the reference tile layers read. */
const ROAD_FILTER_VAR = '--roadFilter';
const ROAD_OPACITY_VAR = '--roadOpacity';

let currentRoadLook = DEFAULT_ROAD_LOOK;

/**
 * Apply a road/label overlay treatment to the live map.
 * @param {string} id Look id.
 */
function applyRoadLook(id) {
  currentRoadLook = ROAD_LOOKS[id] ? id : DEFAULT_ROAD_LOOK;
  const look = ROAD_LOOKS[currentRoadLook];
  const root = document.documentElement.style;
  root.setProperty(ROAD_FILTER_VAR, look.filter || 'none');
  root.setProperty(ROAD_OPACITY_VAR, String(look.opacity));
  // Opacity cannot ride on the CSS variable: Leaflet writes style.opacity
  // inline on the layer container, and inline wins over a normal rule. The map
  // engine pushes it through Leaflet's own API instead.
  if (typeof syncRoadLayerOpacity === 'function') syncRoadLayerOpacity();
}

/** @returns {string} The active road look id. */
function getRoadLook() { return currentRoadLook; }

/** @returns {{filter:string, opacity:number}} Treatment to use when exporting. */
function roadExportStyle() {
  const look = ROAD_LOOKS[currentRoadLook] || ROAD_LOOKS[DEFAULT_ROAD_LOOK];
  return { filter: look.filter || 'none', opacity: look.opacity };
}

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
  const savedRoad = getPref('roadLook');
  if (ROAD_LOOKS[savedRoad]) currentRoadLook = savedRoad;
}
applyRoadLook(currentRoadLook);

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IMAGERY_LOOKS, DEFAULT_IMAGERY_LOOK, imageryFilterFor, ROAD_LOOKS, DEFAULT_ROAD_LOOK };
}
