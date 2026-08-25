/**
 * parseCoord, proved without a browser: plain decimal degrees, and now
 * degrees-minutes-seconds — "19°22'37.1"N 73°10'10.4"E", copied off a phone's
 * GPS app or Google Earth.
 *
 * The one rule this exists to protect: a string carrying a degree mark must
 * NEVER reach the decimal split-by-comma path. `parseFloat` stops at the
 * first character it cannot read rather than failing, so
 * `parseFloat("19°22'37.1\"N")` silently returns 19 — the minutes and seconds
 * just vanish. A comma-joined DMS pair fed to the old path would have handed
 * back a coordinate several kilometres from the one pasted in, with no error
 * to say so. Several cases below exist specifically to catch that class of
 * silent-truncation regression, not just to confirm the happy path works.
 *
 *   node diagnostics/coord-parse.cjs
 *
 * No server and no network: it requires the app's own file directly.
 */
const path = require('path');
const REPO = path.join(__dirname, '..');
const M = require(path.join(REPO, 'js/utils/math.js'));

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

/** Are two numbers within tol of each other? */
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-6 : tol);

/** Expected decimal degrees from raw D/M/S, computed the same honest way the parser should. */
const dms = (d, m, s, hemi) => {
  const v = d + (m || 0) / 60 + (s || 0) / 3600;
  return /[SW]/i.test(hemi) ? -v : v;
};

/* ---- the existing decimal path: must be untouched ------------------------ */

ck('plain "lat, lng" still parses',
  (() => { const c = M.parseCoord('19.37697, 73.16956'); return c && near(c[0], 19.37697) && near(c[1], 73.16956); })());
ck('no space after the comma still parses',
  (() => { const c = M.parseCoord('19.37697,73.16956'); return c && near(c[0], 19.37697) && near(c[1], 73.16956); })());
// parseCoord has only ever split on a comma — space-only decimal separation
// is parseLatLngPair's territory (project/importSheet.js), a different
// function for the bulk importer. Not in scope here; asserted so a future
// change to the comma requirement doesn't silently drift.
ck('decimal with no comma at all is still rejected, same as before',
  M.parseCoord('19.076090 72.877426') === null);
ck('out-of-range decimal latitude is rejected', M.parseCoord('95, 73') === null);
ck('out-of-range decimal longitude is rejected', M.parseCoord('19, 195') === null);
ck('garbage text is rejected', M.parseCoord('hello there') === null);
ck('empty string is rejected', M.parseCoord('') === null);
ck('null input is rejected', M.parseCoord(null) === null);
ck('a single number with no pair is rejected', M.parseCoord('19.37697') === null);

/* ---- the DMS path ---------------------------------------------------------- */

const USER_EXAMPLE = '19°22\'37.1"N 73°10\'10.4"E';
const expectLat = dms(19, 22, 37.1, 'N'), expectLng = dms(73, 10, 10.4, 'E');

{
  const c = M.parseCoord(USER_EXAMPLE);
  ck('the user\'s own example parses', !!c, JSON.stringify(c));
  ck('and lands within a metre of the right spot',
    c && near(c[0], expectLat, 1e-5) && near(c[1], expectLng, 1e-5),
    c && JSON.stringify({ got: c, want: [expectLat, expectLng] }));
}

{
  const c = M.parseCoord('19°22\'37.1"N, 73°10\'10.4"E');
  ck('comma-separated DMS parses to the same place',
    c && near(c[0], expectLat, 1e-5) && near(c[1], expectLng, 1e-5), JSON.stringify(c));
}

{
  // This exact case is the regression this whole feature guards against: a
  // comma present, so the old path would have split it, parseFloat'd each
  // half down to just the degrees, and silently returned [19, 73] — a real
  // number, inside range, wrong by tens of kilometres, with no error raised.
  const c = M.parseCoord('19°22\'37.1"N, 73°10\'10.4"E');
  ck('and specifically does NOT silently truncate to degrees-only',
    c && !(near(c[0], 19, 1e-9) && near(c[1], 73, 1e-9)), JSON.stringify(c));
}

{
  const curly = '19°22’ 37.1”N 73°10’ 10.4”E';   // ’ and ”
  const prime = '19°22′ 37.1″N 73°10′ 10.4″E';   // ′ and ″
  const c1 = M.parseCoord(curly), c2 = M.parseCoord(prime);
  ck('curly quote/apostrophe minute-second marks parse',
    c1 && near(c1[0], expectLat, 1e-5) && near(c1[1], expectLng, 1e-5), JSON.stringify(c1));
  ck('prime/double-prime marks parse',
    c2 && near(c2[0], expectLat, 1e-5) && near(c2[1], expectLng, 1e-5), JSON.stringify(c2));
}

{
  const c = M.parseCoord('19°22\'37.1"n 73°10\'10.4"e');
  ck('lowercase hemisphere letters parse',
    c && near(c[0], expectLat, 1e-5) && near(c[1], expectLng, 1e-5), JSON.stringify(c));
}

{
  const c = M.parseCoord('19°22.5\'N 73°10.2\'E');
  const want = [dms(19, 22.5, 0, 'N'), dms(73, 10.2, 0, 'E')];
  ck('degrees-and-minutes with no seconds parses',
    c && near(c[0], want[0]) && near(c[1], want[1]), JSON.stringify({ got: c, want }));
}

{
  const c = M.parseCoord('19.377°N 73.170°E');
  ck('degree-only with a hemisphere letter parses',
    c && near(c[0], 19.377, 1e-4) && near(c[1], 73.170, 1e-4), JSON.stringify(c));
}

{
  const c = M.parseCoord('73°10\'10.4"E 19°22\'37.1"N');
  ck('lng-then-lat order resolves correctly by hemisphere letter, not position',
    c && near(c[0], expectLat, 1e-5) && near(c[1], expectLng, 1e-5), JSON.stringify(c));
}

{
  const c = M.parseCoord('19°22\'37.1"N73°10\'10.4"E');   // no separator at all
  ck('tokens run together with no separator still parse',
    c && near(c[0], expectLat, 1e-5) && near(c[1], expectLng, 1e-5), JSON.stringify(c));
}

{
  const c = M.parseCoord('19°22\'37.1"S 73°10\'10.4"W');
  ck('S and W hemispheres produce negative degrees',
    c && near(c[0], -expectLat, 1e-5) && near(c[1], -expectLng, 1e-5), JSON.stringify(c));
}

/* ---- malformed DMS is refused, not guessed at ----------------------------- */

ck('minutes >= 60 is rejected', M.parseCoord('19°60\'0"N 73°10\'0"E') === null);
ck('seconds >= 60 is rejected', M.parseCoord('19°22\'60"N 73°10\'0"E') === null);
ck('a degree mark with no hemisphere letters at all is refused, not guessed',
  M.parseCoord('19°22\'37.1" 73°10\'10.4"') === null);
ck('two halves on the same axis (both N) is rejected',
  M.parseCoord('19°22\'37.1"N 73°10\'10.4"N') === null);
ck('two halves on the same axis (both E) is rejected',
  M.parseCoord('19°22\'37.1"E 73°10\'10.4"E') === null);
ck('an out-of-range DMS latitude is rejected', M.parseCoord('95°0\'0"N 73°0\'0"E') === null);
ck('an out-of-range DMS longitude is rejected', M.parseCoord('19°0\'0"N 185°0\'0"E') === null);
ck('trailing garbage after a valid pair is rejected, not ignored',
  M.parseCoord('19°22\'37.1"N 73°10\'10.4"E and then some') === null);
ck('a decimal pair is never misread as DMS just because it has a comma',
  (() => { const c = M.parseCoord('19.37697, 73.16956'); return c && near(c[0], 19.37697); })());

console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
process.exit(R.every(Boolean) ? 0 : 1);
