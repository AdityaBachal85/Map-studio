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

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 11, fontFamily: 'Helvetica', color: '#1a1a2e' },
  title: { fontSize: 20, marginBottom: 4, fontFamily: 'Helvetica-Bold' },
  meta: { fontSize: 9, color: '#666', marginBottom: 20 },
  heading: { fontSize: 14, fontFamily: 'Helvetica-Bold', marginTop: 18, marginBottom: 6 },
  para: { marginBottom: 8, lineHeight: 1.4 },
  sourceLine: { fontSize: 9, marginBottom: 3 },
  sourceLink: { color: '#2563eb' },
});

const el = React.createElement;

/** @param {string} text @returns {import('react').ReactElement[]} */
function paragraphs(text) {
  const parts = (text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return (parts.length ? parts : ['(no content)']).map((p, i) => el(Text, { key: i, style: styles.para }, p));
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
    children.push(...paragraphs(section.body));
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
