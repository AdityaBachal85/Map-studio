/**
 * agents/news.js — News Agent: recent local/property/construction/
 * development news, folding in local crime/safety signal.
 *
 * A dedicated Risk/Crime agent is deferred (see the design doc's
 * "documented for later" roster) — for v6 this covers that ground at lower
 * complexity, since India-wide structured crime-data sources are patchy
 * enough that a dedicated agent wouldn't reliably outperform grounded news
 * search anyway.
 */
const router = require('../lib/aiRouter');
const { siteLine, SOURCE_STEER } = require('./_shared');

/**
 * @param {{site:{name:string,lat:number,lng:number}, nearby:object}} ctx
 * @returns {Promise<{evidence:object, sources:Array, usage:object}>}
 */
async function run({ site }) {
  const prompt = `${siteLine(site)}

Research recent news relevant to this area (roughly the last 12 months): property market or real-estate development news, construction and infrastructure news, and any notable local safety or crime coverage. If recent safety-related coverage exists, summarize it factually and proportionately — do not sensationalize, and do not speculate beyond what is actually reported. If nothing notable turns up on the safety side, say so plainly rather than padding the section.

${SOURCE_STEER}`;

  const { text, sources, usage } = await router.ask({ task: 'research', prompt, grounded: true });
  return { evidence: { summary: text }, sources, usage };
}

module.exports = { run };
