/**
 * agents/_shared.js — small helpers shared by the four research agents, so
 * each one only has to write its own topic-specific instructions rather than
 * re-deriving how to describe the site and its nearby context every time.
 */

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
 * @param {{name:string, lat:number, lng:number}} site
 * @returns {string}
 */
function siteLine(site) {
  return `Site: "${site.name}" at coordinates ${site.lat}, ${site.lng} (India).`;
}

/**
 * Common closing instructions every research agent's prompt ends with —
 * steering toward real, checkable Indian sources without claiming a hard
 * guarantee Gemini's grounding can't actually enforce (see the design doc's
 * "no hard per-domain restriction on Gemini" open risk).
 */
const SOURCE_STEER =
  'Prefer citing reputable, checkable Indian sources — established news outlets ' +
  '(e.g. Times of India, Business Standard), real-estate portals (e.g. 99acres, Housing.com, ' +
  'MagicBricks), and official/government sources (municipal corporations, PIB, state ' +
  'infrastructure authorities) over unverified blogs or forums. Write in clear prose, ' +
  'not bullet fragments. If you cannot find reliable current information on a point, say so ' +
  'plainly rather than guessing.';

module.exports = { formatNearby, siteLine, SOURCE_STEER };
