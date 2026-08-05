/**
 * report/renderDocx.js — the Writer's structured document -> a .docx buffer.
 *
 * No markdown parsing step exists in this pipeline — each research agent
 * already returns discrete evidence, and the Writer assembles it into
 * {title, executiveSummary, sections, allSources} directly. Renderers
 * consume that structure as-is.
 */
const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink } = require('docx');
const { blocks } = require('./markdownLite');

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
    children.push(...bodyParagraphs(section.body, !!section.unavailable));
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
 *
 * `unavailable` sets the text apart in grey italics for the same reason the
 * PDF does: in the body face, "this section could not be sourced" reads as a
 * finding about the area rather than a note about the report.
 * @param {string} text @param {boolean} [unavailable] @returns {Paragraph[]}
 */
function bodyParagraphs(text, unavailable) {
  const parsed = blocks(text);
  if (!parsed.length) return [new Paragraph({ text: '(no content)', spacing: { after: 150 } })];

  return parsed.map(b => {
    if (unavailable) {
      return new Paragraph({
        children: b.runs.map(r => new TextRun({ text: r.text, italics: true, color: '8A8A99' })),
        spacing: { after: 150 },
      });
    }
    if (b.type === 'heading') {
      return new Paragraph({
        children: b.runs.map(r => new TextRun({ text: r.text, bold: true })),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 },
      });
    }
    return new Paragraph({
      children: b.runs.map(r => new TextRun({ text: r.text, bold: r.bold })),
      bullet: b.type === 'bullet' ? { level: 0 } : undefined,
      spacing: { after: 150 },
    });
  });
}

module.exports = { renderDocx };
