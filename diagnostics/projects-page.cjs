/**
 * The project list: naming a project, saying where it is, and finding it again.
 *
 * Creating a project used to be a browser prompt() — a grey strip at the top of
 * the window, in the browser's own type, with room for exactly one field. That
 * last part is why a project could be named and not placed, and why somebody
 * looking for "the Thane one" had to remember what they had called it.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/projects-page.cjs
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

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  // The list redirects to the login page without a session.
  await p.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1800);
  await p.fill('#authName', 'Aditya');
  await p.fill('#authLocalEmail', 'aditya.bachal@dbotrealty.com');
  await p.click('#authLocalForm button[type="submit"]');
  await p.waitForTimeout(2200);
  ck('signing in lands on the project list', /projects\.html/.test(p.url()), p.url());

  /* ---- the dialog, not the browser's ------------------------------------- */

  const prompts = [];
  await p.evaluate(() => { window.prompt = () => { window.__promptUsed = true; return null; }; });

  await p.click('#pjNew');
  await p.waitForTimeout(350);
  const dlg = await p.evaluate(() => {
    const m = document.getElementById('pjModal');
    if (!m || m.hidden) return null;
    const card = m.querySelector('.pj-modal-card');
    const cs = getComputedStyle(m.querySelector('#pjModalOk'));
    return {
      title: m.querySelector('#pjModalTitle').textContent,
      fields: Array.from(m.querySelectorAll('.pj-field > span')).map(s => s.textContent),
      role: card.getAttribute('role'), modal: card.getAttribute('aria-modal'),
      // A bare browser button in a dialog built to replace a browser prompt
      // would be the very thing it exists to avoid.
      okStyled: cs.backgroundImage !== 'none' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
      usedPrompt: !!window.__promptUsed,
    };
  });
  ck('New project opens the app\'s own dialog', !!dlg && dlg.title === 'New project',
    JSON.stringify(dlg && dlg.title));
  ck('and not the browser\'s prompt', dlg && dlg.usedPrompt === false);
  ck('asking for a name AND a location',
    dlg && dlg.fields.join('|') === 'Project name|Location', JSON.stringify(dlg && dlg.fields));
  ck('announced to a screen reader as a dialog',
    dlg && dlg.role === 'dialog' && dlg.modal === 'true', JSON.stringify([dlg.role, dlg.modal]));
  ck('with buttons in the app\'s own language, not the browser\'s', dlg && dlg.okStyled);

  await p.keyboard.press('Escape');
  await p.waitForTimeout(250);
  ck('escape closes it', await p.evaluate(() => document.getElementById('pjModal').hidden));

  /* ---- creating, and finding again --------------------------------------- */

  const make = async (name, place) => {
    await p.click('#pjNew');
    await p.waitForTimeout(300);
    await p.fill('#pjModalName', name);
    await p.fill('#pjModalPlace', place);
    await p.click('#pjModalOk');
    await p.waitForTimeout(700);
    if (!/projects\.html/.test(p.url())) {
      await p.goto(BASE + '/projects.html', { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(1600);
    }
  };
  await make('Kalyan corridor', 'Kalyan, Thane, Maharashtra');
  await make('Powai study', 'Powai, Mumbai');
  await p.waitForTimeout(500);

  const shown = await p.evaluate(() =>
    Array.from(document.querySelectorAll('.pj-name')).map(n => ({
      name: n.querySelector('.t').textContent,
      place: (n.querySelector('.p') || {}).textContent || '',
    })));
  ck('both projects are in the list', shown.length === 2, JSON.stringify(shown.map(s => s.name)));
  ck('each showing where it is', shown.every(s => s.place.length > 3),
    JSON.stringify(shown.map(s => s.place)));

  const find = async q => {
    await p.fill('#pjSearch', q);
    await p.waitForTimeout(350);
    return p.evaluate(() => Array.from(document.querySelectorAll('.pj-name .t')).map(n => n.textContent));
  };
  // The point of storing the location: somebody knows where a project is long
  // before they remember what they called it.
  ck('searching a location nobody put in the name still finds it',
    (await find('thane')).join() === 'Kalyan corridor', JSON.stringify(await find('thane')));
  ck('and another one finds the other', (await find('powai')).join() === 'Powai study');
  ck('the name still works too', (await find('corridor')).join() === 'Kalyan corridor');
  ck('and a word in neither finds nothing', (await find('zzzz')).length === 0);
  await p.fill('#pjSearch', '');
  await p.waitForTimeout(300);

  /* ---- and it can be changed afterwards ---------------------------------- */

  const edited = await p.evaluate(async () => {
    const rows = await projectsList();
    const one = rows.find(r => r.name === 'Powai study');
    await projectsRename(one.id, 'Powai study', 'Powai, Mumbai, Maharashtra');
    const after = (await projectsList()).find(r => r.id === one.id);
    return { name: after.name, place: after.place };
  });
  ck('a project\'s location can be edited without renaming it',
    edited.name === 'Powai study' && /Maharashtra/.test(edited.place), JSON.stringify(edited));

  const kept = await p.evaluate(async () => {
    const rows = await projectsList();
    const one = rows.find(r => r.name === 'Kalyan corridor');
    // undefined means "leave it alone" — a rename must not wipe the location.
    await projectsRename(one.id, 'Kalyan corridor v2');
    const after = (await projectsList()).find(r => r.id === one.id);
    return { name: after.name, place: after.place };
  });
  ck('and renaming without touching the location leaves it there',
    kept.name === 'Kalyan corridor v2' && /Thane/.test(kept.place), JSON.stringify(kept));

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');

  await p.screenshot({ path: path.join(REPO, 'diagnostics', 'shot-projects-page.png') });
  await b.close();
  const pass = R.filter(Boolean).length;
  console.log('\n' + pass + '/' + R.length + ' passed');
  process.exit(pass === R.length ? 0 : 1);
})();
