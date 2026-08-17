/**
 * The road joiner, exercised directly — no browser, no Overpass.
 *
 * "Why is the road still in pieces" was a joiner that only ever compared
 * fragments inside one class, while OSM re-tags a road as its importance
 * changes along its length. These cases pin both halves of the fix: pieces of
 * one road must merge across classes and across spelling variants, and roads
 * that merely touch must not.
 *
 *   node diagnostics/road-join.cjs
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'services', 'ringFeatures.js'), 'utf8');
const ctx = {};
new Function('exports', src + `
  exports.joinRingFeatures = joinRingFeatures;
  exports.roadNameKey = roadNameKey;
`)(ctx);

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

// A road running west->east across four OSM ways, re-tagged mid-length:
// primary (classId 'highway') then secondary (classId 'arterial').
const seg = (a, b) => [[19.10, a], [19.10, b]];
const road = [
  { kind: 'line', classId: 'highway',  name: 'L.B.S. Marg', pts: seg(72.80, 72.85), km: 5 },
  { kind: 'line', classId: 'highway',  name: 'LBS Marg',    pts: seg(72.85, 72.90), km: 5 },
  { kind: 'line', classId: 'arterial', name: 'L B S  Marg', pts: seg(72.90, 72.95), km: 5 },
  { kind: 'line', classId: 'arterial', name: 'LBS Marg',    pts: seg(72.95, 73.00), km: 5 },
];
const joined = ctx.joinRingFeatures(road.map(f => Object.assign({}, f)));
ck('four pieces across two classes become one road', joined.length === 1,
   joined.length + ' row(s): ' + joined.map(f => f.name + '/' + f.classId).join(', '));
if (joined.length === 1) {
  ck('the joined road spans the whole length',
     Math.abs(joined[0].pts[0][1] - 72.80) < 1e-9
     && Math.abs(joined[0].pts[joined[0].pts.length - 1][1] - 73.00) < 1e-9,
     JSON.stringify([joined[0].pts[0], joined[0].pts[joined[0].pts.length - 1]]));
  ck('it counts all four parts', joined[0].parts === 4, 'parts=' + joined[0].parts);
}

// Name normalisation
ck('name keys ignore dots, case and spacing',
   ctx.roadNameKey('L.B.S. Marg') === ctx.roadNameKey('LBS  marg'),
   ctx.roadNameKey('L.B.S. Marg') + ' vs ' + ctx.roadNameKey('LBS  marg'));
ck('but Road and Marg stay different roads',
   ctx.roadNameKey('Station Road') !== ctx.roadNameKey('Station Marg'));

// Two DIFFERENT roads that touch must NOT merge.
const touching = [
  { kind: 'line', classId: 'highway',  name: 'Andheri Kurla Road', pts: seg(72.80, 72.85), km: 5 },
  { kind: 'line', classId: 'arterial', name: 'Sahar Road',         pts: seg(72.85, 72.90), km: 5 },
];
const t = ctx.joinRingFeatures(touching.map(f => Object.assign({}, f)));
ck('different roads that touch stay separate', t.length === 2,
   t.length + ' row(s): ' + t.map(f => f.name).join(', '));

// An unnamed connector must not bridge two classes.
const bridge = [
  { kind: 'line', classId: 'highway',  name: 'Road A', pts: seg(72.80, 72.85), km: 5 },
  { kind: 'line', classId: 'arterial', name: null,     pts: seg(72.85, 72.90), km: 5 },
  { kind: 'line', classId: 'highway',  name: 'Road B', pts: seg(72.90, 72.95), km: 5 },
];
const br = ctx.joinRingFeatures(bridge.map(f => Object.assign({}, f)));
ck('an unnamed piece does not bridge two different named roads', br.length >= 2,
   br.length + ' row(s): ' + br.map(f => (f.name || '(unnamed)')).join(', '));

// Points and areas still pass straight through.
const mixed = ctx.joinRingFeatures([
  { kind: 'point', classId: 'station', name: 'Ghatkopar', lat: 19.1, lng: 72.9 },
  { kind: 'area', classId: 'green', name: 'Park', polys: [[[[19.1, 72.9]]]] },
]);
ck('points and areas pass through untouched', mixed.length === 2);

console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
process.exit(R.every(Boolean) ? 0 : 1);
