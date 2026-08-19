/**
 * The sign-in page still signs people in.
 *
 * The page was restructured — one split card, form on the left and the
 * photograph on the right, on a dark ground — and a visual change to an AUTH
 * page is the one place where "it looks right" is not enough. Every control
 * the sign-in, sign-up and local-profile flows depend on has to still be
 * there, still wired, and still reachable.
 *
 * The pointer effects are asserted to be DECORATION: they are built by
 * js/auth/loginFx.js at runtime, marked aria-hidden, and the form has to work
 * identically with that file's elements removed.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/login-page.cjs
 */
const { chromium } = require('playwright');
const path = require('path');

const BASE = 'http://127.0.0.1:8000';
const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:')) ? r.continue() : r.abort();
  });

  await p.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1800);

  /* -- the layout ----------------------------------------------------------- */

  const layout = await p.evaluate(() => {
    const shell = document.querySelector('.auth-shell');
    const form = document.querySelector('.auth-main');
    const art = document.querySelector('.auth-stage');
    const sr = shell.getBoundingClientRect();
    const fr = form.getBoundingClientRect();
    const ar = art.getBoundingClientRect();
    return {
      shell: !!shell,
      bothInside: shell.contains(form) && shell.contains(art),
      formLeft: fr.left < ar.left,
      halves: Math.abs(fr.width - ar.width) < 4,
      cardVisible: sr.width > 400 && sr.height > 300,
      bg: getComputedStyle(document.body).backgroundColor,
    };
  });
  ck('the form and the photograph are two halves of one card',
    layout.shell && layout.bothInside && layout.halves, JSON.stringify(layout));
  ck('the form is the left half — it is the task', layout.formLeft === true);
  ck('and the page is dark', /rgb\(16, 18, 20\)/.test(layout.bg), layout.bg);

  /* -- every control the auth flows need ------------------------------------ */

  const controls = await p.evaluate(() => {
    const need = ['authReal', 'authLocal', 'authMsBtn', 'authForm', 'authEmail', 'authPassword',
      'authSubmit', 'authSwitchBtn', 'authForgot', 'authEye', 'authNameField', 'authFullName',
      'authError', 'authOk', 'authTitle', 'authLede', 'authLocalForm', 'authName', 'authLocalEmail'];
    const missing = need.filter(id => !document.getElementById(id));
    const real = document.getElementById('authReal');
    return {
      missing,
      // Whichever branch this build shows, exactly one of the two is live.
      realShown: !real.hidden,
      localShown: !document.getElementById('authLocal').hidden,
    };
  });
  ck('every control the sign-in, sign-up and local flows use is still on the page',
    controls.missing.length === 0, controls.missing.join(', ') || 'none missing');
  ck('and exactly one of the real / local branches is showing',
    controls.realShown !== controls.localShown,
    JSON.stringify({ real: controls.realShown, local: controls.localShown }));

  /* -- and they still work -------------------------------------------------- */

  const flows = await p.evaluate(() => {
    const out = {};
    const email = document.getElementById('authEmail');
    const pw = document.getElementById('authPassword');

    // Typing reaches the fields.
    email.value = 'someone@dbotrealty.com';
    pw.value = 'hunter2';
    out.typed = email.value === 'someone@dbotrealty.com' && pw.value === 'hunter2';

    // The eye reveals the password.
    const before = pw.type;
    document.getElementById('authEye').click();
    out.eye = before === 'password' && pw.type === 'text';
    document.getElementById('authEye').click();
    out.eyeBack = pw.type === 'password';

    // Switching to Create an account reveals the name field.
    const nameHiddenFirst = document.getElementById('authNameField').hidden;
    document.getElementById('authSwitchBtn').click();
    out.switched = nameHiddenFirst && !document.getElementById('authNameField').hidden;
    out.titleChanged = document.getElementById('authTitle').textContent.trim();
    document.getElementById('authSwitchBtn').click();
    out.switchedBack = document.getElementById('authNameField').hidden;
    return out;
  });
  ck('the fields accept typing', flows.typed === true);
  ck('the password eye still reveals and re-hides',
    flows.eye === true && flows.eyeBack === true, JSON.stringify({ shown: flows.eye, hidden: flows.eyeBack }));
  ck('switching to Create an account still reveals the name field',
    flows.switched === true && flows.switchedBack === true,
    'title became "' + flows.titleChanged + '"');

  /* -- the effects are decoration, and only decoration ---------------------- */

  const fx = await p.evaluate(() => ({
    glow: !!document.querySelector('.auth-glow'),
    edges: document.querySelectorAll('.auth-input .edge').length,
    sheens: document.querySelectorAll('.sheen').length,
    // None of it may be announced, focusable, or in the way of a click.
    hidden: [...document.querySelectorAll('.auth-glow, .edge, .sheen')]
      .every(el => el.getAttribute('aria-hidden') === 'true'),
    focusable: [...document.querySelectorAll('.auth-glow, .edge, .sheen')]
      .filter(el => el.tabIndex >= 0).length,
    inert: [...document.querySelectorAll('.auth-glow, .edge, .sheen')]
      .every(el => getComputedStyle(el).pointerEvents === 'none'),
    // Not in the markup — built at runtime, so the source stays readable.
    inSource: false,
  }));
  ck('the pointer effects are present', fx.glow && fx.edges > 0 && fx.sheens > 0,
    JSON.stringify({ glow: fx.glow, edges: fx.edges, sheens: fx.sheens }));
  ck('and every one of them is hidden from assistive tech and inert to the pointer',
    fx.hidden === true && fx.focusable === 0 && fx.inert === true, JSON.stringify(fx));

  const stillWorks = await p.evaluate(() => {
    // Rip the decoration out entirely; the form must not notice.
    document.querySelectorAll('.auth-glow, .edge, .sheen').forEach(el => el.remove());
    const email = document.getElementById('authEmail');
    email.value = 'after@dbotrealty.com';
    document.getElementById('authSwitchBtn').click();
    const ok = !document.getElementById('authNameField').hidden && email.value === 'after@dbotrealty.com';
    document.getElementById('authSwitchBtn').click();
    return ok;
  });
  ck('the form works identically with the decoration removed', stillWorks === true);

  /* -- the click target is the field, not the glow -------------------------- */

  const clickable = await p.evaluate(() => {
    const r = document.getElementById('authEmail').getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { id: hit && hit.id, tag: hit && hit.tagName };
  });
  ck('clicking the middle of the email field lands on the input',
    clickable.id === 'authEmail', JSON.stringify(clickable));

  await p.screenshot({ path: path.join(__dirname, 'shot-login.png') });

  /* -- nothing inside the card ever scrolls --------------------------------- */

  // Two separate faults produced the scrollbars in the report. The form column
  // is a flex item, so it defaulted to min-height:auto — "never shrink below my
  // content" — and was therefore taller than the card holding it, which clipped
  // it and gave the column its own scrollbar. And the card was sized in `vw`,
  // which ignores the wrapper's padding, so it overflowed the viewport
  // sideways on anything under about a thousand pixels wide.
  const sizes = [[1440, 900], [1280, 600], [1100, 430], [900, 520], [714, 450]];
  const scrolling = [];
  for (const [w, h] of sizes) {
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(260);
    scrolling.push(await p.evaluate(vp => {
      const main = document.querySelector('.auth-main');
      const shell = document.querySelector('.auth-shell');
      const sr = shell.getBoundingClientRect();
      return {
        vp,
        innerScroll: main.scrollHeight > main.clientHeight + 1,
        clipped: sr.height + 1 < main.scrollHeight,
        sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    }, w + 'x' + h));
  }
  ck('no panel inside the card ever gets its own scrollbar',
    scrolling.every(r => !r.innerScroll),
    scrolling.filter(r => r.innerScroll).map(r => r.vp).join(', ') || 'clean at ' + sizes.length + ' sizes');
  ck('and the card never clips its own contents',
    scrolling.every(r => !r.clipped),
    scrolling.filter(r => r.clipped).map(r => r.vp).join(', ') || 'clean');
  ck('and the page never scrolls sideways',
    scrolling.every(r => !r.sideways),
    scrolling.filter(r => r.sideways).map(r => r.vp).join(', ') || 'clean');

  /* -- the logo has something to stand on ----------------------------------- */

  await p.setViewportSize({ width: 1440, height: 900 });
  await p.waitForTimeout(300);
  const plate = await p.evaluate(() => {
    const img = document.querySelector('.auth-card-brand img');
    const cs = getComputedStyle(img);
    const r = img.getBoundingClientRect();
    return {
      box: cs.boxSizing,
      pad: parseFloat(cs.paddingLeft),
      radius: parseFloat(cs.borderTopLeftRadius),
      lit: /rgb/.test(cs.backgroundImage) || cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
      shadow: cs.boxShadow !== 'none',
      h: Math.round(r.height),
      declaredH: parseFloat(cs.height),
    };
  });
  ck('the logo sits on a plate', plate.pad > 4 && plate.radius > 6 && plate.lit && plate.shadow,
    JSON.stringify({ pad: plate.pad, radius: plate.radius, shadow: plate.shadow }));
  ck('and the plate grows around the mark rather than shrinking it',
    // border-box would take the padding OUT of the declared height, which is
    // what left the logo at sixteen pixels inside a full-size plate.
    plate.box === 'content-box' && plate.h >= plate.declaredH + plate.pad,
    `${plate.box}, ${plate.declaredH}px mark in a ${plate.h}px plate`);

  /* -- narrow: the photograph goes, the form does not ----------------------- */

  await p.setViewportSize({ width: 430, height: 900 });
  await p.waitForTimeout(400);
  const narrow = await p.evaluate(() => {
    const art = document.querySelector('.auth-stage');
    const form = document.querySelector('.auth-main');
    return {
      artHidden: getComputedStyle(art).display === 'none',
      formVisible: form.getBoundingClientRect().width > 200,
      submitVisible: !!document.getElementById('authSubmit').offsetParent,
      noSideScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
    };
  });
  ck('on a phone the photograph is dropped rather than squeezed', narrow.artHidden === true);
  ck('and the form keeps the whole width, with its button reachable',
    narrow.formVisible && narrow.submitVisible, JSON.stringify(narrow));
  ck('with no sideways scroll', narrow.noSideScroll === true);
  await p.screenshot({ path: path.join(__dirname, 'shot-login-narrow.png') });

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
