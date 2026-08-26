/**
 * Bold, italic, underline and a highlighter on the text of a card.
 *
 * TWO THINGS ARE BEING ASSERTED AND THEY PULL AGAINST EACH OTHER.
 *
 * The first is that the marks work: applied to a selection, stored, shown again
 * when the board is not being edited, and carried into the export as runs so a
 * writer that can set bold on part of a paragraph knows which part.
 *
 * The second is that storing markup does not turn a card into a place to put
 * a script. Every field goes through `dashRichClean()` on the way in, and the
 * tag set is deliberately tiny — so the interesting assertions are the ones
 * about what does NOT survive, not the ones about what does.
 *
 * And a third, quieter one: the board has fields that are PARSED, not shown —
 * `labels`, a series' values, the slicer's items are comma lists read back with
 * textContent. A `<b>` in the middle of one is not emphasis, it is a corrupted
 * number, so those must be left entirely alone.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/dash-richtext.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8000';
const REPO = path.join(__dirname, '..');
const localAuthConfig = () => fs.readFileSync(path.join(REPO, 'js', 'config.js'), 'utf8')
  .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = '';")
  .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = '';");

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

const M = require(path.join(REPO, 'js/export/dashExportModel.js'));

(async () => {
  /* -- the run splitter, in Node: no DOM, because the export has none -------- */

  const runs = v => M.dashModelRuns(v).map(r => r.text
    + (r.b ? '[b]' : '') + (r.i ? '[i]' : '') + (r.u ? '[u]' : '')
    + (r.s ? '[s]' : '') + (r.hi ? '[hi]' : ''));

  ck('plain text is one run with no marks on it',
    JSON.stringify(runs('just words')) === '["just words"]');
  ck('a marked phrase is its own run',
    JSON.stringify(runs('a <b>bold</b> word')) === '["a ","bold[b]"," word"]',
    JSON.stringify(runs('a <b>bold</b> word')));
  ck('nested marks stack rather than replacing one another',
    JSON.stringify(runs('<b>x <i>y</i></b>')) === '["x [b]","y[b][i]"]',
    JSON.stringify(runs('<b>x <i>y</i></b>')));
  // Blink puts the highlight straight onto the tag that is already there, so a
  // parser that only reads colour off a <span> loses every highlight that was
  // applied to text somebody had already marked.
  ck('a highlight applied over bold text reaches the file as both',
    JSON.stringify(runs('<b style="background-color: rgb(255, 243, 163);">hi</b>')) === '["hi[b][hi]"]',
    JSON.stringify(runs('<b style="background-color: rgb(255, 243, 163);">hi</b>')));
  ck('adjacent runs with the same marks are merged',
    M.dashModelRuns('<b>a</b><b>b</b>').length === 1,
    JSON.stringify(runs('<b>a</b><b>b</b>')));
  ck('a line break is a run of its own newline',
    JSON.stringify(runs('one<br>two')) === '["one\\ntwo"]',
    JSON.stringify(runs('one<br>two')));
  ck('a stray close tag does not unwind everything after it',
    JSON.stringify(runs('<b>a</i>b</b>c')) === '["ab[b]","c"]',
    JSON.stringify(runs('<b>a</i>b</b>c')));

  ck('and the flat form is the words, with the marks gone',
    M.dashModelPlain('The <b>site</b> sits <mark>2.4 km</mark> away')
      === 'The site sits 2.4 km away',
    JSON.stringify(M.dashModelPlain('The <b>site</b> sits <mark>2.4 km</mark> away')));
  ck('an entity is decoded rather than left as its escape',
    M.dashModelPlain('Kalyan &amp; Shil &lt;road&gt;') === 'Kalyan & Shil <road>',
    M.dashModelPlain('Kalyan &amp; Shil &lt;road&gt;'));
  ck('text with no markup in it is returned untouched',
    M.dashModelPlain('2.4 km · 12 min') === '2.4 km · 12 min');

  /* -- the browser half ----------------------------------------------------- */

  const b = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const p = await (await b.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));
  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3200);

  /* -- what a field is allowed to keep -------------------------------------- */

  const clean = await p.evaluate(() => {
    const c = s => dashRichClean(s);
    return {
      marks: c('<b>b</b><i>i</i><u>u</u><s>s</s><mark>m</mark>'),
      alias: c('<strong>a</strong><em>b</em><strike>c</strike><del>d</del>'),
      hi: c('<span style="background-color: rgb(255, 243, 163);">lit</span>'),
      onMark: c('<b style="background-color: rgb(255, 243, 163);">lit</b>'),
      script: c('<script>window.__pwned = 1;<\/script>safe'),
      img: c('<img src=x onerror="window.__pwned = 1">safe'),
      handler: c('<b onclick="window.__pwned = 1">click</b>'),
      href: c('<a href="javascript:window.__pwned=1">link</a>'),
      iframe: c('<iframe src="https://example.com"></iframe>kept'),
      style: c('<b style="position:fixed;width:100vw;height:100vh;background:red">huge</b>'),
      word: c('<div class="x"><p style="font-size:72px">para one</p><p>para two</p></div>'),
      empty: c('<span>nothing to keep</span>'),
    };
  });
  await p.waitForTimeout(50);
  const pwned = await p.evaluate(() => !!window.__pwned);

  ck('the four marks and a highlight survive',
    clean.marks === '<b>b</b><i>i</i><u>u</u><s>s</s><mark>m</mark>', clean.marks);
  ck('and every spelling of them lands on one tag',
    clean.alias === '<b>a</b><i>b</i><s>c</s><s>d</s>', clean.alias);
  ck('a highlight survives on a span and on a mark it was applied over',
    /background-color/.test(clean.hi) && /^<b style="background-color/.test(clean.onMark),
    clean.hi + ' | ' + clean.onMark);

  ck('a script tag does not survive, and does not run',
    clean.script.indexOf('script') < 0 && pwned === false, clean.script);
  ck('nor an image with a handler on it',
    clean.img.indexOf('img') < 0 && clean.img.indexOf('onerror') < 0, clean.img);
  ck('an event handler is stripped off a tag that is otherwise kept',
    clean.handler === '<b>click</b>', clean.handler);
  ck('a link is unwrapped rather than kept with its href',
    clean.href.indexOf('href') < 0 && clean.href.indexOf('link') >= 0, clean.href);
  ck('an iframe goes, and the words beside it stay',
    clean.iframe === 'kept', clean.iframe);
  // A card is a box on a board. Style that could take a mark out of that box and
  // across the page is not formatting, whatever it is called.
  ck('only colour survives in a style attribute, never position or size',
    clean.style === '<b>huge</b>', clean.style);

  ck('a pasted document keeps its words and loses its layout',
    clean.word.indexOf('font-size') < 0 && /para one/.test(clean.word)
      && /para two/.test(clean.word) && /<br>/.test(clean.word), clean.word);
  ck('a span that carries no mark is not kept as a wrapper',
    clean.empty === 'nothing to keep', clean.empty);

  /* -- applying a mark to a selection --------------------------------------- */

  await p.evaluate(() => {
    setAppMode('dashboard');
    dashCards = [Object.assign(dashNewCard('text'), { id: 't1', title: 'Summary', x: 0, y: 0, w: 9, h: 7,
      body: 'The site sits 2.4 km from the station and 12 km from the airport.' })];
    dashMapTile = { id: DASH_MAP_ID, x: 0, y: 9999, w: 8, h: 14 };
    dashEditing = true;
    renderDashboard(); dashLayoutApply();
  });
  await p.waitForTimeout(700);

  const drag = async () => {
    const g = await p.evaluate(() => {
      const el = document.querySelector('.dc-text[data-bind="body"]');
      const r = document.createRange();
      r.setStart(el.firstChild, 0); r.setEnd(el.firstChild, 20);
      const bb = r.getBoundingClientRect();
      return { x0: bb.left + 2, y: bb.top + bb.height / 2, x1: bb.right - 2 };
    });
    await p.mouse.move(g.x0, g.y); await p.mouse.down();
    await p.mouse.move(g.x1, g.y, { steps: 8 }); await p.mouse.up();
    await p.waitForTimeout(320);
  };
  const press = async sel => {
    const bx = await p.evaluate(s => {
      const el = document.querySelector(s); if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
    if (!bx) return false;
    await p.mouse.move(bx.x, bx.y); await p.mouse.down(); await p.mouse.up();
    await p.waitForTimeout(300);
    return true;
  };

  await drag();
  const bar = await p.evaluate(() => {
    const el = document.querySelector('.rich-bar');
    return el ? { open: el.classList.contains('open'),
      marks: el.querySelectorAll('[data-rich]:not(.rich-ink)').length,
      inks: el.querySelectorAll('.rich-ink').length,
      onScreen: el.getBoundingClientRect().top >= 0 } : null;
  });
  ck('selecting words in a card raises the formatting bar',
    !!bar && bar.open === true, JSON.stringify(bar));
  ck('with the four marks, a row of inks and a way to clear it',
    bar.marks === 5 && bar.inks === 6, JSON.stringify(bar));
  ck('and it is on the screen rather than off the top of it', bar.onScreen === true);

  await press('.rich-bar [data-rich="bold"]');
  ck('pressing bold marks the selection and stores it',
    /^<b>The site sits 2\.4 km<\/b>/.test(await p.evaluate(() => dashCardById('t1').body)),
    await p.evaluate(() => dashCardById('t1').body));

  // The case that was silently doing nothing: highlighting text already marked.
  await press('.rich-bar .rich-ink');
  const lit = await p.evaluate(() => dashCardById('t1').body);
  ck('and the highlighter works on text that is already bold',
    /background-color/.test(lit) && /<b/.test(lit), lit);

  await press('.rich-bar [data-rich="underline"]');
  ck('the marks stack rather than replacing each other',
    /<u>/.test(await p.evaluate(() => dashCardById('t1').body)),
    await p.evaluate(() => dashCardById('t1').body));

  ck('the bar says which marks the selection already carries',
    await p.evaluate(() => {
      const on = [...document.querySelectorAll('.rich-bar button.on')].map(b => b.dataset.rich);
      return on.indexOf('bold') >= 0 && on.indexOf('underline') >= 0;
    }) === true);

  /* -- and it is still there when nobody is editing ------------------------- */

  const readOnly = await p.evaluate(() => {
    dashEditing = false;
    renderDashboard(); dashLayoutApply();
    const el = document.querySelector('.dc-text[data-bind="body"]');
    return { html: el.innerHTML, editable: el.isContentEditable,
      bar: document.querySelector('.rich-bar').classList.contains('open') };
  });
  ck('the marks are on the card when the board is not being edited',
    /<b/.test(readOnly.html) && /<u>/.test(readOnly.html) && readOnly.editable === false,
    readOnly.html.slice(0, 80));
  ck('and the bar is not', readOnly.bar === false);

  /* -- the parsed fields are left completely alone -------------------------- */

  const parsed = await p.evaluate(async () => {
    const c = Object.assign(dashNewCard('column'), { id: 'c1', title: 'C', x: 0, y: 8, w: 8, h: 7,
      labels: ['North', 'East'], seriesList: [{ name: 'S', values: [1, 2], slot: 1 }] });
    dashCards = dashCards.concat([c]);
    dashEditing = true; dashSelectedId = 'c1';
    renderDashboard(); renderDashFormat();
    const f = document.querySelector('#dashFormat [data-bind="labels"]');
    const r = document.createRange(); r.selectNodeContents(f);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(res => setTimeout(res, 120));
    const offered = document.querySelector('.rich-bar').classList.contains('open');
    // And if markup did somehow reach one, committing must not store it.
    f.innerHTML = '<b>North</b>, East';
    dashCommit(f);
    return { offered: offered, labels: dashCardById('c1').labels,
      rich: dashRichField(f.className) };
  });
  ck('a comma list is not offered the formatting bar',
    parsed.offered === false && parsed.rich === false, JSON.stringify(parsed));
  ck('and markup pasted into one is read as its words, not stored as marks',
    JSON.stringify(parsed.labels) === '["North","East"]', JSON.stringify(parsed.labels));

  /* -- the export carries it ------------------------------------------------ */

  const model = await p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const m = dashExportModel({ title: 'T', resolveColor: n => cs.getPropertyValue(n).trim() });
    const d = m.cards.find(c => c.id === 't1');
    return { body: d.data.body, runs: (d.data.runs || []).map(r => r.text + (r.b ? '[b]' : '')),
      title: d.title, tags: /[<>]/.test(d.data.body + d.title) };
  });
  ck('the export gets the words with no tags anywhere in them',
    model.tags === false, JSON.stringify(model.body));
  ck('and the marks beside them, so a writer that can set bold knows where',
    model.runs.some(r => /\[b\]$/.test(r)), JSON.stringify(model.runs));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');

  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})();
