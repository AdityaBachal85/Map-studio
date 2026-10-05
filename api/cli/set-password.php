<?php
/**
 * api/cli/set-password.php — set somebody's password from the command line.
 *
 * WHY THIS EXISTS. The reset-by-email flow is the right way in: it proves the
 * person controls the address. But it depends on outbound mail working, and on
 * the first day of a deployment it may not — the mailbox is not created yet,
 * the domain's DNS has not propagated, mail_from is still the placeholder. At
 * that moment every migrated account is unreachable, including the operator's.
 *
 * So there is a way in that does not depend on email, and it is deliberately
 * the one that needs a shell: Hostinger gives SSH on Business plans and above,
 * and a web endpoint that could do this would be a permanent back door guarded
 * by whatever secret somebody remembered to set.
 *
 * USAGE, from the directory this file is in:
 *
 *   php set-password.php someone@dbotrealty.com
 *
 * It asks for the password rather than taking it as an argument, because an
 * argument is recorded in the shell history and is visible in `ps` to every
 * other account on the machine while it runs.
 *
 * NO SHELL? Two other ways, in docs/ACCOUNTS-SETUP.md: hPanel's cron can run
 * this once with a password on the command line (accepting the exposure above,
 * on a password that is then immediately changed), or phpMyAdmin can take a
 * hash generated elsewhere.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("This script only runs from the command line.\n");
}

require dirname(__DIR__) . '/lib/config.php';
require dirname(__DIR__) . '/lib/http.php';
require dirname(__DIR__) . '/lib/db.php';
require dirname(__DIR__) . '/lib/auth.php';

$email = isset($argv[1]) ? ms_normalise_email((string)$argv[1]) : '';
if ($email === '') {
    exit("Usage: php set-password.php <email>\n");
}

$user = ms_row('select id, email, full_name from users where email = ?', [$email]);
if ($user === null) {
    exit("No account with that address. Existing addresses:\n  "
        . implode("\n  ", array_column(ms_rows('select email from users order by email'), 'email'))
        . "\n");
}

echo 'Setting a password for ' . $user['email'] . ' (' . $user['full_name'] . ")\n";

$password = ms_prompt_hidden('New password: ');
$again    = ms_prompt_hidden('Again: ');

if ($password !== $again) {
    exit("Those do not match. Nothing changed.\n");
}
$complaint = ms_password_complaint($password, (string)$user['email']);
if ($complaint !== null) {
    exit($complaint . " Nothing changed.\n");
}

ms_exec('update users set password_hash = ?, updated_at = ? where id = ?',
    [ms_password_hash($password), ms_now(), $user['id']]);

/*
 * Every session for this account ends, for the same reason a password change
 * through the API ends them: this is what somebody does when they believe a
 * session is not theirs.
 */
ms_exec('delete from sessions where user_id = ?', [$user['id']]);
ms_exec('update password_resets set used_at = ? where user_id = ? and used_at is null',
    [ms_now(), $user['id']]);

echo "Done. They can sign in with it now.\n";

/**
 * Read a line without echoing it.
 *
 * `stty -echo` is the portable way on the Linux shells Hostinger provides.
 * If it is not available the password is echoed rather than the script
 * failing — with a warning, so it is a visible trade and not a surprise.
 */
function ms_prompt_hidden(string $prompt): string
{
    echo $prompt;
    $hidden = false;
    if (function_exists('shell_exec') && stripos(PHP_OS, 'WIN') !== 0) {
        $before = shell_exec('stty -g 2>/dev/null');
        if (is_string($before) && trim($before) !== '') {
            shell_exec('stty -echo 2>/dev/null');
            $hidden = true;
        }
    }
    if (!$hidden) {
        echo "\n[the password will be visible as you type]\n";
    }

    $line = fgets(STDIN);
    if ($hidden) {
        shell_exec('stty ' . trim((string)$before) . ' 2>/dev/null');
        echo "\n";
    }
    return rtrim((string)$line, "\r\n");
}
