/**
 * report/renderDocx.js — the Writer's structured document -> a .docx buffer.
 *
 * No markdown parsing step exists in this pipeline — each research agent
 * already returns discrete evidence, and the Writer assembles it into
 * {title, executiveSummary, sections, allSources} directly. Renderers
 * consume that structure as-is.
 */
const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink } = require('docx');

/**
 * @param {{title:string, generatedAt:string, executiveSummary:string,
 *   sections:Array<{heading:string, body:string}>, allSources:Array<{title:string,uri:string}>}} doc
 * @returns {Promise<Buffer>}
 */
async function renderDocx(doc) {
  const children = [
    new Paragraph({ text: doc.title, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: 'Generated ' + new Date(doc.generatedAt).toLocaleString(), spacing: { after: 300 } }),
    new Paragraph({ text: 'Executive Summary', heading: HeadingLevel.HEADING_1 }),
    ...bodyParagraphs(doc.executiveSummary),
  ];

  for (const section of doc.sections) {
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }));
    children.push(...bodyParagraphs(section.body));
  }

  if (doc.allSources && doc.allSources.length) {
    children.push(new Paragraph({ text: 'Sources', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }));
    for (const s of doc.allSources) {
      children.push(new Paragraph({
        children: [new ExternalHyperlink({
          link: s.uri,
          children: [new TextRun({ text: s.title || s.uri, style: 'Hyperlink' })],
        })],
      }));
    }
  }

  const document = new Document({ sections: [{ children }] });
  return Packer.toBuffer(document);
}

/**
 * Split prose on blank lines into separate paragraphs, so a multi-paragraph
 * agent response doesn't render as one wall of text.
 * @param {string} text @returns {Paragraph[]}
 */
function bodyParagraphs(text) {
  const parts = (text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return (parts.length ? parts : ['(no content)']).map(p => new Paragraph({ text: p, spacing: { after: 150 } }));
}

module.exports = { renderDocx };
