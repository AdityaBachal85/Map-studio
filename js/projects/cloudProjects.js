/**
 * projects/cloudProjects.js — projects stored in this site's own database.
 *
 * The server half of projectStore.js. Same function shapes, same returned
 * record shape, so the page cannot tell which one answered — see the
 * dispatcher at the bottom of projectStore.js.
 *
 * ---------------------------------------------------------------------------
 * THE OWNERSHIP CHECK MOVED, AND THIS FILE IS NOT WHERE IT LANDED
 *
 * The Supabase version of this file opened with a note saying that no
 * ownership check appeared in it, deliberately: Row Level Security policies
 * inside Postgres applied one to every row, and a query here that returned
 * somebody else's project would have been a missing policy rather than a
 * missing WHERE clause.
 *
 * Half of that is still true and the important half has reversed. The check is
 * still not here — it could not be, since this code runs on a machine the user
 * controls, and anything it enforced could be edited out with the developer
 * tools. What changed is where it went: api/routes/projects.php now takes the
 * owner from the session cookie and puts it in every query, and that file is
 * the one to read, and the one diagnostics/accounts-api.cjs attacks, if the
 * question is ever "could someone else see this".
 *
 * What this file does instead is speak to that API honestly: it sends the
 * project id and nothing about whose it is, and it reports what comes back.
 *
 * `data` (the serialised map) is fetched only when a project is opened. The
 * list reads the summary columns instead — see the note in
 * sql/hostinger-mysql.sql about why they are denormalised.
 */

/**
 * Fill in the two fields the server has no business deciding.
 *
 * `ownerName` is the signed-in person's own name: the server knows the owner's
 * id, and there is exactly one account whose name this browser is entitled to
 * display. `remote` tells the list page which store a row came from.
 *
 * @param {object} m @param {object} [user]
 * @returns {object}
 */
function cloudRowToMeta(m, user) {
  return Object.assign({}, m, {
    ownerName: (user && user.id === m.ownerId) ? user.name : '',
    remote: true,
  });
}

/**
 * Turn an API failure into something worth reading.
 *
 * The messages themselves come from PHP, which writes them for the person who
 * will see them. Two cases are worth recognising by code rather than passing
 * through, because both mean "the install is not finished" and neither is
 * obvious from its wording alone.
 *
 * @param {Error} e @returns {Error}
 */
function cloudError(e) {
  if (e && e.code === 'db_unreachable') {
    return new Error('The database is not reachable. Check the credentials in the API config '
      + 'against hPanel → Databases — see docs/ACCOUNTS-SETUP.md.');
  }
  if (e && e.status === 404 && /table/i.test(String(e.message))) {
    return new Error('The project tables do not exist yet — run sql/hostinger-mysql.sql '
      + 'in phpMyAdmin.');
  }
  return e instanceof Error ? e : new Error(String((e && e.message) || e));
}

/**
 * @param {string} ownerId — unused; the session decides whose rows come back.
 *   Accepted so the signature matches the local store.
 * @returns {Promise<object[]>}
 */
async function cloudProjectsList(ownerId) {
  if (!accountsConfigured()) return [];
  try {
    const data = await apiCall('GET', '/projects');
    const user = currentUser();
    return (data.projects || []).map(m => cloudRowToMeta(m, user));
  } catch (e) {
    throw cloudError(e);
  }
}

/** @param {string} id @returns {Promise<object|null>} */
async function cloudProjectsMeta(id) {
  if (!accountsConfigured()) return null;
  try {
    const data = await apiCall('GET', '/projects/' + encodeURIComponent(id) + '/meta');
    return data.project ? cloudRowToMeta(data.project, currentUser()) : null;
  } catch (e) {
    // A project that is not there is an answer, not a failure — the caller
    // decides what to do about it, exactly as the local store's null does.
    if (e && e.status === 404) return null;
    throw cloudError(e);
  }
}

/** @param {string} id @returns {Promise<object|null>} the serialised map */
async function cloudProjectsLoad(id) {
  if (!accountsConfigured()) return null;
  try {
    const data = await apiCall('GET', '/projects/' + encodeURIComponent(id));
    return data.data == null ? null : data.data;
  } catch (e) {
    if (e && e.status === 404) return null;
    throw cloudError(e);
  }
}

/**
 * Create or update.
 *
 * The owner is not sent. It is taken from the session on the server, which is
 * the only place it could be trusted from — a browser that could name the
 * owner could name somebody else's.
 *
 * @param {{id?:string, name:string, place?:string, project:object}} rec
 * @returns {Promise<object|null>}
 */
async function cloudProjectsSave(rec) {
  if (!accountsConfigured() || !currentUser()) return null;

  const project = rec.project || {};
  const body = {
    name: String(rec.name || 'Untitled map project').trim() || 'Untitled map project',
    project,
    // Display figures for the list row. The server clamps them and measures
    // `bytes` itself — see the note in api/routes/projects.php on why that one
    // is not accepted from here.
    counts: projectsCounts(project),
  };
  if (rec.id) body.id = rec.id;
  if (rec.place != null) body.place = String(rec.place).trim();

  try {
    const data = await apiCall('POST', '/projects', body);
    return cloudRowToMeta(data.project, currentUser());
  } catch (e) {
    if (e && e.code === 'too_large') {
      throw new Error(e.message + ' Remove some imported geometry, or split the map in two.');
    }
    throw cloudError(e);
  }
}

/** @param {string} id @param {string} name @param {string} [place] @returns {Promise<boolean>} */
async function cloudProjectsRename(id, name, place) {
  if (!accountsConfigured()) return false;
  const clean = String(name || '').trim();
  if (!clean) return false;
  const body = { name: clean };
  if (place !== undefined) body.place = String(place || '').trim();
  try {
    await apiCall('PATCH', '/projects/' + encodeURIComponent(id), body);
    return true;
  } catch (e) {
    throw cloudError(e);
  }
}

/** @param {string} id @returns {Promise<boolean>} */
async function cloudProjectsDelete(id) {
  if (!accountsConfigured()) return false;
  try {
    await apiCall('DELETE', '/projects/' + encodeURIComponent(id));
    return true;
  } catch (e) {
    throw cloudError(e);
  }
}

/**
 * Copy a project.
 *
 * One request, and the map never leaves the server — the old version fetched
 * the whole thing into the browser and posted it straight back, which for a
 * large map meant several megabytes each way to produce a row the database
 * could have copied in place.
 *
 * @param {string} id @returns {Promise<object|null>}
 */
async function cloudProjectsDuplicate(id) {
  if (!accountsConfigured()) return null;
  try {
    const data = await apiCall('POST', '/projects/' + encodeURIComponent(id) + '/duplicate');
    return cloudRowToMeta(data.project, currentUser());
  } catch (e) {
    if (e && e.status === 404) return null;
    throw cloudError(e);
  }
}

/**
 * @returns {Promise<{bytes:number, count:number, quota:number|null}>}
 *   quota is null: a shared plan's disk allowance covers the whole site, so a
 *   per-account figure derived from it would be invented.
 */
async function cloudProjectsStorage() {
  if (!accountsConfigured()) return { bytes: 0, count: 0, quota: null };
  try {
    const data = await apiCall('GET', '/projects/storage');
    return { bytes: data.bytes || 0, count: data.count || 0, quota: data.quota == null ? null : data.quota };
  } catch (e) {
    throw cloudError(e);
  }
}

/**
 * Copy every local project into the account, once, the first time someone
 * signs in on a machine that already has work on it.
 *
 * WHY IT COPIES RATHER THAN MOVES. If the upload half-fails, or the account
 * turns out to be the wrong one, the originals are still there. Local projects
 * are left untouched and simply stop being listed once server mode is on; they
 * are recoverable by clearing ACCOUNTS_API_BASE, which is a far better
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
  // server one, so everything on this device is offered rather than only rows
  // that happen to carry the new id.
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
      // No id passed: these get fresh server ids rather than carrying a local
      // 'p_…' key into a table whose other rows are uuids.
      await cloudProjectsSave({ name: meta.name, place: meta.place, project: payload });
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
