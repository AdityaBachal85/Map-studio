/**
 * agents/connectivity.js — Connectivity Agent: roads, highways, metro,
 * airport, railway, bus access, and approximate travel times around a site.
 *
 * Evidence comes from Gemini's Maps grounding. Stations, highways and
 * airports are place questions, and Maps is the right corpus for them —
 * probed live at an Airoli site it returned five real cited nodes including
 * Airoli station. (Web search is not used here: the answer is about
 * geography, which does not change week to week.)
 */
const router = require('../lib/aiRouter');
const { formatNearby, siteLine, areaName, SOURCE_STEER } = require('./_shared');

/**
 * @param {{site:{name:string,lat:number,lng:number}, nearby:object, place:object}} ctx
 * @returns {Promise<{evidence:object, sources:Array, usage:object}>}
 */
async function run({ site, nearby, place }) {
  const prompt = `${siteLine(site, place)}

Known nearby transit/airport access (already verified, use as a starting point — you do not need to re-derive these):
${formatNearby(nearby, ['transit', 'airport'])}

Describe this site's road and transit connectivity in ${areaName(place, site)}: the major roads and highways it sits near or on, metro and railway access with the nearest stations, airport access with approximate drive time, and bus connectivity. Note any connectivity that is notably good or notably poor.

${SOURCE_STEER}`;

  const { text, sources, usage, provider } = await router.ask({
    task: 'research', prompt, evidence: 'maps',
  });
  return { evidence: { summary: text, provider }, sources, usage };
}

module.exports = { run };
