/**
 * admin/adminPage.js — the People page.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE DECIDES ANYTHING
 *
 * Every rule this page appears to enforce — you cannot demote yourself, you
 * cannot remove the last administrator, deleting takes the maps with it — is
 * enforced in api/routes/admin.php, and that file is the one to read if the
 * question is ever whether a rule holds. What this page does is arrange for
 * those refusals to be rare: it greys out the controls that would fail, says
 * why, and asks for confirmation where the consequence is permanent.
 *
 * The distinction matters because the page itself is not a gate. It is fetched
 * by the browser and can be edited in the browser, so a control it hides is a
 * control somebody can unhide. The server checks the role again on every
 * request, which is why the page can afford to be helpful rather than
 * defensive.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PASSWORD IS SHOWN ONCE AND NOT EMAILED
 *
 * Emailing it would be the tidier flow and needs outbound mail to work, which
 * on a fresh Hostinger install it does not — the mailbox has not been created,
 * the domain's DNS has not propagated. An administrator who cannot add anybody
 * until the mail is fixed is an administrator who cannot start.
 *
 * So the password is handed to the person adding the account, to pass on
 * however they normally would, and the account is marked as needing a password
 * of its own at first sign-in. That last part is what makes it acceptable: the
 * credential that travels through a chat application stops working the moment
 * it is used.
 */

const $ = id => document.getElementById(id);

/** Everyone, as the last load saw them. Re-fetched after every change. */
let PEOPLE = [];
let SIGNUP_OPEN = false;
let EMAIL_DOMAIN = '';
let FILTER = '';

/* ---------------------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------------------ */

/** @param {number|null} ms @returns {string} */
function when(ms) {
  if (!ms) return 'never';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** @param {number} n @returns {string} */
function bytes(n) {
  if (!n) return '—';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

/**
 * Escape text bound for innerHTML.
 *
 * Every string on this page — a name, an address — was typed by somebody, and
 * the one page in this application that lists what other people typed is the
 * last place to be casual about it.
 *
 * @param {*} s @returns {string}
 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fail(msg) {
  $('adError').textContent = msg;
  $('adError').hidden = false;
  $('adError').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function clearError() { $('adError').hidden = true; }

/* ---------------------------------------------------------------------------
 * Loading
 * ------------------------------------------------------------------------ */

async function loadPeople() {
  const data = await apiCall('GET', '/admin/users');
  PEOPLE = data.users || [];
  SIGNUP_OPEN = data.signupOpen === true;
  EMAIL_DOMAIN = data.emailDomain || '';
  render();
}

function render() {
  const q = FILTER.trim().toLowerCase();
  const rows = PEOPLE.filter(p => !q
    || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q));

  const active = PEOPLE.filter(p => p.status === 'active').length;
  const admins = PEOPLE.filter(p => p.role === 'admin' && p.status === 'active').length;
  $('adTally').textContent = PEOPLE.length + (PEOPLE.length === 1 ? ' account' : ' accounts')
    + ' · ' + active + ' active · ' + admins + (admins === 1 ? ' administrator' : ' administrators');

  /*
   * The one warning worth interrupting for. With sign-up open, anybody holding
   * a work address can create their own account without being given one — so
   * this page, and the effort of issuing passwords, decides nothing.
   */
  const warn = $('adSignupWarn');
  if (SIGNUP_OPEN) {
    warn.innerHTML = '<strong>Anyone with a ' + esc(EMAIL_DOMAIN || 'permitted')
      + ' address can still create their own account.</strong> '
      + 'Adding people here does not restrict anything until that is switched off: set '
      + '<code>allow_signup</code> to <code>false</code> in the API config file.';
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }

  if (!rows.length) {
    $('adListWrap').innerHTML = '<div class="ad-empty">'
      + (q ? 'Nobody matches “' + esc(FILTER) + '”.' : 'No accounts yet.') + '</div>';
    return;
  }

  $('adListWrap').innerHTML = '<table class="ad-table"><thead><tr>'
    + '<th>Person</th><th>Role</th><th>Maps</th><th>Last signed in</th><th>Added</th>'
    + '<th class="ad-actions-h">Actions</th>'
    + '</tr></thead><tbody>'
    + rows.map(rowHtml).join('')
    + '</tbody></table>';

  $('adListWrap').querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', () => onAction(b.dataset.act, b.dataset.id));
  });
}

/** @param {object} p @returns {string} */
function rowHtml(p) {
  const off = p.status !== 'active';

  const flags = [];
  if (p.mustChangePassword) flags.push('<span class="ad-flag" title="They have not chosen their own '
    + 'password yet — the one they were issued still works">issued password</span>');
  // A Supabase account that only ever used Microsoft. They look entirely
  // normal and cannot sign in, so the list has to say so.
  if (p.noPassword) flags.push('<span class="ad-flag ad-flag-warn" title="Migrated from Microsoft '
    + 'sign-in with no password. Issue one, or they cannot get in">no password</span>');
  if (off) flags.push('<span class="ad-flag ad-flag-off">switched off</span>');

  return '<tr class="' + (off ? 'ad-off' : '') + '">'
    + '<td><div class="ad-who"><div class="ad-nm">' + esc(p.name)
    + (p.isSelf ? ' <span class="ad-you">you</span>' : '') + '</div>'
    + '<div class="ad-em">' + esc(p.email) + '</div>'
    + (flags.length ? '<div class="ad-flags">' + flags.join('') + '</div>' : '')
    + '</div></td>'
    + '<td>' + (p.role === 'admin' ? '<span class="ad-role">Administrator</span>' : 'User') + '</td>'
    + '<td>' + (p.projects || 0) + (p.projects ? ' <span class="ad-sub">' + bytes(p.bytes) + '</span>' : '') + '</td>'
    + '<td>' + when(p.lastSeen) + '</td>'
    + '<td>' + when(p.created) + '</td>'
    + '<td class="ad-actions">' + actionsHtml(p) + '</td>'
    + '</tr>';
}

/**
 * The buttons for one row.
 *
 * Anything the server would refuse is rendered disabled with the reason in its
 * title, rather than offered and then reported as an error. The reasons are
 * the same two the API enforces: not on yourself, and not the last
 * administrator.
 *
 * @param {object} p @returns {string}
 */
function actionsHtml(p) {
  const admins = PEOPLE.filter(x => x.role === 'admin' && x.status === 'active').length;
  const lastAdmin = p.role === 'admin' && p.status === 'active' && admins <= 1;

  const btn = (act, label, disabled, why, cls) =>
    '<button class="ad-btn ' + (cls || '') + '" data-act="' + act + '" data-id="' + esc(p.id) + '"'
    + (disabled ? ' disabled title="' + esc(why) + '"' : (why ? ' title="' + esc(why) + '"' : ''))
    + '>' + label + '</button>';

  const selfWhy = 'You cannot do this to your own account — ask another administrator';
  const lastWhy = 'The only administrator left. Promote somebody else first';

  return [
    btn('password', 'New password', false, 'Issue a new password and show it once'),
    p.role === 'admin'
      ? btn('demote', 'Make a user', p.isSelf || lastAdmin, p.isSelf ? selfWhy : lastAdmin ? lastWhy : '')
      : btn('promote', 'Make admin', false, 'They will be able to add and remove people'),
    p.projects ? btn('move', 'Move maps', false, 'Give their ' + p.projects + ' map(s) to somebody else') : '',
    p.status === 'active'
      ? btn('disable', 'Switch off', p.isSelf || lastAdmin, p.isSelf ? selfWhy : lastAdmin ? lastWhy : 'Stops them signing in; keeps everything')
      : btn('enable', 'Switch on', false, 'Let them sign in again'),
    btn('delete', 'Delete', p.isSelf || lastAdmin, p.isSelf ? selfWhy : lastAdmin ? lastWhy : '', 'ad-btn-danger'),
  ].filter(Boolean).join('');
}

/* ---------------------------------------------------------------------------
 * Actions
 * ------------------------------------------------------------------------ */

async function onAction(act, id) {
  const p = PEOPLE.find(x => x.id === id);
  if (!p) return;
  clearError();

  try {
    if (act === 'promote' || act === 'demote') {
      await apiCall('PATCH', '/admin/users/' + encodeURIComponent(id),
        { role: act === 'promote' ? 'admin' : 'user' });
      await loadPeople();
      return;
    }
    if (act === 'enable' || act === 'disable') {
      if (act === 'disable' && !confirm(
        p.name + ' will be signed out immediately and will not be able to sign in again.\n\n'
        + 'Their ' + (p.projects || 0) + ' map(s) stay exactly where they are.')) return;
      await apiCall('PATCH', '/admin/users/' + encodeURIComponent(id),
        { status: act === 'disable' ? 'disabled' : 'active' });
      await loadPeople();
      return;
    }
    if (act === 'password') {
      if (!confirm('Issue a new password for ' + p.name + '?\n\n'
        + 'Their current one stops working and they will be signed out everywhere.')) return;
      const r = await apiCall('POST', '/admin/users/' + encodeURIComponent(id) + '/password');
      showPassword(p, r.password);
      await loadPeople();
      return;
    }
    if (act === 'move') { openMove(p); return; }
    if (act === 'delete') { openDelete(p); return; }
  } catch (e) {
    fail(e.message || String(e));
  }
}

/* ---- add ---------------------------------------------------------------- */

function openAdd() {
  $('adAddName').value = '';
  $('adAddEmail').value = '';
  $('adAddAdmin').checked = false;
  $('adAddDomainHint').textContent = EMAIL_DOMAIN
    ? 'Must be an address at ' + EMAIL_DOMAIN + '.'
    : 'Any address is allowed on this install.';
  openModal('adAddModal');
  $('adAddName').focus();
}

async function submitAdd() {
  clearError();
  const btn = $('adAddOk');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Creating…';
  try {
    const r = await apiCall('POST', '/admin/users', {
      name: $('adAddName').value,
      email: $('adAddEmail').value,
      role: $('adAddAdmin').checked ? 'admin' : 'user',
    });
    closeModal('adAddModal');
    showPassword({ name: r.user.name, email: r.user.email }, r.password);
    await loadPeople();
  } catch (e) {
    // Inside the dialog, where the field that caused it is: an error reported
    // on the page behind a modal is an error nobody sees.
    alert(e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ---- the password, once ------------------------------------------------- */

function showPassword(who, password) {
  $('adPwWho').textContent = 'For ' + who.name + ' (' + who.email + ')';
  $('adPwValue').textContent = password;
  $('adPwCopy').textContent = 'Copy';
  openModal('adPwModal');
}

async function copyPassword() {
  const text = $('adPwValue').textContent;
  try {
    await navigator.clipboard.writeText(text);
    $('adPwCopy').textContent = 'Copied';
  } catch (e) {
    /*
     * The clipboard API needs a secure context and a permission, and refuses
     * on plain HTTP — which is exactly the state a site is in on the day it is
     * first set up. Selecting the text is the fallback that always works.
     */
    const r = document.createRange();
    r.selectNodeContents($('adPwValue'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    $('adPwCopy').textContent = 'Selected — copy it';
  }
}

/* ---- move maps ---------------------------------------------------------- */

let MOVE_FROM = null;

function openMove(p) {
  MOVE_FROM = p;
  $('adMoveNote').textContent = p.name + ' owns ' + p.projects + ' map(s), '
    + bytes(p.bytes) + ' in total.';
  $('adMoveTo').innerHTML = PEOPLE
    .filter(x => x.id !== p.id && x.status === 'active')
    .map(x => '<option value="' + esc(x.id) + '">' + esc(x.name) + ' — ' + esc(x.email) + '</option>')
    .join('');
  openModal('adMoveModal');
}

async function submitMove() {
  clearError();
  const to = $('adMoveTo').value;
  if (!to || !MOVE_FROM) return;
  try {
    const r = await apiCall('POST', '/admin/users/' + encodeURIComponent(MOVE_FROM.id) + '/transfer',
      { to });
    closeModal('adMoveModal');
    await loadPeople();
    if (r.moved) fail(r.moved + ' map(s) moved to ' + r.to + '.');
  } catch (e) {
    alert(e.message || String(e));
  }
}

/* ---- delete ------------------------------------------------------------- */

let DELETE_TARGET = null;

function openDelete(p) {
  DELETE_TARGET = p;
  $('adDelNote').textContent = 'Delete ' + p.name + ' (' + p.email + ')?';
  if (p.projects) {
    $('adDelMaps').innerHTML = '<strong>' + p.projects + ' map(s) will be deleted with them</strong>'
      + ' — ' + bytes(p.bytes) + ', with no way to get them back. '
      + 'Move the maps to somebody else first if any of them matter.';
    $('adDelMaps').hidden = false;
  } else {
    $('adDelMaps').hidden = true;
  }
  openModal('adDelModal');
}

async function submitDelete() {
  if (!DELETE_TARGET) return;
  clearError();
  try {
    /*
     * The map count is sent back to the server, which refuses if it disagrees.
     * That is what makes this confirmation mean something: it cannot be
     * satisfied by a client that never looked, and it fails safe if the list
     * on screen is out of date because somebody saved a map thirty seconds ago.
     */
    await apiCall('DELETE', '/admin/users/' + encodeURIComponent(DELETE_TARGET.id),
      { expectProjects: DELETE_TARGET.projects || 0 });
    closeModal('adDelModal');
    await loadPeople();
  } catch (e) {
    alert(e.message || String(e));
    closeModal('adDelModal');
    await loadPeople();
  }
}

/* ---- the log ------------------------------------------------------------ */

async function loadLog() {
  try {
    const data = await apiCall('GET', '/admin/log');
    const rows = data.entries || [];
    $('adLog').innerHTML = rows.length
      ? rows.map(e => '<div class="ad-log-row"><span class="t">' + esc(when(e.at)) + '</span> '
        + esc(e.actor) + ' <span class="a">' + esc(e.action) + '</span> '
        + esc(e.target) + (e.detail ? ' <span class="d">— ' + esc(e.detail) + '</span>' : '')
        + '</div>').join('')
      : '<div class="ad-log-row">Nothing yet.</div>';
  } catch (e) {
    $('adLog').textContent = 'Could not read the log: ' + (e.message || e);
  }
}

/* ---------------------------------------------------------------------------
 * Modal plumbing
 *
 * `.pj-modal` hides with `[hidden] { display: none }` and fades in from a
 * keyframe, so clearing `hidden` is genuinely all it takes. Worth stating,
 * because the OTHER modal class in this application — `.modal-overlay`, in the
 * studio — is `opacity: 0` until a class is added, and clearing `hidden` there
 * produces an element that is present, has a size, passes every assertion a
 * test could make about it, and cannot be seen. That shipped once.
 * ------------------------------------------------------------------------ */

function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

/* ---------------------------------------------------------------------------
 * Start
 * ------------------------------------------------------------------------ */

(async function start() {
  applyTheme();
  initFreshness();
  document.querySelectorAll('.dbotLogo').forEach(i => { i.src = 'data:image/png;base64,' + LOGO_B64; });
  $('adVer').textContent = 'v' + APP_VERSION;

  await sessionInit();
  const user = requireSession('login.html');
  if (!user) return;

  /*
   * Not an administrator. Sent back to the project list rather than shown an
   * empty page — the API would refuse every request this page makes, and a
   * screen of error messages is a worse answer to "you are in the wrong place"
   * than simply being in the right one.
   */
  if (!isAdmin()) { location.replace(vlink('projects.html')); return; }

  $('adWhoName').textContent = user.name;
  $('adWhoEmail').textContent = user.email;
  $('adAvatar').textContent = user.initials;
  $('adAvatar').style.background = user.color;

  $('adAvatar').addEventListener('click', async () => {
    await signOut();
    location.href = vlink('login.html');
  });
  $('adTheme').addEventListener('click', () => {
    setPref('theme', effectiveTheme() === 'light' ? 'dark' : 'light');
    applyTheme();
  });

  $('adSearch').addEventListener('input', e => { FILTER = e.target.value; render(); });

  $('adNew').addEventListener('click', openAdd);
  $('adAddCancel').addEventListener('click', () => closeModal('adAddModal'));
  $('adAddOk').addEventListener('click', submitAdd);
  $('adPwCopy').addEventListener('click', copyPassword);
  $('adPwDone').addEventListener('click', () => closeModal('adPwModal'));
  $('adMoveCancel').addEventListener('click', () => closeModal('adMoveModal'));
  $('adMoveOk').addEventListener('click', submitMove);
  $('adDelCancel').addEventListener('click', () => closeModal('adDelModal'));
  $('adDelOk').addEventListener('click', submitDelete);

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    ['adAddModal', 'adPwModal', 'adMoveModal', 'adDelModal'].forEach(id => {
      if (!$(id).hidden) closeModal(id);
    });
  });

  $('adLogBox').addEventListener('toggle', () => { if ($('adLogBox').open) loadLog(); });

  try {
    await loadPeople();
  } catch (e) {
    fail(e.message || String(e));
  }
})();
