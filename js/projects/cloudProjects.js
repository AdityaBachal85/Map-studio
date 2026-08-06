/**
 * projects/cloudProjects.js — projects stored in Supabase.
 *
 * The Supabase half of projectStore.js. Same function shapes, same returned
 * record shape, so the page cannot tell which one answered — see the
 * dispatcher at the bottom of projectStore.js.
 *
 * NO OWNERSHIP CHECK APPEARS IN THIS FILE, deliberately. Every query below
 * omits `where owner_id = me`, because the Row Level Security policies in
 * sql/supabase-auth.sql already apply it inside Postgres, on every row, using
 * the id proven by the signed token. Repeating it here would suggest the
 * filter is the client's job. It is not, and could not be: this code runs on a
 * machine the user controls. If a query here ever returns someone else's row,
 * the bug is a missing policy, not a missing WHERE clause.
 *
 * `data` (the serialised map) is fetched only when a project is opened. The
 * list reads the summary columns instead — see the note in the SQL about why
 * they are denormalised.
 */

/** Columns the list needs. Never includes `data`. */
const CLOUD_META_COLS = 'id,name,owner_id,n_locations,n_sites,n_routes,n_shapes,bytes,created_at,updated_at';

/**
 * Present a database row the way the local store presents its records, so the
 * page's formatting code has one shape to deal with.
 * @param {object} r @param {object} [user]
 * @returns {object}
 */
function cloudRowToMeta(r, user) {
  return {
    id: r.id,
    name: r.name,
    ownerId: r.owner_id,
    ownerName: (user && user.id === r.owner_id) ? user.name : '',
    created: r.created_at ? Date.parse(r.created_at) : 0,
    modified: r.updated_at ? Date.parse(r.updated_at) : 0,
    counts: {
      locations: r.n_locations || 0,
      sites: r.n_sites || 0,
      routes: r.n_routes || 0,
      shapes: r.n_shapes || 0,
    },
    bytes: r.bytes || 0,
    remote: true,
  };
}

/**
 * Turn a PostgREST error into something worth reading.
 *
 * The two that actually happen are worth naming: a violated RLS policy comes
 * back as 42501, which almost always means the SQL was never run; and a
 * missing table as 42P01, same cause. Both otherwise surface as jargon.
 *
 * @param {object} error @returns {Error}
 */
function cloudError(error) {
  const code = error && error.code;
  if (code === '42P01') {
    return new Error('The map_projects table does not exist yet — run sql/supabase-auth.sql '
      + 'in the Supabase SQL editor.');
  }
  if (code === '42501') {
    return new Error('The database refused that write. Its row-level security policies are '
      + 'missing or wrong — re-run sql/supabase-auth.sql.');
  }
  return new Error((error && error.message) || 'The database could not be reached.');
}

/**
 * @param {string} ownerId — unused; RLS scopes the query. Accepted so the
 *   signature matches the local store.
 * @returns {Promise<object[]>}
 */
async function cloudProjectsList(ownerId) {
  const sb = sessionClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('map_projects')
    .select(CLOUD_META_COLS)
    .order('updated_at', { ascending: false });
  if (error) throw cloudError(error);
  const user = currentUser();
  return (data || []).map(r => cloudRowToMeta(r, user));
}

/** @param {string} id @returns {Promise<object|null>} */
async function cloudProjectsMeta(id) {
  const sb = sessionClient();
  if (!sb) return null;
  const { data, error } = await sb.from('map_projects').select(CLOUD_META_COLS).eq('id', id).maybeSingle();
  if (error) throw cloudError(error);
  return data ? cloudRowToMeta(data, currentUser()) : null;
}

/** @param {string} id @returns {Promise<object|null>} the serialised map */
async function cloudProjectsLoad(id) {
  const sb = sessionClient();
  if (!sb) return null;
  const { data, error } = await sb.from('map_projects').select('data').eq('id', id).maybeSingle();
  if (error) throw cloudError(error);
  return data ? data.data : null;
}

/**
 * Create or update. `owner_id` is set from the signed-in user rather than
 * accepted from the caller — the insert policy would reject anything else, and
 * failing here with a clear message beats a policy violation.
 *
 * @param {{id?:string, name:string, project:object}} rec
 * @returns {Promise<object|null>}
 */
async function cloudProjectsSave(rec) {
  const sb = sessionClient();
  const user = currentUser();
  if (!sb || !user) return null;

  const project = rec.project || {};
  const counts = projectsCounts(project);
  const row = {
    owner_id: user.id,
    name: String(rec.name || 'Untitled map project').trim() || 'Untitled map project',
    data: project,
    n_locations: counts.locations,
    n_sites: counts.sites,
    n_routes: counts.routes,
    n_shapes: counts.shapes,
    bytes: JSON.stringify(project).length,
  };
  if (rec.id) row.id = rec.id;

  // upsert rather than insert-or-update: one round trip, and no window where a
  // concurrent write could turn the update into a duplicate insert.
  const { data, error } = await sb.from('map_projects').upsert(row).select(CLOUD_META_COLS).single();
  if (error) throw cloudError(error);
  return cloudRowToMeta(data, user);
}

/** @param {string} id @param {string} name @returns {Promise<boolean>} */
async function cloudProjectsRename(id, name) {
  const sb = sessionClient();
  if (!sb) return false;
  const clean = String(name || '').trim();
  if (!clean) return false;
  const { error } = await sb.from('map_projects').update({ name: clean }).eq('id', id);
  if (error) throw cloudError(error);
  return true;
}

/** @param {string} id @returns {Promise<boolean>} */
async function cloudProjectsDelete(id) {
  const sb = sessionClient();
  if (!sb) return false;
  const { error } = await sb.from('map_projects').delete().eq('id', id);
  if (error) throw cloudError(error);
  return true;
}

/** @param {string} id @returns {Promise<object|null>} */
async function cloudProjectsDuplicate(id) {
  const meta = await cloudProjectsMeta(id);
  const payload = await cloudProjectsLoad(id);
  if (!meta || !payload) return null;
  return await cloudProjectsSave({ name: meta.name + ' (copy)', project: payload });
}

/**
 * @returns {Promise<{bytes:number, count:number, quota:number|null}>}
 *   quota is null: Supabase's 500 MB free-tier limit covers the whole database
 *   including other tables, so a per-user figure would be invented.
 */
async function cloudProjectsStorage() {
  const list = await cloudProjectsList();
  return { bytes: list.reduce((n, p) => n + (p.bytes || 0), 0), count: list.length, quota: null };
}

/**
 * Copy every local project into the account, once, the first time someone
 * signs in on a machine that already has work on it.
 *
 * WHY IT COPIES RATHER THAN MOVES. If the upload half-fails, or the account
 * turns out to be the wrong one, the originals are still there. Local projects
 * are left untouched and simply stop being listed once cloud mode is on; they
 * are recoverable by clearing SUPABASE_ANON_KEY, which is a far better
 * position than "your maps were on the way to the server when it failed".
 *
 * @returns {Promise<{migrated:number, failed:number, skipped:boolean}>}
 */
async function cloudMigrateLocalProjects() {
  const user = currentUser();
  if (!user) return { migrated: 0, failed: 0, skipped: true };

  const flag = 'dbot.migrated.' + user.id;
  try { if (localStorage.getItem(flag)) return { migrated: 0, failed: 0, skipped: true }; }
  catch (e) { /* storage unavailable; attempt anyway */ }

  // Local records are keyed by the local-mode id, which no longer matches the
  // Supabase one, so everything on this device is offered rather than only
  // rows that happen to carry the new id.
  let local = [];
  try { local = await localProjectsList(null); }
  catch (e) { return { migrated: 0, failed: 0, skipped: true }; }
  if (!local.length) {
    try { localStorage.setItem(flag, String(Date.now())); } catch (e) { /* ignore */ }
    return { migrated: 0, failed: 0, skipped: false };
  }

  let migrated = 0, failed = 0;
  for (const meta of local) {
    try {
      const payload = await localProjectsLoad(meta.id);
      if (!payload) { failed++; continue; }
      // No id passed: these get fresh cloud ids rather than colliding with a
      // uuid column that would reject the local 'p_…' format anyway.
      await cloudProjectsSave({ name: meta.name, project: payload });
      migrated++;
    } catch (e) {
      failed++;
    }
  }
  // Marked done even with failures, so a permanent problem does not re-upload
  // the successes on every load. The count is reported to the user instead.
  try { localStorage.setItem(flag, String(Date.now())); } catch (e) { /* ignore */ }
  return { migrated, failed, skipped: false };
}
