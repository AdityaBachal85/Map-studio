#!/usr/bin/env node
/**
 * tools/export-supabase.js — take everything out of Supabase, into one file.
 *
 * WHY THIS TALKS TO POSTGRES AND NOT TO THE REST API. Supabase's admin REST
 * endpoint will list users, and it will not give you their passwords — the
 * hash lives in auth.users.encrypted_password and is never serialised out.
 * Going through Postgres directly is what makes the difference between a
 * migration nobody notices and one where every person in the company has to
 * reset a password on the same morning.
 *
 * The hashes transfer verbatim, and they work: Supabase stores standard bcrypt
 * ($2a$…), which is exactly what PHP's password_verify() reads. Nobody's
 * password changes, and nothing here ever sees a plaintext one.
 *
 * WHY IT WRITES A FILE INSTEAD OF INSERTING. Three reasons, in order:
 *
 *   1. Hostinger's MySQL does not accept connections from outside by default,
 *      so a script that wrote directly would need Remote MySQL turned on and
 *      this machine's address whitelisted — for a one-off.
 *   2. Generating SQL by hand means escaping megabytes of arbitrary JSON into
 *      string literals, where MySQL's backslash handling differs from every
 *      other dialect's, and one map containing a Windows path or a regular
 *      expression corrupts a row silently. api/cli/import.php uses the same
 *      prepared statements the app does, so nothing is escaped by hand at all.
 *   3. A file can be read before it is trusted. Open it, count the rows,
 *      confirm it is your data, and only then import.
 *
 * USAGE
 *
 *   node tools/export-supabase.js --dsn "postgresql://postgres:PASS@db.xxx.supabase.co:5432/postgres"
 *   node tools/export-supabase.js                 # reads SUPABASE_DB_URL instead
 *
 * The connection string is in Supabase → Project Settings → Database. Use the
 * **Session pooler** string (its host ends .pooler.supabase.com) rather than
 * the direct one, which is IPv6-only and times out from most networks.
 *
 * It writes map-studio-export.json beside itself unless --out says otherwise.
 * That file contains password hashes and every map you have: it is as
 * sensitive as a database backup, because it is one. Delete it once the import
 * is confirmed, and do not commit it — .gitignore already covers the name.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

/**
 * The `pg` driver, borrowed from the AI reports backend.
 *
 * Not a dependency of the site — the site has no build step and no
 * package.json — so it is looked for where it already exists rather than
 * introducing one for a script that runs once.
 */
function loadPg() {
  try {
    return require(path.join(REPO, 'server', 'node_modules', 'pg'));
  } catch (e) { /* try the ambient one */ }
  try {
    return require('pg');
  } catch (e) {
    console.error(
      'The `pg` driver is not installed.\n'
      + 'Run this first:\n\n'
      + '    cd ' + path.join(REPO, 'server') + ' && npm install\n');
    process.exit(1);
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * Ask for a column that may not be there.
 *
 * `place` was added to the project record after the Supabase table was created
 * and the app carried a fallback for its absence for exactly that reason. A
 * SELECT naming a missing column fails entirely, so a migration that assumed
 * it would export nothing at all rather than exporting rows without one field.
 */
async function selectWithOptional(client, base, optional, tail) {
  try {
    return await client.query('select ' + base + ', ' + optional.join(', ') + ' ' + tail);
  } catch (e) {
    if (!/column .* does not exist/i.test(String(e && e.message))) throw e;
    console.warn('  (no `place` column in this database — exporting without it)');
    return await client.query('select ' + base + ' ' + tail);
  }
}

(async () => {
  const dsn = arg('dsn', process.env.SUPABASE_DB_URL || '');
  if (!dsn) {
    console.error('No connection string. Pass --dsn "postgresql://…" or set SUPABASE_DB_URL.\n'
      + 'Supabase → Project Settings → Database → Connection string → Session pooler.');
    process.exit(1);
  }

  const { Client } = loadPg();
  const client = new Client({
    connectionString: dsn,
    // Supabase's pooler presents a certificate rooted in its own CA, which
    // Node correctly rejects against its built-in roots. The connection is
    // still encrypted; only the server's identity is unverified, for the
    // minutes this script runs. See the same reasoning, at length, in
    // server/src/lib/db.js.
    ssl: { rejectUnauthorized: false },
  });

  console.log('Connecting…');
  await client.connect();

  console.log('Reading accounts…');
  const users = await client.query(`
    select u.id::text                       as id,
           lower(u.email)                   as email,
           u.encrypted_password             as password_hash,
           u.created_at,
           coalesce(p.full_name, '')        as full_name,
           coalesce(p.avatar_url, '')       as avatar_url
      from auth.users u
      left join public.profiles p on p.id = u.id
     where u.email is not null
     order by u.created_at`);

  console.log('Reading maps…');
  const projects = await selectWithOptional(client,
    `id::text as id, owner_id::text as owner_id, name, data,
     n_locations, n_sites, n_routes, n_shapes, bytes, created_at, updated_at`,
    ['coalesce(place, \'\') as place'],
    'from public.map_projects order by created_at');

  await client.end();

  const out = {
    exportedAt: new Date().toISOString(),
    source: 'supabase',
    users: users.rows.map(r => ({
      id: r.id,
      email: r.email,
      // May be null for an account that only ever signed in with Microsoft.
      // Imported as null, which api/lib/auth.php refuses every password
      // against — those people set one through the reset link.
      passwordHash: r.password_hash || null,
      fullName: r.full_name || '',
      avatarUrl: r.avatar_url || '',
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    })),
    projects: projects.rows.map(r => ({
      id: r.id,
      ownerId: r.owner_id,
      name: r.name || 'Untitled map project',
      place: r.place || '',
      // jsonb arrives from `pg` already parsed. It is re-serialised on import
      // by PHP, so what lands in MySQL is this object, not Postgres's
      // formatting of it.
      data: r.data == null ? null : r.data,
      counts: {
        locations: r.n_locations || 0,
        sites: r.n_sites || 0,
        routes: r.n_routes || 0,
        shapes: r.n_shapes || 0,
      },
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    })),
  };

  const file = arg('out', path.join(REPO, 'map-studio-export.json'));
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  const withPw = out.users.filter(u => u.passwordHash).length;
  const bytes = fs.statSync(file).size;

  console.log('');
  console.log('Wrote ' + file);
  console.log('  ' + out.users.length + ' accounts (' + withPw + ' with a password that will carry over, '
    + (out.users.length - withPw) + ' who will need the reset link)');
  console.log('  ' + out.projects.length + ' maps');
  console.log('  ' + (bytes / (1024 * 1024)).toFixed(1) + ' MB');
  console.log('');
  console.log('This file contains password hashes and every map. Treat it as a database backup:');
  console.log('upload it, import it, confirm the site works, then delete it from both machines.');
  console.log('');
  console.log('Next: docs/ACCOUNTS-SETUP.md → "Bringing the Supabase data across".');
})().catch(e => {
  console.error('\nExport failed: ' + (e && e.message));
  if (/self.signed|certificate/i.test(String(e && e.message))) {
    console.error('If this is a certificate complaint, the pooler string is the one to use.');
  }
  if (/ENOTFOUND|ETIMEDOUT|ENETUNREACH/i.test(String(e && e.message))) {
    console.error('If this timed out, you are probably on the direct connection string, which is '
      + 'IPv6-only. Use the Session pooler string — its host ends .pooler.supabase.com.');
  }
  process.exit(1);
});
