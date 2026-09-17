<?php
/**
 * api/routes/admin.php — who gets in, and who stops getting in.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN ADMINISTRATOR CAN DO, AND WHAT THEY DELIBERATELY CANNOT
 *
 * Can: create an account and be handed a password to pass on, issue a fresh
 * password, rename somebody, switch an account off and on again, promote and
 * demote, move one person's maps to another person, and delete an account.
 *
 * Cannot: open anybody else's maps. There is no route here that returns a
 * project's contents, and that is a decision rather than an omission. An
 * administrator's job in this application is access, not content — the
 * question administration actually has to answer is "so-and-so has left, what
 * happens to their work", and the honest answer to that is to move the maps to
 * a named colleague, visibly, in the log, rather than to give one account a
 * quiet key to everyone's drawings. `/admin/users/{id}/transfer` is that
 * answer.
 *
 * ---------------------------------------------------------------------------
 * THE LOCKOUT RULES
 *
 * Three actions can leave an installation with nobody able to administer it,
 * and on shared hosting the way back in is SSH, which is the one thing the
 * plan may not include. So: an administrator cannot demote, disable or delete
 * themselves, and none of the three may take the last active administrator.
 * Both checks exist because they fail differently — the first stops a slip,
 * the second stops two administrators removing each other in either order.
 */

declare(strict_types=1);

/**
 * @param list<string> $seg path after /admin
 */
function ms_route_admin(string $method, array $seg): void
{
    $admin = ms_require_admin();
    $first = $seg[0] ?? '';

    if ($first === 'users' && $method === 'GET' && !isset($seg[1])) {
        ms_admin_list($admin);
    }
    if ($first === 'users' && $method === 'POST' && !isset($seg[1])) {
        ms_require_csrf();
        ms_admin_create($admin);
    }
    if ($first === 'log' && $method === 'GET') {
        ms_admin_recent_log();
    }

    if ($first === 'users' && isset($seg[1])) {
        $id = $seg[1];
        $sub = $seg[2] ?? '';

        if ($sub === 'password' && $method === 'POST') {
            ms_require_csrf();
            ms_admin_reissue_password($admin, $id);
        }
        if ($sub === 'transfer' && $method === 'POST') {
            ms_require_csrf();
            ms_admin_transfer($admin, $id);
        }
        if ($sub === '' && $method === 'PATCH') {
            ms_require_csrf();
            ms_admin_update($admin, $id);
        }
        if ($sub === '' && $method === 'DELETE') {
            ms_require_csrf();
            ms_admin_delete($admin, $id);
        }
    }

    ms_fail(404, 'No such endpoint: /admin/' . implode('/', $seg), 'no_route');
}

/* ---------------------------------------------------------------------------
 * Reading
 * ------------------------------------------------------------------------ */

/**
 * Everyone, with the numbers an administrator actually decides on.
 *
 * The map count and total size come from one grouped join rather than a query
 * per person: a list of forty accounts should be one round trip, and the
 * per-row version is the kind of thing that is fine until the day it is not.
 *
 * @param array<string,mixed> $admin
 */
function ms_admin_list(array $admin): void
{
    $rows = ms_rows(
        'select u.id, u.email, u.full_name, u.role, u.status, u.must_change_password,
                u.created_at, u.last_seen_at, u.password_hash is null as no_password,
                count(p.id) as n_projects,
                coalesce(sum(p.bytes), 0) as bytes
           from users u
           left join map_projects p on p.owner_id = u.id
          group by u.id, u.email, u.full_name, u.role, u.status, u.must_change_password,
                   u.created_at, u.last_seen_at, u.password_hash
          order by u.full_name, u.email'
    );

    ms_send(200, [
        'users' => array_map(static fn(array $r): array => [
            'id'        => (string)$r['id'],
            'email'     => (string)$r['email'],
            'name'      => (string)$r['full_name'] !== ''
                ? (string)$r['full_name'] : ms_name_from_email((string)$r['email']),
            'role'      => (string)$r['role'],
            'status'    => (string)$r['status'],
            'mustChangePassword' => (int)$r['must_change_password'] === 1,
            // True for an account migrated from Supabase that only ever used
            // Microsoft sign-in. The list says so, because otherwise the
            // person appears perfectly normal and cannot get in.
            'noPassword' => (int)$r['no_password'] === 1,
            'created'   => strtotime((string)$r['created_at']) * 1000,
            'lastSeen'  => $r['last_seen_at'] ? strtotime((string)$r['last_seen_at']) * 1000 : null,
            'projects'  => (int)$r['n_projects'],
            'bytes'     => (int)$r['bytes'],
            // So the page can grey out the controls that would refuse anyway,
            // rather than offering them and reporting an error.
            'isSelf'    => (string)$r['id'] === (string)$admin['id'],
        ], $rows),
        // Surfaced so the panel can say, plainly, that the sign-up form is
        // still open — which quietly defeats the entire point of this page.
        'signupOpen' => ms_config()['allow_signup'],
        'emailDomain' => ms_config()['allowed_email_domain'],
        'admins' => ms_admin_count(),
    ]);
}

function ms_admin_recent_log(): void
{
    $rows = ms_rows('select * from admin_log order by at desc, id desc limit 100');
    ms_send(200, [
        'entries' => array_map(static fn(array $r): array => [
            'at'      => strtotime((string)$r['at']) * 1000,
            'actor'   => (string)$r['actor_email'],
            'action'  => (string)$r['action'],
            'target'  => (string)$r['target_email'],
            'detail'  => (string)$r['detail'],
        ], $rows),
    ]);
}

/* ---------------------------------------------------------------------------
 * Writing
 * ------------------------------------------------------------------------ */

/**
 * Create an account and issue a password.
 *
 * THE PASSWORD IS RETURNED ONCE AND NEVER STORED IN READABLE FORM. What goes
 * into the database is its hash, exactly as for any other password; what comes
 * back in this response is the only copy, and there is no endpoint that can
 * produce it again. If the administrator loses it before passing it on, they
 * issue another.
 *
 * `must_change_password` is set with it. An issued password has by definition
 * been read by two people and has travelled through whatever chat application
 * was to hand; it is a way in, not a secret, and it should stop working as
 * soon as it has been used once.
 *
 * @param array<string,mixed> $admin
 */
function ms_admin_create(array $admin): void
{
    $email = ms_normalise_email(ms_body_str('email'));
    $name = ms_body_str('name');
    $role = ms_body_str('role') === 'admin' ? 'admin' : 'user';

    $complaint = ms_email_complaint($email);
    if ($complaint !== null) {
        ms_fail(400, $complaint, 'bad_email');
    }

    if (ms_row('select id from users where email = ?', [$email]) !== null) {
        ms_fail(409, 'That address already has an account.', 'email_taken');
    }

    $password = ms_generate_password();
    $id = ms_uuid();

    try {
        ms_exec(
            'insert into users (id, email, password_hash, full_name, role, status,
                                must_change_password, created_by, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
            [$id, $email, ms_password_hash($password),
             $name !== '' ? $name : ms_name_from_email($email),
             $role, 'active', $admin['id'], ms_now(), ms_now()]
        );
    } catch (PDOException $e) {
        if (ms_is_duplicate_error($e)) {
            ms_fail(409, 'That address already has an account.', 'email_taken');
        }
        throw $e;
    }

    $created = ms_row('select ' . MS_USER_COLS . ' from users where id = ?', [$id]);
    ms_admin_log($admin, 'create', $created, 'as ' . $role);

    ms_send(201, [
        'user' => ms_user_public($created),
        'password' => $password,
        'note' => 'This password is shown once. Pass it on now — it cannot be read again, '
            . 'and they will be asked to choose their own the first time they sign in.',
    ]);
}

/**
 * Issue a fresh password for somebody who has lost theirs.
 *
 * Also the answer for a migrated account that never had one, and for the case
 * where outbound mail is not working and the reset link cannot be delivered.
 *
 * Every session that account has ends. A password is reissued when somebody
 * has lost control of one, and leaving the existing sessions live would make
 * the act pointless.
 *
 * @param array<string,mixed> $admin
 */
function ms_admin_reissue_password(array $admin, string $id): void
{
    $target = ms_admin_target($id);
    $password = ms_generate_password();

    ms_exec('update users set password_hash = ?, must_change_password = 1, updated_at = ?
              where id = ?',
        [ms_password_hash($password), ms_now(), $target['id']]);
    ms_exec('delete from sessions where user_id = ?', [$target['id']]);
    ms_exec('update password_resets set used_at = ? where user_id = ? and used_at is null',
        [ms_now(), $target['id']]);

    ms_admin_log($admin, 'password', $target, 'issued a new password');

    ms_send(200, [
        'password' => $password,
        'note' => 'Shown once. They will be asked to choose their own when they sign in.',
    ]);
}

/**
 * Rename, promote, demote, disable, enable.
 *
 * One route rather than four because the three fields are edited from the same
 * row of the same table and each is a single value; four endpoints would be
 * four places to repeat the lockout rules.
 *
 * @param array<string,mixed> $admin
 */
function ms_admin_update(array $admin, string $id): void
{
    $target = ms_admin_target($id);
    $body = ms_json_body();
    $changes = [];

    if (array_key_exists('name', $body)) {
        $name = mb_substr(ms_body_str('name'), 0, 190);
        if ($name === '') {
            ms_fail(400, 'A name cannot be empty.', 'no_name');
        }
        ms_exec('update users set full_name = ?, updated_at = ? where id = ?',
            [$name, ms_now(), $target['id']]);
        $changes[] = 'renamed to ' . $name;
    }

    if (array_key_exists('role', $body)) {
        $role = ms_body_str('role') === 'admin' ? 'admin' : 'user';
        if ($role !== (string)$target['role']) {
            if ($role === 'user') {
                ms_admin_guard_last($admin, $target, 'demote');
            }
            ms_exec('update users set role = ?, updated_at = ? where id = ?',
                [$role, ms_now(), $target['id']]);
            $changes[] = $role === 'admin' ? 'made an administrator' : 'made an ordinary user';
        }
    }

    if (array_key_exists('status', $body)) {
        $status = ms_body_str('status') === 'disabled' ? 'disabled' : 'active';
        if ($status !== (string)$target['status']) {
            if ($status === 'disabled') {
                ms_admin_guard_last($admin, $target, 'disable');
            }
            ms_exec('update users set status = ?, updated_at = ? where id = ?',
                [$status, ms_now(), $target['id']]);
            if ($status === 'disabled') {
                // Immediately, not at the next expiry. "Switched off" has to
                // mean now, or it means "within thirty days".
                ms_exec('delete from sessions where user_id = ?', [$target['id']]);
            }
            $changes[] = $status === 'disabled' ? 'switched off' : 'switched back on';
        }
    }

    if (!$changes) {
        ms_send(200, ['ok' => true, 'changed' => false]);
    }

    ms_admin_log($admin, 'update', $target, implode(', ', $changes));
    ms_send(200, ['ok' => true, 'changed' => true, 'detail' => implode(', ', $changes)]);
}

/**
 * Move every map one person owns to somebody else.
 *
 * The answer to "they have left; their work must not go with them" that does
 * not involve giving anybody a key to everyone's drawings. It is visible, it
 * names both people, and it is in the log.
 *
 * Ownership moves wholesale — there is no partial transfer — because the
 * alternative is a list of checkboxes over somebody's project names, which is
 * the content-reading this file deliberately does not do.
 *
 * @param array<string,mixed> $admin
 */
function ms_admin_transfer(array $admin, string $id): void
{
    $from = ms_admin_target($id);
    $toId = ms_body_str('to');
    if ($toId === '' || $toId === (string)$from['id']) {
        ms_fail(400, 'Choose somebody else to move the maps to.', 'bad_target');
    }
    $to = ms_admin_target($toId);

    $n = (int)(ms_row('select count(*) as n from map_projects where owner_id = ?',
        [$from['id']])['n'] ?? 0);
    if ($n === 0) {
        ms_send(200, ['ok' => true, 'moved' => 0]);
    }

    ms_exec('update map_projects set owner_id = ?, updated_at = ? where owner_id = ?',
        [$to['id'], ms_now(), $from['id']]);

    ms_admin_log($admin, 'transfer', $from,
        'moved ' . $n . ' map(s) to ' . (string)$to['email']);

    ms_send(200, ['ok' => true, 'moved' => $n, 'to' => (string)$to['email']]);
}

/**
 * Delete an account, and everything it owns.
 *
 * REQUIRES THE MAP COUNT TO BE SENT BACK. `map_projects` has `on delete
 * cascade`, so removing a person removes their maps — quietly, instantly, with
 * no undo anywhere in this application. A button that can do that on one click
 * is a button somebody will press on the wrong row.
 *
 * So the client has to name how many maps it believes will be destroyed, and
 * the server refuses if that number is wrong. That makes the confirmation
 * meaningful rather than decorative: it cannot be satisfied by a client that
 * did not look, and it fails safe if the list on screen is out of date.
 *
 * @param array<string,mixed> $admin
 */
function ms_admin_delete(array $admin, string $id): void
{
    $target = ms_admin_target($id);
    ms_admin_guard_last($admin, $target, 'delete');

    $n = (int)(ms_row('select count(*) as n from map_projects where owner_id = ?',
        [$target['id']])['n'] ?? 0);

    $claimed = ms_json_body()['expectProjects'] ?? null;
    if (!is_int($claimed) || $claimed !== $n) {
        ms_fail(409,
            'That account owns ' . $n . ' map(s), which will be deleted with it and cannot be '
            . 'recovered. Move them to somebody else first, or confirm again now that you know '
            . 'the number.',
            'confirm_projects');
    }

    ms_exec('delete from users where id = ?', [$target['id']]);
    ms_admin_log($admin, 'delete', $target, 'with ' . $n . ' map(s)');

    ms_send(200, ['ok' => true, 'deletedProjects' => $n]);
}

/* ---------------------------------------------------------------------------
 * Guards
 * ------------------------------------------------------------------------ */

/**
 * The account being acted on, or a 404.
 *
 * @return array<string,mixed>
 */
function ms_admin_target(string $id): array
{
    if (!ms_valid_id($id)) {
        ms_fail(404, 'No such account.', 'not_found');
    }
    $row = ms_row('select ' . MS_USER_COLS . ' from users where id = ?', [$id]);
    if ($row === null) {
        ms_fail(404, 'No such account.', 'not_found');
    }
    return $row;
}

/**
 * Refuse an action that would leave nobody able to administer this install.
 *
 * Two separate refusals, because they are two different mistakes. Acting on
 * yourself is a slip — the row you meant was the one above. Removing the last
 * administrator is a decision that looks reasonable from inside and locks the
 * door from outside, and it can be reached by two administrators demoting each
 * other in either order, which no self-check would catch.
 *
 * @param array<string,mixed> $admin
 * @param array<string,mixed> $target
 */
function ms_admin_guard_last(array $admin, array $target, string $verb): void
{
    $words = ['demote' => 'demote', 'disable' => 'switch off', 'delete' => 'delete'];
    $word = $words[$verb] ?? $verb;

    if ((string)$target['id'] === (string)$admin['id']) {
        ms_fail(409,
            'You cannot ' . $word . ' your own account. Ask another administrator to do it.',
            'not_yourself');
    }

    if ((string)$target['role'] === 'admin' && (string)$target['status'] === 'active'
        && ms_admin_count() <= 1) {
        ms_fail(409,
            'That is the only administrator left. Make somebody else an administrator first, '
            . 'or there will be no way back into this page.',
            'last_admin');
    }
}
