/**
 * export/dashExportModel.js — what the board IS, without any DOM.
 *
 * WHY THIS EXISTS. The board's export used to be one html2canvas pass over
 * #dashGrid: everything on the page flattened into a single bitmap, wrapped in
 * a PDF. That is a fine way to make a picture and a hopeless one to make a
 * document — a picture has no text to select, no table to copy, no shape to
 * edit, and no idea which of its cards were empty.
 *
 * Asking for a PDF with real text, a PowerPoint of real shapes and a Word file
 * of real tables is asking the same question three times: *what is on this
 * board?* Answered once, here, and each writer renders the answer its own way.
 * Answered three times, in three writers, they drift — and the one that drifts
 * is always the one nobody opened this week.
 *
 * NO DOM, ON PURPOSE. Everything here reads `dashCards` / `dashMapTile` and
 * plain objects. The one thing it genuinely cannot know by itself is what
 * `var(--viz-3)` resolves to, because that lives in a stylesheet and depends on
 * the active theme — so that is injected (see `resolveColor`) rather than
 * reached for. The consequence is that this file runs under Node, which is
 * where its tests are: the shape of an export is worth proving without a
 * browser in the way.
 */

/**
 * The board's grid, restated so a writer can lay a page out without measuring
 * the screen. These mirror dashLayout.js — kept in step by
 * dash-export-model.cjs, which fails if they drift.
 */
const DASH_MODEL_COLS = 12;

/**
 * Turn a slot reference into something a file format can use.
 *
 * A card stores a slot number and `vizSlot()` turns it into `var(--viz-3)`,
 * which is exactly right on a page and meaningless in a PDF, a PPTX or a DOCX.
 * Nothing in the old export path resolved these, because a screenshot never had
 * to: the browser did it. Every writer downstream of here needs a literal.
 *
 * @param {string|number} c a slot number, a `var(--viz-N)` string, or a hex
 * @param {function(string):string} [resolve] maps a CSS custom property name to
 *   its value; supply the real one in a browser, a table in a test
 * @returns {string} a hex colour
 */
function dashModelColor(c, resolve) {
  if (c == null || c === '') return DASH_MODEL_FALLBACK;
  if (typeof c === 'number') return dashModelColor('var(--viz-' + c + ')', resolve);
  const s = String(c).trim();
  if (s.charAt(0) === '#') return s;
  const m = s.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (!m) return s;                       // a named colour or rgb() — pass it through
  const got = resolve ? resolve(m[1]) : '';
  return (got && String(got).trim()) || DASH_MODEL_FALLBACK;
}

/** Used when a colour cannot be resolved at all. Grey, so it reads as unset
 *  rather than as a confident wrong answer. */
const DASH_MODEL_FALLBACK = '#8A94A6';

/**
 * The words out of a marked-up field, with no DOM.
 *
 * This file runs under Node as well as in the browser — that is the point of it
 * — so it cannot reach for a `<div>` to do this. The tag set a card may store
 * is tiny and fixed (see js/ui/dashRichText.js), which is what makes stripping
 * it with a regex honest rather than the usual mistake.
 *
 * @param {*} v @returns {string} the text, with breaks as newlines
 */
function dashModelPlain(v) {
  const s = String(v == null ? '' : v);
  // An ampersand is markup too. Skipping on "no angle brackets" left
  // "Kalyan &amp; Shil" in a document as those five characters, because a field
  // holding an entity and no tag took the fast path out.
  if (s.indexOf('<') < 0 && s.indexOf('&') < 0) return s;
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The same text, split into runs that each carry their own marks.
 *
 * A writer that can set bold on part of a paragraph — Word and PowerPoint both
 * can, and a PDF gets Helvetica-Bold for nothing because it is one of the
 * fourteen built-in faces — needs to know WHICH part. Flattening first and
 * bolding nothing is a document that has quietly lost what somebody marked.
 *
 * Depth-counted rather than nested: a run is described by which marks are open
 * over it, so `<b>a<i>b</i></b>` gives two runs and not a tree.
 *
 * @param {*} v @returns {Array<{text:string,b:boolean,i:boolean,u:boolean,s:boolean,hi:?string,fg:?string}>}
 */
function dashModelRuns(v) {
  const src = String(v == null ? '' : v);
  const TAG = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', del: 's' };
  // ONE STACK, NOT A MARK COUNTER AND A SEPARATE INK STACK. A tag can be both:
  // highlighting a phrase that is already bold does not wrap it, it puts the
  // background straight onto the `<b>`, so `<b style="background-color: …">` is
  // a bold AND a highlight opened by the same tag and closed by the same tag.
  // Tracked apart, the ink was only ever read off a `<span>` and a highlight
  // over bold text reached the file as plain bold.
  const stack = [];
  const out = [];

  const push = t => {
    if (t === '') return;
    let hi = null, fg = null;
    const on = { b: false, i: false, u: false, s: false };
    for (let n = 0; n < stack.length; n++) {
      const e = stack[n];
      if (e.k) on[e.k] = true;
      if (e.hi) hi = e.hi;
      if (e.fg) fg = e.fg;
    }
    const run = { text: t, b: on.b, i: on.i, u: on.u, s: on.s, hi: hi, fg: fg };
    const last = out[out.length - 1];
    // Merged where the marks match, so `<b>a</b><b>b</b>` is one run and a
    // writer does not emit two adjacent identical formatting blocks.
    if (last && last.b === run.b && last.i === run.i && last.u === run.u
      && last.s === run.s && last.hi === run.hi && last.fg === run.fg) {
      last.text += t;
      return;
    }
    out.push(run);
  };

  let at = 0;
  src.replace(/<\/?([a-z]+)([^>]*)>/gi, (m, rawName, attrs, idx) => {
    push(dashModelPlain(src.slice(at, idx)));
    at = idx + m.length;
    const name = rawName.toLowerCase();
    if (name === 'br') { push('\n'); return m; }
    if (m.charAt(1) === '/') {
      // Pop back to the matching open, so a stray close cannot unwind the lot.
      for (let n = stack.length - 1; n >= 0; n--) {
        if (stack[n].tag === name) { stack.splice(n, 1); break; }
      }
      return m;
    }
    if (/\/>\s*$/.test(m)) return m;                  // self-closing, nothing to open
    const hiM = /background-color\s*:\s*([^;"']+)/i.exec(attrs);
    const fgM = /(?:^|[;"'\s])color\s*:\s*([^;"']+)/i.exec(attrs);
    const k = TAG[name] || null;
    const hi = hiM ? hiM[1].trim() : (name === 'mark' ? '#fff3a3' : null);
    if (!k && !hi && !fgM) return m;                   // a tag that says nothing
    stack.push({ tag: name, k: k, hi: hi, fg: fgM ? fgM[1].trim() : null });
    return m;
  });
  push(dashModelPlain(src.slice(at)));
  return out;
}

/** @param {*} v @returns {?string} a literal hex, or null if it is not one */
function dashModelHex(v) {
  const s = String(v == null ? '' : v).trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : null;
}

/** @param {*} v @returns {boolean} is this a value somebody actually typed? */
function dashModelHasValue(v) {
  if (v == null) return false;
  if (typeof v === 'number') return isFinite(v);
  return String(v).trim() !== '';
}

/**
 * The prompts a fresh board ships with, in the cards' own body text.
 *
 * These are not hints beside the content, they ARE the content — dashCards.js
 * seeds a text card with "Type the summary that opens the report." so the empty
 * card explains itself. Which is right on screen and wrong in a file: a text
 * card nobody touched is an empty card, and left unrecognised it exports as an
 * instruction addressed to the reader, in the voice of the document.
 *
 * Matched exactly and case-insensitively, so the moment anybody edits the words
 * they are their words and are treated as content.
 */
const DASH_MODEL_PROMPTS = [
  'type here.',
  'type the summary that opens the report.',
  'type the address, the coordinates and anything else worth saying up front.',
];

/** @param {*} v @returns {boolean} typed content, as opposed to a seeded prompt */
function dashModelTyped(v) {
  if (!dashModelHasValue(v)) return false;
  return DASH_MODEL_PROMPTS.indexOf(String(v).trim().toLowerCase()) < 0;
}

/**
 * The chart module's scale rules, wherever this file is running.
 *
 * In the browser they are globals from js/ui/dashCharts.js; under Node they are
 * required from that same file. Either way there is one definition of what a
 * score is measured against — a second copy here would agree with the drawing
 * exactly until the day somebody changed one of them.
 *
 * @returns {?{kinds:string[], max:function(object, number[]):number}}
 */
function dashModelViz() {
  if (typeof VIZ_SCORE_KINDS !== 'undefined' && typeof vizScoreMax === 'function') {
    return { kinds: VIZ_SCORE_KINDS, max: vizScoreMax,
      byCat: typeof VIZ_CATEGORY_KEYED !== 'undefined' ? VIZ_CATEGORY_KEYED : [] };
  }
  if (typeof require === 'function') {
    try {
      const m = require('../ui/dashCharts.js');
      if (m && m.VIZ_SCORE_KINDS) {
        return { kinds: m.VIZ_SCORE_KINDS, max: m.vizScoreMax,
          byCat: m.VIZ_CATEGORY_KEYED || [] };
      }
    } catch (e) { /* not reachable from here; the ceiling simply is not reported */ }
  }
  return null;
}

/**
 * Is this card carrying anything, or is it still a placeholder?
 *
 * THE EXPORT NEEDS THIS AND THE SCREEN DOES NOT. On the board an empty card is
 * an invitation — it says what to type into it. In a file handed to a client it
 * is a blank box, and the prompt inside it ("turn on Edit board to type them")
 * is worse: an instruction addressed to somebody who cannot act on it, printed
 * in a document that is supposed to be finished.
 *
 * What counts as empty is per type and deliberately strict: a chart with five
 * category labels and no numbers is empty, because the labels are the default
 * ones nobody chose. A table whose cells are all blank is empty however many
 * rows it has.
 *
 * @param {object} card @returns {boolean}
 */
function dashModelCardEmpty(card) {
  if (!card) return true;
  switch (card.type) {
    case 'chart':
      return !(card.seriesList || []).some(s => (s.values || []).some(dashModelHasValue));
    case 'stat':
      return !dashModelHasValue(card.value);
    case 'stats':
      return !(card.items || []).some(i => dashModelHasValue(i.value));
    case 'gauges':
      return !(card.items || []).some(i => dashModelHasValue(i.value));
    case 'table':
      return !(card.rows || []).some(r => (r || []).some(dashModelHasValue));
    case 'list':
      return !(card.items || []).some(i => dashModelHasValue(i.name) || dashModelHasValue(i.meta));
    case 'text':
      // A seeded prompt is not content — see DASH_MODEL_PROMPTS.
      return !dashModelTyped(card.body);
    case 'slicer':
      return !(card.items || []).length;
    // The two live cards are empty only when the map is: they are never typed
    // into, so an empty one is a statement about the map, not a to-do.
    case 'comment':
      return !dashModelTyped(card.body);
    case 'rating':
      return !dashModelHasValue(card.value);
    case 'access':
      return !(card._rows || []).length;
    case 'legend':
      return !(card._rows || []).length;
    default:
      return false;
  }
}

/**
 * The per-type payload, normalised.
 *
 * Every writer gets the same field names whatever the card is, so a PPTX table
 * and a DOCX table are reading one structure rather than each re-deriving it
 * from the card's own idiosyncratic shape.
 *
 * @param {object} card @param {function(string):string} resolve
 * @returns {object}
 */
function dashModelData(card, resolve) {
  const col = c => dashModelColor(c, resolve);
  switch (card.type) {
    case 'chart': {
      const kind = card.kind || 'column';
      const m = {
        kind,
        labels: (card.labels || []).slice(),
        series: (card.seriesList || []).map(s => ({
          name: s.name || '',
          values: (s.values || []).map(v => (dashModelHasValue(v) ? Number(v) : null)),
          // A colour chosen outside the palette is already a literal; a slot
          // has to be resolved. The file has to agree with the screen either
          // way, which is the whole reason this model exists.
          color: /^#[0-9a-f]{6}$/i.test(String(s.hex || '')) ? String(s.hex).toLowerCase() : col(s.slot),
          // Per-point overrides, resolved the same way. A bar the operator
          // coloured to say "look at this one" has to say it in the file too.
          points: (s.points && Object.keys(s.points).length)
            ? Object.keys(s.points).reduce((a, k) => {
              const v = String(s.points[k] || '');
              if (/^#[0-9a-f]{6}$/i.test(v)) a[k] = v.toLowerCase();
              return a;
            }, {})
            : null,
        })),
      };

      // WHAT COLOUR IS SLICE THREE — answered here rather than left for each
      // writer to work out. A pie, donut, ring, funnel or treemap draws one
      // mark per CATEGORY out of a single series, so the `color` above — the
      // series' own — describes none of them, and a writer reading it would
      // paint all five slices the same. Resolved to literals in category order,
      // so PDF, PowerPoint and Word all get the picture that is on the screen
      // without re-deriving the rule three times and drifting.
      // A ring, a gauge and a radar are drawn as a fraction of a ceiling, so the
      // ceiling is part of what they say. Read out of a document without it,
      // "82" has lost the half that made it mean anything.
      const viz = dashModelViz();
      if (viz && viz.kinds.indexOf(kind) >= 0) {
        const all = m.series.reduce((a, s) => a.concat(s.values.filter(v => v != null)), []);
        m.max = viz.max(card, all);
      }
      // Off the same handle, so this reports the same thing under Node as it
      // does in the browser. Read straight off the global it would have been
      // browser-only, and the headless suite would have been testing a model
      // the export never actually produces.
      if (viz && viz.byCat && viz.byCat.indexOf(kind) >= 0) {
        const pts = (m.series[0] && m.series[0].points) || {};
        m.sliceColors = m.labels.map((lb, i) => pts[i] || col(i + 1));
      }
      return m;
    }
    case 'stat':
      // FLATTENED, because a writer that is handed "<b>1,840</b>" prints those
      // tags. `runs` carries the same text with its marks intact for the two
      // formats that can set bold on part of a paragraph.
      return { label: dashModelPlain(card.label), value: dashModelPlain(card.value),
        sub: dashModelPlain(card.sub),
        runs: { label: dashModelRuns(card.label), sub: dashModelRuns(card.sub) } };
    case 'stats':
      return { items: (card.items || []).map(i => ({ label: i.label || '', value: i.value || '' })) };
    case 'gauges':
      // A gauge with no stored colour takes the slot its POSITION gives it,
      // which is the rule dashGaugesHtml() draws by. Reading i.color alone sent
      // every ring to the unresolvable-colour fallback and printed four grey
      // rings into the file while the screen showed four different ones.
      return {
        items: (card.items || []).map((i, n) => ({
          cap: dashModelPlain(i.cap), value: dashModelPlain(i.value), color: col(i.color || (n + 1)),
        })),
      };
    case 'table':
      // A native PowerPoint or Word table takes strings; a cell handed markup
      // would print the tags inside the cell.
      return {
        columns: (card.columns || []).map(dashModelPlain),
        rows: (card.rows || []).map(r => (r || []).map(dashModelPlain)),
        runs: {
          columns: (card.columns || []).map(dashModelRuns),
          rows: (card.rows || []).map(r => (r || []).map(dashModelRuns)),
        },
        // A fill that exists only on screen is not a fill: PowerPoint and Word
        // both take a cell background, and a table exported without them is a
        // different table from the one on the board. Per row, plus the header,
        // and null wherever nobody chose one.
        headFill: dashModelHex(card.headFill),
        headInk: dashModelHex(card.headInk),
        rowFill: (card.rows || []).map((r, i) => dashModelHex((card.rowFill || {})[i])),
        // The chosen text colour, or null where the writer should work out a
        // readable one from the fill itself.
        rowInk: (card.rows || []).map((r, i) => dashModelHex((card.rowInk || {})[i])),
      };
    case 'list':
      return { items: (card.items || []).map(i => ({
        name: dashModelPlain(i.name), meta: dashModelPlain(i.meta),
        runs: { name: dashModelRuns(i.name), meta: dashModelRuns(i.meta) },
      })) };
    case 'text':
      // The prompt goes no further than the screen: a writer asking for the
      // body of an untouched card gets nothing, and renders it as empty.
      return { body: dashModelTyped(card.body) ? dashModelPlain(card.body) : '',
        runs: dashModelTyped(card.body) ? dashModelRuns(card.body) : [] };
    case 'slicer':
      return { items: (card.items || []).slice(), picked: (card.picked || []).slice() };
    case 'access': {
      // A COLUMN NOBODY FILLED IN IS NOT A COLUMN. This card always offers
      // Place / Distance / Time, but a route the router has not timed has no
      // time, and a whole column of em-dashes still takes its full share of the
      // width — width taken from the place names, which are then the thing that
      // gets cut short. Dropped here rather than in a writer, so the PDF, the
      // deck and the Word file agree about what the card contains.
      //
      // Only this card, and only because THIS card invented the columns. A
      // table the operator typed keeps every column they made, empty or not:
      // withdrawing one of those would be editing their work.
      // Time is opt-in, for the reason given on dashAccessHtml(): a drive time
      // is a measurement of traffic on one day and goes stale; a distance does
      // not. The card and the file agree about it, so a board showing km only
      // does not become a PDF with a Time column in it.
      const wantTime = !!(card.fmt && card.fmt.time);
      const rows = (card._rows || []).map(r =>
        wantTime ? [r.name || '', r.km || '', r.min || ''] : [r.name || '', r.km || '']);
      const cols = wantTime ? ['Place', 'Distance', 'Time'] : ['Place', 'Distance'];
      const keep = cols.map((c, i) => i === 0 || rows.some(r => {
        const v = String(r[i] == null ? '' : r[i]).trim();
        return v && v !== '—' && v !== '-';
      }));
      return {
        columns: cols.filter((c, i) => keep[i]),
        rows: rows.map(r => r.filter((c, i) => keep[i])),
        marks: (card._rows || []).map(r => col(r.color)),
      };
    }
    case 'legend':
      // `shape` alongside `kind`, not instead of it: kind is what the thing IS
      // on the map, shape is what somebody chose to draw it as, and a writer
      // that predates the choice keeps working off kind.
      return {
        rows: (card._rows || []).map(r => ({
          label: dashModelPlain(r.label), kind: r.kind || 'area',
          shape: r.shape || null, color: col(r.color),
        })),
      };

    case 'comment':
      // Its own type rather than a text card, so a writer can give it the block
      // it has on the sheet instead of a loose paragraph.
      return { label: 'Location comment',
        body: dashModelTyped(card.body) ? dashModelPlain(card.body) : '',
        runs: dashModelTyped(card.body) ? dashModelRuns(card.body) : [] };

    case 'rating': {
      const set = dashModelHasValue(card.value);
      const v = set ? Number(card.value) : null;
      const viz = dashModelViz();
      return {
        label: dashModelPlain(card.label),
        note: dashModelTyped(card.body) ? dashModelPlain(card.body) : '',
        value: v,
        max: viz ? viz.max(card, set ? [v] : []) : 10,
      };
    }
    default:
      return {};
  }
}

/**
 * Describe the board.
 *
 * The two live cards — Key access points and Legend — read the map rather than
 * a stored value, and this file may not touch the DOM to get them. So they are
 * handed in: `opts.liveRows.access` and `.legend`, which the browser side fills
 * from `legendRows()` and `colorKeyRows()`. Under Node they are simply absent
 * and the cards come back empty, which is the honest answer for a board with no
 * map behind it.
 *
 * @param {object} [opts]
 * @param {Array<object>} [opts.cards] defaults to the global `dashCards`
 * @param {object} [opts.mapTile] defaults to the global `dashMapTile`
 * @param {function(string):string} [opts.resolveColor]
 * @param {{access?:Array, legend?:Array}} [opts.liveRows]
 * @param {string} [opts.title] the project name for the page header
 * @param {Date} [opts.now]
 * @returns {object}
 */
function dashExportModel(opts) {
  opts = opts || {};
  const cards = opts.cards
    || (typeof dashCards !== 'undefined' ? dashCards : []);
  const mapTile = opts.mapTile
    || (typeof dashMapTile !== 'undefined' ? dashMapTile : null);
  const resolve = opts.resolveColor || null;
  const live = opts.liveRows || {};

  const tiles = cards.map(c => {
    // The live cards get their rows attached before anything asks whether they
    // are empty, so `_rows` is set for both questions from one place.
    const withRows = (c.type === 'access' || c.type === 'legend')
      ? Object.assign({}, c, { _rows: live[c.type] || [] })
      : c;
    return {
      id: c.id,
      type: c.type,
      title: dashModelPlain(c.title),
      titleRuns: dashModelRuns(c.title),
      x: c.x | 0, y: c.y | 0, w: c.w | 0, h: c.h | 0,
      isEmpty: dashModelCardEmpty(withRows),
      data: dashModelData(withRows, resolve),
    };
  });

  const map = mapTile ? {
    id: mapTile.id, type: 'map', title: '',
    x: mapTile.x | 0, y: mapTile.y | 0, w: mapTile.w | 0, h: mapTile.h | 0,
    isEmpty: false, data: {},
  } : null;

  const all = map ? [map].concat(tiles) : tiles.slice();
  // Reading order, not storage order: a writer laying cards onto a page wants
  // them top-to-bottom then left-to-right, and dashCards is in creation order.
  const ordered = all.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const rows = all.reduce((m, t) => Math.max(m, t.y + t.h), 0);
  const now = opts.now || new Date();

  return {
    title: opts.title || '',
    date: now,
    cols: DASH_MODEL_COLS,
    rows,
    map,
    cards: tiles,
    ordered,
    emptyCount: tiles.filter(t => t.isEmpty).length,
    emptyTitles: tiles.filter(t => t.isEmpty).map(t => t.title).filter(Boolean),
  };
}

/* Node/test interop — harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    dashExportModel, dashModelColor, dashModelCardEmpty, dashModelData,
    dashModelHasValue, dashModelTyped, dashModelViz, dashModelPlain, dashModelRuns,
    dashModelHex,
    DASH_MODEL_COLS, DASH_MODEL_FALLBACK, DASH_MODEL_PROMPTS,
  };
}
