/**
 * The admin panel: can somebody who is not an administrator do any of this?
 *
 * That is the question. Everything else here — creating an account, issuing a
 * password, moving maps — is a feature and would be noticed if it broke. The
 * failure that would NOT be noticed is an endpoint that answers an ordinary
 * user, because the page is hidden from them and nobody would look. So the
 * first block below signs in as a normal user and tries every admin route.
 *
 * The second thing worth this much trouble is the lockout rules. An install
 * whose last administrator demotes themselves has no way back in except SSH,
 * which a shared plan may not have, and the person who caused it is by
 * definition the person who can no longer fix it.
 *
 *   node diagnostics/admin-panel.cjs
 *
 * Runs real PHP against SQLite, and then drives admin.html in a real browser —
 * because the interesting part of an issued password is not that the API
 * returns one, it is that somebody can sign in with it and is then made to
 * choose their own.
 */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 8014;
const BASE = 'http://127.0.0.1:' + PORT;

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

/* ------------------------------------------------------------------------ */

class Client {
  constructor() { this.cookies = new Map(); this.csrf = null; }

  takeCookies(res) {
    const all = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
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
    // fetch refuses a body on GET outright, and the sweep below calls every
    // route with the same arguments to prove they are all refused.
    if (method === 'GET' || method === 'HEAD') body = undefined;
    const headers = {};
    const jar = [...this.cookies].map(([k, v]) => k + '=' + v).join('; ');
    if (jar) headers.cookie = jar;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    const res = await fetch(BASE + '/api' + route, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    this.takeCookies(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* reported by the caller */ }
    if (json && typeof json.csrf === 'string') this.csrf = json.csrf;
    return { status: res.status, json, text };
  }

  get(r) { return this.call('GET', r); }
  post(r, b) { return this.call('POST', r, b === undefined ? {} : b); }
  patch(r, b) { return this.call('PATCH', r, b); }
  del(r, b) { return this.call('DELETE', r, b === undefined ? {} : b); }
}

function phpConfig(obj) {
  const lit = v => {
    if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v === null || v === undefined) return 'null';
    return String(v);
  };
  return '<?php\nreturn [\n'
    + Object.entries(obj).map(([k, v]) => `  ${lit(k)} => ${lit(v)},`).join('\n') + '\n];\n';
}

function setUp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapstudio-admin-'));
  const db = path.join(dir, 'test.sqlite');

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
    max_attempts: 50,           // this suite signs in a great many times
    mail_from: '',
    app_url: BASE,
    debug: true,
  }));

  const out = String(execFileSync('php', [path.join(REPO, 'api', 'cli', 'migrate.php')], {
    env: Object.assign({}, process.env, { MAPSTUDIO_CONFIG: config }), stdio: 'pipe',
  }));

  return { dir, db, config, migrateOut: out };
}

function query(env, sql) {
  return JSON.parse(String(execFileSync('php', ['-r', `
    $p = new PDO('sqlite:' . $argv[1]);
    $p->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    echo json_encode($p->query($argv[2])->fetchAll(PDO::FETCH_ASSOC));
  `, env.db, sql], { stdio: ['ignore', 'pipe', 'pipe'] })));
}

function cli(env, script, args) {
  try {
    return String(execFileSync('php', [path.join(REPO, 'api', 'cli', script), ...(args || [])], {
      env: Object.assign({}, process.env, { MAPSTUDIO_CONFIG: env.config }), stdio: 'pipe',
    }));
  } catch (e) {
    return String((e.stdout || '') + (e.stderr || ''));
  }
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

async function run(env) {
  /* --- the upgrade path ------------------------------------------------- */

  ck('migrate.php upgrades a database built before the admin panel',
    /added `users`\.`role`/.test(env.migrateOut) && /created the table `admin_log`/.test(env.migrateOut),
    env.migrateOut.split('\n').filter(l => l.includes('✓')).length + ' changes');

  const again = cli(env, 'migrate.php');
  ck('and running it a second time does nothing at all',
    /already up to date/.test(again), again.trim().split('\n')[0]);

  const health = await new Client().get('/health');
  ck('/api/health then reports the schema as current',
    health.status === 200 && health.json.schema === 'current',
    JSON.stringify(health.json && health.json.schema).slice(0, 80));

  /* --- the first account is the administrator --------------------------- */

  const boss = new Client();
  const first = await boss.post('/auth/signup',
    { email: 'boss@example.com', password: 'the-first-account', name: 'Bo Boss' });
  ck('the first account on a fresh install is an administrator',
    first.status === 201 && first.json.user.role === 'admin',
    first.json && first.json.user && first.json.user.role);

  const worker = new Client();
  const second = await worker.post('/auth/signup',
    { email: 'worker@example.com', password: 'the-second-account', name: 'Wynn Worker' });
  ck('and the second is not', second.status === 201 && second.json.user.role === 'user',
    second.json && second.json.user && second.json.user.role);

  /* --- THE ONE THAT MATTERS: an ordinary user cannot reach any of it ----- */

  const forbidden = [
    ['GET', '/admin/users'],
    ['GET', '/admin/log'],
    ['POST', '/admin/users'],
    ['PATCH', '/admin/users/' + second.json.user.id],
    ['POST', '/admin/users/' + second.json.user.id + '/password'],
    ['POST', '/admin/users/' + second.json.user.id + '/transfer'],
    ['DELETE', '/admin/users/' + second.json.user.id],
  ];
  const answers = [];
  for (const [m, r] of forbidden) answers.push((await worker.call(m, r, {})).status);
  ck('an ordinary user is refused every admin route', answers.every(s => s === 404),
    answers.join('/'));

  ck('and is told there is no such endpoint, not that they lack permission',
    /No such endpoint/i.test((await worker.get('/admin/users')).json.error || ''));

  const anon = await new Client().get('/admin/users');
  ck('a signed-out caller likewise', anon.status === 401 || anon.status === 404, String(anon.status));

  /* --- the list --------------------------------------------------------- */

  const list = await boss.get('/admin/users');
  ck('an administrator sees everybody, with the numbers to decide on',
    list.status === 200 && list.json.users.length === 2
    && list.json.users.every(u => 'projects' in u && 'lastSeen' in u && 'role' in u),
    list.json.users.map(u => u.email).join(', '));

  ck('and no password hash comes with them',
    !/\$2[aby]\$/.test(JSON.stringify(list.json)));

  ck('the list marks which row is the caller themselves',
    list.json.users.filter(u => u.isSelf).length === 1);

  ck('and reports that self sign-up is still open, which defeats the point',
    list.json.signupOpen === true);

  /* --- creating somebody ------------------------------------------------ */

  const made = await boss.post('/admin/users',
    { email: 'newbie@example.com', name: 'Newt Newbie' });
  ck('creating an account returns a password, once',
    made.status === 201 && typeof made.json.password === 'string' && made.json.password.length >= 16,
    made.json && made.json.password);

  const issued = made.json.password;
  ck('the issued password avoids characters nobody can tell apart',
    !/[0O1lI5S]/.test(issued.replace(/-/g, '')), issued);

  ck('and the account is marked as needing one of its own',
    made.json.user.mustChangePassword === true);

  const badDomain = await boss.post('/admin/users', { email: 'outsider@gmail.com', name: 'Out' });
  ck('the domain restriction applies to accounts an administrator creates too',
    badDomain.status === 400, badDomain.json && badDomain.json.error);

  const dup = await boss.post('/admin/users', { email: 'worker@example.com', name: 'Again' });
  ck('and an address that already has an account is refused', dup.status === 409);

  /* --- signing in on an issued password --------------------------------- */

  const newbie = new Client();
  const newIn = await newbie.post('/auth/signin',
    { email: 'newbie@example.com', password: issued });
  ck('the issued password signs in', newIn.status === 200,
    newIn.status + ' ' + ((newIn.json || {}).error || ''));

  ck('and the session says a password of their own is still needed',
    newIn.json.user.mustChangePassword === true);

  await newbie.post('/auth/password', { current: issued, next: 'one-only-i-know' });
  const afterChange = await newbie.get('/auth/me');
  ck('choosing one clears the flag', afterChange.json.user.mustChangePassword === false);

  const oldIssued = await new Client().post('/auth/signin',
    { email: 'newbie@example.com', password: issued });
  ck('and the issued password stops working', oldIssued.status === 401);

  /* --- switching an account off ----------------------------------------- */

  const workerId = second.json.user.id;
  await boss.patch('/admin/users/' + workerId, { status: 'disabled' });

  const offIn = await new Client().post('/auth/signin',
    { email: 'worker@example.com', password: 'the-second-account' });
  ck('a switched-off account cannot sign in, with the right password',
    offIn.status === 403 && offIn.json.code === 'disabled',
    offIn.json && offIn.json.error);

  const stillLive = await worker.get('/auth/me');
  ck('and a session that was already open stops working at once',
    stillLive.status === 200 && stillLive.json.user === null);

  await boss.patch('/admin/users/' + workerId, { status: 'active' });
  const backIn = new Client();
  ck('switching it back on lets them in again',
    (await backIn.post('/auth/signin',
      { email: 'worker@example.com', password: 'the-second-account' })).status === 200);

  /* --- the lockout rules ------------------------------------------------ */

  const bossId = first.json.user.id;

  const selfDemote = await boss.patch('/admin/users/' + bossId, { role: 'user' });
  ck('an administrator cannot demote themselves',
    selfDemote.status === 409 && selfDemote.json.code === 'not_yourself',
    selfDemote.json && selfDemote.json.error);

  const selfOff = await boss.patch('/admin/users/' + bossId, { status: 'disabled' });
  const selfDel = await boss.del('/admin/users/' + bossId, { expectProjects: 0 });
  ck('nor switch themselves off, nor delete themselves',
    selfOff.status === 409 && selfDel.status === 409,
    selfOff.status + '/' + selfDel.status);

  // Two administrators, each able to remove the other — which no self-check
  // would catch, and which is how an install ends up with none.
  await boss.patch('/admin/users/' + workerId, { role: 'admin' });
  const w2 = new Client();
  await w2.post('/auth/signin', { email: 'worker@example.com', password: 'the-second-account' });
  const demoteBoss = await w2.patch('/admin/users/' + bossId, { role: 'user' });
  ck('one administrator can demote another while a second one exists',
    demoteBoss.status === 200, String(demoteBoss.status));

  const demoteLast = await w2.patch('/admin/users/' + workerId, { role: 'user' });
  ck('but nobody can remove the last one — not even by removing themselves',
    demoteLast.status === 409, (demoteLast.json || {}).code);

  // Put it back for the rest of the suite.
  await w2.patch('/admin/users/' + bossId, { role: 'admin' });

  /* --- maps: moving, and deleting -------------------------------------- */

  const mapOwner = new Client();
  await mapOwner.post('/auth/signin',
    { email: 'newbie@example.com', password: 'one-only-i-know' });
  await mapOwner.post('/projects', {
    name: 'Leaver’s map', project: { version: 1, locations: [] },
    counts: { locations: 0, sites: 0, routes: 0, shapes: 0 },
  });
  const newbieId = made.json.user.id;

  const withMaps = (await boss.get('/admin/users')).json.users.find(u => u.id === newbieId);
  ck('the list counts the maps each person owns', withMaps.projects === 1, String(withMaps.projects));

  const wrongCount = await boss.del('/admin/users/' + newbieId, { expectProjects: 0 });
  ck('deleting refuses unless the caller names the right number of maps',
    wrongCount.status === 409 && wrongCount.json.code === 'confirm_projects',
    wrongCount.json && wrongCount.json.error);

  const moved = await boss.post('/admin/users/' + newbieId + '/transfer', { to: workerId });
  ck('their maps can be moved to a named colleague instead',
    moved.status === 200 && moved.json.moved === 1,
    JSON.stringify(moved.json));

  const receiver = new Client();
  await receiver.post('/auth/signin',
    { email: 'worker@example.com', password: 'the-second-account' });
  const received = await receiver.get('/projects');
  ck('and the colleague can now open them',
    received.json.projects.length === 1 && /Leaver/.test(received.json.projects[0].name),
    received.json.projects.map(p => p.name).join(', '));

  const gone = await boss.del('/admin/users/' + newbieId, { expectProjects: 0 });
  ck('after which the account deletes cleanly', gone.status === 200);

  ck('and is really gone', query(env,
    "select count(*) as n from users where email = 'newbie@example.com'")[0].n === 0);

  /* --- an administrator still cannot read anybody's maps ---------------- */

  const someoneElsesMap = received.json.projects[0].id;
  const peek = await boss.get('/projects/' + someoneElsesMap);
  ck('an administrator cannot open another person’s map through the project API',
    peek.status === 404, String(peek.status));

  ck('and there is no admin route that returns one either',
    (await boss.get('/admin/users/' + workerId + '/projects')).status === 404);

  /* --- the log ---------------------------------------------------------- */

  const log = await boss.get('/admin/log');
  const actions = (log.json.entries || []).map(e => e.action);
  ck('every administrative action was recorded',
    actions.includes('create') && actions.includes('update')
    && actions.includes('transfer') && actions.includes('delete'),
    [...new Set(actions)].join(', '));

  const deleted = (log.json.entries || []).find(e => e.action === 'delete');
  ck('including who was deleted, after the account itself is gone',
    deleted && deleted.target === 'newbie@example.com' && deleted.actor === 'boss@example.com',
    deleted && (deleted.actor + ' → ' + deleted.target));

  /* --- the CLI ---------------------------------------------------------- */

  const promoted = cli(env, 'make-admin.php', ['worker@example.com']);
  ck('make-admin.php reports somebody who is already an administrator',
    /already an administrator/.test(promoted), promoted.trim());

  const listed = cli(env, 'make-admin.php', ['--list']);
  ck('and can list everyone', /boss@example.com/.test(listed) && /admin/.test(listed));

  const unknown = cli(env, 'make-admin.php', ['nobody@example.com']);
  ck('an unknown address is told so, with the real ones printed',
    /No account with that address/.test(unknown));
}

/**
 * The bootstrap window: can a fresh install with the RECOMMENDED config be
 * started at all?
 *
 * api/config.sample.php ships `allow_signup => false`, because accounts are
 * meant to be issued from the People page. Taken literally that is
 * unstartable — administrators create accounts, administrators are accounts,
 * and an empty database has neither — so the first sign-up is allowed through
 * whatever the setting says, and the window shuts behind it.
 *
 * Worth its own server and its own database, because the whole question is
 * what happens when there are no rows, and every other test here begins by
 * creating some.
 */
async function runBootstrap() {
  const PORT2 = 8015;
  const BASE2 = 'http://127.0.0.1:' + PORT2;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapstudio-boot-'));
  const db = path.join(dir, 'test.sqlite');
  execFileSync('php', ['-r', `
    $p = new PDO('sqlite:' . $argv[1]);
    $p->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $p->exec(file_get_contents($argv[2]));
  `, db, path.join(__dirname, 'accounts-sqlite.sql')], { stdio: 'pipe' });

  const config = path.join(dir, 'config.php');
  fs.writeFileSync(config, phpConfig({
    db_driver: 'sqlite',
    db_sqlite_path: db,
    allowed_email_domain: 'example.com',
    allow_signup: false,              // exactly what the sample config ships
    max_attempts: 50,
    mail_from: '',
    app_url: BASE2,
    debug: true,
  }));
  execFileSync('php', [path.join(REPO, 'api', 'cli', 'migrate.php')], {
    env: Object.assign({}, process.env, { MAPSTUDIO_CONFIG: config }), stdio: 'pipe',
  });

  const srv = spawn('php', ['-S', '127.0.0.1:' + PORT2, '-t', REPO,
    path.join(__dirname, 'php-router.php')], {
    cwd: REPO,
    env: Object.assign({}, process.env, { MAPSTUDIO_CONFIG: config }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const post = async (route, body) => {
    const res = await fetch(BASE2 + '/api' + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = JSON.parse(await res.text()); } catch (e) { /* reported by the caller */ }
    return { status: res.status, json };
  };

  try {
    for (let i = 0; i < 100; i++) {
      try { await fetch(BASE2 + '/api/health'); break; } catch (e) { /* not up */ }
      await new Promise(r => setTimeout(r, 100));
    }

    const first = await post('/auth/signup',
      { email: 'founder@example.com', password: 'the-very-first-one', name: 'Fay Founder' });
    ck('with sign-up switched off, the first account is still allowed through',
      first.status === 201, first.status + ' ' + ((first.json || {}).error || ''));

    ck('and it is an administrator, so the install can be administered',
      first.json && first.json.user && first.json.user.role === 'admin',
      first.json && first.json.user && first.json.user.role);

    const second = await post('/auth/signup',
      { email: 'gatecrash@example.com', password: 'the-second-one', name: 'Gus' });
    ck('the window shuts immediately behind it',
      second.status === 403 && second.json.code === 'signup_closed',
      second.json && second.json.error);
  } finally {
    srv.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

/**
 * Sign out and land on the sign-in page.
 *
 * Not one line, because the page signs ITSELF out to login.html the moment the
 * session ends — so a goto issued at the same moment races that redirect and
 * whichever loses is cancelled. Waiting for the page's own navigation first
 * makes the sequence deterministic.
 */
async function signOutTo(page, url) {
  await page.evaluate(() => signOut()).catch(() => {});
  await page.waitForURL(/login\.html/, { timeout: 15000 }).catch(() => {});
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof sessionReady === 'function' && sessionReady());
}

/* ---------------------------------------------------------------------------
 * The browser half
 * ------------------------------------------------------------------------ */

async function runBrowser() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();

  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e.message)));

    /* -- an ordinary user is sent away from the page ------------------- */

    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof sessionReady === 'function' && sessionReady());
    await page.fill('#authEmail', 'worker@example.com');
    await page.fill('#authPassword', 'the-second-account');
    await Promise.all([
      page.waitForURL(u => !/login\.html/.test(String(u)), { timeout: 15000 }),
      page.click('#authSubmit'),
    ]);

    await page.goto(BASE + '/projects.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof sessionReady === 'function' && sessionReady());
    // worker was promoted and demoted during the API half; whichever they are
    // now, the link must agree with it rather than with a stale render.
    const workerIsAdmin = await page.evaluate(() => isAdmin());
    const linkShown = await page.evaluate(() =>
      !document.getElementById('pjAdminLink').hidden);
    ck('the People link appears exactly when the person is an administrator',
      workerIsAdmin === linkShown, 'admin=' + workerIsAdmin + ' link=' + linkShown);

    /* -- an administrator uses the page -------------------------------- */

    await signOutTo(page, BASE + '/login.html');
    await page.fill('#authEmail', 'boss@example.com');
    await page.fill('#authPassword', 'the-first-account');
    await Promise.all([
      page.waitForURL(u => !/login\.html/.test(String(u)), { timeout: 15000 }),
      page.click('#authSubmit'),
    ]);

    await page.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ad-table', { timeout: 15000 });
    ck('the People page lists the accounts',
      (await page.locator('.ad-table tbody tr').count()) >= 2,
      (await page.locator('.ad-table tbody tr').count()) + ' rows');

    ck('and warns that self sign-up is still open',
      !(await page.locator('#adSignupWarn').isHidden()));

    // The row for the administrator themselves: the three destructive controls
    // must be visibly unavailable rather than offered and then refused.
    const selfRow = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.ad-table tbody tr')];
      const mine = rows.find(r => r.querySelector('.ad-you'));
      if (!mine) return null;
      const btns = [...mine.querySelectorAll('button[data-act]')];
      return btns.map(b => ({ act: b.dataset.act, disabled: b.disabled, why: b.title }));
    });
    const blocked = (selfRow || []).filter(b => ['demote', 'disable', 'delete'].includes(b.act));
    ck('the controls that would lock you out of your own install are disabled',
      blocked.length === 3 && blocked.every(b => b.disabled),
      blocked.map(b => b.act + (b.disabled ? '✓' : '✗')).join(' '));

    ck('and each says why', blocked.every(b => /cannot do this to your own account/i.test(b.why)),
      (blocked[0] || {}).why);

    /* -- add somebody, through the form -------------------------------- */

    await page.click('#adNew');
    await page.fill('#adAddName', 'Dee Browser');
    await page.fill('#adAddEmail', 'dee@example.com');
    await page.click('#adAddOk');
    await page.waitForSelector('#adPwModal:not([hidden])', { timeout: 15000 });

    const shown = (await page.locator('#adPwValue').textContent()).trim();
    ck('adding somebody shows their password once, in the page',
      /^[A-Za-z2-9-]{16,}$/.test(shown), shown);

    ck('and says plainly that it cannot be read again',
      /only time it is shown/i.test(await page.locator('.ad-pw-note').textContent()));

    await page.click('#adPwDone');
    // state:'hidden', not a [hidden] selector — the default waits for the
    // element to become VISIBLE, which a hidden element never does, so the
    // selector form waits out its whole timeout and then fails.
    await page.waitForSelector('#adPwModal', { state: 'hidden', timeout: 10000 });
    ck('the new person is in the list, flagged as not having chosen a password',
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('.ad-table tbody tr')]
          .find(r => r.textContent.includes('dee@example.com'));
        return !!row && /issued password/.test(row.textContent);
      }));

    /* -- and that password actually works, once ------------------------ */

    await signOutTo(page, BASE + '/login.html');
    await page.fill('#authEmail', 'dee@example.com');
    await page.fill('#authPassword', shown);
    await page.click('#authSubmit');

    await page.waitForFunction(
      () => document.getElementById('authTitle').textContent.includes('your own'),
      { timeout: 15000 });
    ck('signing in with it goes to "choose your own password", not into the app',
      /choose your own/i.test(await page.locator('#authTitle').textContent()));

    ck('and does not ask for the issued one again — they typed it a second ago',
      await page.locator('#authCurrentField').isHidden());

    await page.fill('#authPassword', 'dees-own-password');
    await Promise.all([
      page.waitForURL(u => !/login\.html/.test(String(u)), { timeout: 15000 }),
      page.click('#authSubmit'),
    ]);
    ck('choosing one lands them in the app', !/login\.html/.test(page.url()),
      page.url().replace(BASE, ''));

    ck('with no page errors anywhere in that flow', errs.length === 0,
      errs.slice(0, 2).join(' | ') || 'none');

    /* -- the studio and the list do not let an issued password linger --- */

    const lingering = new Client();
    await lingering.post('/auth/signin', { email: 'dee@example.com', password: 'dees-own-password' });
    ck('and a password they chose themselves is not flagged',
      (await lingering.get('/auth/me')).json.user.mustChangePassword === false);
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------------ */

(async () => {
  const env = setUp();
  const server = spawn('php', ['-S', '127.0.0.1:' + PORT, '-t', REPO,
    path.join(__dirname, 'php-router.php')], {
    cwd: REPO,
    env: Object.assign({}, process.env, { MAPSTUDIO_CONFIG: env.config }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  server.stdout.on('data', d => log.push(String(d)));
  server.stderr.on('data', d => log.push(String(d)));

  try {
    if (!await waitForServer()) {
      console.log('FAIL the PHP server did not start');
      console.log(log.join(''));
      process.exit(1);
    }
    await run(env);
    await runBrowser();
    await runBootstrap();
  } catch (e) {
    console.log('FAIL the suite threw  — ' + (e && e.message));
    R.push(false);
  } finally {
    server.kill();
    try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  const pass = R.filter(Boolean).length;
  console.log('\n' + pass + '/' + R.length + ' passed');

  const noise = log.join('').split('\n')
    .filter(l => /PHP (Warning|Notice|Deprecated|Fatal)/.test(l));
  if (noise.length) {
    console.log('\nPHP complained ' + noise.length + ' time(s):');
    noise.slice(0, 10).forEach(l => console.log('  ' + l.trim()));
  }

  process.exit(pass === R.length && !noise.length ? 0 : 1);
})();
