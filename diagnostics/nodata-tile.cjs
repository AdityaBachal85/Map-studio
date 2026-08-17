/**
 * The "Map data not yet available" detector.
 *
 * This is what lets the map back off to the deepest zoom a service really has
 * instead of filling with placeholders. It has now failed twice, both times by
 * being too specific about what the placeholder LOOKS like rather than what
 * makes it a placeholder: once on brightness, once on hue. The cases below pin
 * the tint that broke it, and the real-imagery samples that must keep working.
 *
 *   node diagnostics/nodata-tile.cjs
 */
const path = require('path');
const { looksLikeNoDataTile } = require(path.join(__dirname, '..', 'js', 'map', 'basemapProviders.js'));

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

/** Four corners of one flat colour, plus a little JPEG noise. */
const flat = (r, g, b, noise) => {
  const j = n => Math.max(0, Math.min(255, n + (noise ? (Math.random() * noise - noise / 2) : 0)));
  return [].concat(
    [j(r), j(g), j(b), 255], [j(r), j(g), j(b), 255],
    [j(r), j(g), j(b), 255], [j(r), j(g), j(b), 255]);
};
const corners = (...quads) => [].concat(...quads.map(q => q.concat([255])));

// THE ONE THAT BROKE IT: the lavender placeholder in the report, ~(198,200,222).
ck('the lavender placeholder is recognised', looksLikeNoDataTile(flat(198, 200, 222)) === true);
ck('...and still is with JPEG noise on it', looksLikeNoDataTile(flat(198, 200, 222, 8)) === true);

// The older neutral-grey placeholder must not regress.
ck('the older grey placeholder is still recognised', looksLikeNoDataTile(flat(220, 220, 220)) === true);
ck('a slightly warm grey placeholder too', looksLikeNoDataTile(flat(226, 223, 216)) === true);

// Real aerial photography: corners disagree.
ck('vegetation and rooftops are not a placeholder',
  looksLikeNoDataTile(corners([72, 96, 54], [188, 176, 160], [120, 118, 96], [210, 205, 198])) === false);
ck('a mostly-pale urban tile with variation is not a placeholder',
  looksLikeNoDataTile(corners([206, 202, 198], [188, 180, 176], [220, 216, 210], [170, 168, 165])) === false);

// The realistic uniform-tile false positives, excluded by brightness.
ck('deep water is too dark to be mistaken for it', looksLikeNoDataTile(flat(28, 52, 78)) === false);
ck('bright cloud is too light to be mistaken for it', looksLikeNoDataTile(flat(254, 254, 254)) === false);
ck('a flat but strongly coloured tile is left alone', looksLikeNoDataTile(flat(120, 200, 235)) === false);

// Transparent overlay tiles are not the imagery layer's problem.
ck('a transparent tile is not a placeholder',
  looksLikeNoDataTile([220, 220, 220, 0, 220, 220, 220, 0, 220, 220, 220, 0, 220, 220, 220, 0]) === false);
ck('too few samples is not an answer', looksLikeNoDataTile([220, 220, 220, 255]) === false);

console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
process.exit(R.every(Boolean) ? 0 : 1);
