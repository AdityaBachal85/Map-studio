/**
 * auth/session.js — who is using this app.
 *
 * TWO MODES, ONE INTERFACE. When ACCOUNTS_API_BASE is set in js/config.js this
 * is real authentication: the API in api/ checks the password, issues a
 * session cookie the browser will not let JavaScript read, and decides on
 * every request what that session is allowed to have. When it is empty it
 * degrades to a local profile kept in this browser — which names you and
 * separates people's project lists on a shared machine, and locks nothing.
 *
 * The rest of the app cannot tell which mode is running, which is the point:
 * the same handful of calls work either way, and `authMode()` exists for the
 * one place that must say so out loud — the sign-in page, which has to be
 * honest about whether a password is being checked.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED WHEN SUPABASE WENT AWAY, AND WHAT DID NOT
 *
 * This file used to create a Supabase client, and the browser held a public
 * key that let it query Postgres directly; Row Level Security inside the
 * database decided what came back. Now the browser holds nothing. It sends a
 * cookie it cannot read to this site's own API, and PHP decides.
 *
 * Three things follow from that, and they are the whole of the difference:
 *
 *   1. There is no token in localStorage to steal, because there is no token.
 *      The session is an HttpOnly cookie, so a script injected into this page
 *      cannot copy it out the way it could have copied a Supabase session.
 *
 *   2. Every state-changing call carries a CSRF token, held in memory here and
 *      issued by the API. Cookies travel automatically; that is what makes
 *      them convenient and what makes a header necessary alongside them.
 *
 *   3. Microsoft sign-in is gone. It was Supabase brokering Entra, and there
 *      is no broker now. Everyone signs in with an email and a password.
 *
 * WHY currentUser() IS STILL SYNCHRONOUS. Every caller — a page guard, a table
 * render, a header — needs an answer immediately or not at all. sessionInit()
 * is awaited exactly once during page start-up and everything after it reads a
 * resolved value. Calling currentUser() before sessionInit() returns null,
 * which fails closed: it sends someone to sign in rather than showing a list
 * that might not be theirs.
 */

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------ */

const SESSION_KEY = 'dbot.session.v1';          // local mode only
const SESSION_COLORS = ['#FF7A1A', '#2E9BFF', '#12B886', '#F0563A', '#845EF7', '#F59F00', '#E64980', '#0CA678'];

/**
 * A key written on every sign-in and sign-out, purely so other tabs notice.
 *
 * The session itself is an HttpOnly cookie, which JavaScript cannot see and
 * which fires no event when it changes — so a second tab left open on the
 * project list would go on showing it after you signed out in the first. This
 * is a doorbell, not a session: it holds a timestamp and nothing else.
 */
const SESSION_TICK = 'dbot.auth.tick';

/** The resolved user, or null. Read by the synchronous currentUser(). */
let _user = null;
/** Whether sessionInit() has completed, so callers can tell "no user" from "not asked yet". */
let _ready = false;
/** The CSRF token for this session, issued by the API. Memory only, never stored. */
let _csrf = null;
/** What the server said about itself at start-up: sign-up open, domain rule. */
let _serverInfo = { signupOpen: true, emailDomain: '' };
/** Listeners registered through onSessionChange(). */
const _watchers = [];
/** Bound once, however many listeners register. */
let _watchersBound = false;
/** Set when sessionInit() could not reach the API, for the sign-in page to show. */
let _sessionInitError = '';

/**
 * @returns {boolean} whether real authentication is configured
 */
function accountsConfigured() {
  return typeof ACCOUNTS_API_BASE === 'string' && ACCOUNTS_API_BASE !== '';
}

/** @returns {'server'|'local'} */
function authMode() { return accountsConfigured() ? 'server' : 'local'; }

/**
 * The API's base URL, resolved against the page.
 *
 * ACCOUNTS_API_BASE is a relative path ('api'), and it has to stay relative —
 * see the note in js/config.js. Resolving it here against the directory the
 * current page is in, rather than against the origin, is what lets the app
 * live in a subdirectory: from /studio/projects.html the API is /studio/api,
 * not /api.
 *
 * @returns {string}
 */
function apiBase() {
  if (!accountsConfigured()) return '';
  const dir = location.pathname.replace(/[^/]*$/, '');
  return dir + String(ACCOUNTS_API_BASE).replace(/^\/+|\/+$/g, '');
}

/**
 * Call the accounts API.
 *
 * Throws an Error whose message is meant to be shown to a person: the API
 * writes its refusals that way, and this passes them through rather than
 * replacing them with a status code. A transport failure is translated by
 * networkComplaint() instead, because fetch's own message says nothing useful.
 *
 * @param {string} method @param {string} route @param {object} [body]
 * @returns {Promise<object>}
 */
async function apiCall(method, route, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Only needed on state-changing calls, and harmless on the others.
  if (_csrf) headers['X-CSRF-Token'] = _csrf;

  let res;
  try {
    res = await fetch(apiBase() + route, {
      method,
      headers,
      // The session cookie is the entire point of every one of these calls.
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(networkComplaint(e));
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = null; }

  if (data === null) {
    /*
     * Not JSON. On this API that means PHP itself failed before any route ran
     * — a parse error, a missing extension, or the server returning its own
     * error page — and the body is HTML. Saying which is the difference
     * between a fixable report and "Unexpected token < in JSON at position 0".
     */
    throw new Error('The accounts service answered with something that was not JSON ('
      + res.status + '). That usually means PHP is failing before the app runs — '
      + 'check the error log in hPanel.');
  }

  // A token arrives with every answer that establishes or continues a session.
  if (typeof data.csrf === 'string') _csrf = data.csrf;

  if (!res.ok) {
    const err = new Error(data.error || ('The accounts service refused that (' + res.status + ').'));
    err.code = data.code || '';
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------------------------------------------------------------------
 * Presentation helpers — identical in both modes
 * ------------------------------------------------------------------------ */

/** @param {string} seed @returns {string} a stable avatar colour for an identity */
function sessionColorFor(seed) {
  let h = 0;
  for (let i = 0; i < String(seed).length; i++) h = (h * 31 + String(seed).charCodeAt(i)) >>> 0;
  return SESSION_COLORS[h % SESSION_COLORS.length];
}

/** @param {string} name @returns {string} up to two letters */
function sessionInitials(name) {
  const parts = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** @param {string} s @returns {string} short stable hex digest (FNV-1a) */
function sessionHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/**
 * A readable name from an address, for accounts created without one —
 * "aditya.bachal@…" reading as "Aditya Bachal" in the header is the difference
 * between a product and a database row.
 *
 * The same rule exists in api/lib/auth.php, because the server needs it when a
 * row has no name and this file needs it in local mode, where there is no
 * server to ask.
 *
 * @param {string} email @returns {string}
 */
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0];
  if (!local) return '';
  return local
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Turn the API's user into the shape the rest of the app expects.
 *
 * `initials` and `color` are derived here rather than sent, because they are
 * presentation and because local mode has to produce them with no server at
 * all — one definition, used twice.
 *
 * @param {object} u @returns {object}
 */
function fromApiUser(u) {
  const name = u.name || nameFromEmail(u.email) || 'Signed in';
  const seed = String(u.email || u.id).toLowerCase();
  return {
    id: u.id,
    name,
    email: u.email || '',
    initials: sessionInitials(name),
    color: sessionColorFor(seed),
    avatarUrl: u.avatarUrl || '',
    provider: u.provider || 'password',
    role: u.role || 'user',
    mustChangePassword: u.mustChangePassword === true,
    since: u.since || Date.now(),
  };
}

/**
 * Is the signed-in person an administrator?
 *
 * For deciding what to SHOW. It decides nothing about what can be done: every
 * admin endpoint checks the role again on the server, because hiding a link
 * does not stop anybody calling what is behind it. A panel that relied on this
 * would hand the staff list to whoever opened the network tab.
 *
 * @returns {boolean}
 */
function isAdmin() {
  return !!(_user && _user.role === 'admin');
}

/**
 * Has this person been given a password rather than chosen one?
 *
 * True until they set their own. An issued password has been read by two
 * people and has travelled through a chat app; it is a way in, not a secret.
 *
 * @returns {boolean}
 */
function mustChangePassword() {
  return !!(_user && _user.mustChangePassword);
}

/** @param {object|null} u */
function setUser(u) {
  _user = u;
  _watchers.forEach(fn => { try { fn(u); } catch (e) { /* a bad listener must not break auth */ } });
}

/** Tell other tabs that the session changed. */
function ringSessionBell() {
  try { localStorage.setItem(SESSION_TICK, String(Date.now())); } catch (e) { /* ignore */ }
}

/* ---------------------------------------------------------------------------
 * Start-up
 * ------------------------------------------------------------------------ */

/**
 * Resolve who is signed in. Call once, and await it, before anything reads
 * currentUser().
 *
 * Never rejects: an API that is down should land someone on a sign-in page
 * with an explanation, not on a stack trace.
 *
 * @returns {Promise<object|null>}
 */
async function sessionInit() {
  if (_ready) return _user;

  if (!accountsConfigured()) {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const u = raw ? JSON.parse(raw) : null;
      setUser(u && u.id && u.name ? u : null);
    } catch (e) {
      setUser(null);      // corrupt record: sign out rather than throw every load
    }
    _ready = true;
    return _user;
  }

  try {
    const data = await apiCall('GET', '/auth/me');
    setUser(data.user ? fromApiUser(data.user) : null);
    _serverInfo = {
      signupOpen: data.signupOpen !== false,
      emailDomain: typeof data.emailDomain === 'string' ? data.emailDomain : '',
    };
  } catch (e) {
    /*
     * Deliberately NOT falling back to local mode. Local mode reads and writes
     * a different store, so quietly switching to it during an outage would
     * fork somebody's work across two places and look like success. authMode()
     * still says 'server'; there is simply nobody signed in, and the sign-in
     * page will report why.
     */
    console.warn('Auth: the accounts API did not answer —', e && e.message);
    setUser(null);
    _sessionInitError = e && e.message ? String(e.message) : 'unreachable';
  }

  _ready = true;
  return _user;
}

/** @returns {string} why start-up could not reach the accounts API, or ''. */
function sessionStartupError() { return _sessionInitError; }

/**
 * @returns {object|null} the signed-in user, or null. Synchronous — see the
 *   file header on why, and why it answers null before sessionInit().
 */
function currentUser() { return _user; }

/** @returns {boolean} whether sessionInit() has finished. */
function sessionReady() { return _ready; }

/** @returns {{signupOpen:boolean, emailDomain:string}} what the API said about itself. */
function authServerInfo() { return _serverInfo; }

/* ---------------------------------------------------------------------------
 * Signing in
 * ------------------------------------------------------------------------ */

/**
 * Refuse a personal address early, with a sentence that says what to do.
 *
 * Client-side and therefore bypassable — the binding check is
 * `allowed_email_domain` in the API's config. This exists so the common honest
 * mistake gets a useful answer instead of an opaque failure after the round
 * trip.
 *
 * Prefers what the server reported at start-up over the constant in
 * js/config.js, so the two cannot disagree once the page has loaded.
 *
 * @param {string} email @returns {string|null} an error message, or null
 */
function emailDomainComplaint(email) {
  const fromServer = _serverInfo && _serverInfo.emailDomain;
  const domain = String(fromServer
    || (typeof AUTH_ALLOWED_EMAIL_DOMAIN === 'string' ? AUTH_ALLOWED_EMAIL_DOMAIN : '')).trim();
  if (!domain) return null;
  if (String(email || '').toLowerCase().endsWith('@' + domain.toLowerCase())) return null;
  return `Use your ${domain} work account — other addresses are not permitted.`;
}

/**
 * Say what a failed request actually means.
 *
 * fetch() reports every network-level failure as the same bare "Failed to
 * fetch" — offline, DNS miss, TLS refusal, a proxy in the way. That string
 * tells the person nothing and sends them looking at their password.
 *
 * @param {Error} e @returns {string}
 */
function networkComplaint(e) {
  const msg = String((e && e.message) || e);
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return 'This device appears to be offline. Reconnect and try again.';
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return 'Could not reach the accounts service on this site. If the site itself is loading, '
      + 'the api/ folder is probably missing from the upload, or PHP is not running for it — '
      + 'opening ' + apiBase() + '/health in a tab will say which.';
  }
  return msg;
}

/**
 * Email and password.
 *
 * @param {{email:string, password:string}} creds
 * @returns {Promise<object>} the signed-in user
 * @throws {Error} with a message written for the person reading it
 */
async function signInWithPassword(creds) {
  const email = String(creds.email || '').trim().toLowerCase();
  const password = String(creds.password || '');
  if (!email || !password) throw new Error('Enter your email and password.');

  const complaint = emailDomainComplaint(email);
  if (complaint) throw new Error(complaint);

  if (!accountsConfigured()) {
    throw new Error('Accounts are not configured on this copy, so there is no password to check. '
      + 'Set ACCOUNTS_API_BASE in js/config.js, or continue without an account.');
  }

  const data = await apiCall('POST', '/auth/signin', { email, password });
  const u = fromApiUser(data.user);
  setUser(u);
  ringSessionBell();
  return u;
}

/**
 * Create an account with a password.
 *
 * Whether this is permitted at all is `allow_signup` in the API's config; if
 * it is off the refusal comes from the server, which is the right place for
 * that decision.
 *
 * Returns the same shape the Supabase version did, including
 * `needsConfirmation` — which is now always false. There is no confirmation
 * email step: the domain restriction is what limits who can sign up, and
 * adding a mail round trip in front of every new account would mean nobody
 * could start until outbound mail was working. The field stays so callers do
 * not have to change; see docs/ACCOUNTS-SETUP.md for the reasoning in full.
 *
 * @param {{email:string, password:string, name?:string}} details
 * @returns {Promise<{user:object|null, needsConfirmation:boolean}>}
 */
async function signUpWithPassword(details) {
  const email = String(details.email || '').trim().toLowerCase();
  const password = String(details.password || '');
  if (!email || !password) throw new Error('Enter an email and a password.');
  if (password.length < 8) throw new Error('Use at least 8 characters.');

  const complaint = emailDomainComplaint(email);
  if (complaint) throw new Error(complaint);

  if (!accountsConfigured()) throw new Error('Accounts are not configured on this copy.');

  const data = await apiCall('POST', '/auth/signup', {
    email, password, name: details.name || nameFromEmail(email),
  });
  const u = data.user ? fromApiUser(data.user) : null;
  if (u) { setUser(u); ringSessionBell(); }
  return { user: u, needsConfirmation: false };
}

/**
 * Local mode only: record a name so projects can be attributed. Throws in
 * server mode rather than quietly creating a second, weaker notion of identity
 * alongside the real one.
 *
 * @param {{name:string, email?:string}} who @returns {object}
 */
function signInLocally(who) {
  if (accountsConfigured()) throw new Error('Accounts are configured — sign in with your work account.');
  const name = String(who.name || '').trim();
  if (!name) throw new Error('A name is required.');
  const email = String(who.email || '').trim().toLowerCase();
  const seed = email || name.toLowerCase();
  const prior = _user;
  const id = 'u_' + sessionHash(seed);
  const user = {
    id, name, email,
    initials: sessionInitials(name || email),
    color: sessionColorFor(seed),
    provider: 'local',
    since: prior && prior.id === id ? prior.since : Date.now(),
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  setUser(user);
  return user;
}

/**
 * Where an emailed auth link should land: this deployment's own login page.
 *
 * Built from `location` rather than from a constant so the same file works at
 * a domain root, in a subdirectory, and from a local server, without a build
 * step to swap the value. The API builds the same URL independently when it
 * writes a reset email; both derive it rather than storing it.
 *
 * @returns {string} absolute URL to login.html beside the current page
 */
function authReturnUrl() {
  return location.origin + location.pathname.replace(/[^/]*$/, 'login.html');
}

/**
 * Ask for a password-reset email.
 *
 * Resolves with the API's message whether or not the address has an account —
 * see api/routes/auth.php on why that cannot be distinguished. It rejects only
 * when something is actually broken, which in practice means outbound mail is
 * not configured.
 *
 * @param {string} email @returns {Promise<string>} the message to show
 */
async function sendPasswordReset(email) {
  if (!accountsConfigured()) throw new Error('Accounts are not configured on this copy.');
  const data = await apiCall('POST', '/auth/reset/request',
    { email: String(email || '').trim().toLowerCase() });
  return data.message || 'If that address has an account, a reset link is on its way.';
}

/**
 * Finish a reset: the token from the emailed link, and the new password.
 *
 * Signs the person in on success. They have just proved control of the address
 * and chosen a password; sending them to a form to type it again is ceremony.
 *
 * @param {string} token @param {string} password @returns {Promise<object>} the user
 */
async function completePasswordReset(token, password) {
  if (!accountsConfigured()) throw new Error('Accounts are not configured on this copy.');
  const data = await apiCall('POST', '/auth/reset/confirm',
    { token: String(token || ''), password: String(password || '') });
  const u = data.user ? fromApiUser(data.user) : null;
  if (u) { setUser(u); ringSessionBell(); }
  return u;
}

/**
 * Change the password of the signed-in account.
 *
 * Every other session for the account ends server-side — this is what somebody
 * does when they think a session is not theirs, and leaving the others live
 * would make the act pointless.
 *
 * @param {string} current @param {string} next @returns {Promise<void>}
 */
async function changePassword(current, next) {
  if (!accountsConfigured()) throw new Error('Accounts are not configured on this copy.');
  await apiCall('POST', '/auth/password', { current: String(current), next: String(next) });
  ringSessionBell();
}

/* ---------------------------------------------------------------------------
 * Signing out, guarding, watching
 * ------------------------------------------------------------------------ */

/** End the session. Projects are left where they are — signing out is not deleting. */
async function signOut() {
  if (accountsConfigured()) {
    try { await apiCall('POST', '/auth/signout'); }
    catch (e) { console.warn('Auth: sign-out call failed —', e && e.message); }
  }
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  _csrf = null;
  setUser(null);
  ringSessionBell();
}

/**
 * The sign-in URL for someone who has arrived without a session.
 *
 * SIGNING IN LANDS ON THE PROJECT LIST, NOT ON THE MAP. It used to remember
 * whatever page you were on, which sounds helpful and is not: the common case
 * is opening the app at index.html, and remembering that put people into the
 * studio with whichever project autosave happened to restore, rather than at
 * the list of their work. The list is where a session starts.
 *
 * A destination is only worth remembering when it names something — a shared
 * `?project=` link, or an explicit `?next=`. Those still return where they were
 * going. Everything else falls through to login.html's own default, which is
 * the project list.
 *
 * @param {string} [loginUrl] @param {string} [here] @param {string} [search]
 * @returns {string} a relative URL, not yet version-linked
 */
function authSignInUrl(loginUrl, here, search) {
  const page = here != null ? here : (location.pathname.split('/').pop() || 'index.html');
  const q = search != null ? search : location.search;
  const url = loginUrl || 'login.html';
  return /[?&](project|next)=/.test(q) ? url + '?next=' + encodeURIComponent(page + q) : url;
}

/**
 * Send anyone without a session to the sign-in page. Call only after awaiting
 * sessionInit().
 *
 * @param {string} [loginUrl] @returns {object|null} the session, or null if redirecting
 */
function requireSession(loginUrl) {
  if (_user && !mustChangePassword()) return _user;
  if (_user) {
    /*
     * Signed in, on a password an administrator issued. Sent back to the
     * sign-in page to choose their own — otherwise a credential that two
     * people have read, and that travelled through a chat application,
     * quietly becomes somebody's permanent password because they closed the
     * tab at the wrong moment.
     *
     * login.html recognises this state and shows the "choose your own
     * password" form rather than bouncing them straight back here, which is
     * what would otherwise be a loop.
     */
    location.replace(vlink(loginUrl || 'login.html'));
    return null;
  }
  location.replace(vlink(authSignInUrl(loginUrl)));
  return null;
}

/**
 * React to sign-in and sign-out, including changes made in other tabs.
 *
 * The session cookie is HttpOnly and fires no event when it changes, so the
 * cross-tab signal is the doorbell written by ringSessionBell(). A tab that
 * hears it re-asks the API rather than trusting what it heard — the bell says
 * "something changed", not what.
 *
 * @param {function(object|null): void} fn
 */
function onSessionChange(fn) {
  _watchers.push(fn);
  if (_watchersBound) return;
  _watchersBound = true;

  window.addEventListener('storage', async e => {
    // Neither key fires in the tab that made the change, which is exactly
    // right — that tab already knows.
    if (accountsConfigured()) {
      if (e.key !== SESSION_TICK) return;
      try {
        const data = await apiCall('GET', '/auth/me');
        setUser(data.user ? fromApiUser(data.user) : null);
      } catch (err) {
        // Leave the current view alone rather than signing somebody out
        // because one background request failed.
        console.warn('Auth: could not re-check the session —', err && err.message);
      }
      return;
    }
    if (e.key !== SESSION_KEY) return;
    try { const raw = localStorage.getItem(SESSION_KEY); setUser(raw ? JSON.parse(raw) : null); }
    catch (err) { setUser(null); }
  });
}
