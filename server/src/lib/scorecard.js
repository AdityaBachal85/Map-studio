/**
 * lib/scorecard.js — the report's headline scores, computed rather than
 * asked for.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 * No model is ever asked to produce a number here. Ask one to "score
 * connectivity out of 100" and it returns a confident figure with no basis
 * whatsoever — and a number is the most dangerous thing to invent, because
 * numbers get quoted, tabulated and acted on long after the prose around
 * them is forgotten. A bank reading "Liquidity 88/100" will not go looking
 * for the sentence admitting nobody measured it.
 *
 * So every score here is arithmetic over measured inputs — drive times from
 * the Routes API, amenity counts from Places, project counts from sourced
 * research — and every score carries the inputs that produced it, printed in
 * the report beside the number. A reader can check the working.
 *
 * Metrics with no data source return `null` and render as an em dash with a
 * reason. There is no "AI estimate" mode. Market demand, liquidity, safety
 * and environmental quality have no free data source that covers Indian
 * localities, so they stay blank, and blank is the honest answer.
 *
 * ── ON THE BANDS ──────────────────────────────────────────────────────────
 * The thresholds below are a stated convention, not a measurement — someone
 * else would reasonably draw them elsewhere. What matters is that they are
 * fixed, visible in this file, identical for every site, and reported
 * alongside the raw inputs, so two sites are compared on the same ruler and
 * any reader can disagree with the ruler rather than the number.
 */

/**
 * Score one value against descending thresholds.
 * @param {number|null} value @param {Array<[number, number]>} bands [threshold, points], best first
 * @param {number} floor points when nothing matches
 * @returns {number}
 */
function band(value, bands, floor) {
  if (value == null || !isFinite(value)) return floor;
  for (const [limit, points] of bands) if (value <= limit) return points;
  return floor;
}

/** @param {number} n @returns {number} clamped to 0–100 and rounded */
const clamp100 = n => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Connectivity, from real drive times and distances.
 *
 * Weighted toward the airport and the nearest station because those are what
 * a buyer asks about first. The congestion penalty is the interesting part:
 * a site 30 minutes from the airport at 3am and 70 minutes at 9am is not a
 * 30-minute site, and free-flow-only figures are exactly how brochures
 * overstate connectivity.
 *
 * @param {{rows:Array}} matrix a buildTravelMatrix() result
 * @returns {{score:number|null, basis:string, reason?:string}}
 */
function connectivityScore(matrix) {
  const rows = (matrix && matrix.rows) || [];
  if (!rows.length) {
    return { score: null, basis: '', reason: 'no route to any reference destination could be measured' };
  }
  const by = Object.fromEntries(rows.map(r => [r.key, r]));
  const airport = by.airport, railway = by.railway, metro = by.metro;

  const airportPts = band(airport && airport.offPeakMin,
    [[30, 32], [45, 26], [60, 19], [90, 10]], 4);
  const railwayPts = band(railway && railway.distanceKm,
    [[1, 34], [3, 27], [6, 18], [12, 9]], 3);
  const metroPts = band(metro && metro.distanceKm,
    [[2, 26], [5, 21], [10, 14], [20, 7]], 2);

  // Congestion: how much worse the airport run gets at 9am.
  let penalty = 0, congestionNote = '';
  if (airport && airport.offPeakMin && airport.peakMin) {
    const ratio = airport.peakMin / airport.offPeakMin;
    if (ratio >= 1.6) { penalty = 10; congestionNote = `, heavy peak congestion (+${Math.round((ratio - 1) * 100)}%)`; }
    else if (ratio >= 1.3) { penalty = 5; congestionNote = `, moderate peak congestion (+${Math.round((ratio - 1) * 100)}%)`; }
  }

  const parts = [];
  if (airport) parts.push(`airport ${airport.offPeakMin} min off-peak / ${airport.peakMin} min at 9am`);
  if (railway) parts.push(`station ${railway.distanceKm} km`);
  if (metro) parts.push(`metro ${metro.distanceKm} km`);

  return {
    score: clamp100(airportPts + railwayPts + metroPts + 8 - penalty),
    basis: parts.join(' · ') + congestionNote,
  };
}

/**
 * Categories that make a place liveable, and how many within 5 km is "good".
 * `full` is the count at which the category stops adding — twelve schools and
 * forty schools are the same answer to "are there schools here".
 */
const AMENITY_WEIGHTS = [
  { key: 'school', label: 'schools', weight: 18, full: 8 },
  { key: 'hospital', label: 'hospitals', weight: 18, full: 5 },
  { key: 'college', label: 'colleges', weight: 10, full: 4 },
  { key: 'mall', label: 'retail', weight: 12, full: 6 },
  { key: 'transit', label: 'stations/stops', weight: 12, full: 5 },
  { key: 'bank', label: 'banks', weight: 8, full: 6 },
  { key: 'pharmacy', label: 'pharmacies', weight: 8, full: 5 },
  { key: 'restaurant', label: 'restaurants', weight: 6, full: 10 },
  { key: 'park', label: 'parks', weight: 8, full: 4 },
];

/**
 * Infrastructure density, from what Places actually returned within 5 km.
 *
 * Counts are capped by the provider at 20 per category, so a very dense area
 * saturates — which is fine, since every weight tops out well below that.
 *
 * @param {object} nearby the client-gathered nearby context
 * @returns {{score:number|null, basis:string, reason?:string, counts:object}}
 */
function infrastructureScore(nearby) {
  const counts = {};
  for (const a of AMENITY_WEIGHTS) counts[a.key] = ((nearby && nearby[a.key]) || []).length;
  const measured = Object.values(counts).reduce((n, c) => n + c, 0);
  if (!measured) {
    return { score: null, basis: '', counts, reason: 'no nearby-place data was gathered for this site' };
  }
  const score = AMENITY_WEIGHTS.reduce(
    (sum, a) => sum + a.weight * Math.min(1, counts[a.key] / a.full), 0);

  const shown = AMENITY_WEIGHTS
    .filter(a => counts[a.key] > 0)
    .sort((x, y) => counts[y.key] - counts[x.key])
    .slice(0, 5)
    .map(a => `${counts[a.key]} ${a.label}`);
  return { score: clamp100(score), basis: `within 5 km: ${shown.join(', ')}`, counts };
}

/**
 * How many of the tracked categories are represented at all.
 *
 * A separate metric from density on purpose: eighty restaurants and nothing
 * else is a different place from a suburb with two of everything, and a
 * single blended number hides that.
 * @param {object} nearby
 */
function diversityScore(nearby) {
  const present = AMENITY_WEIGHTS.filter(a => ((nearby && nearby[a.key]) || []).length > 0);
  if (!nearby || !Object.keys(nearby).length) {
    return { score: null, basis: '', reason: 'no nearby-place data was gathered for this site' };
  }
  return {
    score: clamp100((present.length / AMENITY_WEIGHTS.length) * 100),
    basis: `${present.length} of ${AMENITY_WEIGHTS.length} amenity categories present within 5 km`,
  };
}

/**
 * Development pipeline, from projects the Government agent actually sourced.
 *
 * Counting citations rather than reading the prose: the agent's own source
 * list is evidence that survived a domain filter, where a count parsed out of
 * generated text would just be counting sentences.
 *
 * @param {object[]} agentRuns
 */
function futureDevelopmentScore(agentRuns) {
  const gov = (agentRuns || []).find(r => r.agent_name === 'government');
  if (!gov || !gov.evidence || !(gov.evidence.summary || '').trim()) {
    return { score: null, basis: '', reason: 'the Government Projects section could not be sourced' };
  }
  const sources = (gov.sources || []).length;
  const score = band(-sources, [[-8, 92], [-5, 80], [-3, 66], [-1, 50]], 30);
  return { score: clamp100(score), basis: `${sources} official/government source${sources === 1 ? '' : 's'} cited for planned works` };
}

/** Metrics we deliberately do not score, and why. Printed in the report. */
const UNSCORED = [
  ['marketDemand', 'Market Demand', 'no free data source publishes Indian locality-level demand, inventory or absorption'],
  ['liquidity', 'Liquidity', 'resale transaction data is not public in India'],
  ['safety', 'Safety', 'no crime statistics exist per locality; news coverage tracks which paper covers the area, not incident rates'],
  ['environment', 'Environmental Quality', 'the Air Quality API is not enabled on this project, and flood/noise/green-cover data has no free source'],
];

/**
 * Build the scorecard.
 *
 * @param {{matrix:object, nearby:object, agentRuns:object[]}} input
 * @returns {{metrics:Array, overall:{score:number|null, basis:string}, scored:number, total:number}}
 */
function buildScorecard({ matrix, nearby, agentRuns }) {
  const computed = [
    { key: 'connectivity', label: 'Connectivity', ...connectivityScore(matrix) },
    { key: 'infrastructure', label: 'Infrastructure', ...infrastructureScore(nearby) },
    { key: 'diversity', label: 'Amenity Diversity', ...diversityScore(nearby) },
    { key: 'futureDevelopment', label: 'Future Development', ...futureDevelopmentScore(agentRuns) },
  ];
  const metrics = computed.concat(
    UNSCORED.map(([key, label, reason]) => ({ key, label, score: null, basis: '', reason })));

  const scored = computed.filter(m => m.score != null);
  const overall = scored.length
    ? {
      score: clamp100(scored.reduce((n, m) => n + m.score, 0) / scored.length),
      // Saying what fed the average matters as much as the average: a 90 from
      // two metrics is not the same claim as a 90 from six.
      basis: `mean of ${scored.length} measured metric${scored.length === 1 ? '' : 's'} (${scored.map(m => m.label.toLowerCase()).join(', ')})`,
    }
    : { score: null, basis: '', reason: 'nothing could be measured for this site' };

  return { metrics, overall, scored: scored.length, total: computed.length };
}

module.exports = {
  buildScorecard, connectivityScore, infrastructureScore, diversityScore,
  futureDevelopmentScore, AMENITY_WEIGHTS, UNSCORED,
};
