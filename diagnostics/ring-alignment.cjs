/**
 * Two lines that run along each other, and what should happen to them.
 *
 * A ring scan draws every OSM way it finds, and OSM does not store a road the
 * way a map draws one. Two consequences the reader sees:
 *
 *   - A DIVIDED ROAD IS TWO WAYS. One per direction, ten to forty metres
 *     apart, never touching — so the joiner cannot chain them, and a four-lane
 *     highway arrived on the map as two parallel lines with the same name.
 *   - AN ELEVATED METRO IS MAPPED OVER THE ROAD IT FOLLOWS. Drawn, the two are
 *     the same line at any zoom a connectivity sheet uses, so one covered the
 *     other completely — and which one covered which was down to the order
 *     they happened to be added in.
 *
 * The maths that decides both is pure arithmetic over coordinate arrays, so it
 * is proved here with no browser and no network.
 *
 *   node diagnostics/ring-alignment.cjs
 */
const path = require('path');
const REPO = path.join(__dirname, '..');
const M = require(path.join(REPO, 'js/services/ringFeatures.js'));

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

/** Degrees of latitude per metre, near 19°N. */
const MLAT = 1 / 111320;
/** Degrees of longitude per metre, near 19°N. */
const MLNG = 1 / (111320 * Math.cos(19.1 * Math.PI / 180));

/** A straight west-east line `km` long at `lat`, sampled every 100 m. */
const eastLine = (lat, lng0, km) => {
  const out = [];
  for (let m = 0; m <= km * 1000; m += 100) out.push([lat, lng0 + m * MLNG]);
  return out;
};

/** The same line shifted `m` metres north. */
const shift = (pts, m) => pts.map(p => [p[0] + m * MLAT, p[1]]);

const line = (o) => Object.assign({ kind: 'line', classId: 'highway', name: null, ref: null,
  parts: 1, km: 0 }, o);

/* ---- the measurement itself ---------------------------------------------- */

const base = eastLine(19.1, 72.8, 4);

ck('a line follows itself completely',
  M.ringFollowFrac(base, base, 0.02) === 1, String(M.ringFollowFrac(base, base, 0.02)));
ck('a line 15 m away is inside a 45 m corridor',
  M.ringFollowFrac(shift(base, 15), base, 0.045) === 1);
ck('a line 120 m away is not',
  M.ringFollowFrac(shift(base, 120), base, 0.045) === 0,
  String(M.ringFollowFrac(shift(base, 120), base, 0.045)));
// Direction is not something the reader of a map can see, and the second
// carriageway of a road runs the other way.
ck('following is direction-blind',
  M.ringFollowFrac(shift(base, 15).slice().reverse(), base, 0.045) === 1);
// A road that starts out beside another and then leaves it is a different road.
const diverge = base.map((p, i) => [p[0] + (i > base.length / 2 ? (i - base.length / 2) * 8 : 0) * MLAT, p[1]]);
const dfrac = M.ringFollowFrac(diverge, base, 0.045);
ck('a line that peels away part-way through is only partly inside',
  dfrac > 0.3 && dfrac < 0.85, dfrac.toFixed(2));

// OSM puts fifty vertices round a curve and two down a straight kilometre, so
// walking the vertices would weigh the curve fifty times as heavily.
const lumpy = [[19.1, 72.8], [19.1, 72.81], [19.1, 72.8101], [19.1, 72.8102], [19.1, 72.8103]];
const sampled = M.ringSampleAlong(M.ringToLocalKm(lumpy, 19.1), 5);
const gaps = sampled.slice(1).map((p, i) => Math.hypot(p[0] - sampled[i][0], p[1] - sampled[i][1]));
ck('samples are evenly spaced along the line, not bunched at its vertices',
  Math.max(...gaps) - Math.min(...gaps) < 1e-9, gaps.map(g => g.toFixed(3)).join(' / '));

/* ---- a divided road is drawn once ---------------------------------------- */

const dual = M.collapseCarriageways([
  line({ name: 'Kalyan Padgha Road', pts: base, km: 4 }),
  line({ name: 'Kalyan Padgha Road', pts: shift(base, 18), km: 3.9 }),
]);
ck('two carriageways of one road are drawn once', dual.length === 1, dual.length + ' line(s)');
ck('and the longer one is what survives', dual[0] && dual[0].km === 4, String(dual[0] && dual[0].km));
ck('and it says it is both of them', dual[0] && dual[0].carriageways === 2,
  String(dual[0] && dual[0].carriageways));

// A grade-separated junction splits each direction again.
const four = M.collapseCarriageways([
  line({ name: 'NH 48', pts: base, km: 4 }),
  line({ name: 'NH 48', pts: shift(base, 14), km: 3.8 }),
  line({ name: 'NH 48', pts: shift(base, -14), km: 3.7 }),
  line({ name: 'NH 48', pts: shift(base, 28), km: 3.6 }),
]);
ck('four ways of one divided highway collapse to one', four.length === 1, four.length + ' line(s)');
ck('and all four are counted', four[0] && four[0].carriageways === 4,
  String(four[0] && four[0].carriageways));

// THE GUARD THAT MATTERS. Dropping a line is severe, so nothing is dropped on
// proximity alone — two roads that merely pass close by are two roads.
const near = M.collapseCarriageways([
  line({ name: 'Station Road', pts: base, km: 4 }),
  line({ name: 'Bazaar Road', pts: shift(base, 18), km: 3.9 }),
]);
ck('two DIFFERENT roads running alongside each other both survive',
  near.length === 2, near.length + ' line(s)');

const far = M.collapseCarriageways([
  line({ name: 'Station Road', pts: base, km: 4 }),
  line({ name: 'Station Road', pts: shift(base, 400), km: 3.9 }),
]);
ck('and so do two stretches of one name that are nowhere near each other',
  far.length === 2, far.length + ' line(s)');

// A road severed by a river and picked up on the far side is two stretches,
// not two carriageways — the geometry is end to end, not side by side.
const severed = M.collapseCarriageways([
  line({ name: 'River Road', pts: eastLine(19.1, 72.8, 2), km: 2 }),
  line({ name: 'River Road', pts: eastLine(19.1, 72.83, 2), km: 2 }),
]);
ck('a road severed and resumed further on stays two stretches',
  severed.length === 2, severed.length + ' line(s)');

// Anonymous parallel lines are just as likely to be a road and its service
// lane. Silence is better than invention.
const unnamed = M.collapseCarriageways([
  line({ pts: base, km: 4 }),
  line({ pts: shift(base, 18), km: 3.9 }),
]);
ck('two unnamed parallel lines are left alone', unnamed.length === 2, unnamed.length + ' line(s)');

// A carriageway often carries the ref and not the name, or the reverse.
const byRef = M.collapseCarriageways([
  line({ ref: 'NH 48', pts: base, km: 4 }),
  line({ ref: 'NH 48', name: 'Mumbai-Ahmedabad Highway', pts: shift(base, 18), km: 3.9 }),
]);
ck('carriageways matched on their ref when only one is named',
  byRef.length === 1, byRef.length + ' line(s)');
ck('and the survivor inherits the name the other half carried',
  byRef[0] && byRef[0].name === 'Mumbai-Ahmedabad Highway', String(byRef[0] && byRef[0].name));

// The joined-segment count has to travel too, or the row says "4 joined" for a
// road that was assembled from nine ways.
const parts = M.collapseCarriageways([
  line({ name: 'LBS Marg', pts: base, km: 4, parts: 6 }),
  line({ name: 'L.B.S. Marg', pts: shift(base, 18), km: 3.9, parts: 5 }),
]);
ck('the OSM segment counts of both halves are added up',
  parts.length === 1 && parts[0].parts === 11, String(parts[0] && parts[0].parts));
ck('and the two spellings of one name were seen as one road', parts.length === 1);

// Points and areas go through untouched — the test is about lines.
const mixed = M.collapseCarriageways([
  { kind: 'point', name: 'Ghatkopar', lat: 19.1, lng: 72.8 },
  { kind: 'area', name: 'Industrial land', polys: [[[19.1, 72.8]]] },
  line({ name: 'Road', pts: base, km: 4 }),
]);
ck('a point and an area are not carriageways of anything', mixed.length === 3,
  mixed.length + ' feature(s)');

/* ---- a metro over a road, with both still visible ------------------------ */

const overlaid = [
  line({ classId: 'arterial', name: 'LBS Marg', pts: base, km: 4 }),
  line({ classId: 'metro', name: 'Line 4', pts: shift(base, 8), km: 4 }),
];
M.markSharedAlignments(overlaid);
ck('a metro mapped over a road is marked as sharing its alignment',
  overlaid[1].overRoad === true, String(overlaid[1].overRoad));
// Only the rail side is marked: the road is what it always was, and moving it
// would put the thing distances are measured along somewhere it is not.
ck('and the road itself is not', !overlaid[0].overRoad);
ck('the rail is told which side to move to', Math.abs(overlaid[1].shiftSide) === 1,
  String(overlaid[1].shiftSide));
ck('and it is the first thing over that road, so it takes the first step out',
  overlaid[1].shiftRank === 1, String(overlaid[1].shiftRank));

const apart = [
  line({ classId: 'arterial', name: 'LBS Marg', pts: base, km: 4 }),
  line({ classId: 'metro', name: 'Line 4', pts: shift(base, 300), km: 4 }),
];
M.markSharedAlignments(apart);
ck('a metro on its own alignment is left alone', !apart[1].overRoad);

// Marked on a partial run too: a metro that follows a road for a third of its
// length still disappears along that third, and a dash is a mild consequence.
const partial = [
  line({ classId: 'highway', name: 'NH 48', pts: eastLine(19.1, 72.8, 1.5), km: 1.5 }),
  line({ classId: 'metro', name: 'Line 7', pts: shift(eastLine(19.1, 72.8, 5), 8), km: 5 }),
];
M.markSharedAlignments(partial);
ck('a metro that follows a road for part of its run is marked',
  partial[1].overRoad === true, String(partial[1].overRoad));

const rail = [
  line({ classId: 'expressway', name: 'Eastern Express', pts: base, km: 4 }),
  line({ classId: 'rail', name: 'Central Line', pts: shift(base, 12), km: 4 }),
];
M.markSharedAlignments(rail);
ck('a railway beside an expressway is marked the same way', rail[1].overRoad === true);

const water = [
  line({ classId: 'arterial', name: 'Riverside Road', pts: base, km: 4 }),
  line({ classId: 'river', name: 'Ulhas', pts: shift(base, 12), km: 4 }),
];
M.markSharedAlignments(water);
// A river is not something that rides over a road, and a dashed river reads as
// a seasonal one — a different fact about the water.
ck('a river alongside a road is NOT dashed', !water[1].overRoad);

/* ---- which side it moves to ---------------------------------------------- */

/*
 * A FIXED DIRECTION CANCELS INSTEAD OF ADDING. A metro mapped 8 m north of its
 * road and moved 7 px south is clear of it at 1:100000, where 7 px is 60 m —
 * and sitting exactly on it at 1:4000, where 7 px is 8 m. Not a near miss: the
 * original complaint, reappearing at one zoom level, which is the sort of
 * thing nobody finds by hand.
 *
 * So the side is measured here, where both lines are in hand, and returned in
 * the frame the drawing uses: +1 is the line's own right, looking along the
 * direction its coordinates run in.
 */

// East-running metro, road to its south (right hand) -> move left, -1.
ck('a line with the road on its right is sent left',
  M.ringSideOf(shift(base, 8), base) === -1,
  String(M.ringSideOf(shift(base, 8), base)));
// Same pair, road to its north (left hand) -> move right, +1.
ck('and one with the road on its left is sent right',
  M.ringSideOf(shift(base, -8), base) === 1,
  String(M.ringSideOf(shift(base, -8), base)));
// THE ONE THAT MATTERS. A metro's coordinates may run the opposite way along
// the same alignment; anchored to the road's heading instead of its own, the
// answer flips and the shift points back at the road.
ck('a metro whose coordinates run the other way is still sent away from the road',
  M.ringSideOf(shift(base, 8).slice().reverse(), base) === 1,
  String(M.ringSideOf(shift(base, 8).slice().reverse(), base)));
ck('and the reversed pair the other way round, likewise',
  M.ringSideOf(shift(base, -8).slice().reverse(), base) === -1);
// Exactly on top of it: either side is as truthful as the other, so the answer
// only has to be one of them, consistently.
ck('a line exactly on the road still gets a definite side',
  Math.abs(M.ringSideOf(base, base)) === 1, String(M.ringSideOf(base, base)));

// A second line over the same road steps further out on the SAME side. Sending
// it across would put it back in the cancelling case the first one escaped.
const two = [
  line({ classId: 'arterial', name: 'LBS Marg', pts: base, km: 4 }),
  line({ classId: 'metro', name: 'Line 4', pts: shift(base, 8), km: 4 }),
  line({ classId: 'metro', name: 'Line 6', pts: shift(base, 11), km: 4 }),
];
M.markSharedAlignments(two);
ck('two metros over one road are ranked, not piled on the same offset',
  two[1].shiftRank === 1 && two[2].shiftRank === 2,
  two[1].shiftRank + ' and ' + two[2].shiftRank);
ck('and both are sent to the same side of it',
  two[1].shiftSide === two[2].shiftSide, two[1].shiftSide + ' / ' + two[2].shiftSide);

// Counted per road: a metro over a different road is the first thing over THAT
// road and takes the first step out, not the second.
const twoRoads = [
  line({ classId: 'arterial', name: 'A Road', pts: base, km: 4 }),
  line({ classId: 'arterial', name: 'B Road', pts: shift(base, 900), km: 4 }),
  line({ classId: 'metro', name: 'Line 4', pts: shift(base, 8), km: 4 }),
  line({ classId: 'metro', name: 'Line 9', pts: shift(base, 908), km: 4 }),
];
M.markSharedAlignments(twoRoads);
ck('a metro over a different road starts from the first step out again',
  twoRoads[2].shiftRank === 1 && twoRoads[3].shiftRank === 1,
  twoRoads[2].shiftRank + ' and ' + twoRoads[3].shiftRank);

const noRoads = [line({ classId: 'metro', name: 'Line 4', pts: base, km: 4 })];
M.markSharedAlignments(noRoads);
ck('a metro with no road anywhere near is left alone', !noRoads[0].overRoad);

/* ---- and both, through the real entry point ------------------------------ */

const joined = M.joinRingFeatures([
  line({ classId: 'highway', name: 'NH 48', pts: base, km: 4 }),
  line({ classId: 'highway', name: 'NH 48', pts: shift(base, 18), km: 3.9 }),
  line({ classId: 'metro', name: 'Line 7', pts: shift(base, 6), km: 4 }),
  { kind: 'point', classId: 'station', name: 'Kalyan', lat: 19.1, lng: 72.8 },
]);
const roads = joined.filter(f => f.classId === 'highway');
const metros = joined.filter(f => f.classId === 'metro');
ck('the whole pipeline draws the divided highway once', roads.length === 1,
  roads.length + ' road(s)');
ck('marks the metro that flies over it', metros.length === 1 && metros[0].overRoad === true);
ck('and leaves the station alone', joined.filter(f => f.kind === 'point').length === 1);
// The numbering existed because the halves could not be merged. Now they can,
// so "1 of 2" on a road that is drawn once would be a lie.
ck('and does not number a road it has just made whole',
  !roads[0].ofParts, String(roads[0].ofParts));

/* ---- the stack the map draws them in ------------------------------------- */

const std = require('fs').readFileSync(path.join(REPO, 'js/map/connectivityStandard.js'), 'utf8');
const stack = (std.match(/const CONNECTIVITY_STACK = \[([\s\S]*?)\];/) || [])[1] || '';
const order = (stack.match(/'([a-zA-Z]+)'/g) || []).map(s => s.replace(/'/g, ''));
const at = id => order.indexOf(id);
ck('the stack is declared and covers the line classes',
  at('metro') >= 0 && at('expressway') >= 0 && at('powerLine') >= 0, order.length + ' classes');
// Everything on the sheet is drawn ON the land, not under it.
ck('ground cover is beneath the roads', at('builtUp') < at('major') && at('farmland') < at('major'));
// A river drawn over the bridge reads as a road that stops at the bank.
ck('water is beneath the roads that bridge it', at('water') < at('major'));
// This is the pair the complaint was about.
ck('a metro is above the road it flies over', at('metro') > at('expressway'));
ck('and above every other road class too',
  at('metro') > at('major') && at('metro') > at('ring') && at('metro') > at('airportRoad'));
// An HT line is the one thing on the map that says "you cannot build here".
ck('a transmission line is above everything', at('powerLine') === order.length - 1);

// A class added to the standard without a place in the stack sorts silently to
// the middle, which is the arbitrary order this replaced — so the two lists
// have to agree exactly, and this is what says so when one of them changes.
const declared = [...std.matchAll(/\{ id: '([a-zA-Z]+)'[^}]*kind: '(line|area|mark)'/g)]
  .filter(m => m[2] !== 'mark').map(m => m[1]);
ck('every class that is DRAWN has a place in the stack',
  declared.every(c => at(c) >= 0),
  declared.filter(c => at(c) < 0).join(', ') || 'all ' + declared.length + ' present');
ck('and the stack names nothing that is not a drawn class',
  order.every(c => declared.indexOf(c) >= 0),
  order.filter(c => declared.indexOf(c) < 0).join(', ') || 'none stale');

/* ---- where an area's marker goes ------------------------------------------ */

/*
 * THE MEAN OF A RING'S CORNERS IS NOT INSIDE IT. An L-shaped residential zone
 * has its mean in the notch — on somebody else's land — and a C-shaped one has
 * it in the gap, which around here is usually the creek the zone wraps around.
 * A pin beside the area it marks is worse than no pin: it says a place is
 * somewhere it is not, and it does it confidently.
 */
const Lparcel = [[0, 0], [0, 3], [1, 3], [1, 1], [3, 1], [3, 0], [0, 0]];
const meanOf = ring => {
  let la = 0, ln = 0;
  ring.forEach(p => { la += p[0]; ln += p[1]; });
  return [la / ring.length, ln / ring.length];
};
ck('the corner mean of an L-shaped parcel is outside it, which is the bug',
  M.pointInRing(meanOf(Lparcel), Lparcel) === false);
const Lpt = M.ringInteriorPoint(Lparcel);
ck('and the marker point is inside it', M.pointInRing([Lpt.lat, Lpt.lng], Lparcel) === true,
  JSON.stringify(Lpt));

// A C wrapped round a creek: the mean lands in the water.
const Cparcel = [[0, 0], [0, 4], [1, 4], [1, 1], [3, 1], [3, 4], [4, 4], [4, 0], [0, 0]];
ck('a C-shaped parcel has its corner mean in the gap as well',
  M.pointInRing(meanOf(Cparcel), Cparcel) === false);
const Cpt = M.ringInteriorPoint(Cparcel);
ck('and its marker lands on the parcel', M.pointInRing([Cpt.lat, Cpt.lng], Cparcel) === true,
  JSON.stringify(Cpt));

// The convex majority keeps the centre it always had — this is a fix for the
// awkward shapes, not a new position for every parcel.
const square = [[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]];
const spt = M.ringInteriorPoint(square);
ck('a square is still marked in the middle',
  Math.abs(spt.lat - 1) < 1e-9 && Math.abs(spt.lng - 1) < 1e-9, JSON.stringify(spt));
ck('a ring with too few corners to be a shape gives nothing rather than NaN',
  M.ringInteriorPoint([[1, 1], [2, 2]]) === null);
// A vertex list that is all one line cuts no span at all; a point on the shape
// beats returning nothing.
const flat = M.ringInteriorPoint([[0, 0], [0, 1], [0, 2], [0, 0]]);
ck('a degenerate ring still yields a point', flat && isFinite(flat.lat) && isFinite(flat.lng),
  JSON.stringify(flat));

/* ---- OSM says where, Google says what it is called ------------------------ */

/*
 * Google Places returns a coordinate and a name and no geometry at all, so for
 * everything drawn as a line or an area Overpass is not the better source, it
 * is the only one. Where Google IS better is names of places, and in India
 * markedly so. The two are merged rather than ranked — and both silent
 * failures of a merge, "the same station twice" and "two stations collapsed
 * into one", are proved here where there is no map to hide them.
 */
const stn = (name, lat, lng) => ({ kind: 'point', classId: 'station', name, lat, lng });
const FC = { id: 'station', gtypes: ['train_station'] };
const M_PER_DEG = 111320;

let feats = [stn(null, 19.10, 72.88)];
let tally = M.ringMergeGoogle(feats, [{ name: 'Kalyan Junction', lat: 19.1004, lng: 72.8801 }], FC);
ck('a station OSM left unnamed takes the name Google has for it',
  feats[0].name === 'Kalyan Junction' && tally.named === 1, feats[0].name);
ck('and the row says so, rather than passing it off as OSM',
  feats[0].source === 'osm+google', feats[0].source);
// A station node is surveyed and sits on the platform, which is what a distance
// should be measured to; Google's marker can be the forecourt or the ticket
// office. So the name is taken and the position is not.
ck('but the coordinate stays OSM\'s, because that is the surveyed one',
  feats[0].lat === 19.10 && feats[0].lng === 72.88, feats[0].lat + ', ' + feats[0].lng);

feats = [stn('Kalyan Jn', 19.10, 72.88)];
M.ringMergeGoogle(feats, [{ name: 'Kalyan Junction Railway Station', lat: 19.1004, lng: 72.8801 }], FC);
ck('a name OSM already has is kept, not overwritten',
  feats[0].name === 'Kalyan Jn', feats[0].name);
ck('though the other name is carried, so the row can show it',
  feats[0].googleName === 'Kalyan Junction Railway Station', feats[0].googleName);

// The half a single source can never fix.
feats = [stn('Kalyan Junction', 19.10, 72.88)];
tally = M.ringMergeGoogle(feats, [{ name: 'Shahad', lat: 19.18, lng: 73.10 }], FC);
ck('a station Google knows and OSM has not mapped is added as a find',
  feats.length === 2 && feats[1].name === 'Shahad' && tally.added === 1,
  feats.map(f => f.name).join(' | '));
ck('and it is marked as Google\'s, not passed off as surveyed',
  feats[1].source === 'google' && feats[1].kind === 'point', feats[1].source);

// TWO STATIONS COLLAPSED INTO ONE is the failure that matters most: it does not
// look like a bug, it looks like a quiet map.
feats = [stn(null, 19.10, 72.88), stn(null, 19.1005, 72.8802)];
tally = M.ringMergeGoogle(feats, [
  { name: 'Kalyan Junction', lat: 19.1001, lng: 72.8801 },
  { name: 'Kalyan East', lat: 19.1004, lng: 72.8803 },
], FC);
ck('two Google rows near two OSM stations name one each, not one twice',
  feats.length === 2 && tally.matched === 2 && tally.added === 0
  && feats[0].name !== feats[1].name, feats.map(f => f.name).join(' | '));

// Google returning the station building AND its entrance must not consume two
// OSM stations, nor add a duplicate pin on top of the one it already named.
feats = [stn(null, 19.10, 72.88)];
tally = M.ringMergeGoogle(feats, [
  { name: 'Kalyan Junction', lat: 19.1000, lng: 72.8800 },
  { name: 'Kalyan Junction Entrance', lat: 19.10005, lng: 72.88005 },
], FC);
ck('a second Google row for the same station does not bind to it twice',
  tally.matched === 1, 'matched ' + tally.matched);

// 150 m is the whole rule, so it is worth pinning from both sides.
const off200 = 200 / M_PER_DEG, off100 = 100 / M_PER_DEG;
feats = [stn(null, 19.10, 72.88)];
M.ringMergeGoogle(feats, [{ name: 'Far away', lat: 19.10 + off200, lng: 72.88 }], FC);
ck('a Google place 200 m off is a different place', feats.length === 2 && !feats[0].name,
  feats.length + ' features');
feats = [stn(null, 19.10, 72.88)];
M.ringMergeGoogle(feats, [{ name: 'Same place', lat: 19.10 + off100, lng: 72.88 }], FC);
ck('and one 100 m off is the same one', feats.length === 1 && feats[0].name === 'Same place');

// Only within a class. A bus station is not a name for the railway station
// across the road from it, however close the two are.
feats = [stn(null, 19.10, 72.88), { kind: 'point', classId: 'busTerminal', name: null, lat: 19.1001, lng: 72.8801 }];
M.ringMergeGoogle(feats, [{ name: 'Kalyan Junction', lat: 19.1001, lng: 72.8801 }], FC);
ck('a Google railway station never names the bus terminal beside it',
  feats[0].name === 'Kalyan Junction' && feats[1].name === null,
  JSON.stringify(feats.map(f => f.name)));

// An area's match point is the one its pin gets, so a find and its marker can
// never disagree about where the thing is.
const area = { kind: 'area', classId: 'airport', polys: [square] };
const ap = M.ringFeaturePoint(area);
ck('an area is matched at the same point its marker is dropped on',
  Math.abs(ap.lat - 1) < 1e-9 && Math.abs(ap.lng - 1) < 1e-9, JSON.stringify(ap));
ck('and a line at the mean of its own vertices',
  !!M.ringFeaturePoint({ kind: 'line', pts: base }));
ck('a feature with no geometry at all yields nothing rather than NaN',
  M.ringFeaturePoint({ kind: 'point' }) === null);

// Nothing from Google is not an error — most rings hold nothing it knows that
// OSM does not.
feats = [stn('Kalyan Junction', 19.10, 72.88)];
tally = M.ringMergeGoogle(feats, [], FC);
ck('an empty answer from Google changes nothing',
  feats.length === 1 && tally.added === 0 && tally.named === 0);
ck('and a missing one is the same as an empty one',
  M.ringMergeGoogle(feats, null, FC).added === 0);
// A row with no usable coordinate is dropped rather than pinned at 0,0 off
// the coast of Africa.
feats = [stn('Kalyan Junction', 19.10, 72.88)];
M.ringMergeGoogle(feats, [{ name: 'Broken', lat: null, lng: undefined }], FC);
ck('a Google row with no coordinate is dropped, not pinned at nowhere',
  feats.length === 1, feats.length + ' features');

// The classes Google is asked about are exactly the ones it can answer for.
const withG = M.RING_FEATURE_CLASSES.filter(c => c.gtypes);
ck('only point classes are given Google types',
  withG.every(c => c.place === true), withG.map(c => c.id).join(', '));
ck('and every kind of place a scan can find has one',
  M.RING_FEATURE_CLASSES.filter(c => c.place).every(c => c.gtypes && c.gtypes.length),
  M.RING_FEATURE_CLASSES.filter(c => c.place && !c.gtypes).map(c => c.id).join(', ') || 'all covered');
// Asking Google for a residential boundary gets a pin in the middle of a suburb
// and nothing else — it has no geometry to give.
ck('no line or area class asks Google for anything',
  M.RING_FEATURE_CLASSES.filter(c => !c.place).every(c => !c.gtypes));

console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
process.exit(R.filter(Boolean).length === R.length ? 0 : 1);
