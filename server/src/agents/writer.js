/**
 * agents/writer.js — Report Writer Agent.
 *
 * Never searches. Reads every research agent's evidence for this report and
 * writes only the Executive Summary as pure synthesis over material that's
 * already been researched and cited — cheap and fast, no grounding tool
 * needed. Then assembles the full document structure the renderers consume.
 */
const router = require('../lib/aiRouter');
const { siteLine, areaName, formatScorecard } = require('./_shared');
const { MODEL_BY_TASK } = require('../lib/aiRouter');

/**
 * agent_name -> heading, in document order, with `interpretation` marking the
 * sections that add no facts.
 *
 * That flag is not cosmetic. Research and interpretation carry different
 * weight — one is "here is what the sources say", the other is "here is what
 * we make of it" — and a reader deciding on a property is entitled to see
 * which is which without inferring it from the prose.
 */
const SECTIONS = [
  { agent: 'connectivity', heading: 'Connectivity Analysis' },
  { agent: 'infrastructure', heading: 'Infrastructure & Amenities' },
  { agent: 'government', heading: 'Government & Upcoming Projects' },
  { agent: 'news', heading: 'News Intelligence' },
  { agent: 'swot', heading: 'SWOT Analysis', interpretation: true },
  { agent: 'risk', heading: 'Risk Assessment', interpretation: true },
  { agent: 'investment', heading: 'Investment Analysis', interpretation: true },
  { agent: 'timeline', heading: 'Development Timeline', interpretation: true },
  { agent: 'insights', heading: 'Key Insights', interpretation: true },
];

/** Kept for callers that still look up a single heading by agent name. */
const SECTION_HEADINGS = Object.fromEntries(SECTIONS.map(s => [s.agent, s.heading]));

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

async function run({ site, agentRuns, place, scorecard, matrix }) {
  const byAgent = Object.fromEntries((agentRuns || []).map(r => [r.agent_name, r]));

  const sections = SECTIONS.map(spec => {
    const r = byAgent[spec.agent];
    const evidence = (r && r.evidence) || {};
    const body = (evidence.summary || '').trim();
    // An errored run has no evidence at all; an unsourced one has evidence
    // with an explicit reason and an empty summary. Both are "we do not
    // know", and both must read as that rather than as an empty finding.
    const unavailable = body ? null
      : (evidence.unsourced || (r && r.error) || 'the research step did not complete');
    return {
      heading: spec.heading,
      interpretation: spec.interpretation || undefined,
      body: unavailable ? unavailableBody(unavailable) : body,
      unavailable: unavailable || undefined,
      sources: (r && r.sources) || [],
    };
  });

  const sourced = sections.filter(s => !s.unavailable && !s.interpretation);

  // With nothing sourced there is nothing to summarise, and asking a model to
  // write an executive summary over a page of "could not be sourced" notices
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

Write the Executive Summary for a property location-intelligence report on this site, in four short labelled parts:
Overview — what and where this site is, in two sentences.
Key findings — the three or four things that most matter, drawn from the research below.
Opportunities — what the evidence suggests could work in this site's favour.
Risks — what the evidence suggests should give a buyer pause.

Keep the whole thing under 350 words. Do not repeat section detail verbatim. Do not add a top-level heading.
${missing.length ? `\nThese sections could not be sourced and are absent from the report: ${missing.join(', ')}. Do not speculate about them, and do not imply the report covers them.\n` : ''}
${scorecard ? `Measured scores (computed, not estimated):\n${formatScorecard(scorecard)}\n` : ''}
${sectionsForPrompt}`;

    const { text } = await router.ask({ task: 'write', prompt, evidence: false });
    executiveSummary = (text || '').trim();
  }

  const allSources = dedupeSources(sections.flatMap(s => s.sources));

  return {
    title: 'Location Intelligence Report',
    propertyName: site.name,
    location: areaName(place, site),
    address: (place && place.formattedAddress) || null,
    coordinates: { lat: site.lat, lng: site.lng },
    generatedAt: new Date().toISOString(),
    scorecard: scorecard || null,
    travelMatrix: matrix || null,
    executiveSummary,
    sections,
    allSources,
    // The footer. Recorded because a report is a dated artefact — six months
    // on, "which model wrote this and what could it see" is the first
    // question anyone re-reading it will have.
    meta: {
      model: MODEL_BY_TASK.write,
      sectionsSourced: sections.filter(s => !s.unavailable).length,
      sectionsTotal: sections.length,
      researchMode: sections.some(s => !s.unavailable && !s.interpretation) ? 'live sources' : 'none',
    },
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

module.exports = { run, SECTIONS, SECTION_HEADINGS };
