/**
 * The Supabase export: does tools/export-supabase.js work against a real
 * Postgres shaped like Supabase's?
 *
 * WHY THIS EXISTS. The import side of the migration is tested in
 * diagnostics/migration.cjs, against a file shaped like the export. The export
 * itself — the script an operator runs first, against their live Supabase,
 * once — had never run at all. A column it names that Supabase does not have,
 * a cast that Postgres refuses, a jsonb that arrives as a string rather than an
 * object: any of those would surface for the first time on the morning of the
 * move, with somebody's data on the other end of it.
 *
 * So this starts a throwaway Postgres, builds the parts of a Supabase database
 * the script reads — auth.users with bcrypt hashes and metadata, public.profiles,
 * public.map_projects with jsonb maps — turns SSL on the way Supabase's pooler
 * has it, runs the real script against it, and then feeds what it wrote into
 * api/cli/import.php and checks the passwords still verify on the far side.
 *
 *   node diagnostics/export-supabase.cjs
 *
 * Needs a Postgres server binary (Debian's postgresql package puts one under
 * /usr/lib/postgresql/<n>/bin) and the `pg` driver resolvable from tools/.
 * Without either it says SKIP and why, rather than failing.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 55432;

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

function skip(why) { console.log('SKIP ' + why); process.exit(0); }

/* --- what is available --------------------------------------------------- */

const PG_BIN = process.env.PG_BIN || (() => {
  const base = '/usr/lib/postgresql';
  if (!fs.existsSync(base)) return '';
  const v = fs.readdirSync(base).sort((a, b) => +b - +a)[0];
  return v ? path.join(base, v, 'bin') : '';
})();
if (!PG_BIN || !fs.existsSync(path.join(PG_BIN, 'postgres'))) {
  skip('no Postgres server binary (set PG_BIN to its bin/ directory)');
}
try {
  require.resolve('pg', { paths: [path.join(REPO, 'tools'), path.join(REPO, 'server')] });
} catch (e) {
  skip('the `pg` driver is not installed — `cd server && npm install`, or set NODE_PATH');
}

// Postgres refuses to run as root, which is what a container usually is.
const asPostgres = process.getuid && process.getuid() === 0;
const run = (bin, args, opts) => {
  const cmd = asPostgres ? 'runuser' : path.join(PG_BIN, bin);
  const full = asPostgres ? ['-u', 'postgres', '--', path.join(PG_BIN, bin), ...args] : args;
  return execFileSync(cmd, full, Object.assign({ stdio: 'pipe' }, opts || {}));
};

/* --- a Supabase-shaped database ------------------------------------------ */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapstudio-pg-'));
const data = path.join(dir, 'data');
const sock = path.join(dir, 'sock');
fs.mkdirSync(sock);
if (asPostgres) execFileSync('chown', ['-R', 'postgres', dir]);

const AL_PW = 'ghodbunder-road-2026';
const BEA_PW = 'kasarvadavali-junction';
// Supabase stores bcrypt with the $2a$ prefix; PHP produces $2y$. Same
// algorithm, and import.php must take the former.
const hash = pw => String(execFileSync('php', ['-r', 'echo password_hash($argv[1], PASSWORD_BCRYPT);', pw]))
  .replace(/^\$2y\$/, '$2a$');

const SCHEMA = `
create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  encrypted_password text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text, full_name text, avatar_url text
);
create table public.map_projects (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'Untitled map project',
  data jsonb not null default '{}'::jsonb,
  n_locations integer not null default 0, n_sites integer not null default 0,
  n_routes integer not null default 0, n_shapes integer not null default 0,
  bytes integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  place text default ''
);
insert into auth.users (id, email, encrypted_password, created_at) values
  ('11111111-1111-4111-8111-111111111111', 'Al@Example.com', '${hash(AL_PW)}', '2026-02-01 14:30:00+05:30'),
  ('22222222-2222-4222-8222-222222222222', 'bea@example.com', '${hash(BEA_PW)}', '2026-03-15 11:30:00+00'),
  ('33333333-3333-4333-8333-333333333333', 'cal@example.com', null, '2026-04-02 08:00:00+00'),
  ('44444444-4444-4444-8444-444444444444', null, null, '2026-04-03 08:00:00+00');
insert into public.profiles (id, full_name, avatar_url) values
  ('11111111-1111-4111-8111-111111111111', 'Al Sharp', ''),
  ('22222222-2222-4222-8222-222222222222', 'Bea Quiet', 'https://example.com/b.png');
insert into public.map_projects (id, owner_id, name, data, n_locations, n_sites, place, created_at, updated_at) values
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'Ghodbunder Road',
   '{"version":1,"locations":[{"id":"l1","lat":19.2183,"lng":72.9781}],"notes":"C:\\\\maps — \\"Twin Tunnel\\" ₹16,600 cr","empty":{},"list":[]}',
   1, 1, 'Thane', '2026-05-01 10:00:00+00', '2026-06-01 10:00:00+00'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'Bea''s map',
   '{"version":1}', 0, 0, null, '2026-05-02 10:00:00+00', '2026-05-02 10:00:00+00');
`;

let started = false;
try {
  run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-sync']);

  // SSL on, with a self-signed certificate — the shape of Supabase's pooler,
  // which the script deliberately accepts without verifying.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', path.join(data, 'server.key'),
    '-out', path.join(data, 'server.crt')], { stdio: 'pipe' });
  if (asPostgres) execFileSync('chown', ['postgres', path.join(data, 'server.key'), path.join(data, 'server.crt')]);
  fs.chmodSync(path.join(data, 'server.key'), 0o600);

  run('pg_ctl', ['-D', data, '-l', path.join(dir, 'log'), '-w', '-o',
    `-p ${PORT} -k ${sock} -c ssl=on -c listen_addresses=127.0.0.1`, 'start']);
  started = true;

  run('psql', ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-q', '-c', SCHEMA]);

  /* --- the export -------------------------------------------------------- */

  const out = path.join(dir, 'export.json');
  const dsn = `postgresql://postgres@127.0.0.1:${PORT}/postgres`;
  const exp = spawnSync(process.execPath, [path.join(REPO, 'tools', 'export-supabase.js'),
    '--dsn', dsn, '--out', out], { encoding: 'utf8' });

  ck('the export script runs against a Supabase-shaped database, over SSL',
    exp.status === 0 && fs.existsSync(out),
    exp.status === 0 ? out : (exp.stderr || exp.stdout).trim().split('\n').slice(-3).join(' | '));

  if (exp.status !== 0) throw new Error('export failed');

  ck('and reports what it found in words an operator can check',
    /3 accounts \(2 with a password that will carry over, 1 who will need/.test(exp.stdout)
    && /2 maps/.test(exp.stdout),
    exp.stdout.split('\n').filter(l => /accounts|maps/.test(l)).join(' / ').trim());

  const ex = JSON.parse(fs.readFileSync(out, 'utf8'));

  ck('an account with no email at all is left out rather than exported broken',
    ex.users.length === 3 && !ex.users.some(u => !u.email));

  const al = ex.users.find(u => u.id === '11111111-1111-4111-8111-111111111111');
  ck('addresses are lower-cased on the way out', al && al.email === 'al@example.com', al && al.email);
  ck("the bcrypt hash comes across verbatim, Supabase's $2a$ prefix and all",
    al && /^\$2a\$/.test(al.passwordHash), al && al.passwordHash.slice(0, 7) + '…');
  ck('the name comes from profiles', al && al.fullName === 'Al Sharp');
  ck('and the created date keeps its instant across the time zone',
    al && al.createdAt === '2026-02-01T09:00:00.000Z', al && al.createdAt);

  const cal = ex.users.find(u => u.email === 'cal@example.com');
  ck('an account that only used Microsoft exports with no hash, not an empty string',
    cal && cal.passwordHash === null);

  const map = ex.projects.find(p => p.id === 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
  ck('the map arrives as an object, not as a string of JSON', map && typeof map.data === 'object');
  ck('with every awkward character in it intact',
    map && map.data.notes === 'C:\\maps — "Twin Tunnel" ₹16,600 cr', map && map.data.notes);
  ck('and its place, counts and owner',
    map && map.place === 'Thane' && map.counts.locations === 1
    && map.ownerId === '11111111-1111-4111-8111-111111111111');
  ck('a null place becomes an empty one rather than the word null',
    ex.projects.find(p => p.name === "Bea's map").place === '');

  /* --- an older Supabase table, from before `place` existed ------------- */

  run('psql', ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-q', '-c',
    'alter table public.map_projects drop column place']);
  const out2 = path.join(dir, 'export-old.json');
  const exp2 = spawnSync(process.execPath, [path.join(REPO, 'tools', 'export-supabase.js'),
    '--dsn', dsn, '--out', out2], { encoding: 'utf8' });
  ck('a database from before the place column still exports, with a note saying so',
    exp2.status === 0 && /no `place` column/.test(exp2.stdout + exp2.stderr)
    && JSON.parse(fs.readFileSync(out2, 'utf8')).projects.length === 2,
    exp2.status === 0 ? 'ok' : (exp2.stderr || '').trim().split('\n').pop());

  /* --- and what it wrote, imported -------------------------------------- */

  const sqlite = path.join(dir, 'site.sqlite');
  execFileSync('php', ['-r', `
    $p = new PDO('sqlite:' . $argv[1]);
    $p->exec(file_get_contents($argv[2]));
  `, sqlite, path.join(__dirname, 'accounts-sqlite.sql')], { stdio: 'pipe' });
  const cfg = path.join(dir, 'config.php');
  fs.writeFileSync(cfg, `<?php return ['db_driver' => 'sqlite', 'db_sqlite_path' => '${sqlite}', `
    + `'allowed_email_domain' => 'example.com'];\n`);
  const env = Object.assign({}, process.env, { MAPSTUDIO_CONFIG: cfg });
  execFileSync('php', [path.join(REPO, 'api', 'cli', 'migrate.php')], { env, stdio: 'pipe' });
  const imp = String(execFileSync('php', [path.join(REPO, 'api', 'cli', 'import.php'), out],
    { env, stdio: 'pipe' }));

  ck('the export imports cleanly',
    /Accounts: 3 added/.test(imp) && /Maps: *2 added/.test(imp),
    imp.split('\n').filter(l => /^(Accounts|Maps)/.test(l)).join(' | '));

  const verify = String(execFileSync('php', ['-r', `
    $p = new PDO('sqlite:' . $argv[1]);
    $h = fn($e) => $p->query("select password_hash from users where email = '$e'")->fetchColumn();
    echo json_encode([
      'al' => password_verify($argv[2], $h('al@example.com')),
      'bea' => password_verify($argv[3], $h('bea@example.com')),
      'wrong' => password_verify($argv[3], $h('al@example.com')),
    ]);
  `, sqlite, AL_PW, BEA_PW]));
  const v = JSON.parse(verify);
  ck('and after the whole round trip, everybody\u2019s Supabase password still verifies',
    v.al === true && v.bea === true && v.wrong === false, verify);
} catch (e) {
  if (!R.length || R[R.length - 1] !== false) {
    console.log('FAIL the suite threw  — ' + String((e && e.stderr) || (e && e.message) || e).trim().split('\n').slice(-2).join(' | '));
    R.push(false);
  }
} finally {
  if (started) {
    try { run('pg_ctl', ['-D', data, '-m', 'immediate', 'stop']); } catch (e) { /* ignore */ }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
process.exit(R.length && R.every(Boolean) ? 0 : 1);
