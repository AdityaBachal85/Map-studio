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
    case 'chart':
      return {
        kind: card.kind || 'column',
        labels: (card.labels || []).slice(),
        series: (card.seriesList || []).map(s => ({
          name: s.name || '',
          values: (s.values || []).map(v => (dashModelHasValue(v) ? Number(v) : null)),
          color: col(s.slot),
        })),
      };
    case 'stat':
      return { label: card.label || '', value: card.value || '', sub: card.sub || '' };
    case 'stats':
      return { items: (card.items || []).map(i => ({ label: i.label || '', value: i.value || '' })) };
    case 'gauges':
      return { items: (card.items || []).map(i => ({ cap: i.cap || '', value: i.value || '', color: col(i.color) })) };
    case 'table':
      return {
        columns: (card.columns || []).slice(),
        rows: (card.rows || []).map(r => (r || []).slice()),
      };
    case 'list':
      return { items: (card.items || []).map(i => ({ name: i.name || '', meta: i.meta || '' })) };
    case 'text':
      // The prompt goes no further than the screen: a writer asking for the
      // body of an untouched card gets nothing, and renders it as empty.
      return { body: dashModelTyped(card.body) ? card.body : '' };
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
      const rows = (card._rows || []).map(r => [r.name || '', r.km || '', r.min || '']);
      const cols = ['Place', 'Distance', 'Time'];
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
      return {
        rows: (card._rows || []).map(r => ({
          label: r.label || '', kind: r.kind || 'area', color: col(r.color),
        })),
      };
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
      title: c.title || '',
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
    dashModelHasValue, dashModelTyped,
    DASH_MODEL_COLS, DASH_MODEL_FALLBACK, DASH_MODEL_PROMPTS,
  };
}
