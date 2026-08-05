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
/**
 * What a section says when nothing could be sourced for it.
 *
 * Deliberately not "no findings", which reads as "we looked and the area has
 * none" — the opposite of the truth, and the more damaging reading in a
 * report used to make a decision. The failure is the tool's, so the sentence
 * says that, and the operator-facing reason rides along so a blank section is
 * diagnosable without opening the server logs.
 * @param {string} [reason]
 */
function unavailableBody(reason) {
  return 'This section could not be sourced. No verified information was retrieved, '
    + 'so nothing is reported here rather than presenting unverified claims.'
    + (reason ? `\n\n(Reason: ${reason})` : '');
}

async function run({ site, agentRuns, place }) {
  const sections = agentRuns
    .filter(r => SECTION_HEADINGS[r.agent_name])
    .map(r => {
      const evidence = r.evidence || {};
      const body = (evidence.summary || '').trim();
      // An errored run has no evidence at all; an unsourced one has evidence
      // with an explicit reason and an empty summary. Both are "we do not
      // know", and both must read as that rather than as an empty finding.
      const unavailable = !body ? (evidence.unsourced || r.error || 'the research step did not complete') : null;
      return {
        heading: SECTION_HEADINGS[r.agent_name],
        body: unavailable ? unavailableBody(unavailable) : body,
        unavailable: unavailable || undefined,
        sources: r.sources || [],
      };
    });

  const sourced = sections.filter(s => !s.unavailable);

  // With nothing sourced there is nothing to summarise, and asking a model to
  // write an executive summary over four "could not be sourced" notices
  // invites it to fill the gap from memory — the exact failure this pipeline
  // is built to avoid.
  let executiveSummary;
  if (!sourced.length) {
    executiveSummary = 'No section of this report could be sourced. Nothing is summarised here '
      + 'because there are no verified findings to summarise.';
  } else {
    const sectionsForPrompt = sourced.map(s => `## ${s.heading}\n${s.body}`).join('\n\n');
    const missing = sections.filter(s => s.unavailable).map(s => s.heading);
    const prompt = `${siteLine(site, place)}

The sections below have already been researched and written. Write a concise Executive Summary (3-5 sentences) that ties them together into an overall picture of this site — do not repeat section detail verbatim, synthesize the key takeaways. Do not add any heading, just the summary prose itself.
${missing.length ? `\nThese sections could not be sourced and are absent from the report: ${missing.join(', ')}. Do not speculate about them, and do not imply the report covers them.\n` : ''}
${sectionsForPrompt}`;

    const { text } = await router.ask({ task: 'write', prompt, evidence: false });
    executiveSummary = (text || '').trim();
  }

  const allSources = dedupeSources(sections.flatMap(s => s.sources));

  return {
    title: `Location Intelligence Report — ${site.name}`,
    generatedAt: new Date().toISOString(),
    executiveSummary,
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
