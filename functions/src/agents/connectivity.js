/**
 * agents/connectivity.js — Connectivity Agent: roads, highways, metro,
 * airport, railway, bus access, and approximate travel times around a site.
 */
const router = require('../lib/aiRouter');
const { formatNearby, siteLine, SOURCE_STEER } = require('./_shared');

/**
 * @param {{site:{name:string,lat:number,lng:number}, nearby:object}} ctx
 * @returns {Promise<{evidence:object, sources:Array, usage:object}>}
 */
async function run({ site, nearby }) {
  const prompt = `${siteLine(site)}

Known nearby transit/airport access (already verified, use as a starting point — you do not need to re-search these specific places):
${formatNearby(nearby, ['transit', 'airport'])}

Research and describe this site's road and transit connectivity: major roads and highways it sits near or on, metro/railway access and the nearest stations, airport access and approximate drive time, and bus connectivity. Note any connectivity that is notably good or notably poor.

${SOURCE_STEER}`;

  const { text, sources, usage } = await router.ask({ task: 'research', prompt, grounded: true });
  return { evidence: { summary: text }, sources, usage };
}

module.exports = { run };
