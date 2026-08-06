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
  const id = projectBridgeActiveId();
  if (!id || typeof projectsLoad !== 'function') return false;

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
  if (!_pbActiveId) return;
  const host = document.querySelector('.brand-line, .sidebar .brand, .sidebar');
  if (!host || document.getElementById('pbBar')) return;

  const bar = document.createElement('div');
  bar.id = 'pbBar';
  bar.className = 'pb-bar';
  bar.innerHTML = `
    <a class="pb-back" href="./projects.html" title="All projects">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4"
        stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      Projects
    </a>
    <span class="pb-name" id="pbName"></span>`;
  // textContent, not markup — a project name is user input and goes in the
  // page every boot.
  bar.querySelector('#pbName').textContent = _pbName;
  host.insertBefore(bar, host.firstChild);
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
