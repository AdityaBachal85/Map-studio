/**
 * projects/projectBridge.js — the studio's half of the projects page.
 *
 * projects.html hands over by navigating to index.html?project=<id>. This
 * module is what makes that mean something: it loads that project into the
 * map on boot, and keeps writing it back as the work changes, so returning to
 * the list shows the real state rather than whatever was there when it opened.
 *
 * WHY IT WRITES THROUGH AUTOSAVE RATHER THAN ON A TIMER OF ITS OWN.
 * autosave.js already decides when the document has meaningfully changed — it
 * hashes the serialised project and skips identical ticks. Running a second
 * timer beside it would double the serialisation cost of the largest object in
 * the app and still be less accurate. So this wraps autosaveNow() and rides
 * its decision: whenever autosave concludes there is something new to keep,
 * this keeps it in the project record too.
 *
 * WHY THE WRAPPER AND NOT AN EDIT TO autosave.js. That file is the one thing
 * standing between a user and lost work, and it is correct as written. Adding
 * a second storage target inside it would put project-list concerns into the
 * crash-safety path. The wrapper composes instead: if this file is absent, or
 * throws, autosave behaves exactly as it always did.
 */

const PROJECT_ACTIVE_KEY = 'dbot.activeProject';

let _pbActiveId = null;
let _pbName = '';

/**
 * The project this session is editing, if any.
 *
 * The URL wins over the stored value, so opening a second project in a new tab
 * does not quietly retarget the first. The stored value is the fallback for a
 * plain reload, where the query string is often gone.
 *
 * @returns {string|null}
 */
function projectBridgeActiveId() {
  if (_pbActiveId) return _pbActiveId;
  const fromUrl = new URLSearchParams(location.search).get('project');
  if (fromUrl) return fromUrl;
  try { return localStorage.getItem(PROJECT_ACTIVE_KEY) || null; }
  catch (e) { return null; }
}

/**
 * Load the active project into the map. Called before initAutosave(), which
 * skips its own restore when this has claimed the session — otherwise the last
 * session's map would land on top of the project just opened.
 *
 * @returns {Promise<boolean>} whether a project was applied
 */
async function projectBridgeBoot() {
  // Resolve the account first — before deciding anything. Which store holds a
  // project depends on whether anyone is signed in, and asking earlier would
  // read the local store for a project that lives in the cloud.
  if (typeof sessionInit === 'function') {
    try { await sessionInit(); } catch (e) { /* falls back to the local store */ }
  }

  if (projectBridgeGuard()) return false;   // redirecting to sign in

  const id = projectBridgeActiveId();
  if (!id || typeof projectsLoad !== 'function') {
    // No project, but possibly a signed-in person — who still needs to see
    // whose account this is and how to leave it.
    projectBridgeMarkUi();
    return false;
  }

  let payload = null, meta = null;
  try {
    payload = await projectsLoad(id);
    meta = await projectsMeta(id);
  } catch (e) {
    // Storage refused. Fall through to autosave's normal restore rather than
    // starting the user at a blank map with no explanation.
    console.warn('Project bridge: could not read project —', e && e.message);
    return false;
  }

  if (!payload || !meta) {
    // The id points at nothing: deleted in another tab, or a stale link.
    try { localStorage.removeItem(PROJECT_ACTIVE_KEY); } catch (e) { /* ignore */ }
    if (typeof status === 'function') {
      status('That project could not be found — it may have been deleted. Showing your last session instead.', true);
    }
    return false;
  }

  _pbActiveId = id;
  _pbName = meta.name;

  try {
    applyProject(payload, { silent: true });
  } catch (e) {
    console.warn('Project bridge: applyProject failed —', e && e.message);
    if (typeof status === 'function') status('“' + meta.name + '” could not be opened — the file may be damaged.', true);
    return false;
  }

  document.title = meta.name + ' · DBOT Map Studio';
  projectBridgeMarkUi();
  if (typeof status === 'function') status('Opened “' + meta.name + '”.');
  return true;
}

/**
 * Send anyone without an account to the sign-in page.
 *
 * WHAT THIS DOES AND DOES NOT ACHIEVE, because the difference matters and is
 * easy to get wrong. It stops the studio opening for someone who is not signed
 * in — typing the URL directly, or following a link. It does NOT make the page
 * secret: this is a static site, so index.html, every script and the styles are
 * public files that anyone can fetch, and someone determined can read them or
 * turn off JavaScript and see an empty map.
 *
 * That distinction is fine, because the map is not the asset — the projects
 * are. Those live in Postgres behind Row Level Security, and no amount of
 * disabling JavaScript produces a token that lets someone read them. Skipping
 * this guard gets you a blank studio with an empty project list, not anyone's
 * work.
 *
 * Only applies when accounts are actually configured. With SUPABASE_ANON_KEY
 * empty the app is a local tool with no accounts to check, and redirecting
 * would lock people out of their own browser.
 *
 * @returns {boolean} whether a redirect was issued
 */
function projectBridgeGuard() {
  if (typeof authMode !== 'function' || authMode() !== 'supabase') return false;
  if (typeof currentUser === 'function' && currentUser()) return false;

  // authSignInUrl() decides whether this page is worth coming back to. A bare
  // index.html is not: signing in belongs at the project list, not in the studio
  // with whatever autosave last restored. A ?project= link still returns here.
  location.replace(vlink(authSignInUrl('login.html')));
  return true;
}

/**
 * Whether this session is editing a named project, so autosave.js knows to
 * skip its own restore. Answers false until projectBridgeBoot() has actually
 * applied one — a project that failed to load must fall back to the normal
 * restore, not to a blank map.
 * @returns {boolean}
 */
function projectBridgeClaimed() { return !!_pbActiveId; }

/**
 * Put the project's name and a way back into the header, so it is obvious
 * which document is on screen and how to leave it. Without this the studio
 * looks identical whichever project is open, which is how people overwrite
 * the wrong one.
 */
function projectBridgeMarkUi() {
  // Inside the existing header block, not above it. Inserted at the top of the
  // sidebar this read as a detached strip pinned over the product name — the
  // page's first line was navigation chrome rather than the app. The brandbar
  // already owns identity and already carries the divider below it, so both of
  // these belong within it.
  const brandbar = document.querySelector('.sidebar .brandbar');
  if (!brandbar || document.getElementById('pbBar')) return;

  const user = typeof currentUser === 'function' ? currentUser() : null;
  if (!_pbActiveId && !user) return;   // nothing to say on either count

  // The account control sits beside the preferences gear, which is absolutely
  // positioned in the brandbar's top-right. Two round controls in a row reads
  // as a toolbar; one below the other would read as an accident.
  if (user) {
    const av = document.createElement('button');
    av.id = 'pbAvatar';
    av.className = 'pb-avatar';
    av.type = 'button';
    av.setAttribute('aria-haspopup', 'menu');
    av.textContent = user.initials;
    av.style.background = user.color;
    av.title = user.name + ' — account';
    av.setAttribute('aria-label', 'Account menu for ' + user.name);
    av.addEventListener('click', e => { e.stopPropagation(); projectBridgeAccountMenu(av, user); });
    brandbar.appendChild(av);
  }

  if (!_pbActiveId) return;   // signed in, but not editing a named project

  const bar = document.createElement('div');
  bar.id = 'pbBar';
  bar.className = 'pb-bar';
  bar.innerHTML = `
    <a class="pb-back" href="./projects.html" data-vlink title="Back to all projects">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6"
        stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      Projects
    </a>
    <span class="pb-sep">/</span>
    <span class="pb-name" id="pbName"></span>`;
  // textContent, not markup — a project name is outside text going into the
  // page on every boot.
  bar.querySelector('#pbName').textContent = _pbName || '';
  bar.querySelector('#pbName').title = _pbName || '';
  const back = bar.querySelector('[data-vlink]');
  if (back) back.setAttribute('href', vlink(back.getAttribute('href')));
  brandbar.appendChild(bar);
}

/**
 * The studio's account menu. Same contents as the projects page's, because
 * being signed in somewhere with no way to see who you are or to leave is the
 * complaint that produced both.
 *
 * @param {HTMLElement} anchor @param {object} user
 */
function projectBridgeAccountMenu(anchor, user) {
  const existing = document.getElementById('pbAcctMenu');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'pbAcctMenu';
  menu.className = 'pb-acct-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <div class="pb-acct-head"><div class="nm"></div><div class="em"></div></div>
    <button type="button" role="menuitem" data-act="projects">All projects</button>
    <button type="button" role="menuitem" data-act="signout" class="danger">Sign out</button>`;
  menu.querySelector('.nm').textContent = user.name;
  menu.querySelector('.em').textContent = user.email || '';

  anchor.parentElement.appendChild(menu);
  menu.querySelector('button').focus();

  menu.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    e.stopPropagation();
    menu.remove();
    if (b.dataset.act === 'projects') { location.href = vlink('./projects.html'); return; }
    if (b.dataset.act === 'signout') {
      // Get whatever is on screen into the project before leaving, or the last
      // few seconds of work go with the session.
      try { if (typeof autosaveNow === 'function') await autosaveNow({ force: true, reason: 'sign-out' }); }
      catch (err) { /* saving is best effort; signing out must still happen */ }
      if (typeof signOut === 'function') await signOut();
      location.replace(vlink('login.html'));
    }
  });

  const close = () => { const m = document.getElementById('pbAcctMenu'); if (m) m.remove(); };
  document.addEventListener('click', close, { once: true });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); }, { once: true });
}

/**
 * Persist the current map into the active project record.
 * @returns {Promise<void>}
 */
async function projectBridgeSave() {
  if (!_pbActiveId || typeof projectsSave !== 'function') return;
  try {
    const meta = await projectsMeta(_pbActiveId);
    if (!meta) { _pbActiveId = null; return; }   // deleted elsewhere; stop writing
    await projectsSave({
      id: _pbActiveId,
      name: meta.name,
      ownerId: meta.ownerId,
      ownerName: meta.ownerName,
      project: serialiseProject(),
    });
  } catch (e) {
    console.warn('Project bridge: save failed —', e && e.message);
  }
}

/**
 * Ride autosave's change detection. Installed once, at load.
 */
(function wrapAutosave() {
  if (typeof autosaveNow !== 'function') return;
  const original = autosaveNow;
  // eslint-disable-next-line no-global-assign
  autosaveNow = async function projectAwareAutosaveNow(opts) {
    const result = await original.apply(this, arguments);
    // Only mirror when autosave actually wrote — it returns falsy for an
    // unchanged document, and copying an unchanged map into the project record
    // would bump its "last modified" on a timer and make the list lie.
    if (result && _pbActiveId) await projectBridgeSave();
    return result;
  };
})();
