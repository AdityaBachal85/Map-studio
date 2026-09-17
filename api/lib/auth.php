<?php
/**
 * api/lib/auth.php — who is calling, and may they.
 *
 * ---------------------------------------------------------------------------
 * THE SESSION IS A COOKIE HOLDING A RANDOM TOKEN, AND NOTHING ELSE
 *
 * Not a JWT, and not PHP's $_SESSION. The reasoning for each:
 *
 * A JWT would let the server verify a session without touching the database,
 * which is a real saving for something running at scale and a liability here:
 * a token that validates by signature alone cannot be revoked, so signing out
 * on a shared machine would leave a working credential in circulation until it
 * expired. This application has one small database and one request per action;
 * a row lookup costs nothing it will notice, and DELETE means signed out.
 *
 * PHP's own session handler is avoided for the reason set out in
 * sql/hostinger-mysql.sql: on shared hosting its files live in a directory
 * shared with other accounts and are garbage-collected on somebody else's
 * timetable, which reads as being signed out at random.
 *
 * The cookie is HttpOnly (JavaScript cannot read it, so an injected script
 * cannot steal it), Secure whenever the request arrived over HTTPS, and
 * SameSite=Lax, which means a browser will not attach it to a POST that
 * another site initiated. That last one is the primary CSRF defence; the token
 * checked by ms_require_csrf() is the second.
 *
 * ---------------------------------------------------------------------------
 * WHAT REPLACED ROW LEVEL SECURITY
 *
 * Under Supabase the database refused to hand over another user's rows. MySQL
 * will hand over anything asked for, so every query that touches user data
 * takes its owner from ms_require_user() — the session — and never from the
 * request. A caller can name any project id they like; what they cannot do is
 * name whose it is.
 */

declare(strict_types=1);

/** The session cookie's name. */
const MS_COOKIE = 'mapstudio_session';

/* ---------------------------------------------------------------------------
 * Passwords
 * ------------------------------------------------------------------------ */

/**
 * Hash a password for storage.
 *
 * PASSWORD_DEFAULT rather than a named algorithm on purpose: PHP moves the
 * default forward as the state of the art changes, password_verify() reads
 * whatever algorithm each stored hash names, and ms_password_rehash() below
 * upgrades a hash the next time its owner signs in. Naming bcrypt explicitly
 * here would freeze this deployment at bcrypt forever.
 */
function ms_password_hash(string $plain): string
{
    return password_hash($plain, PASSWORD_DEFAULT);
}

/**
 * Check a password against a stored hash.
 *
 * A NULL or empty hash — a migrated account that has never set a password —
 * must fail for every input, including the empty string. password_verify()
 * against '' can return true for some malformed hashes, so the emptiness is
 * tested first rather than relied on.
 */
function ms_password_ok(string $plain, ?string $hash): bool
{
    if ($hash === null || $hash === '') {
        return false;
    }
    return password_verify($plain, $hash);
}

/** Re-hash on sign-in if PHP's default has moved on since this one was made. */
function ms_password_rehash(string $userId, string $plain, string $hash): void
{
    if (!password_needs_rehash($hash, PASSWORD_DEFAULT)) {
        return;
    }
    ms_exec('update users set password_hash = ?, updated_at = ? where id = ?',
        [ms_password_hash($plain), ms_now(), $userId]);
}

/**
 * Why this password is not acceptable, or null.
 *
 * Eight characters, and no similarity rule beyond "not your own address".
 * Composition rules (an upper, a digit, a symbol) are left out deliberately:
 * they push people towards Password1! and are not what makes a password hard
 * to guess. Length and the sign-in throttle are.
 */
function ms_password_complaint(string $password, string $email): ?string
{
    if (strlen($password) < 8) {
        return 'Use at least 8 characters.';
    }
    if ($password === $email || strcasecmp($password, explode('@', $email)[0]) === 0) {
        return 'That password is your own email address — pick something else.';
    }
    return null;
}

/* ---------------------------------------------------------------------------
 * Email
 * ------------------------------------------------------------------------ */

/** Normalise for storage and comparison: addresses are not case-sensitive. */
function ms_normalise_email(string $email): string
{
    return strtolower(trim($email));
}

/** Why this address may not sign up, or null. */
function ms_email_complaint(string $email): ?string
{
    if ($email === '' || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
        return 'That does not look like an email address.';
    }
    if (strlen($email) > 190) {
        return 'That address is too long.';
    }
    $domain = ms_config()['allowed_email_domain'];
    if ($domain !== '' && !str_ends_with($email, '@' . $domain)) {
        return 'Use your ' . $domain . ' work account — other addresses are not permitted.';
    }
    return null;
}

/* ---------------------------------------------------------------------------
 * The sign-in throttle
 * ------------------------------------------------------------------------ */

/**
 * Refuse if this address or this account has failed too often, too recently.
 *
 * Counted over a sliding window rather than reset on a schedule, so an
 * attacker cannot wait for the top of the minute and get a fresh allowance.
 *
 * The refusal says how long to wait. Hiding that produces people who retry
 * immediately and stay locked out, and it conceals nothing an attacker could
 * not measure.
 */
function ms_check_throttle(string $email, string $ip): void
{
    $cfg = ms_config();
    $since = gmdate('Y-m-d H:i:s', time() - $cfg['attempt_minutes'] * 60);

    $row = ms_row(
        'select
           sum(case when email = ? then 1 else 0 end) as by_email,
           sum(case when ip    = ? then 1 else 0 end) as by_ip
         from login_attempts
         where ok = 0 and at >= ? and (email = ? or ip = ?)',
        [$email, $ip, $since, $email, $ip]
    );

    $byEmail = (int)($row['by_email'] ?? 0);
    $byIp    = (int)($row['by_ip'] ?? 0);

    if ($byEmail >= $cfg['max_attempts'] || $byIp >= $cfg['max_attempts']) {
        ms_fail(429,
            'Too many sign-in attempts. Wait ' . $cfg['attempt_minutes']
            . ' minutes and try again, or reset your password.',
            'throttled');
    }
}

/** Record an attempt, and occasionally sweep the old ones away. */
function ms_record_attempt(string $email, string $ip, bool $ok): void
{
    ms_exec('insert into login_attempts (email, ip, ok, at) values (?, ?, ?, ?)',
        [$email, $ip, $ok ? 1 : 0, ms_now()]);

    // Roughly one request in fifty pays for the cleanup, so the table cannot
    // grow without bound and no single sign-in waits for a DELETE.
    if (random_int(1, 50) === 1) {
        ms_exec('delete from login_attempts where at < ?',
            [gmdate('Y-m-d H:i:s', time() - 7 * 86400)]);
    }
}

/* ---------------------------------------------------------------------------
 * Sessions
 * ------------------------------------------------------------------------ */

/**
 * Begin a session for this user and set the cookie.
 *
 * @return array{token:string, csrf:string}
 */
function ms_session_begin(string $userId): array
{
    $cfg = ms_config();
    [$token, $hash] = ms_new_token();
    $csrf = bin2hex(random_bytes(32));
    $expires = time() + $cfg['session_days'] * 86400;

    ms_exec(
        'insert into sessions (id, user_id, csrf, created_at, last_seen_at, expires_at, user_agent, ip)
         values (?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $hash, $userId, $csrf, ms_now(), ms_now(), gmdate('Y-m-d H:i:s', $expires),
            substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255),
            ms_client_ip(),
        ]
    );

    setcookie(MS_COOKIE, $token, [
        'expires'  => $expires,
        'path'     => ms_app_base() . '/',
        'secure'   => ms_is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);

    /*
     * setcookie() only queues a header for the browser; $_COOKIE still holds
     * whatever arrived with the request, which for a sign-up or a sign-in is
     * nothing. Anything later in this same request that asks who is signed in
     * would therefore be told "nobody" — and both /auth/signup and
     * /auth/reset/confirm answer with the user they just created.
     *
     * Priming it here makes the request internally consistent, so one code
     * path answers that question rather than two.
     */
    $_COOKIE[MS_COOKIE] = $token;

    ms_sweep_sessions();
    return ['token' => $token, 'csrf' => $csrf];
}

/**
 * The current session row, or null.
 *
 * Extends a session that is being used: the expiry slides forward whenever it
 * is more than a day old. Writing on every request would mean a database write
 * per page view for nothing; never writing would sign people out mid-week
 * however much they were using it.
 *
 * @return array<string,mixed>|null
 */
function ms_current_session(): ?array
{
    /*
     * Keyed by the cookie rather than resolved once, because the cookie can
     * change inside a single request: ms_session_begin() primes $_COOKIE when
     * somebody signs up or signs in, and a cache that ignored that would go on
     * reporting the signed-out answer it worked out before they did.
     *
     * @var array<string, array<string,mixed>|null> $cache
     */
    static $cache = [];

    $token = (string)($_COOKIE[MS_COOKIE] ?? '');
    if (array_key_exists($token, $cache)) {
        return $cache[$token];
    }
    $cache[$token] = null;

    if ($token === '' || !preg_match('/^[a-f0-9]{64}$/', $token)) {
        return null;
    }

    $row = ms_row('select * from sessions where id = ?', [hash('sha256', $token)]);
    if ($row === null) {
        return null;
    }
    if ((string)$row['expires_at'] <= ms_now()) {
        ms_exec('delete from sessions where id = ?', [$row['id']]);
        return null;
    }

    $cfg = ms_config();
    if ((string)$row['last_seen_at'] < gmdate('Y-m-d H:i:s', time() - 86400)) {
        ms_exec('update sessions set last_seen_at = ?, expires_at = ? where id = ?', [
            ms_now(),
            gmdate('Y-m-d H:i:s', time() + $cfg['session_days'] * 86400),
            $row['id'],
        ]);
    }

    $cache[$token] = $row;
    return $row;
}

/**
 * The signed-in user as the client expects them, or null.
 *
 * `initials` and `color` are not here: they are derived from the name and are
 * computed in js/auth/session.js, which already had the code for it and which
 * needs them in local mode too, where there is no server to ask.
 *
 * @return array<string,mixed>|null
 */
function ms_current_user(): ?array
{
    $session = ms_current_session();
    if ($session === null) {
        return null;
    }
    $row = ms_row('select id, email, full_name, avatar_url, created_at from users where id = ?',
        [$session['user_id']]);
    if ($row === null) {
        // The account was deleted while a session was live. Clearing it here
        // means the next request is a clean signed-out one rather than a
        // repeated lookup for a user who is not coming back.
        ms_exec('delete from sessions where id = ?', [$session['id']]);
        return null;
    }
    return ms_user_public($row);
}

/**
 * The signed-in user, or a 401 that stops the request.
 *
 * @return array<string,mixed>
 */
function ms_require_user(): array
{
    $user = ms_current_user();
    if ($user === null) {
        ms_fail(401, 'Sign in to continue.', 'signed_out');
    }
    return $user;
}

/**
 * Check the CSRF token on a request that changes something.
 *
 * The SameSite=Lax cookie already stops a browser attaching credentials to a
 * cross-site POST, so this is the second lock rather than the only one. It
 * costs one header and covers the cases Lax does not: a browser too old to
 * implement it, and a same-site subdomain that should not be trusted.
 *
 * hash_equals rather than === because comparing secrets with a short-circuiting
 * comparison leaks their contents through timing, one character at a time.
 */
function ms_require_csrf(): void
{
    $session = ms_current_session();
    if ($session === null) {
        ms_fail(401, 'Sign in to continue.', 'signed_out');
    }
    $sent = (string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
    if ($sent === '' || !hash_equals((string)$session['csrf'], $sent)) {
        ms_fail(403,
            'That request could not be verified. Reload the page and try again.',
            'csrf');
    }
}

/** End the current session, if there is one. */
function ms_session_end(): void
{
    $session = ms_current_session();
    if ($session !== null) {
        ms_exec('delete from sessions where id = ?', [$session['id']]);
    }
    // Same reasoning as the priming in ms_session_begin, in reverse: anything
    // asking after this point in the same request must be told nobody is here.
    unset($_COOKIE[MS_COOKIE]);
    setcookie(MS_COOKIE, '', [
        'expires'  => time() - 3600,
        'path'     => ms_app_base() . '/',
        'secure'   => ms_is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

/** Drop expired sessions. Cheap, indexed, and only on sign-in. */
function ms_sweep_sessions(): void
{
    ms_exec('delete from sessions where expires_at < ?', [ms_now()]);
}

/* ---------------------------------------------------------------------------
 * Shaping a user for the client
 * ------------------------------------------------------------------------ */

/**
 * A readable name from an address, for accounts created without one.
 *
 * The same rule as nameFromEmail() in js/auth/session.js, kept in both places
 * because both have a moment where it is the only thing to work from: the
 * server when a row has no full_name, the client in local mode where there is
 * no server at all.
 */
function ms_name_from_email(string $email): string
{
    $local = explode('@', $email)[0];
    if ($local === '') {
        return '';
    }
    $parts = preg_split('/[._\-+]+/', $local) ?: [];
    $words = [];
    foreach ($parts as $w) {
        if ($w !== '') {
            $words[] = ucfirst($w);
        }
    }
    return implode(' ', $words);
}

/**
 * @param array<string,mixed> $row
 * @return array<string,mixed>
 */
function ms_user_public(array $row): array
{
    $email = (string)($row['email'] ?? '');
    $name = trim((string)($row['full_name'] ?? ''));
    if ($name === '') {
        $name = ms_name_from_email($email);
    }
    if ($name === '') {
        $name = 'Signed in';
    }
    return [
        'id'        => (string)$row['id'],
        'name'      => $name,
        'email'     => $email,
        'avatarUrl' => (string)($row['avatar_url'] ?? ''),
        'provider'  => 'password',
        // Milliseconds, so the client can Date.parse-free it straight into the
        // same field the Supabase shape used.
        'since'     => isset($row['created_at']) ? strtotime((string)$row['created_at']) * 1000 : null,
    ];
}
