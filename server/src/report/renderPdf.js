/**
 * report/renderPdf.js — the Writer's structured document -> a PDF buffer.
 *
 * @react-pdf/renderer over Puppeteer/Playwright deliberately: it's a pure-JS
 * layout engine with no headless Chromium to cold-start, which matters given
 * the pipeline already carries real cold-start risk. Written with
 * React.createElement rather than JSX — this repo has no build/transpile step
 * anywhere, client or server, and there's no reason to introduce one for one
 * file.
 *
 * Three things here exist to keep the document honest rather than to look
 * good, and should not be tidied away:
 *   - unsourced sections are set in grey italic, so "could not be sourced"
 *     reads as a note about the report rather than a finding about the area;
 *   - interpretation sections carry a visible label, because "here is what
 *     the sources say" and "here is what we make of it" are different claims;
 *   - scorecard rows with no data print an em dash and the reason, never a
 *     number.
 */
const React = require('react');
const { Document, Page, Text, View, Link, StyleSheet, renderToBuffer } = require('@react-pdf/renderer');
const { blocks } = require('./markdownLite');

const INK = '#1a1a2e';
const MUTED = '#6b7280';
const FAINT = '#8a8a99';
const RULE = '#d8dbe2';
const ACCENT = '#0A1E3C';

const styles = StyleSheet.create({
  page: { padding: 40, paddingBottom: 56, fontSize: 10.5, fontFamily: 'Helvetica', color: INK },

  coverPage: { padding: 56, fontFamily: 'Helvetica', color: INK, justifyContent: 'center' },
  coverKicker: { fontSize: 10, letterSpacing: 2, color: MUTED, marginBottom: 14, fontFamily: 'Helvetica-Bold' },
  coverTitle: { fontSize: 30, fontFamily: 'Helvetica-Bold', lineHeight: 1.15, marginBottom: 26, color: ACCENT },
  coverRule: { borderBottomWidth: 2, borderBottomColor: ACCENT, width: 90, marginBottom: 26 },
  coverLabel: { fontSize: 8.5, letterSpacing: 1.4, color: MUTED, marginTop: 14, fontFamily: 'Helvetica-Bold' },
  coverValue: { fontSize: 13, marginTop: 3 },
  coverFoot: { position: 'absolute', bottom: 48, left: 56, right: 56, fontSize: 8.5, color: MUTED },

  title: { fontSize: 17, fontFamily: 'Helvetica-Bold', marginBottom: 3 },
  heading: { fontSize: 13.5, fontFamily: 'Helvetica-Bold', marginTop: 20, marginBottom: 7, color: ACCENT },
  subheading: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginTop: 10, marginBottom: 4 },
  para: { marginBottom: 7, lineHeight: 1.45 },
  bullet: { marginBottom: 4, marginLeft: 12, lineHeight: 1.45 },
  bold: { fontFamily: 'Helvetica-Bold' },
  meta: { fontSize: 8.5, color: MUTED, marginBottom: 16 },
  unavailable: { marginBottom: 7, lineHeight: 1.45, color: FAINT, fontFamily: 'Helvetica-Oblique' },
  interpTag: { fontSize: 7.5, color: MUTED, fontFamily: 'Helvetica-Bold', letterSpacing: 0.8, marginBottom: 6 },

  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: RULE, paddingVertical: 4 },
  headRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: ACCENT, paddingBottom: 4, marginTop: 4 },
  th: { fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: ACCENT, letterSpacing: 0.5 },
  td: { fontSize: 9.5 },
  tdMuted: { fontSize: 9.5, color: FAINT, fontFamily: 'Helvetica-Oblique' },
  scoreCell: { fontSize: 12, fontFamily: 'Helvetica-Bold' },
  basis: { fontSize: 8, color: MUTED, marginTop: 1 },

  sourceLine: { fontSize: 8.5, marginBottom: 2.5 },
  sourceLink: { color: '#2563eb' },
  appendixKey: { fontSize: 8.5, fontFamily: 'Helvetica-Bold', marginTop: 6 },
  appendixVal: { fontSize: 8.5, color: MUTED, fontFamily: 'Courier' },
  footer: {
    position: 'absolute', bottom: 26, left: 40, right: 40,
    fontSize: 7.5, color: MUTED, borderTopWidth: 0.5, borderTopColor: RULE, paddingTop: 6,
  },
});

const el = React.createElement;

/**
 * Agent prose -> PDF nodes, with the Markdown the models emit rendered rather
 * than printed. Before this, a section opened with the literal "**Railway
 * Access:**".
 * @param {string} text @param {object} [override] one style for every block
 * @returns {import('react').ReactElement[]}
 */
function paragraphs(text, override) {
  const parsed = blocks(text);
  if (!parsed.length) return [el(Text, { key: 'empty', style: override || styles.para }, '(no content)')];

  return parsed.map((b, i) => {
    const base = override || (b.type === 'heading' ? styles.subheading
      : b.type === 'bullet' ? styles.bullet : styles.para);
    const runs = b.runs.map((r, j) => (r.bold && !override
      ? el(Text, { key: j, style: styles.bold }, r.text)
      : r.text));
    const content = b.type === 'bullet' ? ['•  ', ...runs] : runs;
    return el(Text, { key: i, style: base }, ...content);
  });
}

/** @param {Array<{w:string, text:string, style?:object, sub?:string}>} cells */
function tableRow(cells, rowStyle, key) {
  return el(View, { key, style: rowStyle, wrap: false },
    ...cells.map((c, i) => el(View, { key: i, style: { width: c.w, paddingRight: 6 } },
      el(Text, { style: c.style || styles.td }, c.text),
      c.sub ? el(Text, { style: styles.basis }, c.sub) : null)));
}

/** The scorecard, dashes and all. @param {object} scorecard */
function scorecardNodes(scorecard) {
  if (!scorecard || !scorecard.metrics) return [];
  const out = [
    el(Text, { key: 'h', style: styles.heading }, 'Scorecard'),
    el(Text, { key: 'n', style: styles.basis },
      'Computed from measured route times and place counts, never estimated. '
      + 'Metrics with no data source are left blank rather than guessed.'),
    tableRow([{ w: '38%', text: 'METRIC', style: styles.th }, { w: '12%', text: 'SCORE', style: styles.th },
      { w: '50%', text: 'BASIS', style: styles.th }], styles.headRow, 'head'),
  ];
  scorecard.metrics.forEach((m, i) => {
    const has = m.score != null;
    out.push(tableRow([
      { w: '38%', text: m.label, style: has ? styles.td : styles.tdMuted },
      { w: '12%', text: has ? String(m.score) : '—', style: has ? styles.scoreCell : styles.tdMuted },
      { w: '50%', text: has ? (m.basis || '') : (m.reason || 'no data source'), style: has ? styles.basis : styles.tdMuted },
    ], styles.row, 'm' + i));
  });
  if (scorecard.overall && scorecard.overall.score != null) {
    out.push(tableRow([
      { w: '38%', text: 'Overall', style: styles.bold },
      { w: '12%', text: String(scorecard.overall.score), style: styles.scoreCell },
      { w: '50%', text: scorecard.overall.basis, style: styles.basis },
    ], styles.headRow, 'overall'));
  }
  return out;
}

/** The travel-time matrix. @param {object} matrix */
function travelNodes(matrix) {
  if (!matrix || !matrix.rows || !matrix.rows.length) return [];
  const out = [
    el(Text, { key: 'h', style: styles.heading }, 'Travel Time Matrix'),
    tableRow([
      { w: '24%', text: 'DESTINATION', style: styles.th }, { w: '34%', text: 'PLACE', style: styles.th },
      { w: '14%', text: 'DISTANCE', style: styles.th }, { w: '14%', text: 'OFF-PEAK', style: styles.th },
      { w: '14%', text: 'PEAK', style: styles.th },
    ], styles.headRow, 'head'),
  ];
  matrix.rows.forEach((r, i) => out.push(tableRow([
    { w: '24%', text: r.label }, { w: '34%', text: r.name || '' },
    { w: '14%', text: r.distanceKm != null ? r.distanceKm + ' km' : '—' },
    { w: '14%', text: r.offPeakMin != null ? r.offPeakMin + ' min' : '—' },
    { w: '14%', text: r.peakMin != null ? r.peakMin + ' min' : '—' },
  ], styles.row, 't' + i)));
  out.push(el(Text, { key: 'note', style: styles.basis }, matrix.departureNote || ''));
  return out;
}

/**
 * The measured inputs, printed so every number above can be checked.
 * @param {object} doc
 */
function appendixNodes(doc) {
  const out = [el(Text, { key: 'h', style: styles.heading }, 'Appendix — measured data')];
  const kv = (k, v) => {
    out.push(el(Text, { key: 'k' + k, style: styles.appendixKey }, k));
    out.push(el(Text, { key: 'v' + k, style: styles.appendixVal }, v));
  };
  kv('Coordinates', `${doc.coordinates.lat}, ${doc.coordinates.lng}`);
  if (doc.address) kv('Resolved address', doc.address);
  if (doc.travelMatrix && doc.travelMatrix.rows && doc.travelMatrix.rows.length) {
    kv('Routing', doc.travelMatrix.rows
      .map(r => `${r.label}: ${r.name} — ${r.distanceKm}km, ${r.offPeakMin}/${r.peakMin} min`).join('\n'));
  }
  const infra = doc.scorecard && doc.scorecard.metrics
    && doc.scorecard.metrics.find(m => m.key === 'infrastructure');
  if (infra && infra.counts) {
    kv('Nearby counts (5 km)', Object.entries(infra.counts).map(([k, v]) => `${k}: ${v}`).join(', '));
  }
  return out;
}

/**
 * @param {object} doc the Writer's document
 * @returns {Promise<Buffer>}
 */
async function renderPdf(doc) {
  const generated = new Date(doc.generatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' });
  const meta = doc.meta || { sectionsSourced: 0, sectionsTotal: 0, model: 'unknown' };

  const cover = el(Page, { size: 'A4', style: styles.coverPage, key: 'cover' },
    el(Text, { style: styles.coverKicker }, 'LOCATION INTELLIGENCE REPORT'),
    el(Text, { style: styles.coverTitle }, doc.propertyName || 'Site'),
    el(View, { style: styles.coverRule }),
    el(Text, { style: styles.coverLabel }, 'LOCATION'),
    el(Text, { style: styles.coverValue }, doc.location || ''),
    ...(doc.address
      ? [el(Text, { key: 'al', style: styles.coverLabel }, 'ADDRESS'),
        el(Text, { key: 'av', style: styles.coverValue }, doc.address)]
      : []),
    el(Text, { style: styles.coverLabel }, 'COORDINATES'),
    el(Text, { style: styles.coverValue }, `${doc.coordinates.lat}, ${doc.coordinates.lng}`),
    el(Text, { style: styles.coverFoot },
      `Generated ${generated} IST · ${meta.sectionsSourced} of ${meta.sectionsTotal} sections sourced`),
  );

  const body = [];
  body.push(...scorecardNodes(doc.scorecard));
  body.push(el(Text, { key: 'exh', style: styles.heading }, 'Executive Summary'));
  body.push(...paragraphs(doc.executiveSummary).map((n, j) => React.cloneElement(n, { key: 'ex' + j })));

  doc.sections.forEach((section, i) => {
    body.push(el(Text, { key: 'sh' + i, style: styles.heading }, section.heading));
    if (section.interpretation && !section.unavailable) {
      body.push(el(Text, { key: 'it' + i, style: styles.interpTag },
        'INTERPRETATION — analysis of the research above, not new findings'));
    }
    body.push(...paragraphs(section.body, section.unavailable ? styles.unavailable : null)
      .map((n, j) => React.cloneElement(n, { key: 's' + i + '_' + j })));
    // The matrix belongs with connectivity, where a reader is already
    // thinking about journeys, rather than orphaned in an appendix.
    if (section.heading === 'Connectivity Analysis') body.push(...travelNodes(doc.travelMatrix));
  });

  if (doc.allSources && doc.allSources.length) {
    body.push(el(Text, { key: 'srch', style: styles.heading }, 'Sources'));
    doc.allSources.forEach((s, i) => body.push(
      el(Link, { key: 'src' + i, src: s.uri, style: [styles.sourceLine, styles.sourceLink] }, s.title || s.uri)));
  }
  body.push(...appendixNodes(doc));

  const footer = el(Text, {
    fixed: true,
    style: styles.footer,
    render: ({ pageNumber, totalPages }) =>
      `${doc.propertyName || 'Site'} · ${generated} IST · ${meta.model} · `
      + `${meta.sectionsSourced}/${meta.sectionsTotal} sections sourced · page ${pageNumber} of ${totalPages}`,
  });

  const main = el(Page, { size: 'A4', style: styles.page, key: 'main' },
    el(Text, { style: styles.title }, doc.title),
    el(Text, { style: styles.meta }, `${doc.propertyName} · ${doc.location}`),
    el(View, null, ...body),
    footer,
  );

  return renderToBuffer(el(Document, null, cover, main));
}

module.exports = { renderPdf };
