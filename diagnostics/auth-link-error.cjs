/**
 * login.html has to explain a reset link that did not work.
 *
 * WHAT THIS USED TO TEST. Supabase wrote its auth failures into the URL — query
 * string and hash fragment both — and this suite drove the page with the exact
 * URL a real failed confirmation produced. That mechanism is gone with
 * Supabase. The failure it was about is not: a reset link is single-use, and
 * corporate mail security opens every link in an incoming message to scan it,
 * which spends the token before the human clicks. People still receive links
 * that are dead on arrival, and the page still has to say why in words that do
 * not read as "the app is broken".
 *
 * So the same question, asked of the new flow: given a reset link the API
 * refuses, does login.html explain it, visibly, without blaming the reader?
 *
 * The API is stubbed rather than run, deliberately. This is about what the page
 * renders when it is told `used_token` — the refusal itself is the API's job
 * and is tested against real PHP in diagnostics/accounts-api.cjs.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/auth-link-error.cjs
 */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:8000';
const TOKEN = 'a1b2c3d4'.repeat(8);          // 64 hex characters, as the API issues

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

/** Answer the accounts API without one running. */
function stubApi(page, confirm) {
  return Promise.all([
    page.route('**/api/auth/me', r => r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: null, csrf: null, signupOpen: true, emailDomain: 'dbotrealty.com' }),
    })),
    page.route('**/api/auth/reset/confirm', r => r.fulfill({
      status: confirm.status,
      contentType: 'application/json',
      body: JSON.stringify(confirm.body),
    })),
  ]);
}

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const p = await (await b.newContext({ viewport: { width: 1364, height: 760 } })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  // Block outbound network; the page itself is local.
  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:')) ? r.continue() : r.abort();
  });
  await stubApi(p, {
    status: 400,
    body: { error: 'That reset link has already been used. Ask for a new one.', code: 'used_token' },
  });

  /* -- arriving with a reset link ---------------------------------------- */

  await p.goto(BASE + '/login.html?reset=' + TOKEN, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof sessionReady === 'function' && sessionReady());

  const arrived = await p.evaluate(() => ({
    title: document.getElementById('authTitle').textContent.trim(),
    label: document.getElementById('authSubmitLabel').textContent.trim(),
    emailHidden: document.getElementById('authEmailField').hidden,
    switchHidden: document.getElementById('authSwitch').hidden,
    url: location.href,
  }));
  ck('the page turns into "choose a new password"',
    /new password/i.test(arrived.title) && /set password/i.test(arrived.label),
    arrived.title + ' / ' + arrived.label);
  ck('and stops asking for an address the token already names', arrived.emailHidden === true);
  ck('and offers nothing to switch to', arrived.switchHidden === true);

  // A live reset token in the address bar ends up in history, in a screenshot
  // attached to a bug report, and in the Referer of the next request.
  ck('the token is wiped from the address bar before anything else happens',
    !/reset=/.test(arrived.url), arrived.url.replace(BASE, ''));

  /* -- the link turns out to be spent ------------------------------------ */

  await p.fill('#authPassword', 'a-new-password-here');
  await p.click('#authSubmit');
  await p.waitForFunction(() => !document.getElementById('authError').hidden, { timeout: 10000 });

  const st = await p.evaluate(() => {
    const e = document.getElementById('authError');
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return {
      hidden: e.hidden, text: e.textContent.trim(),
      opacity: cs.opacity, display: cs.display, h: Math.round(r.height),
    };
  });
  ck('the dead link is explained on the page', st.hidden === false && st.text.length > 30,
    st.text.slice(0, 80));
  // Learned the hard way on another dialog in this app: every DOM assertion
  // passes on an element with opacity 0.
  ck('the explanation is actually visible (not opacity:0 / 0-height)',
    st.opacity !== '0' && st.display !== 'none' && st.h > 0,
    'opacity=' + st.opacity + ' h=' + st.h);
  ck('it names the real cause rather than only saying "already used"',
    /scanners/i.test(st.text), st.text.slice(0, 120));
  ck('and still tells them what to do next', /new one/i.test(st.text));

  await p.screenshot({ path: __dirname + '/shot-login-err.png' });

  /* -- a clean visit must not show any of this --------------------------- */

  await p.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof sessionReady === 'function' && sessionReady());
  const clean = await p.evaluate(() => ({
    banner: document.getElementById('authError').hidden,
    title: document.getElementById('authTitle').textContent.trim(),
    emailShown: !document.getElementById('authEmailField').hidden,
  }));
  ck('a normal visit shows no error banner', clean.banner === true);
  ck('and is an ordinary sign-in form again',
    /welcome/i.test(clean.title) && clean.emailShown, clean.title);

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');

  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS', e); process.exit(2); });
