/**
 * report/renderPdf.js — the Writer's structured document -> a PDF buffer.
 *
 * @react-pdf/renderer over Puppeteer/Playwright deliberately: it's a pure-JS
 * layout engine with no headless Chromium to cold-start, which matters given
 * the pipeline already carries real cold-start risk from several sequential
 * Gemini calls (see the design doc's open risks). Written with
 * React.createElement rather than JSX — this repo has no build/transpile
 * step anywhere, client or server, and there's no reason to introduce one
 * just for this file.
 */
const React = require('react');
const { Document, Page, Text, View, Link, StyleSheet, renderToBuffer } = require('@react-pdf/renderer');
const { blocks } = require('./markdownLite');

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 11, fontFamily: 'Helvetica', color: '#1a1a2e' },
  title: { fontSize: 20, marginBottom: 4, fontFamily: 'Helvetica-Bold' },
  meta: { fontSize: 9, color: '#666', marginBottom: 20 },
  heading: { fontSize: 14, fontFamily: 'Helvetica-Bold', marginTop: 18, marginBottom: 6 },
  para: { marginBottom: 8, lineHeight: 1.4 },
  sourceLine: { fontSize: 9, marginBottom: 3 },
  sourceLink: { color: '#2563eb' },
  // An unsourced section is set apart on purpose. Left in the body face it
  // reads as a finding about the area; grey and italic, it reads as a note
  // about the report, which is what it is.
  unavailable: { marginBottom: 8, lineHeight: 1.4, color: '#8a8a99', fontFamily: 'Helvetica-Oblique' },
  subheading: { fontSize: 11.5, fontFamily: 'Helvetica-Bold', marginTop: 10, marginBottom: 4 },
  bullet: { marginBottom: 4, marginLeft: 12, lineHeight: 1.4 },
  bold: { fontFamily: 'Helvetica-Bold' },
});

const el = React.createElement;

/**
 * Agent prose -> PDF nodes, with the Markdown the models emit rendered
 * rather than printed. Before this, a section opened with the literal text
 * "**Railway Access:**".
 * @param {string} text @param {object} [override] style for every block
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
    const content = b.type === 'bullet' ? ['\u2022  ', ...runs] : runs;
    return el(Text, { key: i, style: base }, ...content);
  });
}

/**
 * @param {{title:string, generatedAt:string, executiveSummary:string,
 *   sections:Array<{heading:string, body:string}>, allSources:Array<{title:string,uri:string}>}} doc
 * @returns {Promise<Buffer>}
 */
async function renderPdf(doc) {
  const children = [
    el(Text, { style: styles.title }, doc.title),
    el(Text, { style: styles.meta }, 'Generated ' + new Date(doc.generatedAt).toLocaleString()),
    el(Text, { style: styles.heading }, 'Executive Summary'),
    ...paragraphs(doc.executiveSummary),
  ];

  for (const section of doc.sections) {
    children.push(el(Text, { style: styles.heading }, section.heading));
    children.push(...paragraphs(section.body, section.unavailable ? styles.unavailable : null));
  }

  if (doc.allSources && doc.allSources.length) {
    children.push(el(Text, { style: styles.heading }, 'Sources'));
    doc.allSources.forEach((s, i) => {
      children.push(el(Link, { key: i, src: s.uri, style: [styles.sourceLine, styles.sourceLink] }, s.title || s.uri));
    });
  }

  const pdfDoc = el(Document, null, el(Page, { size: 'A4', style: styles.page }, el(View, null, ...children)));
  return renderToBuffer(pdfDoc);
}

module.exports = { renderPdf };
