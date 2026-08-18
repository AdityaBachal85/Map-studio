/**
 * One colour picker on the Key Distances card, not two — and one that stays
 * attached to the row it was opened from.
 *
 * The swatch is a real `<input type="color">`. It opened the app's preset
 * popover from mousedown and called preventDefault() there to stop the
 * operating system's dialog, which does not work: the OS picker is the input's
 * ACTIVATION behaviour and runs on click. Both opened, stacked over the card.
 *
 * Underneath that sat a second fault with the same symptom. Opening the
 * popover moves focus into it, which blurs the cell being typed in, which
 * committed and rebuilt the whole table — mid-mousedown. The swatch was
 * replaced before the popover was placed, so the picker anchored to a detached
 * node and wrote colours into a row nobody could see.
 *
 * The OS dialog is not in the DOM, so what is asserted here is the mechanism
 * that suppresses it: no `.legend-color` may ever receive a click that was not
 * cancelled. That invariant is checked down both paths — clicking a swatch
 * cold, and clicking one straight out of a half-typed cell, which is the case
 * that rebuilds the table underneath the pointer.
 *
 * Real mouse clicks throughout: the bug lives in the order of focus, blur and
 * activation, and only a real click reproduces it.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/legend-picker.cjs
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

/** Click whatever is at the centre of the first swatch, for real. */
async function clickFirstSwatch(p) {
  const box = await p.evaluate(() => {
    const inp = document.querySelector('.legend-color');
    inp.scrollIntoView({ block: 'center' });
    const r = inp.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  });
  if (!(box.w > 0 && box.h > 0)) return box;
  await p.mouse.click(box.x, box.y);
  await p.waitForTimeout(300);
  return box;
}

(async () => {
  const b = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const p = await (await b.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);

  // Hand-added rows are the quickest way to a card with editable swatches and
  // need no routing, which is unreachable from here anyway.
  const opened = await p.evaluate(() => {
    // Every uncancelled click that lands on a swatch is the OS dialog opening.
    // Capture phase, so it is recorded no matter what cancels it; read later,
    // once dispatch has finished and defaultPrevented has settled.
    window.__swatchClicks = [];
    window.addEventListener('click', ev => {
      // The event object is kept, NOT ev.defaultPrevented. This listener is on
      // the capture phase and so runs before the handler that cancels — read
      // here, the flag is always false and the check passes vacuously.
      if (ev.target && ev.target.closest && ev.target.closest('.legend-color')) {
        window.__swatchClicks.push(ev);
      }
    }, true);
    window.__uncancelled = () => window.__swatchClicks.filter(ev => !ev.defaultPrevented).length;

    legendAddExtraRow();
    legendAddExtraRow();
    document.activeElement.blur();     // start cold: no cell holding the caret
    return { rows: document.querySelectorAll('.legend-color').length, editing: legendEditing };
  });
  ck('the card has editable colour swatches', opened.rows > 0, JSON.stringify(opened));
  if (!opened.rows) { await b.close(); process.exit(1); }

  // ---- Cold: click a swatch with nothing being typed. ------------------------
  const box = await clickFirstSwatch(p);
  ck('the swatch is on screen to be clicked', box.w > 0 && box.h > 0, JSON.stringify(box));

  const cold = await p.evaluate(() => {
    const pop = document.querySelector('.cp-pop');
    return {
      popovers: document.querySelectorAll('.cp-pop').length,
      swatchClicks: window.__swatchClicks.length,
      uncancelled: window.__uncancelled(),
      anchorLive: !!(pop && pop._anchor && pop._anchor.isConnected
        && pop._anchor.classList.contains('legend-color')),
    };
  });
  ck('the app\'s own preset popover opens', cold.popovers === 1, JSON.stringify(cold));
  ck('the click reaches the swatch and arrives cancelled, so the OS dialog cannot open',
    cold.swatchClicks === 1 && cold.uncancelled === 0, JSON.stringify(cold));
  ck('the picker is anchored to a swatch that is still on the page',
    cold.anchorLive === true, JSON.stringify(cold));

  await p.screenshot({ path: path.join(__dirname, 'shot-legend-picker.png') });

  // Picking a colour must not rebuild the table under the popover's anchor.
  const live = await p.evaluate(() => {
    const pop = document.querySelector('.cp-pop');
    const anchor = pop && pop._anchor;
    const sw = pop && pop.querySelector('.cp-sw[data-hex]');
    const key = anchor && anchor.closest('tr') ? anchor.closest('tr').dataset.key : null;
    if (sw) sw.click();
    return {
      picked: sw ? sw.getAttribute('data-hex') : null,
      anchorSurvived: !!(anchor && anchor.isConnected),
      shownValue: (document.querySelector('.legend-color') || {}).value,
      storeColor: (legendExtras.find(x => 'x:' + x.id === key) || {}).color,
    };
  });
  ck('picking a colour keeps the popover\'s anchor alive',
    live.anchorSurvived === true, JSON.stringify(live));
  ck('the row\'s stored colour changes',
    (live.storeColor || '').toLowerCase() === (live.picked || '').toLowerCase(), JSON.stringify(live));
  ck('and the swatch on screen shows the new colour',
    (live.shownValue || '').toLowerCase() === (live.picked || '').toLowerCase(), JSON.stringify(live));

  // ---- Warm: click a swatch straight out of a half-typed cell. ---------------
  // This is the path that used to rebuild the table mid-mousedown and leave the
  // picker anchored to a node that had already been thrown away.
  const typed = await p.evaluate(() => {
    const cell = document.querySelector('#legendBody tr .legend-name');
    cell.focus();
    cell.textContent = 'Airport';
    const key = cell.closest('tr').dataset.key;
    return { key, caretInCell: document.activeElement === cell };
  });
  ck('a cell is being edited', typed.caretInCell === true, JSON.stringify(typed));

  await clickFirstSwatch(p);

  const warm = await p.evaluate(key => {
    const pop = document.querySelector('.cp-pop');
    return {
      popovers: document.querySelectorAll('.cp-pop').length,
      uncancelled: window.__uncancelled(),
      anchorLive: !!(pop && pop._anchor && pop._anchor.isConnected
        && pop._anchor.classList.contains('legend-color')),
      typedNameKept: (legendExtras.find(x => 'x:' + x.id === key) || {}).name,
    };
  }, typed.key);
  ck('the picker opens over the half-typed row too', warm.popovers === 1, JSON.stringify(warm));
  ck('no swatch ever received an uncancelled click', warm.uncancelled === 0, JSON.stringify(warm));
  ck('the picker is anchored to a live swatch, not one the rebuild threw away',
    warm.anchorLive === true, JSON.stringify(warm));
  ck('and the half-typed edit was committed, not lost',
    warm.typedNameKept === 'Airport', JSON.stringify(warm));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
