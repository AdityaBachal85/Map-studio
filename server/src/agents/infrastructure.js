/**
 * agents/infrastructure.js — Infrastructure Agent: schools, hospitals,
 * colleges, malls, IT parks, banks, and parks around a site.
 */
const router = require('../lib/aiRouter');
const { formatNearby, siteLine, SOURCE_STEER } = require('./_shared');

/**
 * @param {{site:{name:string,lat:number,lng:number}, nearby:object}} ctx
 * @returns {Promise<{evidence:object, sources:Array, usage:object}>}
 */
async function run({ site, nearby }) {
  const prompt = `${siteLine(site)}

Known nearby amenities (already verified, use as a starting point — you do not need to re-search these specific places):
${formatNearby(nearby, ['school', 'college', 'hospital', 'mall'])}

Research and describe the social and civic infrastructure around this site: reputable schools and colleges, hospitals and healthcare access, shopping/malls, and — if present nearby — IT parks, business districts, or major employers. Note the overall quality and density of amenities for a resident or investor.

${SOURCE_STEER}`;

  const { text, sources, usage } = await router.ask({ task: 'research', prompt, grounded: true });
  return { evidence: { summary: text }, sources, usage };
}

module.exports = { run };
