/**
 * Signing in lands on the project list, and the mark on it can be read.
 *
 * It used to land wherever you happened to be, which sounds helpful and is not.
 * The common case is opening the app at index.html: the guard remembered that,
 * so signing in dropped you into the studio with whichever project autosave had
 * restored, rather than at the list of your work. The list is where a session
 * starts.
 *
 * The exception is a destination that names something — a shared ?project= link,
 * or an explicit ?next=. Those still arrive where they were going, and the point
 * of this suite is that BOTH halves hold: the bare page falls through to the
 * list, and the deep link does not.
 *
 * The second half of the file is the rail's brand plate. The DBOT mark is navy
 * artwork with a coloured counter, drawn to sit on white; on the dark rail it
 * was sitting on near-black, where the wordmark all but disappeared and only
 * the 'o' survived. The plate exists to give it a light ground, so the test
 * that matters is a contrast measurement taken off the rendered pixels — not a
 * check that some CSS is present.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/sign-in-landing.cjs
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
  const b = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));

  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  await p.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1600);

  /* -- the rule, stated directly ------------------------------------------- */

  const urls = await p.evaluate(() => ({
    bareMap: authSignInUrl('login.html', 'index.html', ''),
    bareList: authSignInUrl('login.html', 'projects.html', ''),
    project: authSignInUrl('login.html', 'index.html', '?project=abc123'),
    explicit: authSignInUrl('login.html', 'index.html', '?next=projects.html'),
    otherQuery: authSignInUrl('login.html', 'index.html', '?reset=1'),
  }));

  ck('a bare map URL is not worth coming back to', urls.bareMap === 'login.html', urls.bareMap);
  ck('nor is a bare list URL — it is the default anyway',
    urls.bareList === 'login.html', urls.bareList);
  ck('a shared project link is, and survives intact',
    urls.project === 'login.html?next=' + encodeURIComponent('index.html?project=abc123'),
    urls.project);
  ck('so does an explicit next', /next=/.test(urls.explicit), urls.explicit);
  ck('a query that names nothing does not count as a destination',
    urls.otherQuery === 'login.html', urls.otherQuery);

  /* -- and the landing itself ---------------------------------------------- */

  const signIn = async () => {
    await p.fill('#authName', 'Aditya');
    await p.fill('#authLocalEmail', 'aditya.bachal@dbotrealty.com');
    await p.click('#authLocalForm button[type="submit"]');
    await p.waitForTimeout(1400);
    return p.url().split('/').pop().split('?')[0].split('&')[0];
  };

  ck('signing in from a bare login page opens the project list',
    (await signIn()).replace(/\?.*$/, '') === 'projects.html', p.url());

  // Signed out again, then in through a shared link.
  await p.evaluate(() => { try { localStorage.removeItem('dbot.session.v1'); } catch (e) {} });
  await p.goto(BASE + '/login.html?next=' + encodeURIComponent('index.html?project=abc123'),
    { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1600);
  const landed = await signIn();
  ck('but a shared project link still opens that project',
    landed === 'index.html' && /project=abc123/.test(p.url()), p.url());

  /* -- the rail's brand plate ---------------------------------------------- */

  await p.goto(BASE + '/projects.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1800);
  await p.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await p.waitForTimeout(500);

  ck('the mark sits on a plate rather than straight on the rail',
    await p.evaluate(() => !!document.querySelector('.pj-rail-brand .pj-brand-glass .dbotLogo')) === true);

  const glassOn = await p.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.pj-brand-glass'));
    return { bf: cs.backdropFilter || cs.webkitBackdropFilter, img: cs.backgroundImage.slice(0, 30) };
  });
  ck('and the plate is frosted, not painted flat',
    /blur/.test(glassOn.bf) && /saturate/.test(glassOn.bf), glassOn.bf);

  /**
   * The relative luminance of a rendered pixel, and the contrast between two.
   * Measured off a screenshot rather than reasoned about from the CSS: the
   * plate is translucent, so what the wordmark actually sits on is the result
   * of compositing several layers over whatever the rail happens to be.
   */
  const plateContrast = async () => {
    const box = await p.evaluate(() => {
      const r = document.querySelector('.pj-brand-glass').getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top),
        width: Math.round(r.width), height: Math.round(r.height) };
    });
    const shot = (await p.screenshot({ clip: box })).toString('base64');
    return p.evaluate(async b64 => {
      const img = new Image();
      await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      // The lightest pixels are the ground the navy letterforms are drawn on;
      // sample the brightest tenth so a letter stroke cannot be mistaken for it.
      const lum = [];
      for (let i = 0; i < d.length; i += 4) {
        const f = v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
        lum.push(0.2126 * f(d[i]) + 0.7152 * f(d[i + 1]) + 0.0722 * f(d[i + 2]));
      }
      lum.sort((a, b) => b - a);
      const ground = lum[Math.floor(lum.length * 0.1)];
      // The wordmark's navy, #0A1E3C.
      const f = v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
      const ink = 0.2126 * f(0x0A) + 0.7152 * f(0x1E) + 0.0722 * f(0x3C);
      return Math.round(((ground + 0.05) / (ink + 0.05)) * 100) / 100;
    }, shot);
  };

  const dark = await plateContrast();
  ck('the navy wordmark clears AA against the plate in the dark theme',
    dark >= 4.5, dark + ':1');

  await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await p.waitForTimeout(450);
  const light = await plateContrast();
  ck('and in the light theme', light >= 4.5, light + ':1');

  // Glass off is a preference about cost, not about legibility: the plate has
  // to keep doing its job with the expensive part switched off.
  await p.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    document.body.classList.add('no-glass');
  });
  await p.waitForTimeout(450);
  const off = await p.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.pj-brand-glass'));
    return { bf: cs.backdropFilter || cs.webkitBackdropFilter };
  });
  const offContrast = await plateContrast();
  ck('with glass off the filter goes and the ground stays',
    (!off.bf || off.bf === 'none') && offContrast >= 4.5,
    off.bf + ' / ' + offContrast + ':1');
  await p.evaluate(() => document.body.classList.remove('no-glass'));

  // A logo that shimmers on its own pulls the eye off the list the page is for,
  // so the sheen is a hover response — and reduced motion switches it off.
  await p.evaluate(() => document.body.classList.add('reduce-motion'));
  await p.hover('.pj-rail-brand');
  await p.waitForTimeout(300);
  ck('reduced motion stops the sheen',
    await p.evaluate(() =>
      getComputedStyle(document.querySelector('.pj-brand-glass'), '::after').display) === 'none');

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');

  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})();
