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

/**
 * The evidence a synthesis agent is allowed to reason over, plus an explicit
 * list of what is missing.
 *
 * Naming the gaps is the whole point. A model handed three sections and asked
 * for a risk assessment will infer from their absence — "no government
 * projects were found, suggesting limited development activity" — which is a
 * conclusion drawn from a tool failure and reads in the report as a finding
 * about the area. Told plainly that the section could not be sourced, it says
 * so instead.
 *
 * @param {object[]} agentRuns rows from db.getAgentRuns()
 * @param {string[]} [only] restrict to these agent names
 * @returns {{text:string, sourced:string[], missing:string[]}}
 */
function evidenceDigest(agentRuns, only) {
  const rows = (agentRuns || []).filter(r => !only || only.includes(r.agent_name));
  const sourced = [];
  const missing = [];
  const blocks = [];
  for (const r of rows) {
    const body = ((r.evidence && r.evidence.summary) || '').trim();
    if (body) {
      sourced.push(r.agent_name);
      blocks.push(`## ${r.agent_name}\n${body}`);
    } else {
      missing.push(r.agent_name);
    }
  }
  const gaps = missing.length
    ? `\n\nNOT AVAILABLE — these topics could not be researched, so nothing is known about them either way. Do not treat their absence as evidence of anything, and do not mention them as findings: ${missing.join(', ')}.`
    : '';
  return {
    text: (blocks.join('\n\n') || '(no research available)') + gaps,
    sourced,
    missing,
  };
}

/**
 * Render a computed scorecard for a prompt.
 *
 * Only the measured metrics go in. Handing a model "Market Demand: —" invites
 * it to fill the blank, which is precisely what the scorecard refuses to do.
 * @param {{metrics:Array, overall:object}} scorecard
 * @returns {string}
 */
function formatScorecard(scorecard) {
  if (!scorecard || !scorecard.metrics) return '(no scorecard)';
  const rows = scorecard.metrics
    .filter(m => m.score != null)
    .map(m => `- ${m.label}: ${m.score}/100 (${m.basis})`);
  if (!rows.length) return '(nothing could be measured for this site)';
  if (scorecard.overall && scorecard.overall.score != null) {
    rows.push(`- Overall: ${scorecard.overall.score}/100 — ${scorecard.overall.basis}`);
  }
  return rows.join('\n');
}

/** Every synthesis agent ends with this. @type {string} */
const INTERPRETATION_RULES =
  'Base every statement on the research above. Do not introduce facts, names, figures or '
  + 'projects that do not appear in it. Where the evidence does not support a point, leave the '
  + 'point out rather than softening it into a guess. Write plainly and specifically — a sentence '
  + 'that would be true of any Indian suburb is not worth including.';

module.exports = {
  formatNearby, siteLine, areaName, SOURCE_STEER, GOV_DOMAINS, NEWS_DOMAINS,
  evidenceDigest, formatScorecard, INTERPRETATION_RULES,
};
