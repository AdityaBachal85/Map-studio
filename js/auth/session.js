/**
 * auth/session.js — who is using this browser.
 *
 * READ THIS BEFORE TRUSTING IT WITH ANYTHING. This is a *profile*, not
 * security. Map Studio is a static site: every file it serves is public, the
 * projects live in this browser's IndexedDB, and anyone can open the app URL
 * directly or read this code. A sign-in implemented in client-side JavaScript
 * cannot keep anyone out of a static page, and pretending otherwise would be
 * worse than not having one — it invites people to put private work behind a
 * door with no lock.
 *
 * What it is genuinely for, and does well:
 *   - a name and colour to stamp on projects, so a shared machine shows whose
 *     work is whose,
 *   - a stable id to scope projects by, so two people on one laptop don't see
 *     each other's lists,
 *   - the seam real authentication drops into later.
 *
 * THE SEAM. Everything above the store talks to this module, never to
 * localStorage directly. Swapping in Supabase auth means reimplementing the
 * five functions below against supabase.auth — currentUser(), signIn(),
 * signOut(), onChange(), requireSession() — and changing nothing in
 * projects.html, login.html, or projectStore.js. That is the whole reason the
 * indirection exists; see docs/AI-REPORTS-SETUP.md for the pattern this
 * mirrors on the server side.
 */

const SESSION_KEY = 'dbot.session.v1';

/** Avatar colours, picked to stay legible against both themes. */
const SESSION_COLORS = ['#FF7A1A', '#2E9BFF', '#12B886', '#F0563A', '#845EF7', '#F59F00', '#E64980', '#0CA678'];

/**
 * A deterministic colour per identity, so the same person keeps the same
 * avatar across sessions and devices without storing a preference.
 * @param {string} seed @returns {string} hex
 */
function sessionColorFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return SESSION_COLORS[h % SESSION_COLORS.length];
}

/**
 * Up to two letters, from a display name or an email's local part.
 * @param {string} name @returns {string}
 */
function sessionInitials(name) {
  const parts = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * @returns {{id:string,name:string,email:string,initials:string,color:string,since:number}|null}
 */
function currentUser() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    // A hand-edited or half-written record should log you out, not throw on
    // every page load forever.
    return (u && u.id && u.name) ? u : null;
  } catch (e) {
    return null;
  }
}

/**
 * Start a session. No password is checked, because there is nothing here that
 * checking one would protect — see the file header.
 *
 * @param {{name:string, email?:string}} who
 * @returns {object} the stored profile
 */
function signIn(who) {
  const name = String(who.name || '').trim();
  if (!name) throw new Error('A name is required.');
  const email = String(who.email || '').trim().toLowerCase();

  // Identity keys off the email when there is one, so signing in again on the
  // same machine returns to the same projects rather than starting an empty
  // list. Without an email, the name serves.
  const seed = email || name.toLowerCase();
  const existing = currentUser();
  const user = {
    id: 'u_' + sessionHash(seed),
    name,
    email,
    initials: sessionInitials(name || email),
    color: sessionColorFor(seed),
    since: (existing && existing.id === 'u_' + sessionHash(seed)) ? existing.since : Date.now(),
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  return user;
}

/** End the session. Projects are left on disk — signing out is not deleting. */
function signOut() {
  localStorage.removeItem(SESSION_KEY);
}

/**
 * Send anyone without a session to the sign-in page, remembering where they
 * were headed so they land there afterwards rather than at a generic home.
 * @param {string} [loginUrl]
 * @returns {object|null} the session, or null if a redirect was issued
 */
function requireSession(loginUrl) {
  const u = currentUser();
  if (u) return u;
  const back = encodeURIComponent(location.pathname.split('/').pop() + location.search);
  location.replace((loginUrl || 'login.html') + '?next=' + back);
  return null;
}

/**
 * React to sign-in/out in *other* tabs. The storage event does not fire in the
 * tab that made the change, which is what makes it right for this: the tab
 * that signed out already knows.
 * @param {function(object|null): void} fn
 */
function onSessionChange(fn) {
  window.addEventListener('storage', e => {
    if (e.key === SESSION_KEY) fn(currentUser());
  });
}

/** @param {string} s @returns {string} short stable hex digest (FNV-1a) */
function sessionHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
