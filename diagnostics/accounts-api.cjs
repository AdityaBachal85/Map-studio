/**
 * The accounts API: does it actually keep one person's maps away from another's?
 *
 * WHY THIS SUITE EXISTS AT ALL. Under Supabase, the database refused to hand
 * over another user's rows — Row Level Security applied an owner test inside
 * Postgres to every row of every query, and a client that asked for somebody
 * else's project simply received nothing. That protection does not exist on
 * Hostinger's MySQL. It was replaced by a WHERE clause in api/routes/
 * projects.php, which is code, which can be wrong.
 *
 * So the central test here is not that saving works. It is that Bea, signed in
 * as herself, cannot read, rename, duplicate or delete Al's project by naming
 * its id — and that the answer she gets is "not found" rather than "not
 * yours", because the second one confirms it exists.
 *
 *   node diagnostics/accounts-api.cjs
 *
 * It runs the real PHP — index.php's own routing, the real session cookies,
 * the real queries — against SQLite rather than MySQL, because MySQL is not
 * available here and the alternative was testing none of it. What that cannot
 * catch is written down in diagnostics/accounts-sqlite.sql.
 */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 8012;
const BASE = 'http://127.0.0.1:' + PORT;

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

/* ---------------------------------------------------------------------------
 * A browser-shaped client: one cookie jar each, and the CSRF header
 * ------------------------------------------------------------------------ */

class Client {
  constructor(label) { this.label = label; this.cookies = new Map(); this.csrf = null; }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => k + '=' + v).join('; ');
  }

  takeCookies(res) {
    // Node's fetch does not keep cookies, which is what makes two independent
    // sessions in one process straightforward rather than a problem.
    const all = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    for (const line of all) {
      const [pair] = String(line).split(';');
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '' || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }

  async call(method, route, body) {
    const headers = {};
    const jar = this.cookieHeader();
    if (jar) headers.cookie = jar;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.csrf) headers['x-csrf-token'] = this.csrf;

    const res = await fetch(BASE + '/api' + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    this.takeCookies(res);

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* reported by the caller */ }
    if (json && typeof json.csrf === 'string') this.csrf = json.csrf;
    return { status: res.status, json, text, headers: res.headers };
  }

  get(r) { return this.call('GET', r); }
  post(r, b) { return this.call('POST', r, b === undefined ? {} : b); }
  patch(r, b) { return this.call('PATCH', r, b); }
  del(r) { return this.call('DELETE', r); }
}

/* ---------------------------------------------------------------------------
 * A database and a configuration, thrown away at the end
 * ------------------------------------------------------------------------ */

/**
 * A PHP file returning this object as an array literal.
 *
 * Written out rather than JSON-encoded and decoded at run time, because the
 * file under test is a PHP file that returns an array — and a test that fed
 * the configuration in by some other route would not be exercising
 * api/lib/config.php's actual loading path.
 */
function phpConfig(obj) {
  const lit = v => {
    if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v === null || v === undefined) return 'null';
    return String(v);
  };
  const body = Object.entries(obj)
    .map(([k, v]) => `  ${lit(k)} => ${lit(v)},`)
    .join('\n');
  return `<?php\nreturn [\n${body}\n];\n`;
}

function setUp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapstudio-api-'));
  const db = path.join(dir, 'test.sqlite');

  const schema = fs.readFileSync(path.join(__dirname, 'accounts-sqlite.sql'), 'utf8');
  execFileSync('php', ['-r', `
    $p = new PDO('sqlite:' . $argv[1]);
    $p->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $p->exec('PRAGMA foreign_keys = ON');
    $p->exec(file_get_contents($argv[2]));
  `, db, path.join(__dirname, 'accounts-sqlite.sql')], { stdio: 'pipe' });

  const config = path.join(dir, 'config.php');
  fs.writeFileSync(config, phpConfig({
    db_driver: 'sqlite',
    db_sqlite_path: db,
    allowed_email_domain: 'example.com',
    allow_signup: true,
    session_days: 30,
    reset_minutes: 60,
    max_attempts: 5,
    attempt_minutes: 15,
    mail_from: '',                 // deliberately unset — see the reset tests
    app_url: BASE,
    debug: true,
  }));

  return { dir, db, config, schemaLines: schema.split('\n').length };
}

function startServer(configPath) {
  const php = spawn('php', ['-S', '127.0.0.1:' + PORT, '-t', REPO,
    path.join(__dirname, 'php-router.php')], {
    cwd: REPO,
    env: Object.assign({}, process.env, { MAPSTUDIO_CONFIG: configPath }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  php.stdout.on('data', d => log.push(String(d)));
  php.stderr.on('data', d => log.push(String(d)));
  return { php, log };
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.status === 200 || res.status === 503) return true;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

/* ---------------------------------------------------------------------------
 * The checks
 * ------------------------------------------------------------------------ */

async function run() {
  /* --- it is alive, and it knows its own schema --- */

  const health = await new Client('probe').get('/health');
  ck('the API answers, and finds every table it needs', health.status === 200,
    health.json ? Object.keys(health.json.tables || {}).length + ' tables' : health.text.slice(0, 120));

  /* --- signing up --- */

  const al = new Client('al');
  const bea = new Client('bea');

  const badDomain = await al.post('/auth/signup',
    { email: 'someone@gmail.com', password: 'correct-horse', name: 'Someone' });
  ck('an address outside the allowed domain cannot sign up', badDomain.status === 400,
    badDomain.json && badDomain.json.error);

  const weak = await al.post('/auth/signup',
    { email: 'al@example.com', password: 'short', name: 'Al' });
  ck('nor can a password under eight characters', weak.status === 400,
    weak.json && weak.json.error);

  const alUp = await al.post('/auth/signup',
    { email: 'al@example.com', password: 'correct-horse-battery', name: 'Al Sharp' });
  ck('a work address with a real password can', alUp.status === 201,
    alUp.json && alUp.json.user && alUp.json.user.email);
  ck('and is signed in straight away, with a CSRF token', !!al.csrf && !!(alUp.json || {}).user);

  const dup = await new Client('dup').post('/auth/signup',
    { email: 'al@example.com', password: 'another-long-one', name: 'Impostor' });
  ck('the same address cannot sign up twice', dup.status === 409,
    dup.json && dup.json.code);

  await bea.post('/auth/signup',
    { email: 'bea@example.com', password: 'hunter2-hunter2', name: 'Bea Quiet' });

  /* --- the session cookie itself --- */

  const cookieLine = (() => {
    const jar = al.cookies;
    return jar.has('mapstudio_session');
  })();
  ck('the session rides in a cookie, not in the response body', cookieLine
    && !JSON.stringify(alUp.json).includes(al.cookies.get('mapstudio_session')));

  const meSignedIn = await al.get('/auth/me');
  ck('/auth/me names the signed-in user', meSignedIn.status === 200
    && meSignedIn.json.user && meSignedIn.json.user.email === 'al@example.com');

  const stranger = await new Client('nobody').get('/auth/me');
  ck('and answers 200 with a null user for nobody, not 401', stranger.status === 200
    && stranger.json.user === null);

  /* --- signing in --- */

  const wrong = await new Client('wrong').post('/auth/signin',
    { email: 'al@example.com', password: 'not-the-password' });
  const unknown = await new Client('unknown').post('/auth/signin',
    { email: 'nobody@example.com', password: 'not-the-password' });
  ck('a wrong password and an unknown address answer identically',
    wrong.status === unknown.status && wrong.json.error === unknown.json.error,
    wrong.json && wrong.json.error);

  const al2 = new Client('al2');
  const signedIn = await al2.post('/auth/signin',
    { email: 'AL@Example.com ', password: 'correct-horse-battery' });
  ck('signing in is not case-sensitive about the address', signedIn.status === 200
    && signedIn.json.user.email === 'al@example.com');

  /* --- projects: the ordinary path --- */

  const emptyList = await al.get('/projects');
  ck('a new account has an empty project list', emptyList.status === 200
    && Array.isArray(emptyList.json.projects) && emptyList.json.projects.length === 0);

  const mapPayload = {
    version: 1,
    locations: [{ id: 'l1', name: 'Site', lat: 19.2, lng: 72.9 }],
    routes: [], geometries: [],
    // A key whose order and exact bytes must survive the round trip.
    notes: 'Thane–Borivali Twin Tunnel — ₹ 16,600 cr',
  };
  const saved = await al.post('/projects', {
    name: 'Ghodbunder Road', place: 'Thane', project: mapPayload,
    counts: { locations: 1, sites: 1, routes: 0, shapes: 0 },
  });
  ck('a map saves and comes back with an id', saved.status === 201
    && saved.json.project && saved.json.project.id, saved.json && saved.json.project
      && saved.json.project.id);

  const alProject = saved.json.project.id;

  const loaded = await al.get('/projects/' + alProject);
  ck('and loads back byte-for-byte, unicode intact',
    loaded.status === 200 && JSON.stringify(loaded.json.data) === JSON.stringify(mapPayload),
    loaded.json && loaded.json.data && loaded.json.data.notes);

  const listed = await al.get('/projects');
  ck('the list carries the summary without the map',
    listed.json.projects.length === 1
    && listed.json.projects[0].counts.locations === 1
    && listed.json.projects[0].place === 'Thane'
    && listed.json.projects[0].data === undefined);

  // Bytes, not characters. JSON.stringify().length counts UTF-16 units, so the
  // en dash and the ₹ in the payload above each cost one there and three in
  // storage — which is exactly the sort of quiet six-byte disagreement that
  // makes a storage total wrong by a little, forever.
  const payloadBytes = Buffer.byteLength(JSON.stringify(mapPayload), 'utf8');
  ck('and the byte count is measured on the server, in bytes, not taken from the client',
    listed.json.projects[0].bytes === payloadBytes,
    listed.json.projects[0].bytes + ' vs ' + payloadBytes);

  const updated = await al.post('/projects', {
    id: alProject, name: 'Ghodbunder Road', place: 'Thane',
    project: Object.assign({}, mapPayload, { routes: [{ id: 'r1' }] }),
    counts: { locations: 1, sites: 1, routes: 1, shapes: 0 },
  });
  ck('saving again updates rather than duplicating', updated.status === 200
    && (await al.get('/projects')).json.projects.length === 1);

  const renamed = await al.patch('/projects/' + alProject, { name: 'Ghodbunder Road — final' });
  ck('renaming works', renamed.status === 200
    && (await al.get('/projects/' + alProject + '/meta')).json.project.name === 'Ghodbunder Road — final');

  const copy = await al.post('/projects/' + alProject + '/duplicate');
  ck('duplicating makes a second row with the same map', copy.status === 201
    && copy.json.project.id !== alProject
    && /\(copy\)$/.test(copy.json.project.name));

  const storage = await al.get('/projects/storage');
  ck('storage totals only this account', storage.status === 200
    && storage.json.count === 2 && storage.json.bytes > 0 && storage.json.quota === null,
    storage.json && (storage.json.count + ' projects, ' + storage.json.bytes + ' bytes'));

  /* --- THE ONE THAT MATTERS: one account cannot reach another's --- */

  await bea.post('/projects', {
    name: "Bea's map", project: { version: 1, locations: [] },
    counts: { locations: 0, sites: 0, routes: 0, shapes: 0 },
  });

  const beaList = await bea.get('/projects');
  ck("Bea's list contains only Bea's work", beaList.json.projects.length === 1
    && beaList.json.projects[0].name === "Bea's map",
    beaList.json.projects.map(p => p.name).join(', '));

  const peekData = await bea.get('/projects/' + alProject);
  const peekMeta = await bea.get('/projects/' + alProject + '/meta');
  ck("Bea cannot load Al's map by naming its id",
    peekData.status === 404 && peekMeta.status === 404,
    peekData.status + '/' + peekMeta.status);

  ck('and is told it does not exist, not that it is not hers',
    /does not exist/i.test((peekData.json || {}).error || ''),
    (peekData.json || {}).error);

  const steal = await bea.patch('/projects/' + alProject, { name: 'Mine now' });
  const wipe = await bea.del('/projects/' + alProject);
  const clone = await bea.post('/projects/' + alProject + '/duplicate');
  ck("nor rename, delete or duplicate Al's map",
    steal.status === 404 && wipe.status === 404 && clone.status === 404,
    [steal.status, wipe.status, clone.status].join('/'));

  const overwrite = await bea.post('/projects', {
    id: alProject, name: 'Overwritten', project: { hostile: true },
    counts: { locations: 0, sites: 0, routes: 0, shapes: 0 },
  });
  ck("nor overwrite it by saving to its id", overwrite.status === 404, String(overwrite.status));

  const stillAls = await al.get('/projects/' + alProject);
  ck("and after all that, Al's map is untouched",
    stillAls.status === 200 && stillAls.json.data.notes === mapPayload.notes);

  /* --- signed out, and CSRF --- */

  const noSession = new Client('none');
  const reads = await noSession.get('/projects');
  ck('a signed-out caller gets nothing from /projects', reads.status === 401,
    (reads.json || {}).code);

  const forger = new Client('forger');
  forger.cookies = new Map(al.cookies);      // stolen cookie, no CSRF token
  const forged = await forger.post('/projects', {
    name: 'Forged', project: {}, counts: {},
  });
  ck('a request with the cookie but no CSRF token is refused', forged.status === 403,
    (forged.json || {}).code);

  const noCors = await fetch(BASE + '/api/auth/me', { method: 'OPTIONS' });
  ck('and a cross-origin preflight is refused rather than welcomed',
    noCors.status === 405 && !noCors.headers.get('access-control-allow-origin'));

  /* --- password change and reset --- */

  const changed = await al.post('/auth/password',
    { current: 'correct-horse-battery', next: 'a-brand-new-secret' });
  ck('a password can be changed with the old one', changed.status === 200);

  const oldStillWorks = await new Client('old').post('/auth/signin',
    { email: 'al@example.com', password: 'correct-horse-battery' });
  ck('after which the old password no longer signs in', oldStillWorks.status === 401);

  const otherSession = await al2.get('/projects');
  ck('and every other session for that account was ended', otherSession.status === 401,
    (otherSession.json || {}).code);

  const stillHere = await al.get('/auth/me');
  ck('while the session that made the change stays signed in',
    stillHere.status === 200 && stillHere.json.user !== null);

  const resetUnknown = await new Client('r1').post('/auth/reset/request',
    { email: 'nobody@example.com' });
  ck('a reset for an unknown address says nothing about whether it exists',
    resetUnknown.status === 200 && /if that address/i.test(resetUnknown.json.message || ''),
    resetUnknown.json && resetUnknown.json.message);

  const resetReal = await new Client('r2').post('/auth/reset/request',
    { email: 'bea@example.com' });
  ck('and a real one reports honestly that mail is not configured',
    resetReal.status === 500 && resetReal.json.code === 'mail_failed',
    resetReal.json && resetReal.json.error);

  const badToken = await new Client('r3').post('/auth/reset/confirm',
    { token: 'f'.repeat(64), password: 'does-not-matter-here' });
  ck('an invented reset token is refused', badToken.status === 400,
    (badToken.json || {}).code);

  /* --- signing out --- */

  await al.post('/auth/signout');
  const afterOut = await al.get('/auth/me');
  ck('signing out ends the session at the server, not only in the browser',
    afterOut.status === 200 && afterOut.json.user === null);

  /* --- the shape of a failure --- */

  const missing = await new Client('x').get('/nonsense');
  ck('an unknown endpoint answers JSON, not an HTML error page',
    missing.status === 404 && missing.json && typeof missing.json.error === 'string',
    missing.text.slice(0, 60));
}

/**
 * The sign-in throttle — run last, and deliberately so.
 *
 * It counts failures by address as well as by account, and every request in
 * this suite comes from 127.0.0.1. Run anywhere earlier, it left every later
 * sign-in refused with a 429: four unrelated-looking failures that were one
 * correct behaviour in the wrong place. Anything that needs to sign in has to
 * happen before this.
 */
async function runThrottle() {
  const attacker = new Client('attacker');
  let throttled = null;
  for (let i = 0; i < 8 && !throttled; i++) {
    const r = await attacker.post('/auth/signin',
      { email: 'bea@example.com', password: 'guess-' + i });
    if (r.status === 429) throttled = r;
  }
  ck('repeated failures are refused rather than answered forever', !!throttled,
    throttled && throttled.json.error);
}

/* ---------------------------------------------------------------------------
 * The same API, through the actual browser client
 *
 * Everything above talks to the API with fetch and a hand-rolled cookie jar,
 * which proves the server is right and proves nothing about whether the app
 * agrees with it. The gap between them is where a migration like this breaks:
 * a header spelled X-CSRF-Token on one side and X-Csrf on the other, a field
 * called `projects` being read as `data`, a cookie the browser declines to
 * send because of a path. None of that shows up in a server test, and all of
 * it shows up as "sign-in does nothing" on the day.
 *
 * So this half drives login.html in a real browser, then calls the app's own
 * store functions — projectsSave, projectsList, projectsLoad — in the page,
 * where they run through js/auth/session.js and js/projects/cloudProjects.js
 * exactly as they do for a user.
 * ------------------------------------------------------------------------ */

async function runBrowser() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();

  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e.message)));

    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof sessionReady === 'function' && sessionReady());

    ck('the sign-in page comes up in server mode, not local',
      await page.evaluate(() => authMode()) === 'server');

    // js/config.js still says dbotrealty.com; the API under test says
    // example.com. The client is supposed to believe the server.
    ck('and takes the allowed domain from the server rather than from config.js',
      await page.evaluate(() => authServerInfo().emailDomain) === 'example.com');

    await page.click('#authSwitchBtn');                   // → create account
    await page.fill('#authFullName', 'Dee Browser');
    await page.fill('#authEmail', 'dee@example.com');
    await page.fill('#authPassword', 'a-password-typed-in');
    await Promise.all([
      page.waitForURL(/projects\.html/, { timeout: 15000 }),
      page.click('#authSubmit'),
    ]);
    ck('creating an account through the form lands on the project list',
      /projects\.html/.test(page.url()), page.url().replace(BASE, ''));

    await page.waitForFunction(() => typeof sessionReady === 'function' && sessionReady());
    const who = await page.evaluate(() => {
      const u = currentUser();
      return u ? { name: u.name, email: u.email, initials: u.initials, colour: !!u.color } : null;
    });
    ck('and the page knows who it is, with the initials it derives itself',
      who && who.email === 'dee@example.com' && who.initials === 'DB' && who.colour,
      who && (who.name + ' / ' + who.initials));

    ck('the store dispatches to the server, not to IndexedDB',
      await page.evaluate(() => projectsSource()) === 'cloud');

    /* --- a full round trip through the app's own store ------------------ */

    // Built here and passed in, rather than written inside the evaluated
    // function: a backslash in a string that is serialised to the page as
    // source text goes through two rounds of escaping, and getting that wrong
    // makes the test disagree with itself while the data is perfectly fine.
    const NOTES = 'em\u2014dash, "quotes", \u20b9 and a \\backslash';
    const saved = await page.evaluate(async notes => projectsSave({
      name: 'Browser round trip',
      place: 'Thane',
      project: {
        version: 1,
        locations: [{ id: 'l1', name: 'Site', lat: 19.2183, lng: 72.9781, type: 'site' }],
        routes: [], geometries: [],
        notes,
      },
    }), NOTES);
    ck('saving a map through projectsSave() returns a list row',
      saved && saved.id && saved.remote === true && saved.name === 'Browser round trip',
      saved && (saved.id + ' · ' + saved.bytes + ' bytes'));

    ck('carrying the counts the app worked out, and the owner it belongs to',
      saved && saved.counts && saved.counts.locations === 1 && saved.counts.sites === 1
      && saved.ownerName === 'Dee Browser',
      saved && JSON.stringify(saved.counts));

    const listed = await page.evaluate(() => projectsList());
    ck('and it appears in projectsList()', listed.length === 1
      && listed[0].name === 'Browser round trip' && listed[0].place === 'Thane');

    const back = await page.evaluate(id => projectsLoad(id), saved.id);
    ck('projectsLoad() returns the map exactly as it went in',
      back && back.notes === NOTES && back.locations[0].lat === 19.2183,
      back && back.notes);

    const renamed = await page.evaluate(async id => {
      await projectsRename(id, 'Renamed in the browser', 'Mumbai');
      return (await projectsMeta(id));
    }, saved.id);
    ck('renaming through the store reaches the database',
      renamed.name === 'Renamed in the browser' && renamed.place === 'Mumbai');

    const dup = await page.evaluate(id => projectsDuplicate(id), saved.id);
    ck('duplicating works without the map leaving the server',
      dup && dup.id !== saved.id && /\(copy\)$/.test(dup.name), dup && dup.name);

    const storage = await page.evaluate(() => projectsStorage());
    ck('and the storage figure counts both', storage.count === 2 && storage.bytes > 0,
      storage.count + ' / ' + storage.bytes + ' bytes');

    const afterDelete = await page.evaluate(async id => {
      await projectsDelete(id);
      return (await projectsList()).length;
    }, dup.id);
    ck('deleting one leaves the other', afterDelete === 1);

    /* --- the CSRF header is actually being sent ------------------------- */

    const csrfSeen = await page.evaluate(async () => {
      let header = null;
      const real = window.fetch;
      window.fetch = (url, opts) => {
        if (opts && opts.headers && opts.headers['X-CSRF-Token']) {
          header = opts.headers['X-CSRF-Token'];
        }
        return real(url, opts);
      };
      await projectsSave({ name: 'CSRF probe', project: { version: 1 } });
      window.fetch = real;
      return header;
    });
    ck('every write carries the CSRF token the API issued',
      typeof csrfSeen === 'string' && csrfSeen.length === 64,
      csrfSeen ? csrfSeen.slice(0, 12) + '…' : String(csrfSeen));

    /* --- signing out, and the guard that follows ------------------------ */

    /*
     * projects.html watches the session and navigates away the moment it ends,
     * so this evaluate can be killed mid-flight by the very thing it is
     * triggering. That is correct behaviour, and it means the result has to be
     * read from the server afterwards rather than from a page that may no
     * longer exist.
     */
    await page.evaluate(() => signOut()).catch(() => {});
    const afterSignOut = await new Client('after').get('/auth/me');
    ck('signing out through the app ends the session at the server too',
      afterSignOut.status === 200 && afterSignOut.json.user === null);

    // projects.html sends itself to the sign-in page as soon as the session
    // ends. Let that finish before asking for another page: two navigations in
    // flight at once cancel each other, and the loser is whichever this test
    // was waiting on.
    await page.waitForURL(/login\.html/, { timeout: 15000 }).catch(() => {});

    await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForURL(/login\.html/, { timeout: 15000 }).catch(() => {});
    ck('and the studio then refuses to open, sending the browser to sign in',
      /login\.html/.test(page.url()), page.url().replace(BASE, ''));

    /* --- signing back in gets the work back ----------------------------- */

    await page.waitForFunction(() => typeof sessionReady === 'function' && sessionReady());
    await page.fill('#authEmail', 'dee@example.com');
    await page.fill('#authPassword', 'a-password-typed-in');
    await Promise.all([
      page.waitForURL(u => !/login\.html/.test(String(u)), { timeout: 15000 }),
      page.click('#authSubmit'),
    ]);
    await page.goto(BASE + '/projects.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof sessionReady === 'function' && sessionReady());
    const afterReturn = await page.evaluate(() => projectsList());
    ck('signing back in shows the same maps, from the database',
      afterReturn.length === 2, afterReturn.map(p => p.name).join(', '));

    ck('and the browser reported no page errors throughout',
      errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------------ */

(async () => {
  const env = setUp();
  const { php, log } = startServer(env.config);

  try {
    if (!await waitForServer()) {
      console.log('FAIL the PHP server did not start');
      console.log(log.join(''));
      process.exit(1);
    }
    await run();
    await runBrowser();
    await runThrottle();
  } catch (e) {
    console.log('FAIL the suite threw  — ' + (e && e.message));
    R.push(false);
  } finally {
    php.kill();
    try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  const pass = R.filter(Boolean).length;
  console.log('\n' + pass + '/' + R.length + ' passed');

  // PHP writes notices and warnings to stderr; any that appeared are shown,
  // because a suite that passes while the server is complaining is a suite
  // that will fail on the next PHP version.
  const noise = log.join('').split('\n')
    .filter(l => /PHP (Warning|Notice|Deprecated|Fatal)/.test(l));
  if (noise.length) {
    console.log('\nPHP complained ' + noise.length + ' time(s):');
    noise.slice(0, 10).forEach(l => console.log('  ' + l.trim()));
  }

  process.exit(pass === R.length && !noise.length ? 0 : 1);
})();
