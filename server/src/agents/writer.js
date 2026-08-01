/**
 * agents/writer.js — Report Writer Agent.
 *
 * Never searches. Reads every research agent's evidence for this report and
 * writes only the Executive Summary as pure synthesis over material that's
 * already been researched and cited — cheap and fast, no grounding tool
 * needed. Then assembles the full document structure the renderers consume.
 */
const router = require('../lib/aiRouter');
const { siteLine } = require('./_shared');

/** agent_name -> the section heading it produces, in document order. */
const SECTION_HEADINGS = {
  connectivity: 'Connectivity',
  infrastructure: 'Infrastructure & Amenities',
  government: 'Government & Upcoming Infrastructure Projects',
  news: 'Recent News & Local Safety',
};

/**
 * @param {{name:string,lat:number,lng:number}} site
 * @param {object[]} agentRuns — rows from db.getAgentRuns(reportId), each with
 *   agent_name, evidence, sources (evidence.summary is the section's prose).
 * @returns {Promise<{title:string, generatedAt:string, executiveSummary:string,
 *   sections:Array<{heading:string, body:string, sources:Array}>, allSources:Array}>}
 */
async function run({ site, agentRuns }) {
  const sections = agentRuns
    .filter(r => SECTION_HEADINGS[r.agent_name] && r.evidence)
    .map(r => ({
      heading: SECTION_HEADINGS[r.agent_name],
      body: (r.evidence.summary || '').trim() || '(no findings)',
      sources: r.sources || [],
    }));

  const sectionsForPrompt = sections.map(s => `## ${s.heading}\n${s.body}`).join('\n\n');
  const prompt = `${siteLine(site)}

The sections below have already been researched and written. Write a concise Executive Summary (3-5 sentences) that ties them together into an overall picture of this site — do not repeat section detail verbatim, synthesize the key takeaways. Do not add any heading, just the summary prose itself.

${sectionsForPrompt}`;

  const { text: executiveSummary } = await router.ask({ task: 'write', prompt, grounded: false });

  const allSources = dedupeSources(sections.flatMap(s => s.sources));

  return {
    title: `Location Intelligence Report — ${site.name}`,
    generatedAt: new Date().toISOString(),
    executiveSummary: executiveSummary.trim(),
    sections,
    allSources,
  };
}

/** @param {Array<{title:string,uri:string}>} sources @returns {Array<{title:string,uri:string}>} */
function dedupeSources(sources) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    if (!s || !s.uri || seen.has(s.uri)) continue;
    seen.add(s.uri);
    out.push(s);
  }
  return out;
}

module.exports = { run, SECTION_HEADINGS };
