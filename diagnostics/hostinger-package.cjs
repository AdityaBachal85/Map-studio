/**
 * The Hostinger upload package: does what ships actually run?
 *
 * The repository is 487 MB and the site inside it is under 6 MB, so a deploy
 * is a selection rather than a copy — and a selection made by an allow-list in
 * tools/build-hostinger.js, which is exactly the kind of list that goes one
 * directory out of date. This app loads 125 scripts in a load-bearing order:
 * a missing one is not a missing feature but a ReferenceError that halts every
 * later init, so one absent file blanks the whole studio while the build
 * script reports success.
 *
 * So the package is built and then *served and loaded*, rather than inspected.
 *
 *   node diagnostics/hostinger-package.cjs
 *
 * It starts its own server on 8011 — the package under test is dist/, not the
 * repository root that the other suites serve.
 */
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..');
const DIST = path.join(REPO, 'dist');
const PORT = 8011;
const BASE = 'http://127.0.0.1:' + PORT;

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

/**
 * The stubbed config every suite here uses: no accounts backend from a test.
 *
 * This harness serves dist/ from Node and has no PHP, so api/ cannot answer —
 * and with the accounts API configured but unreachable, the studio correctly
 * refuses to load and sends the browser to the sign-in page. That is the right
 * behaviour and the wrong thing to measure here: what this suite is asking is
 * whether the 125 scripts in the package load in the right order, which is a
 * different question from whether PHP is installed.
 *
 * Blanking ACCOUNTS_API_BASE puts the app in local mode, where it boots
 * without a server. The accounts API gets tested properly, against real PHP,
 * in diagnostics/accounts-api.cjs.
 */
const localAuthConfig = () => fs.readFileSync(path.join(DIST, 'js', 'config.js'), 'utf8')
  .replace(/const ACCOUNTS_API_BASE = '[^']*';/, "const ACCOUNTS_API_BASE = '';");

/* ---------------------------------------------------------------------------
 * A server for dist/, with no dependency on one already running
 * ------------------------------------------------------------------------ */

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

function serve(root) {
  return http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(root, rel);
    // Nothing outside the package: a traversal here would make the test pass
    // on files the package does not contain, which is the whole question.
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

(async () => {
  /* -- build it ---------------------------------------------------------- */

  let built = '';
  try {
    built = execFileSync(process.execPath, [path.join(REPO, 'tools', 'build-hostinger.js'), '--no-zip'],
      { cwd: REPO, encoding: 'utf8' });
  } catch (e) {
    ck('the package builds', false, ((e.stdout || '') + (e.stderr || '')).trim().split('\n').slice(-3).join(' | '));
    console.log('\n0/1 passed'); process.exit(1);
  }
  ck('the package builds', /\d+ files/.test(built), built.trim());

  const version = fs.readFileSync(path.join(REPO, 'js', 'constants.js'), 'utf8')
    .match(/APP_VERSION\s*=\s*['"]([\w.]+)['"]/)[1];

  /* -- what it contains, and what it must not ---------------------------- */

  const has = p => fs.existsSync(path.join(DIST, p));
  ck('the hidden .htaccess is in it', has('.htaccess'));
  // The one file a File Manager upload silently drops, and the one whose
  // absence is invisible until people report seeing an old build for a week.
  ck('so is the error page', has('404.html'));
  ck('and all three entry pages', has('index.html') && has('login.html') && has('projects.html'));

  const forbidden = ['legacy', 'diagnostics', 'server', 'tools', 'sql', 'docs', '.git', 'node_modules'];
  const shipped = forbidden.filter(has);
  // legacy/ alone is 473 MB. Publishing it would spend a shared plan's whole
  // disk quota on build snapshots; publishing server/ or .git would publish
  // rather more than that.
  ck('and nothing that has no business on a web host', shipped.length === 0, shipped.join(', ') || 'none');

  const totalMb = (() => {
    let n = 0;
    (function walk(d) {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        const st = fs.statSync(p);
        st.isDirectory() ? walk(p) : (n += st.size);
      }
    })(DIST);
    return n / 1048576;
  })();
  // A number rather than a ceiling nobody revisits: 50 MB is far above what
  // the site needs and far below what one stray directory would add.
  ck('the package is a size a shared plan can hold', totalMb < 50, totalMb.toFixed(1) + ' MB');

  /* -- the .htaccess says the things that matter ------------------------- */

  const ht = fs.readFileSync(path.join(DIST, '.htaccess'), 'utf8');
  // THE rule. Assets are busted by ?v=; nothing busts the HTML that names
  // them, so a cached index.html asks for old asset versions and gets them —
  // a page that looks entirely right and is missing whatever shipped last.
  ck('the HTML is told not to cache', /\\\.html\$/.test(ht) && /no-cache/.test(ht));
  ck('and the versioned assets are told they can be', /immutable/.test(ht));
  ck('.js is given a type a browser will execute', /AddType text\/javascript\s+\.js/.test(ht));
  ck('HTTPS is forced, through the header a proxy actually sets',
    /X-Forwarded-Proto/.test(ht) && /R=301/.test(ht));
  ck('and the directories that must never be served are blocked',
    /server\|tools\|diagnostics/.test(ht) && /\.\(git/.test(ht));

  /* -- the accounts API is in the package, and its insides are not --------
   *
   * api/ is the one directory here that must be BOTH shipped and partly
   * refused: index.php has to answer, and the three directories beside it have
   * to not. Both halves are asserted, because the failure modes are opposite
   * and equally quiet — a missing api/ is a site where nobody can sign in, and
   * a reachable api/config.php is the database password on a public URL.
   */
  ck('the accounts API shipped', has('api/index.php') && has('api/lib/auth.php')
    && has('api/routes/projects.php'));
  ck('with the nested .htaccess files that refuse its insides',
    has('api/.htaccess') && has('api/lib/.htaccess') && has('api/routes/.htaccess')
    && has('api/cli/.htaccess'));
  ck('and the root .htaccess refuses them a second time, in case those are lost',
    /\^api\/\(lib\|routes\|cli\)\//.test(ht) && /\^config\(/.test(ht));

  // The live credential file. It exists on a developer's machine, and if it
  // were ever packaged it would carry one deployment's database password into
  // an archive meant for another.
  ck('but never the filled-in config', !has('api/config.php'),
    has('api/config.php') ? 'api/config.php IS IN THE PACKAGE' : 'absent');
  ck('while the sample it is copied from does ship', has('api/config.sample.php'));

  // The Supabase client was 200 KB of vendored SDK for a service this no
  // longer talks to. Asserted rather than assumed, because a stale script tag
  // in one of three entry pages is easy to leave behind and costs a 404 on
  // every page load.
  // The vendored SDK was 200 KB for a service this no longer talks to. The
  // test is for a <script> that still loads it, not for the word — login.html
  // explains in prose why the Microsoft button went away, and should.
  ck('and nothing still loads the Supabase client', !has('vendor/supabase.js')
    && !['index.html', 'login.html', 'projects.html']
      .some(f => /<script[^>]+supabase/i.test(fs.readFileSync(path.join(DIST, f), 'utf8'))));

  /* -- serve it and load it ---------------------------------------------- */

  const srv = serve(DIST);
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));

  const b = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();

  const errs = []; const missing = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('response', r => {
    if (r.status() === 404 && r.url().startsWith(BASE)) missing.push(new URL(r.url()).pathname);
  });
  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  for (const page of ['login.html', 'projects.html', 'index.html', '404.html']) {
    missing.length = 0; errs.length = 0;
    await p.goto(BASE + '/' + page, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(page === 'index.html' ? 3400 : 1800);
    ck(page + ' asks for nothing the package left out',
      missing.length === 0, missing.slice(0, 4).join(', ') || 'none');
    ck(page + ' loads without a page error', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
  }

  // The studio is the page with the 125 scripts. Check something initialised
  // LATE in app.js: an early global proves only that the first few arrived.
  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3600);
  const boot = await p.evaluate(() => ({
    map: typeof map === 'object' && !!map,
    version: typeof APP_VERSION === 'string' ? APP_VERSION : null,
    late: typeof initAutosave === 'function' && typeof initMap3dControls === 'function',
    panes: document.querySelectorAll('.leaflet-tile-pane').length,
  }));
  ck('the studio boots from the package', boot.map === true && boot.panes > 0, JSON.stringify(boot));
  ck('every init in app.js ran, not only the early ones', boot.late === true);
  ck('at the version the tree is stamped at', boot.version === version,
    boot.version + ' vs ' + version);

  /* -- the error page has to stand on its own ---------------------------- */

  await p.goto(BASE + '/404.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  const nf = await p.evaluate(() => {
    const card = document.querySelector('.nf-card');
    return {
      drawn: !!card && card.getBoundingClientRect().height > 100,
      bg: getComputedStyle(document.body).backgroundColor,
      logo: !document.getElementById('nfLogo').hidden,
      rooted: Array.from(document.querySelectorAll('link[href], script[src]'))
        .map(e => e.getAttribute('href') || e.getAttribute('src'))
        .filter(u => u && !/^(https?:|data:)/.test(u))
        .every(u => u.charAt(0) === '/'),
    };
  });
  ck('the error page draws, on the app\'s own ground',
    nf.drawn && nf.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(nf));
  ck('and carries the logo rather than a broken image', nf.logo === true);
  // Apache serves this one file for every missing address. A relative href
  // resolves against the address that failed — from /a/b/c.html, "./css/x.css"
  // asks for /a/b/css/x.css — so the error page would arrive unstyled exactly
  // when somebody is already confused.
  ck('its own assets are root-absolute, so a deep 404 is still styled',
    nf.rooted === true);

  /* -- the build script refuses a tree that would deploy broken ---------- */

  const stamped = path.join(REPO, 'js', 'constants.js');
  const original = fs.readFileSync(stamped, 'utf8');
  let refused = false, why = '';
  try {
    fs.writeFileSync(stamped, original.replace(/APP_VERSION\s*=\s*'[\w.]+'/,
      "APP_VERSION = '0.0001'"));
    execFileSync(process.execPath, [path.join(REPO, 'tools', 'build-hostinger.js'), '--list'],
      { cwd: REPO, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    refused = true;
    why = ((e.stdout || '') + (e.stderr || '')).trim().split('\n').filter(Boolean)[0] || '';
  } finally {
    fs.writeFileSync(stamped, original);
  }
  // Version-stamping is a manual step, so it is a step that gets forgotten.
  // An upload where the HTML asks for ?v=6.0229 and constants.js says 6.0228
  // puts every visitor on the wrong side of the freshness banner: the page
  // reports itself stale, reloads, and is stale again.
  ck('packaging an unstamped tree is refused rather than shipped', refused, why);

  await p.screenshot({ path: path.join(REPO, 'diagnostics', 'shot-hostinger-404.png') });
  await b.close();
  await new Promise(r => srv.close(r));

  const pass = R.filter(Boolean).length;
  console.log('\n' + pass + '/' + R.length + ' passed');
  process.exit(pass === R.length ? 0 : 1);
})();
