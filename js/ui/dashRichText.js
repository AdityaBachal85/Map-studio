/**
 * Bold, italic, underline and a highlighter, for the text on a card.
 *
 * WHY THIS IS NOT JUST `execCommand` ON EVERY FIELD. The board has two kinds of
 * editable field and they are not interchangeable:
 *
 *   - PROSE — a title, a summary, a comment, a table cell, a row's name. What
 *     is typed is what the reader sees, so marking a phrase bold is meaningful
 *     and the markup has to be stored.
 *   - PARSED — `labels`, a series' values, the slicer's items. These are comma
 *     lists read back with `textContent` and split; a `<b>` in the middle of
 *     one is not emphasis, it is a corrupted number. They carry `dc-input` and
 *     this module leaves them completely alone.
 *
 * Storing markup means storing something that gets written back into the page,
 * so everything read out of a field goes through `dashRichClean()` first. The
 * allowed set is deliberately tiny — the four marks, a highlight, a colour, a
 * line break — and anything else is unwrapped to its text rather than dropped,
 * so pasting from Word loses the formatting rather than the words.
 */

/**
 * Tags dropped WITH everything inside them.
 *
 * Everything else unknown is unwrapped, because a paste from a word processor
 * is a nest of divs around the sentence you actually wanted. That is exactly
 * the wrong treatment here: unwrapping a `<script>` does not run it — assigning
 * innerHTML never does — but it does put the source code on the card as text,
 * which is a card that reads "window.__x = 1" where a sentence should be.
 */
const RICH_DROP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME|OBJECT|EMBED|APPLET|SVG|MATH|LINK|META|TITLE|HEAD)$/;

/** The only tags a field may keep. Everything else is unwrapped to its text. */
const RICH_TAGS = {
  B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u',
  S: 's', STRIKE: 's', DEL: 's', MARK: 'mark', SPAN: 'span', BR: 'br',
  // LISTS ARE STRUCTURE, and this is the one place the "inline marks only" rule
  // bends. It has to: execCommand builds a real ul/ol/li, and without them on
  // this list the sanitiser unwraps the list back into a run-on line the moment
  // the field is committed — the button would appear to work and then undo
  // itself. They carry no attributes, so nothing rides in with them.
  UL: 'ul', OL: 'ol', LI: 'li',
};

/** The only inline styles a span may keep, and what they have to look like. */
const RICH_STYLE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|transparent)$/i;

/**
 * Strip a fragment down to the marks a card is allowed to carry.
 *
 * Unwrap rather than delete: a paste from a word processor arrives as a nest of
 * divs and spans with a stylesheet's worth of inline style on it, and deleting
 * those would delete the sentence inside them.
 *
 * @param {string} html @returns {string} safe HTML
 */
function dashRichClean(html) {
  // PARSED INERT, NOT ASSIGNED TO A DIV. `innerHTML` on a detached element does
  // not run a `<script>`, which is the case everyone checks — but it DOES start
  // loading an `<img>`, so `<img src=x onerror=…>` fires its handler while the
  // sanitiser is still deciding whether to keep the tag. The cleaner was the
  // hole. DOMParser builds a document with no browsing context: nothing loads,
  // nothing executes, and the same walk below then decides what to keep.
  const doc = new DOMParser().parseFromString(
    '<body>' + String(html == null ? '' : html) + '</body>', 'text/html');
  const src = doc.body;

  const walk = node => {
    [...node.childNodes].forEach(ch => {
      if (ch.nodeType === 3) return;                       // text, always fine
      if (ch.nodeType !== 1) { ch.remove(); return; }      // comments and the rest
      if (RICH_DROP.test(ch.tagName)) { ch.remove(); return; }
      const keep = RICH_TAGS[ch.tagName];
      if (!keep) {
        // A block that held a line of text becomes a line break plus its text,
        // so a pasted paragraph does not run into the next one.
        walk(ch);
        const block = /^(DIV|P|LI|TR|H[1-6]|BLOCKQUOTE)$/.test(ch.tagName);
        while (ch.firstChild) node.insertBefore(ch.firstChild, ch);
        if (block && ch.nextSibling) node.insertBefore(doc.createElement('br'), ch);
        ch.remove();
        return;
      }
      walk(ch);
      if (keep === 'br') { ch.replaceWith(doc.createElement('br')); return; }

      const bg = ch.style && ch.style.backgroundColor;
      const fg = ch.style && ch.style.color;
      const el = doc.createElement(keep);
      // ON ANY KEPT TAG, NOT ONLY ON A SPAN. Highlighting a phrase that is
      // already bold does not wrap it — Blink puts the background straight onto
      // the `<b>` it is already inside, giving
      // `<b style="background-color: …">`. Reading style off spans alone threw
      // that away, so the highlighter worked on plain text and silently did
      // nothing on any text that had been marked first.
      if (RICH_STYLE.test(String(bg || ''))) el.style.backgroundColor = bg;
      if (RICH_STYLE.test(String(fg || ''))) el.style.color = fg;
      // A span carrying nothing we keep is not a mark, it is a wrapper. A `<b>`
      // still means bold whether or not it carries a colour, so only spans go.
      if (keep === 'span' && !el.getAttribute('style')) {
        while (ch.firstChild) node.insertBefore(ch.firstChild, ch);
        ch.remove();
        return;
      }
      while (ch.firstChild) el.appendChild(ch.firstChild);
      ch.replaceWith(el);
    });
  };
  walk(src);
  return src.innerHTML;
}

/** @param {string} html @returns {string} the words, with no marks at all */
function dashRichPlain(html) {
  // Inert for the same reason dashRichClean() is: this is handed strings from
  // wherever a card's text came from, and reading the words out of one must not
  // be a way to run something in it.
  const doc = new DOMParser().parseFromString(
    '<body>' + String(html == null ? '' : html) + '</body>', 'text/html');
  doc.body.querySelectorAll('br').forEach(br => br.replaceWith(doc.createTextNode('\n')));
  // A list reads as a list in plain text too, or the card title in the pane and
  // every place that shows a field's words rather than its marks would run four
  // bullet points together into one sentence.
  doc.body.querySelectorAll('li').forEach(li => {
    const parent = li.parentElement;
    const ordered = parent && parent.tagName === 'OL';
    const n = parent ? Array.prototype.indexOf.call(parent.children, li) + 1 : 1;
    li.insertBefore(doc.createTextNode((li.previousElementSibling || parent.previousSibling ? '\n' : '')
      + (ordered ? n + '. ' : '\u2022 ')), li.firstChild);
  });
  return doc.body.textContent;
}

/** Whether a field stores marks or a plain string. @param {string} cls */
function dashRichField(cls) { return !/\bdc-input\b/.test(String(cls || '')); }

/* ---------------------------------------------------------------------------
 * The toolbar
 * ------------------------------------------------------------------------ */

/** The marks, in the order every word processor puts them. */
const RICH_BUTTONS = [
  ['bold', 'B', 'Bold', 'font-weight:800'],
  ['italic', 'I', 'Italic', 'font-style:italic'],
  ['underline', 'U', 'Underline', 'text-decoration:underline'],
  ['strikeThrough', 'S', 'Strikethrough', 'text-decoration:line-through'],
  // A bulleted and a numbered list, as Word has them. Glyphs rather than an
  // icon font: these four characters render in every renderer this app writes
  // to, which is the same reason the legend's symbols are characters.
  ['insertUnorderedList', '\u2261', 'Bulleted list', 'font-size:13px'],
  ['insertOrderedList', '\u2116', 'Numbered list', 'font-size:12px'],
];

/** The highlighter's inks. Last one lifts the highlight off again. */
const RICH_INKS = ['#fff3a3', '#c8f0d2', '#cfe3ff', '#ffd6e0', '#e6dcff', ''];

let _richBar = null;
let _richOn = null;                        // the field the bar is serving

/** @returns {HTMLElement} the toolbar, built once */
function dashRichBar() {
  if (_richBar) return _richBar;
  const bar = document.createElement('div');
  // `frost` is the app's own glass surface — the gradient tint, the blur, the
  // saturation boost and the top-edge catch-light, plus the solid fallback when
  // Preferences turns glass off. Styling this bar by hand produced a translucent
  // rectangle with nothing blurring behind it, which over a dark card is a dark
  // wash with dark ink on it.
  bar.className = 'rich-bar frost';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Text formatting');
  bar.innerHTML =
    RICH_BUTTONS.map(b => '<button type="button" data-rich="' + b[0] + '" title="' + b[2]
      + '" aria-label="' + b[2] + '" style="' + b[3] + '">' + b[1] + '</button>').join('')
    + '<span class="rich-sep"></span>'
    + RICH_INKS.map(c => '<button type="button" class="rich-ink' + (c ? '' : ' rich-ink-off')
      + '" data-rich="hiliteColor" data-v="' + (c || 'transparent')
      + '" title="' + (c ? 'Highlight' : 'No highlight') + '" aria-label="'
      + (c ? 'Highlight' : 'No highlight') + '"><i style="background:'
      + (c || 'transparent') + '"></i></button>').join('')
    + '<span class="rich-sep"></span>'
    + '<button type="button" data-rich="removeFormat" title="Clear formatting"'
    + ' aria-label="Clear formatting">&#10005;</button>';

  // mousedown, not click: the selection is gone by the time a click lands,
  // because pressing a button takes focus off the text it was meant to mark.
  bar.addEventListener('mousedown', e => {
    const b = e.target.closest('button[data-rich]');
    if (!b) return;
    e.preventDefault();
    dashRichRun(b.dataset.rich, b.dataset.v || null);
  });
  document.body.appendChild(bar);
  _richBar = bar;
  return bar;
}

/**
 * Apply a mark to the selection.
 *
 * `execCommand` is deprecated and has no replacement that works on a
 * contenteditable without writing a selection model from scratch. Every engine
 * still implements it, and the alternative here is several hundred lines to do
 * the same four things worse.
 *
 * @param {string} cmd @param {?string} val
 */
function dashRichRun(cmd, val) {
  const host = _richOn;
  if (!host) return;
  host.focus({ preventScroll: true });
  try {
    // Tags rather than inline style wherever the engine will give them: they
    // survive the sanitiser as themselves and read as intent in a saved file.
    document.execCommand('styleWithCSS', false, cmd === 'hiliteColor');
    if (cmd === 'hiliteColor') {
      // THE HIGHLIGHTER HAS TWO NAMES AND NO ENGINE ANSWERS TO BOTH. Firefox
      // implements `hiliteColor`; Blink and WebKit only ever did `backColor`
      // for a selection. Called by one name alone the button did nothing at all
      // in the browser this app is actually used in, and said nothing about it.
      // Both are attempted and the one that takes, wins.
      const before = host.innerHTML;
      document.execCommand('hiliteColor', false, val);
      if (host.innerHTML === before) document.execCommand('backColor', false, val);
    } else {
      document.execCommand(cmd, false, val);
    }
  } catch (e) { /* an engine without it simply does nothing */ }
  dashRichSync();
  if (typeof dashCommit === 'function') dashCommit(host);
}

/** Light the buttons that describe the selection. */
function dashRichSync() {
  if (!_richBar) return;
  RICH_BUTTONS.forEach(b => {
    const el = _richBar.querySelector('[data-rich="' + b[0] + '"]');
    let on = false;
    try { on = document.queryCommandState(b[0]); } catch (e) { /* leave it off */ }
    if (el) el.classList.toggle('on', !!on);
  });
}

/** Put the bar over the selection, or hide it when there is nothing to mark. */
function dashRichPlace() {
  const sel = window.getSelection();
  const host = _richOn;
  if (!host || !sel || !sel.rangeCount || sel.isCollapsed) { dashRichHide(); return; }
  const r = sel.getRangeAt(0);
  if (!host.contains(r.commonAncestorContainer)) { dashRichHide(); return; }

  const bar = dashRichBar();
  bar.classList.add('open');
  const box = r.getBoundingClientRect();
  const bw = bar.offsetWidth || 250;
  // Clamped to the window, and flipped below the selection when there is no
  // room above it — a toolbar off the top of the screen cannot be pressed.
  const x = Math.max(8, Math.min(window.innerWidth - bw - 8, box.left + box.width / 2 - bw / 2));
  const above = box.top - bar.offsetHeight - 10;
  bar.style.left = x.toFixed(0) + 'px';
  bar.style.top = (above > 8 ? above : box.bottom + 10).toFixed(0) + 'px';
  dashRichSync();
}

/** @returns {void} */
function dashRichHide() {
  if (_richBar) _richBar.classList.remove('open');
}

/** Watch for a selection inside a rich field, and serve it. */
(function initDashRichText() {
  const start = () => {
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      const node = sel && sel.anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      const field = el && el.closest && el.closest('[data-bind]');
      // Only prose, and only while the board is being edited.
      if (!field || !dashEditing || !dashRichField(field.className)
        || !field.isContentEditable) {
        _richOn = null; dashRichHide(); return;
      }
      _richOn = field;
      dashRichPlace();
    });
    // The bar is positioned in viewport coordinates, so anything that moves the
    // page underneath it leaves it pointing at the wrong words.
    window.addEventListener('scroll', dashRichHide, true);
    window.addEventListener('resize', dashRichHide);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else { start(); }
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RICH_TAGS, RICH_STYLE, RICH_DROP };
}
