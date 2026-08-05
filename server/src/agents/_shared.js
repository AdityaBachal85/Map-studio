/**
 * agents/_shared.js — helpers every research agent leans on, so each one only
 * writes its own topic-specific instructions.
 */
const { placePhrase } = require('../lib/placeContext');

/**
 * Render the client-gathered nearby-places JSON (see js/ui/aiTab.js
 * aiGatherNearbyContext) as short bullet lines for a prompt. Keeping this
 * plain text rather than raw JSON in the prompt reads better to the model
 * and keeps prompts shorter.
 * @param {object} nearby @param {string[]} keys which categories to include
 * @returns {string}
 */
function formatNearby(nearby, keys) {
  const lines = [];
  for (const key of keys) {
    const rows = (nearby && nearby[key]) || [];
    if (!rows.length) continue;
    const names = rows.slice(0, 5).map(r => `${r.name} (${Math.round(r.distance)}m)`).join(', ');
    lines.push(`- ${key}: ${names}`);
  }
  return lines.length ? lines.join('\n') : '(none found nearby)';
}

/**
 * The area, named the way a search engine and a reader both understand it.
 *
 * This is the highest-leverage line in any of these prompts. The site's own
 * `name` is whatever the operator typed — "Plot 4", a project codename — and
 * coordinates appear in no news article or municipal notice ever written.
 * `place` comes from lib/placeContext.js and turns 19.1547, 72.9986 into
 * "Airoli, Navi Mumbai, Thane, Maharashtra", which is what those documents
 * actually say.
 *
 * @param {object} [place] a resolvePlace() result @param {{lat:number,lng:number}} site
 * @returns {string}
 */
function areaName(place, site) {
  return place && place.resolved ? placePhrase(place, site) : `${site.lat}, ${site.lng}`;
}

/**
 * @param {{name:string, lat:number, lng:number}} site
 * @param {object} [place]
 * @returns {string}
 */
function siteLine(site, place) {
  const where = areaName(place, site);
  const addr = place && place.formattedAddress ? `\nFull address: ${place.formattedAddress}` : '';
  return `Site: "${site.name}" in ${where}, India (coordinates ${site.lat}, ${site.lng}).${addr}`;
}

/**
 * Hard source allow-lists for the two web-research agents.
 *
 * Capped at ten because that is Perplexity's `search_domain_filter` limit,
 * and split by topic rather than pooled because a single list would spend the
 * whole allowance covering both and restrict neither properly. A
 * government-projects section citing a property portal is weak; the same
 * section citing an NMMC notification is what makes a client believe the
 * rest of the document.
 *
 * This closes the risk the original design doc logged and could not: Gemini's
 * grounding could only ever be *steered* toward reputable sources, never
 * restricted to them. A domain filter is the restriction.
 *
 * Regional to Maharashtra/MMR, which is where this tool is used. Sites
 * elsewhere still work — the national outlets and MahaRERA's central registry
 * are not city-specific — but the list is worth revisiting if the tool starts
 * being pointed at another state.
 */
const GOV_DOMAINS = [
  'nmmc.gov.in',                    // Navi Mumbai Municipal Corporation
  'cidco.maharashtra.gov.in',       // CIDCO — the Navi Mumbai planning authority
  'mmrda.maharashtra.gov.in',       // Mumbai Metropolitan Region Development Authority
  'maharera.maharashtra.gov.in',    // every registered project, with its status
  'mmrcl.com',                      // Mumbai Metro Rail Corporation
  'pwd.maharashtra.gov.in',
  'maharashtra.gov.in',
  'pib.gov.in',                     // central government press releases
];

const NEWS_DOMAINS = [
  'timesofindia.indiatimes.com',
  'hindustantimes.com',
  'indianexpress.com',
  'business-standard.com',
  'economictimes.indiatimes.com',
  'moneycontrol.com',
  'freepressjournal.in',
  'mid-day.com',
];

/**
 * Closing instructions for the two agents whose evidence comes from Maps
 * grounding rather than a domain-restricted web search.
 *
 * The web agents don't need this — their sources are constrained by the
 * filter itself, which is a guarantee rather than a request.
 */
const SOURCE_STEER =
  'Describe only places you can actually identify from the grounded results. Do not ' +
  'invent names, distances or travel times, and do not pad the section with generic ' +
  'statements that would be true of any Indian suburb. If something is not covered by ' +
  'the results, say so plainly. Write clear prose, not bullet fragments.';

module.exports = {
  formatNearby, siteLine, areaName, SOURCE_STEER, GOV_DOMAINS, NEWS_DOMAINS,
};
