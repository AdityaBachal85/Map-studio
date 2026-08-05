/**
 * report/renderDocx.js — the Writer's structured document -> a .docx buffer.
 *
 * Deliberately mirrors renderPdf.js rather than sharing a layout layer with
 * it: the two formats have genuinely different primitives (flex boxes against
 * Word tables), and the one thing that must stay identical between them is
 * not the layout but the honesty — unsourced sections grey and italic,
 * interpretation sections labelled, and scorecard rows with no data showing
 * an em dash and a reason instead of a number.
 */
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink,
  Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType, PageBreak,
} = require('docx');
const { blocks } = require('./markdownLite');

const MUTED = '6B7280';
const FAINT = '8A8A99';
const ACCENT = '0A1E3C';

/** @param {string} text @param {object} [opts] */
const small = (text, opts) => new Paragraph({
  children: [new TextRun({ text, size: 16, color: (opts && opts.color) || MUTED, italics: !!(opts && opts.italics) })],
  spacing: { after: (opts && opts.after) != null ? opts.after : 80 },
});

/** A table cell. @param {string} text @param {object} [opts] */
function cell(text, opts) {
  const o = opts || {};
  return new TableCell({
    width: { size: o.width || 20, type: WidthType.PERCENTAGE },
    margins: { top: 60, bottom: 60, right: 90 },
    borders: {
      top: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      bottom: { style: o.head ? BorderStyle.SINGLE : BorderStyle.SINGLE, size: o.head ? 8 : 2, color: o.head ? ACCENT : 'D8DBE2' },
    },
    children: [new Paragraph({
      children: [new TextRun({
        text,
        bold: !!o.bold || !!o.head,
        italics: !!o.italics,
        size: o.size || (o.head ? 15 : 19),
        color: o.color || (o.head ? ACCENT : undefined),
      })],
    })],
  });
}

/** @param {object} scorecard @returns {Array} */
function scorecardBlock(scorecard) {
  if (!scorecard || !scorecard.metrics) return [];
  const rows = [new TableRow({
    children: [cell('METRIC', { width: 32, head: true }), cell('SCORE', { width: 12, head: true }), cell('BASIS', { width: 56, head: true })],
  })];

  for (const m of scorecard.metrics) {
    const has = m.score != null;
    rows.push(new TableRow({
      children: [
        cell(m.label, { width: 32, italics: !has, color: has ? undefined : FAINT }),
        cell(has ? String(m.score) : '—', { width: 12, bold: has, size: has ? 24 : 19, italics: !has, color: has ? undefined : FAINT }),
        cell(has ? (m.basis || '') : (m.reason || 'no data source'),
          { width: 56, size: 16, italics: !has, color: has ? MUTED : FAINT }),
      ],
    }));
  }
  if (scorecard.overall && scorecard.overall.score != null) {
    rows.push(new TableRow({
      children: [
        cell('Overall', { width: 32, bold: true }),
        cell(String(scorecard.overall.score), { width: 12, bold: true, size: 24 }),
        cell(scorecard.overall.basis, { width: 56, size: 16, color: MUTED }),
      ],
    }));
  }

  return [
    new Paragraph({ text: 'Scorecard', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }),
    small('Computed from measured route times and place counts, never estimated. '
      + 'Metrics with no data source are left blank rather than guessed.'),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }),
  ];
}

/** @param {object} matrix @returns {Array} */
function travelBlock(matrix) {
  if (!matrix || !matrix.rows || !matrix.rows.length) return [];
  const rows = [new TableRow({
    children: [
      cell('DESTINATION', { width: 22, head: true }), cell('PLACE', { width: 34, head: true }),
      cell('DISTANCE', { width: 14, head: true }), cell('OFF-PEAK', { width: 15, head: true }),
      cell('PEAK', { width: 15, head: true }),
    ],
  })];
  for (const r of matrix.rows) {
    rows.push(new TableRow({
      children: [
        cell(r.label, { width: 22 }), cell(r.name || '', { width: 34 }),
        cell(r.distanceKm != null ? r.distanceKm + ' km' : '—', { width: 14 }),
        cell(r.offPeakMin != null ? r.offPeakMin + ' min' : '—', { width: 15 }),
        cell(r.peakMin != null ? r.peakMin + ' min' : '—', { width: 15 }),
      ],
    }));
  }
  return [
    new Paragraph({ text: 'Travel Time Matrix', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }),
    small(matrix.departureNote || ''),
  ];
}

/**
 * Split prose into paragraphs, rendering the Markdown the agents emit.
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
        children: b.runs.map(r => new TextRun({ text: r.text, italics: true, color: FAINT })),
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

/**
 * @param {object} doc the Writer's document
 * @returns {Promise<Buffer>}
 */
async function renderDocx(doc) {
  const generated = new Date(doc.generatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' });
  const meta = doc.meta || { sectionsSourced: 0, sectionsTotal: 0, model: 'unknown' };

  const coverLine = (label, value) => [
    new Paragraph({ children: [new TextRun({ text: label, size: 15, bold: true, color: MUTED })], spacing: { before: 220 } }),
    new Paragraph({ children: [new TextRun({ text: value, size: 24 })] }),
  ];

  const children = [
    new Paragraph({
      children: [new TextRun({ text: 'LOCATION INTELLIGENCE REPORT', size: 18, bold: true, color: MUTED })],
      spacing: { before: 2400, after: 200 },
    }),
    new Paragraph({
      children: [new TextRun({ text: doc.propertyName || 'Site', size: 56, bold: true, color: ACCENT })],
      spacing: { after: 240 },
    }),
    ...coverLine('LOCATION', doc.location || ''),
    ...(doc.address ? coverLine('ADDRESS', doc.address) : []),
    ...coverLine('COORDINATES', `${doc.coordinates.lat}, ${doc.coordinates.lng}`),
    new Paragraph({
      children: [new TextRun({
        text: `Generated ${generated} IST · ${meta.sectionsSourced} of ${meta.sectionsTotal} sections sourced`,
        size: 16, color: MUTED,
      })],
      spacing: { before: 600 },
    }),
    new Paragraph({ children: [new PageBreak()] }),

    ...scorecardBlock(doc.scorecard),

    new Paragraph({ text: 'Executive Summary', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }),
    ...bodyParagraphs(doc.executiveSummary),
  ];

  for (const section of doc.sections) {
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }));
    if (section.interpretation && !section.unavailable) {
      children.push(small('INTERPRETATION — analysis of the research above, not new findings', { after: 120 }));
    }
    children.push(...bodyParagraphs(section.body, !!section.unavailable));
    if (section.heading === 'Connectivity Analysis') children.push(...travelBlock(doc.travelMatrix));
  }

  if (doc.allSources && doc.allSources.length) {
    children.push(new Paragraph({ text: 'Sources', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }));
    for (const s of doc.allSources) {
      children.push(new Paragraph({
        children: [new ExternalHyperlink({
          link: s.uri,
          children: [new TextRun({ text: s.title || s.uri, style: 'Hyperlink', size: 17 })],
        })],
      }));
    }
  }

  // The measured inputs, so every number above can be checked.
  children.push(new Paragraph({ text: 'Appendix — measured data', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }));
  const kv = (k, v) => {
    children.push(new Paragraph({ children: [new TextRun({ text: k, bold: true, size: 17 })], spacing: { before: 120 } }));
    children.push(new Paragraph({ children: [new TextRun({ text: v, size: 17, font: 'Courier New', color: MUTED })] }));
  };
  kv('Coordinates', `${doc.coordinates.lat}, ${doc.coordinates.lng}`);
  if (doc.address) kv('Resolved address', doc.address);
  if (doc.travelMatrix && doc.travelMatrix.rows && doc.travelMatrix.rows.length) {
    kv('Routing', doc.travelMatrix.rows
      .map(r => `${r.label}: ${r.name} — ${r.distanceKm}km, ${r.offPeakMin}/${r.peakMin} min`).join('; '));
  }
  const infra = doc.scorecard && doc.scorecard.metrics
    && doc.scorecard.metrics.find(m => m.key === 'infrastructure');
  if (infra && infra.counts) {
    kv('Nearby counts (5 km)', Object.entries(infra.counts).map(([k, v]) => `${k}: ${v}`).join(', '));
  }
  children.push(new Paragraph({
    children: [new TextRun({
      text: `${doc.propertyName || 'Site'} · ${generated} IST · model ${meta.model} · `
        + `${meta.sectionsSourced}/${meta.sectionsTotal} sections sourced`,
      size: 15, color: MUTED,
    })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 400 },
  }));

  const document = new Document({ sections: [{ children }] });
  return Packer.toBuffer(document);
}

module.exports = { renderDocx };
