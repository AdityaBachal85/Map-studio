/**
 * agents/government.js — Government Projects Agent: metro/road/smart-city
 * projects, official notifications, and development plans near a site.
 *
 * Evidence comes from a domain-restricted web search, never from Maps
 * grounding. That distinction was measured, not assumed: asked this exact
 * question, Maps grounding returned HTTP 200 with seven citations — all of
 * which were nearby *apartment blocks* (Akshar Green World, Airoli Tower,
 * Delta Luxuria) — and prose hedged into "often supported by surrounding
 * civic infrastructure managed by NMMC". No project, no status, no year, but
 * citations attached and therefore looking trustworthy. That is the failure
 * mode this agent exists to avoid.
 */
const router = require('../lib/aiRouter');
const { siteLine, areaName, GOV_DOMAINS } = require('./_shared');

/**
 * @param {{site:{name:string,lat:number,lng:number}, place:object}} ctx
 * @returns {Promise<{evidence:object, sources:Array, usage:object}>}
 */
async function run({ site, place }) {
  const area = areaName(place, site);
  const question = `What government or civic infrastructure projects are planned, approved, or under construction in or near ${area}, India? Cover metro line extensions, road widening and highway works, smart-city initiatives, and any official development plan or notification affecting this area. For each project state clearly whether it is announced, under construction, or completed, and give the expected completion year where it is publicly stated. If a project's status or timeline is not stated in the sources, say so rather than estimating.`;

  const { text, sources, usage, provider, unsourced } = await router.ask({
    task: 'research',
    prompt: siteLine(site, place),
    evidence: 'web',
    web: {
      question,
      query: `${area} infrastructure project metro road development plan status`,
      domains: GOV_DOMAINS,
      // A year, not a month: development plans and notifications move slowly,
      // and the useful document is often the one published last spring.
      recency: 'year',
    },
  });

  return { evidence: { summary: text, provider, unsourced }, sources, usage };
}

module.exports = { run };
