/**
 * agents/news.js — News Agent: recent property, construction and development
 * coverage for the area, plus locally reported safety incidents.
 *
 * ON THE SAFETY HALF. There is no API — Perplexity's, Google's or anyone
 * else's — that returns crime statistics for an Indian locality. What is
 * actually available is *news coverage of incidents*, and that is a biased
 * proxy: more coverage can simply mean a larger paper covers that suburb.
 * Presenting it as a crime rate, in a document someone buys property on,
 * would be misleading. So the section is framed as what it is — reported
 * incidents in local media — and the prompt says so explicitly.
 */
const router = require('../lib/aiRouter');
const { siteLine, areaName, NEWS_DOMAINS } = require('./_shared');

/**
 * @param {{site:{name:string,lat:number,lng:number}, place:object}} ctx
 * @returns {Promise<{evidence:object, sources:Array, usage:object}>}
 */
async function run({ site, place }) {
  const area = areaName(place, site);
  const question = `What has been reported in the news over roughly the last year about ${area}, India? Cover property-market and real-estate development news, construction and infrastructure news, and any notable safety incidents reported locally. Report safety coverage factually and proportionately — these are reported incidents, not a crime rate, so do not characterise the area as safe or unsafe on the strength of news volume. Where nothing notable was reported on a topic, say so plainly rather than padding. Include dates.`;

  const { text, sources, usage, provider, unsourced } = await router.ask({
    task: 'research',
    prompt: siteLine(site, place),
    evidence: 'web',
    web: {
      question,
      query: `${area} property development construction news`,
      domains: NEWS_DOMAINS,
      // A month, unlike the government agent: "recent news" that is ten
      // months old is not news, and the tighter window keeps the section from
      // filling up with last year's headlines.
      recency: 'month',
    },
  });

  return { evidence: { summary: text, provider, unsourced }, sources, usage };
}

module.exports = { run };
