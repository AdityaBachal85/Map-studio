/**
 * auth/session.js — who is using this app.
 *
 * TWO MODES, ONE INTERFACE. When SUPABASE_URL and SUPABASE_ANON_KEY are both
 * set in js/config.js this is real authentication: Supabase checks the
 * credential, issues a signed token, and Row Level Security policies in
 * Postgres decide what that token can read (see sql/supabase-auth.sql). When
 * either is empty it degrades to a local profile kept in this browser — which
 * names you and separates people's project lists on a shared machine, and
 * locks nothing.
 *
 * The rest of the app cannot tell which mode is running, which is the point:
 * the same five calls work either way, and `authMode()` exists for the one
 * place that must say so out loud — the sign-in page, which has to be honest
 * about whether a password is being checked.
 *
 * WHY currentUser() IS SYNCHRONOUS. Supabase resolves a session asynchronously
 * (it may refresh an expired token over the network first), but every caller
 * here — a page guard, a table render, a header — needs an answer immediately
 * or not at all. So sessionInit() is awaited exactly once during page start-up
 * and everything after it reads a resolved value. Calling currentUser() before
 * sessionInit() returns null, which fails closed: it sends someone to sign in
 * rather than showing a list that might not be theirs.
 *
 * NO PASSWORD, TOKEN OR KEY IS EVER WRITTEN TO A FILE BY THIS MODULE. Supabase
 * stores its own session in localStorage under its own key; that is its
 * business, and it is a token that expires, not a credential.
 */

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------ */

const SESSION_KEY = 'dbot.session.v1';          // local mode only
const SESSION_COLORS = ['#FF7A1A', '#2E9BFF', '#12B886', '#F0563A', '#845EF7', '#F59F00', '#E64980', '#0CA678'];

/** The live Supabase client, or null in local mode. Created once by sessionInit(). */
let _sb = null;
/** The resolved user, or null. Read by the synchronous currentUser(). */
let _user = null;
/** Whether sessionInit() has completed, so callers can tell "no user" from "not asked yet". */
let _ready = false;
/** Listeners registered through onSessionChange(). */
const _watchers = [];

/**
 * @returns {boolean} whether real authentication is configured
 */
function supabaseConfigured() {
  return typeof SUPABASE_URL === 'string' && !!SUPABASE_URL
    && typeof SUPABASE_ANON_KEY === 'string' && !!SUPABASE_ANON_KEY
    && typeof supabase !== 'undefined' && !!supabase.createClient;
}

/** @returns {'supabase'|'local'} */
function authMode() { return supabaseConfigured() ? 'supabase' : 'local'; }

/** @returns {object|null} the Supabase client, or null in local mode. */
function sessionClient() { return _sb; }

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
 * A readable name from an address, for accounts created in the Supabase
 * dashboard — those carry no metadata at all, so the only thing to work from
 * is the email. "aditya.bachal@…" reading as "aditya.bachal" in the header is
 * the difference between a product and a database row.
 *
 * Only separators that are conventionally word breaks are split on. Digits are
 * left attached rather than stripped, because plenty of real addresses carry
 * them meaningfully.
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
 * Turn a Supabase user into the shape the rest of the app expects, so no
 * caller has to know which provider someone signed in with.
 * @param {object} u @returns {object}
 */
function fromSupabaseUser(u) {
  const meta = u.user_metadata || {};
  // Microsoft returns the display name under different claims depending on how
  // the tenant is configured, so several are tried before falling back to the
  // address itself. A blank name in the header looks like a broken page.
  const name = meta.full_name || meta.name || meta.preferred_username
    || nameFromEmail(u.email) || 'Signed in';
  const seed = (u.email || u.id).toLowerCase();
  return {
    id: u.id,
    name,
    email: u.email || '',
    initials: sessionInitials(name),
    color: sessionColorFor(seed),
    avatarUrl: meta.avatar_url || meta.picture || '',
    provider: (u.app_metadata && u.app_metadata.provider) || 'email',
    since: u.created_at ? Date.parse(u.created_at) : Date.now(),
  };
}

/** @param {object|null} u */
function setUser(u) {
  _user = u;
  _watchers.forEach(fn => { try { fn(u); } catch (e) { /* a bad listener must not break auth */ } });
}

/* ---------------------------------------------------------------------------
 * Start-up
 * ------------------------------------------------------------------------ */

/**
 * Resolve who is signed in. Call once, and await it, before anything reads
 * currentUser().
 *
 * Never rejects: a Supabase outage should land someone on a sign-in page with
 * an explanation, not on a stack trace.
 *
 * @returns {Promise<object|null>}
 */
async function sessionInit() {
  if (_ready) return _user;

  if (!supabaseConfigured()) {
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
    _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Required for the OAuth redirect back from Microsoft: the tokens
        // arrive in the URL fragment and have to be read out of it once.
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    });

    const { data, error } = await _sb.auth.getSession();
    if (error) console.warn('Auth: could not read session —', error.message);
    setUser(data && data.session ? fromSupabaseUser(data.session.user) : null);

    // Fires on sign-in, sign-out, and every silent token refresh — including
    // in this tab, unlike the storage event.
    _sb.auth.onAuthStateChange((_evt, sess) => {
      setUser(sess ? fromSupabaseUser(sess.user) : null);
    });

    // The OAuth redirect leaves ?code=… in the address bar. Harmless, but it
    // is confusing to look at and gets copied into bug reports.
    if (/[?&]code=/.test(location.search)) {
      history.replaceState({}, '', location.pathname + location.hash);
    }
  } catch (e) {
    console.warn('Auth: Supabase unavailable —', e && e.message);
    setUser(null);
  }

  _ready = true;
  return _user;
}

/**
 * @returns {object|null} the signed-in user, or null. Synchronous — see the
 *   file header on why, and why it answers null before sessionInit().
 */
function currentUser() { return _user; }

/** @returns {boolean} whether sessionInit() has finished. */
function sessionReady() { return _ready; }

/* ---------------------------------------------------------------------------
 * Signing in
 * ------------------------------------------------------------------------ */

/**
 * Refuse a personal address early, with a sentence that says what to do.
 * Client-side and therefore bypassable — the binding check is the trigger in
 * sql/supabase-auth.sql. This exists so the common honest mistake gets a
 * useful answer instead of an opaque failure after the round trip.
 *
 * @param {string} email @returns {string|null} an error message, or null
 */
function emailDomainComplaint(email) {
  const domain = (typeof AUTH_ALLOWED_EMAIL_DOMAIN === 'string' ? AUTH_ALLOWED_EMAIL_DOMAIN : '').trim();
  if (!domain) return null;
  if (String(email || '').toLowerCase().endsWith('@' + domain.toLowerCase())) return null;
  return `Use your ${domain} work account — other addresses are not permitted.`;
}

/**
 * Say what a failed request actually means.
 *
 * fetch() reports every network-level failure as the same bare "Failed to
 * fetch" — wrong URL, DNS miss, offline, CORS refusal, blocked by a corporate
 * proxy. That string tells the person nothing and sends them looking at their
 * password. These are the causes worth separating, in the order they happen.
 *
 * @param {Error} e @returns {string}
 */
function networkComplaint(e) {
  const msg = String((e && e.message) || e);
  if (!navigator.onLine) return 'This device appears to be offline. Reconnect and try again.';
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return 'Could not reach the sign-in service. That usually means SUPABASE_URL in js/config.js '
      + 'is wrong, the Supabase project is paused, or a network here is blocking it. '
      + 'Opening ' + (typeof SUPABASE_URL === 'string' ? SUPABASE_URL : 'the project URL')
      + ' in a tab will say which.';
  }
  return msg;
}

/**
 * Email and password.
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

  if (!supabaseConfigured()) {
    throw new Error('Accounts are not configured yet, so there is no password to check. '
      + 'Ask for SUPABASE_ANON_KEY to be filled in, or continue without an account.');
  }

  let data, error;
  try {
    ({ data, error } = await _sb.auth.signInWithPassword({ email, password }));
  } catch (e) {
    throw new Error(networkComplaint(e));
  }
  if (error) {
    // Supabase deliberately returns the same message for a wrong password and
    // an unknown address, so an outsider cannot discover who has an account.
    // Passing that through unchanged is right; only the wording is softened.
    if (/invalid login credentials/i.test(error.message)) {
      throw new Error('That email and password do not match an account.');
    }
    if (/email not confirmed/i.test(error.message)) {
      throw new Error('This account still needs its email confirmed — check your inbox for the link.');
    }
    // A transport failure arrives here as a returned error, not a thrown one,
    // so it has to be recognised in both places.
    throw new Error(networkComplaint(error));
  }
  const u = fromSupabaseUser(data.user);
  setUser(u);
  return u;
}

/**
 * Microsoft / Entra ID. Redirects away and comes back to `redirectTo`, where
 * sessionInit() reads the tokens out of the URL.
 *
 * @param {string} [redirectTo] absolute URL to return to
 * @returns {Promise<void>} resolves as the browser navigates away
 */
async function signInWithMicrosoft(redirectTo) {
  if (!supabaseConfigured()) {
    throw new Error('Microsoft sign-in needs SUPABASE_ANON_KEY to be set in js/config.js.');
  }
  const { error } = await _sb.auth.signInWithOAuth({
    provider: 'azure',
    options: {
      // email is not in Azure's default scope set, and without it every user
      // arrives with a null address and an unusable display name.
      scopes: 'openid profile email offline_access',
      redirectTo: redirectTo || (location.origin + location.pathname.replace(/login\.html$/, 'projects.html')),
    },
  });
  if (error) throw new Error(error.message);
}

/**
 * Create an account with a password. Whether this is permitted at all is a
 * Supabase setting (Authentication → Sign-ups); if it is disabled the error
 * comes back from the server, which is the correct place for that decision.
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

  if (!supabaseConfigured()) throw new Error('Accounts are not configured yet.');

  const { data, error } = await _sb.auth.signUp({
    email,
    password,
    options: { data: { full_name: details.name || email.split('@')[0] } },
  });
  if (error) {
    if (/signups? not allowed|disabled/i.test(error.message)) {
      throw new Error('New accounts are not open — ask an administrator to invite you.');
    }
    throw new Error(error.message);
  }
  // With email confirmation on, Supabase returns a user but no session.
  const needsConfirmation = !!(data && data.user && !data.session);
  if (data && data.session) setUser(fromSupabaseUser(data.user));
  return { user: data && data.user ? fromSupabaseUser(data.user) : null, needsConfirmation };
}

/**
 * Local mode only: record a name so projects can be attributed. Throws in
 * Supabase mode rather than quietly creating a second, weaker notion of
 * identity alongside the real one.
 *
 * @param {{name:string, email?:string}} who @returns {object}
 */
function signInLocally(who) {
  if (supabaseConfigured()) throw new Error('Accounts are configured — sign in with your work account.');
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

/** Send a password-reset email. @param {string} email @returns {Promise<void>} */
async function sendPasswordReset(email) {
  if (!supabaseConfigured()) throw new Error('Accounts are not configured yet.');
  const { error } = await _sb.auth.resetPasswordForEmail(String(email || '').trim().toLowerCase(), {
    redirectTo: location.origin + location.pathname.replace(/[^/]*$/, 'login.html'),
  });
  if (error) throw new Error(error.message);
}

/* ---------------------------------------------------------------------------
 * Signing out, guarding, watching
 * ------------------------------------------------------------------------ */

/** End the session. Projects are left where they are — signing out is not deleting. */
async function signOut() {
  if (supabaseConfigured() && _sb) {
    try { await _sb.auth.signOut(); } catch (e) { console.warn('Auth: sign-out call failed —', e && e.message); }
  }
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  setUser(null);
}

/**
 * Send anyone without a session to the sign-in page, remembering where they
 * were headed. Call only after awaiting sessionInit().
 *
 * @param {string} [loginUrl] @returns {object|null} the session, or null if redirecting
 */
function requireSession(loginUrl) {
  if (_user) return _user;
  const back = encodeURIComponent(location.pathname.split('/').pop() + location.search);
  location.replace((loginUrl || 'login.html') + '?next=' + back);
  return null;
}

/**
 * React to sign-in and sign-out, including token refreshes and changes made in
 * other tabs.
 * @param {function(object|null): void} fn
 */
function onSessionChange(fn) {
  _watchers.push(fn);
  // Local mode has no Supabase listener, so cross-tab changes come from the
  // storage event instead. It does not fire in the tab that made the change,
  // which is exactly right — that tab already knows.
  if (!supabaseConfigured()) {
    window.addEventListener('storage', e => {
      if (e.key !== SESSION_KEY) return;
      try { const raw = localStorage.getItem(SESSION_KEY); setUser(raw ? JSON.parse(raw) : null); }
      catch (err) { setUser(null); }
    });
  }
}
