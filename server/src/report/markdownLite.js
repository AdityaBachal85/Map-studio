/**
 * report/markdownLite.js — just enough Markdown to stop it leaking into a
 * client's PDF.
 *
 * The agents are asked for prose and mostly give it, but they reliably reach
 * for `**bold**` for a lead-in and `### Heading` for a sub-topic. Rendered as
 * literal text — which is what both renderers did — a paragraph opens with
 * "**Railway Access:**" and a subsection reads "### Schools and Educational
 * Institutions". In a document going to a client that looks broken.
 *
 * Deliberately not a Markdown library. Three constructs appear in practice
 * (headings, bold, bullets); a parser for the rest would be code with no
 * caller, and the renderers only have bold/plain runs to map onto anyway.
 * Anything not recognised falls through as plain text, so a new construct
 * degrades to a literal rather than an exception.
 */

/**
 * @typedef {{text:string, bold:boolean}} Run
 * @typedef {{type:'heading'|'para'|'bullet', runs:Run[]}} Block
 */

/**
 * Split one line into bold and plain runs.
 *
 * Unmatched `**` is left alone: a stray pair of asterisks is far more likely
 * to be emphasis the model never closed than something the reader wants to
 * see, but silently swallowing text would be worse than showing it.
 * @param {string} line @returns {Run[]}
 */
function inlineRuns(line) {
  const runs = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(line))) {
    if (m.index > last) runs.push({ text: line.slice(last, m.index), bold: false });
    runs.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) runs.push({ text: line.slice(last), bold: false });
  return runs.length ? runs : [{ text: line, bold: false }];
}

/**
 * Parse agent prose into renderable blocks.
 *
 * Paragraphs are separated by blank lines, but a heading or a bullet ends the
 * paragraph it follows too — models routinely write a heading on the line
 * directly above its text with no blank line between.
 *
 * @param {string} text
 * @returns {Block[]}
 */
function blocks(text) {
  const out = [];
  let para = [];

  const flush = () => {
    if (!para.length) return;
    out.push({ type: 'para', runs: inlineRuns(para.join(' ')) });
    para = [];
  };

  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) { flush(); continue; }

    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      out.push({ type: 'heading', runs: inlineRuns(heading[1].trim()) });
      continue;
    }

    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      flush();
      out.push({ type: 'bullet', runs: inlineRuns(bullet[1].trim()) });
      continue;
    }

    // A bold-only line acts as a lead-in heading — "**Railway Access:**" on
    // its own line is a subheading in everything but syntax.
    const boldOnly = line.match(/^\*\*(.+?):?\*\*:?$/);
    if (boldOnly) {
      flush();
      out.push({ type: 'heading', runs: [{ text: boldOnly[1].trim(), bold: true }] });
      continue;
    }

    para.push(line);
  }
  flush();
  return out;
}

/** Flatten to plain text — for anywhere that cannot carry runs. @param {string} text */
function plain(text) {
  return blocks(text).map(b => b.runs.map(r => r.text).join('')).join('\n\n');
}

module.exports = { blocks, inlineRuns, plain };
