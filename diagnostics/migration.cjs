/**
 * The Supabase migration: does everyone's password still work afterwards?
 *
 * That is the question this suite exists for. The rest of the move is data —
 * rows in, rows out, countable. Passwords are the part that cannot be checked
 * by looking: the hashes come out of Supabase as bcrypt strings, go into MySQL
 * untouched, and either PHP's password_verify() reads them or every person in
 * the company is locked out on the morning of the cutover.
 *
 *   node diagnostics/migration.cjs
 *
 * So it builds an export file shaped exactly like tools/export-supabase.js
 * writes one, imports it with api/cli/import.php, and then signs in through
 * the real API with the password the hash was made from.
 *
 * Supabase's hashes carry the $2a$ prefix; PHP's own password_hash() produces
 * $2y$. They are the same algorithm with different version bytes, and both are
 * tested here rather than assumed, because "bcrypt is bcrypt" is exactly the
 * kind of thing that is true until it is not.
 */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 8013;
const BASE = 'http://127.0.0.1:' + PORT;

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

const php = (code, ...args) =>
  String(execFileSync('php', ['-r', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })).trim();

function phpConfig(obj) {
  const lit = v => {
    if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v === null || v === undefined) return 'null';
    return String(v);
  };
  return '<?php\nreturn [\n'
    + Object.entries(obj).map(([k, v]) => `  ${lit(k)} => ${lit(v)},`).join('\n')
    + '\n];\n';
}

/* ---------------------------------------------------------------------------
 * A Supabase export, as tools/export-supabase.js would have written it
 * ------------------------------------------------------------------------ */

const AL_PASSWORD = 'ghodbunder-road-2026';
const BEA_PASSWORD = 'kasarvadavali-junction';

function buildExport() {
  // What PHP itself produces…
  const alHash = php('echo password_hash($argv[1], PASSWORD_BCRYPT);', AL_PASSWORD);
  // …and the same hash wearing Supabase's version byte. bcrypt's $2a and $2y
  // differ only in that prefix; if PHP ever stopped reading $2a, this is the
  // assertion that would say so before the cutover rather than after it.
  const beaHash = php('echo password_hash($argv[1], PASSWORD_BCRYPT);', BEA_PASSWORD)
    .replace(/^\$2y\$/, '$2a$');

  return {
    exportedAt: new Date().toISOString(),
    source: 'supabase',
    users: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'al@example.com',
        passwordHash: alHash,
        fullName: 'Al Sharp',
        avatarUrl: '',
        createdAt: '2026-02-01T09:00:00.000Z',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'bea@example.com',
        passwordHash: beaHash,
        fullName: 'Bea Quiet',
        avatarUrl: '',
        createdAt: '2026-03-15T11:30:00.000Z',
      },
      {
        // Microsoft-only in Supabase: no hash to carry across.
        id: '33333333-3333-4333-8333-333333333333',
        email: 'cal@example.com',
        passwordHash: null,
        fullName: 'Cal Entra',
        avatarUrl: '',
        createdAt: '2026-04-02T08:00:00.000Z',
      },
    ],
    projects: [
      {
        id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        ownerId: '11111111-1111-4111-8111-111111111111',
        name: 'Ghodbunder Road',
        place: 'Thane',
        data: {
          version: 1,
          locations: [{ id: 'l1', name: 'Site', lat: 19.2183, lng: 72.9781 }],
          // The characters that break hand-written SQL: a backslash, a quote,
          // and three multi-byte glyphs.
          notes: 'C:\\maps\\thane — "Twin Tunnel" ₹16,600 cr — 100% done',
          routes: [], geometries: [],
        },
        counts: { locations: 1, sites: 1, routes: 0, shapes: 0 },
        createdAt: '2026-05-01T10:00:00.000Z',
        updatedAt: '2026-06-01T10:00:00.000Z',
      },
      {
        id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
        ownerId: '22222222-2222-4222-8222-222222222222',
        name: "Bea's map",
        place: '',
        data: { version: 1, locations: [], routes: [], geometries: [] },
        counts: { locations: 0, sites: 0, routes: 0, shapes: 0 },
        createdAt: '2026-05-02T10:00:00.000Z',
        updatedAt: '2026-05-02T10:00:00.000Z',
      },
      {
        // Owner deleted in Supabase: must be reported, not inserted, and must
        // not take the rest of the import down with it.
        id: 'cccccccc-3333-4333-8333-cccccccccccc',
        ownerId: '99999999-9999-4999-8999-999999999999',
        name: 'Orphan',
        place: '',
        data: { version: 1 },
        counts: { locations: 0, sites: 0, routes: 0, shapes: 0 },
        createdAt: '2026-05-03T10:00:00.000Z',
        updatedAt: '2026-05-03T10:00:00.000Z',
      },
    ],
  };
}

/* ------------------------------------------------------------------------ */

function setUp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapstudio-migrate-'));
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
    max_attempts: 50,           // this suite signs in a lot, from one address
    mail_from: '',
    app_url: BASE,
    debug: true,
  }));

  const exportFile = path.join(dir, 'map-studio-export.json');
  fs.writeFileSync(exportFile, JSON.stringify(buildExport(), null, 2));

  // Then migrate it, exactly as a real deployment does — see the note at the
  // top of accounts-sqlite.sql on why the schema above is deliberately old.
  execFileSync('php', [path.join(REPO, 'api', 'cli', 'migrate.php')], {
    env: Object.assign({}, process.env, { MAPSTUDIO_CONFIG: config }),
    stdio: 'pipe',
  });

  return { dir, db, config, exportFile };
}

function runImport(env, extraArgs) {
  return String(execFileSync('php',
    [path.join(REPO, 'api', 'cli', 'import.php'), env.exportFile, ...(extraArgs || [])],
    { env: Object.assign({}, process.env, { MAPSTUDIO_CONFIG: env.config }), stdio: 'pipe' }));
}

function query(env, sql) {
  return JSON.parse(php(`
    $p = new PDO('sqlite:' . $argv[1]);
    $p->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    echo json_encode($p->query($argv[2])->fetchAll(PDO::FETCH_ASSOC));
  `, env.db, sql));
}

async function signIn(email, password) {
  const res = await fetch(BASE + '/api/auth/signin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch (e) { /* reported by caller */ }
  return { status: res.status, json };
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

    /* --- a dry run changes nothing --- */

    const dry = runImport(env, ['--dry-run']);
    ck('a dry run reports what it would do and writes nothing',
      /nothing was written/i.test(dry) && query(env, 'select count(*) as n from users')[0].n === 0,
      dry.split('\n').find(l => /^Accounts/.test(l)));

    /* --- the import --- */

    const out = runImport(env);
    ck('the import reports three accounts and two maps',
      /Accounts: 3 added/.test(out) && /Maps: *2 added/.test(out),
      out.split('\n').filter(l => /^(Accounts|Maps)/.test(l)).join(' | '));

    ck('and says plainly that one map had no owner to attach to',
      /1 map\(s\) name an owner who is not in the export/.test(out));

    const users = query(env, 'select id, email, full_name, password_hash, created_at from users order by email');
    ck('every account is there, with the name from its profile',
      users.length === 3 && users[0].full_name === 'Al Sharp',
      users.map(u => u.email).join(', '));

    ck('and the original created date came across, not today',
      String(users[0].created_at).startsWith('2026-02-01'),
      users[0].created_at);

    const orphan = query(env, "select count(*) as n from map_projects where name = 'Orphan'");
    ck('the ownerless map was not inserted', orphan[0].n === 0);

    /* --- THE ONE THAT MATTERS --- */

    const alIn = await signIn('al@example.com', AL_PASSWORD);
    ck("a migrated password still signs in — nobody has to reset ($2y$ hash)",
      alIn.status === 200 && alIn.json.user.email === 'al@example.com',
      alIn.status + ' ' + ((alIn.json || {}).error || ''));

    const beaIn = await signIn('bea@example.com', BEA_PASSWORD);
    ck("and so does one carrying Supabase's own $2a$ prefix",
      beaIn.status === 200 && beaIn.json.user.email === 'bea@example.com',
      beaIn.status + ' ' + ((beaIn.json || {}).error || ''));

    const wrongPw = await signIn('al@example.com', BEA_PASSWORD);
    ck('while the wrong password still does not', wrongPw.status === 401);

    /* --- the account that had no password --- */

    const calIn = await signIn('cal@example.com', 'anything-at-all');
    ck('an account that only ever used Microsoft cannot be signed into with any password',
      calIn.status === 403 && calIn.json.code === 'no_password');

    ck('and is told to use the reset link rather than blamed for a typo',
      /forgot password/i.test((calIn.json || {}).error || ''),
      (calIn.json || {}).error);

    /* --- the data itself --- */

    const projects = query(env, 'select id, name, place, data, bytes, created_at from map_projects order by name');
    const al = projects.find(p => p.name === 'Ghodbunder Road');
    const payload = JSON.parse(al.data);
    ck('a map with a backslash, quotes and rupees in it survived intact',
      payload.notes === 'C:\\maps\\thane — "Twin Tunnel" ₹16,600 cr — 100% done',
      payload.notes);

    ck('its coordinates are still numbers, not strings',
      typeof payload.locations[0].lat === 'number' && payload.locations[0].lat === 19.2183);

    ck('and `place` came across with it', al.place === 'Thane', al.place);

    ck('bytes was measured here rather than copied from the export',
      al.bytes === Buffer.byteLength(al.data, 'utf8'),
      al.bytes + ' vs ' + Buffer.byteLength(al.data, 'utf8'));

    /* --- running it twice --- */

    const again = runImport(env);
    ck('running it a second time adds nothing and destroys nothing',
      /Accounts: 0 added, 3 already here/.test(again)
      && /Maps: *0 added, 2 already here/.test(again)
      && query(env, 'select count(*) as n from map_projects')[0].n === 2,
      again.split('\n').filter(l => /^(Accounts|Maps)/.test(l)).join(' | '));

    /* --- a password set here is not rolled back by a later re-import --- */

    execFileSync('php', ['-r', `
      require $argv[1] . '/lib/config.php';
      require $argv[1] . '/lib/http.php';
      require $argv[1] . '/lib/db.php';
      require $argv[1] . '/lib/auth.php';
      ms_exec('update users set password_hash = ? where email = ?',
        [ms_password_hash('chosen-after-the-move'), 'al@example.com']);
    `, path.join(REPO, 'api')], {
      env: Object.assign({}, process.env, { MAPSTUDIO_CONFIG: env.config }), stdio: 'pipe' });

    runImport(env);
    const afterReimport = await signIn('al@example.com', 'chosen-after-the-move');
    ck('a password chosen after the move survives a second import of the old file',
      afterReimport.status === 200,
      afterReimport.status + ' ' + ((afterReimport.json || {}).error || ''));

    /* --- --replace --- */

    const replaced = runImport(env, ['--replace']);
    ck('--replace overwrites the maps rather than skipping them',
      /2 overwritten/.test(replaced)
      && query(env, 'select count(*) as n from map_projects')[0].n === 2,
      replaced.split('\n').find(l => /^Maps/.test(l)));
  } catch (e) {
    console.log('FAIL the suite threw  — ' + (e && e.message));
    if (e && e.stderr) console.log(String(e.stderr).slice(0, 800));
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
