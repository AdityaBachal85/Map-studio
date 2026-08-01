/**
 * agents/government.js — Government Projects Agent: metro/road/smart-city
 * projects, government notifications, and development plans near a site.
 */
const router = require('../lib/aiRouter');
const { siteLine, SOURCE_STEER } = require('./_shared');

/**
 * @param {{site:{name:string,lat:number,lng:number}, nearby:object}} ctx
 * @returns {Promise<{evidence:object, sources:Array, usage:object}>}
 */
async function run({ site }) {
  const prompt = `${siteLine(site)}

Research current and planned government infrastructure projects near this site: metro line extensions, road widening or highway projects, smart city initiatives, and any official development plans or notifications for the surrounding area. Distinguish clearly between projects that are announced/planned versus already under construction versus completed, and give approximate timelines where they are publicly known.

${SOURCE_STEER}`;

  const { text, sources, usage } = await router.ask({ task: 'research', prompt, grounded: true });
  return { evidence: { summary: text }, sources, usage };
}

module.exports = { run };
