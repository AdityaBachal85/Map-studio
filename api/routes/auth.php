<?php
/**
 * api/routes/auth.php — signing up, in, and out.
 *
 * ONE RULE RUNS THROUGH ALL OF THIS: never say whether an address has an
 * account. A wrong password and an unknown address return the same sentence;
 * a reset request for an address with no account returns the same sentence as
 * one that sent an email. Otherwise this endpoint becomes a way to test a list
 * of addresses against the company's staff — and that is worth something to
 * whoever is compiling one, whatever they do with it next.
 *
 * Sign-up is the deliberate exception. It has to say "that address already has
 * an account", because the alternative is somebody being unable to create an
 * account and unable to find out why. The domain restriction is what limits
 * the damage: only addresses at the configured domain can be tested this way,
 * and whoever holds one can already ask a colleague.
 */

declare(strict_types=1);

/**
 * @param list<string> $seg path after /auth
 */
function ms_route_auth(string $method, array $seg): void
{
    $action = $seg[0] ?? '';

    if ($action === 'me' && $method === 'GET') {
        ms_auth_me();
    }
    if ($action === 'signup' && $method === 'POST') {
        ms_auth_signup();
    }
    if ($action === 'signin' && $method === 'POST') {
        ms_auth_signin();
    }
    if ($action === 'signout' && $method === 'POST') {
        ms_auth_signout();
    }
    if ($action === 'password' && $method === 'POST') {
        ms_auth_change_password();
    }
    if ($action === 'reset' && $method === 'POST') {
        $step = $seg[1] ?? '';
        if ($step === 'request') {
            ms_auth_reset_request();
        }
        if ($step === 'confirm') {
            ms_auth_reset_confirm();
        }
    }

    ms_fail(404, 'No such endpoint: /auth/' . implode('/', $seg), 'no_route');
}

/**
 * Who is signed in, and the CSRF token for this session.
 *
 * Called once at page start-up by sessionInit(). Answers 200 with a null user
 * rather than 401 when nobody is signed in: "nobody is here" is a successful
 * answer to this question, and making it an error means every signed-out page
 * load logs a failure that is not one.
 */
function ms_auth_me(): void
{
    $user = ms_current_user();
    $session = ms_current_session();
    ms_send(200, [
        'user' => $user,
        'csrf' => $session === null ? null : (string)$session['csrf'],
        // So the sign-in page can hide a control that would only fail.
        'signupOpen' => ms_config()['allow_signup'],
        'emailDomain' => ms_config()['allowed_email_domain'],
    ]);
}

function ms_auth_signup(): void
{
    $cfg = ms_config();

    /*
     * THE FIRST ACCOUNT IS ALWAYS ALLOWED, even with sign-up switched off.
     *
     * Otherwise the recommended configuration is unstartable: accounts are
     * created by administrators, administrators are accounts, and a database
     * with no rows in it has neither. The way out would be SSH, which is
     * exactly the thing a shared plan may not include.
     *
     * The window is one account wide and shuts the moment it is used, and it
     * opens onto a form that already refuses every address outside the
     * configured domain. Anybody who reaches this deployment before its owner
     * does is a colleague.
     */
    $nobodyYet = (int)(ms_row('select count(*) as n from users')['n'] ?? 0) === 0;

    if (!$cfg['allow_signup'] && !$nobodyYet) {
        ms_fail(403, 'New accounts are not open — ask an administrator to create one for you.',
            'signup_closed');
    }

    $email = ms_normalise_email(ms_body_str('email'));
    $password = (string)(ms_json_body()['password'] ?? '');
    $name = ms_body_str('name');

    $complaint = ms_email_complaint($email);
    if ($complaint !== null) {
        ms_fail(400, $complaint, 'bad_email');
    }
    $complaint = ms_password_complaint($password, $email);
    if ($complaint !== null) {
        ms_fail(400, $complaint, 'weak_password');
    }

    $existing = ms_row('select id from users where email = ?', [$email]);
    if ($existing !== null) {
        ms_fail(409, 'That address already has an account. Sign in, or reset the password.',
            'email_taken');
    }

    /*
     * THE FIRST ACCOUNT ON A NEW INSTALL IS THE ADMINISTRATOR.
     *
     * Somebody has to be, and every other way of arranging it is worse. An
     * install with no administrator can only be fixed over SSH, which is the
     * one thing a shared plan may not have; and a hard-coded address in the
     * config is a value that gets copied between deployments and forgotten.
     *
     * The window this opens is exactly one account wide and closes the moment
     * it is used, and it opens onto a sign-up form that already refuses every
     * address outside the configured domain. The person who installs this is
     * the person who signs up first.
     *
     * After a Supabase import there are already accounts, so this never fires
     * — which is why api/cli/make-admin.php exists as well.
     *
     * `$nobodyYet` is the same check that let this sign-up through at all when
     * sign-up is switched off, computed once above.
     */
    $role = $nobodyYet ? 'admin' : 'user';

    $id = ms_uuid();
    try {
        ms_exec(
            'insert into users (id, email, password_hash, full_name, role, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?)',
            [$id, $email, ms_password_hash($password),
             $name !== '' ? $name : ms_name_from_email($email), $role, ms_now(), ms_now()]
        );
    } catch (PDOException $e) {
        // Two people signing up with the same address at the same moment: the
        // SELECT above found nothing for both, and the unique index catches
        // the second. Reported as the same conflict rather than a 500.
        if (ms_is_duplicate_error($e)) {
            ms_fail(409, 'That address already has an account. Sign in, or reset the password.',
                'email_taken');
        }
        throw $e;
    }

    $session = ms_session_begin($id);
    $user = ms_current_user();
    ms_send(201, ['user' => $user, 'csrf' => $session['csrf']]);
}

function ms_auth_signin(): void
{
    $email = ms_normalise_email(ms_body_str('email'));
    $password = (string)(ms_json_body()['password'] ?? '');
    $ip = ms_client_ip();

    if ($email === '' || $password === '') {
        ms_fail(400, 'Enter your email and password.', 'missing');
    }

    ms_check_throttle($email, $ip);

    $row = ms_row('select ' . MS_USER_COLS . ', password_hash from users where email = ?', [$email]);

    $ok = $row !== null && ms_password_ok($password, $row['password_hash'] === null
        ? null : (string)$row['password_hash']);

    if (!$ok) {
        ms_record_attempt($email, $ip, false);

        /*
         * A migrated account — one with no password hash — gets a sentence of
         * its own. It is the one case where the generic message sends somebody
         * to look for a typo in a password that has never existed, and saying
         * so reveals nothing an attacker can use: they still cannot sign in,
         * and the reset link goes to the address, not to them.
         */
        if ($row !== null && ($row['password_hash'] === null || $row['password_hash'] === '')) {
            ms_fail(403,
                'This account has not had a password set on this site yet. '
                . 'Use "Forgot password" to choose one.',
                'no_password');
        }

        ms_fail(401, 'That email and password do not match an account.', 'bad_credentials');
    }

    /*
     * The password was right and the account is switched off.
     *
     * Checked AFTER the password, deliberately. Refusing on the address alone
     * would tell anybody who tried an address whether it belongs to a disabled
     * account — which is to say, whether that person once worked here. Getting
     * the password right first is the price of being told anything.
     *
     * And it is told, rather than answered with the generic refusal: the
     * person is usually a colleague whose access was revoked, and sending them
     * to hunt for a typo in a password that is perfectly correct wastes their
     * afternoon and then somebody else's.
     */
    if ((string)($row['status'] ?? 'active') !== 'active') {
        ms_record_attempt($email, $ip, false);
        ms_fail(403, 'This account has been switched off. Ask an administrator to turn it back on.',
            'disabled');
    }

    ms_password_rehash((string)$row['id'], $password, (string)$row['password_hash']);
    ms_record_attempt($email, $ip, true);
    // Not a login timestamp for its own sake: this is the column an
    // administrator reads before revoking anything, and "never" is the most
    // useful value in the column.
    ms_exec('update users set last_seen_at = ? where id = ?', [ms_now(), $row['id']]);

    $session = ms_session_begin((string)$row['id']);
    ms_send(200, ['user' => ms_user_public($row), 'csrf' => $session['csrf']]);
}

function ms_auth_signout(): void
{
    /*
     * No CSRF check, deliberately. The worst a forged sign-out can do is sign
     * somebody out, and requiring a token here means a page whose session has
     * already expired cannot clear its own cookie — which leaves the browser
     * holding a dead cookie and the user looking at a sign-in page that will
     * not take.
     */
    ms_session_end();
    ms_send(200, ['ok' => true]);
}

function ms_auth_change_password(): void
{
    $user = ms_require_user();
    ms_require_csrf();

    $current = (string)(ms_json_body()['current'] ?? '');
    $next = (string)(ms_json_body()['next'] ?? '');

    $row = ms_row('select password_hash from users where id = ?', [$user['id']]);
    $hash = $row === null || $row['password_hash'] === null ? null : (string)$row['password_hash'];

    // An account with no password set (migrated, never reset) cannot change it
    // here — there is nothing to prove with. The reset-by-email path is the
    // one that proves control of the address instead.
    if ($hash === null) {
        ms_fail(403, 'This account has no password yet. Use "Forgot password" to set one.',
            'no_password');
    }
    if (!ms_password_ok($current, $hash)) {
        ms_fail(401, 'That is not your current password.', 'bad_credentials');
    }

    $complaint = ms_password_complaint($next, (string)$user['email']);
    if ($complaint !== null) {
        ms_fail(400, $complaint, 'weak_password');
    }

    ms_exec('update users set password_hash = ?, must_change_password = 0, updated_at = ?
              where id = ?',
        [ms_password_hash($next), ms_now(), $user['id']]);

    /*
     * Every other session for this user is ended. Changing a password is what
     * somebody does when they think a session is not theirs, and leaving the
     * others live would make the act pointless. This one survives, so the
     * person doing it is not signed out of the page they are looking at.
     */
    $session = ms_current_session();
    ms_exec('delete from sessions where user_id = ? and id <> ?',
        [$user['id'], $session === null ? '' : $session['id']]);

    ms_send(200, ['ok' => true]);
}

function ms_auth_reset_request(): void
{
    $cfg = ms_config();
    $email = ms_normalise_email(ms_body_str('email'));
    $minutes = $cfg['reset_minutes'];

    // The same answer whether or not the address is known — see the file note.
    $answer = ['ok' => true, 'message' =>
        'If that address has an account, a reset link is on its way. '
        . 'It stops working in ' . $minutes . ' minutes.'];

    if ($email === '' || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
        ms_send(200, $answer);
    }

    $row = ms_row('select id, email, full_name from users where email = ?', [$email]);
    if ($row === null) {
        ms_send(200, $answer);
    }

    /*
     * One live link at a time. Without this, repeatedly pressing the button
     * mails a person five working links, each of which is a way into the
     * account for as long as it lasts.
     */
    ms_exec('update password_resets set used_at = ? where user_id = ? and used_at is null',
        [ms_now(), $row['id']]);

    [$token, $hash] = ms_new_token();
    ms_exec('insert into password_resets (id, user_id, created_at, expires_at) values (?, ?, ?, ?)',
        [$hash, $row['id'], ms_now(), ms_future($minutes * 60)]);

    $link = ms_origin() . ms_app_base() . '/login.html?reset=' . urlencode($token);
    $sent = ms_send_reset_email((string)$row['email'], (string)$row['full_name'], $link, $minutes);

    /*
     * A failure to hand the message to the mail system is reported, because it
     * is an operator problem — mail_from unset, or outbound mail not working —
     * and hiding it behind the neutral answer means nobody ever finds out why
     * resets do not arrive. It still says nothing about whether the account
     * exists: the same message would appear for an unknown address if the mail
     * system were broken, because it is the mail system being broken that is
     * being reported.
     */
    if (!$sent) {
        ms_fail(500,
            'The reset link could not be sent. Outbound email is not working for this site — '
            . 'check mail_from in the config and the mailbox it names.',
            'mail_failed');
    }

    ms_send(200, $answer);
}

function ms_auth_reset_confirm(): void
{
    $token = ms_body_str('token');
    $password = (string)(ms_json_body()['password'] ?? '');

    if ($token === '' || !preg_match('/^[a-f0-9]{64}$/', $token)) {
        ms_fail(400, 'That reset link is not valid. Ask for a new one.', 'bad_token');
    }

    $row = ms_row(
        'select r.id, r.user_id, r.expires_at, r.used_at, u.email
           from password_resets r join users u on u.id = r.user_id
          where r.id = ?',
        [hash('sha256', $token)]
    );

    if ($row === null) {
        ms_fail(400, 'That reset link is not valid. Ask for a new one.', 'bad_token');
    }
    if ($row['used_at'] !== null) {
        ms_fail(400, 'That reset link has already been used. Ask for a new one.', 'used_token');
    }
    if ((string)$row['expires_at'] <= ms_now()) {
        ms_fail(400, 'That reset link has expired. Ask for a new one.', 'expired_token');
    }

    $complaint = ms_password_complaint($password, (string)$row['email']);
    if ($complaint !== null) {
        ms_fail(400, $complaint, 'weak_password');
    }

    ms_exec('update users set password_hash = ?, must_change_password = 0, updated_at = ?
              where id = ?',
        [ms_password_hash($password), ms_now(), $row['user_id']]);
    ms_exec('update password_resets set used_at = ? where id = ?', [ms_now(), $row['id']]);

    /*
     * Every existing session for this user ends. A reset is the response to
     * losing control of an account, and it has to remove whoever else is in it.
     */
    ms_exec('delete from sessions where user_id = ?', [$row['user_id']]);

    // Signed in immediately: the person just proved control of the address and
    // chose a password, and sending them back to a form to type it again is
    // ceremony, not security.
    $session = ms_session_begin((string)$row['user_id']);
    ms_send(200, ['user' => ms_current_user(), 'csrf' => $session['csrf']]);
}

/**
 * Is this exception a unique-key violation?
 *
 * MySQL reports 23000 with a driver code of 1062; SQLite, used by the test
 * harness, reports 23000 with 19. Both are checked so the same code path is
 * exercised in tests as in production.
 */
function ms_is_duplicate_error(PDOException $e): bool
{
    if ($e->getCode() !== '23000') {
        return false;
    }
    $info = $e->errorInfo ?? [];
    $driverCode = (int)($info[1] ?? 0);
    return $driverCode === 1062 || $driverCode === 19;
}
