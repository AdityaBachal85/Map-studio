/**
 * agents/infrastructure.js — Infrastructure Agent: schools, hospitals,
 * colleges, malls, IT parks, banks, and parks around a site.
 *
 * The best fit for Maps grounding of any agent here — this is literally a
 * places question. Probed live at an Airoli site it returned thirteen cited
 * sources naming EuroSchool Airoli, New Horizon Public School, Coral Bells
 * International and VPM's International, all checkable.
 */
const router = require('../lib/aiRouter');
const { formatNearby, siteLine, areaName, SOURCE_STEER } = require('./_shared');

/**
 * @param {{site:{name:string,lat:number,lng:number}, nearby:object, place:object}} ctx
 * @returns {Promise<{evidence:object, sources:Array, usage:object}>}
 */
async function run({ site, nearby, place }) {
  const prompt = `${siteLine(site, place)}

Known nearby amenities (already verified, use as a starting point — you do not need to re-derive these):
${formatNearby(nearby, ['school', 'college', 'hospital', 'mall'])}

Describe the social and civic infrastructure around this site in ${areaName(place, site)}: reputable schools and colleges, hospitals and healthcare access, shopping and malls, and — where present nearby — IT parks, business districts or major employers. Name specific institutions. Note the overall quality and density of amenities for a resident or investor.

${SOURCE_STEER}`;

  const { text, sources, usage, provider } = await router.ask({
    task: 'research', prompt, evidence: 'maps',
  });
  return { evidence: { summary: text, provider }, sources, usage };
}

module.exports = { run };
