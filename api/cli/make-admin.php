<?php
/**
 * api/cli/make-admin.php — hand somebody the keys to the admin panel.
 *
 * WHEN THIS IS NEEDED. The first account created on a fresh install becomes the
 * administrator on its own, so a new deployment never needs this. A database
 * imported from Supabase does: it already has accounts, so that rule never
 * fires, and every one of them arrives as an ordinary user with no way to
 * promote anyone.
 *
 * It is also the way back in if the last administrator is lost — which the API
 * tries hard to prevent, and cannot prevent absolutely.
 *
 *   cd public_html/api/cli
 *   php make-admin.php someone@dbotrealty.com
 *   php make-admin.php someone@dbotrealty.com --remove
 *   php make-admin.php --list
 *
 * NO SSH? hPanel → Advanced → Cron Jobs runs the same command once. Set it a
 * few minutes out, check the site, then delete the job.
 *
 * Deliberately CLI-only. A web endpoint that could grant administrator rights
 * would be a permanent back door guarded by whatever secret somebody
 * remembered to set, and it would sit inside public_html being found by
 * scanners.
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
require dirname(__DIR__) . '/lib/schema.php';

/*
 * The `role` column may not exist yet — this script is most often reached
 * straight after an upgrade, by somebody who has not run the migration. Saying
 * which command to run beats "Unknown column 'role' in 'field list'".
 */
$gaps = ms_schema_gaps();
if ($gaps) {
    echo "The database is not up to date yet:\n";
    foreach ($gaps as $g) {
        echo '  - ' . $g . "\n";
    }
    exit("\nRun this first:  php migrate.php\n");
}

function ms_show_everyone(): void
{
    $rows = ms_rows('select email, full_name, role, status from users order by role desc, email');
    if (!$rows) {
        echo "There are no accounts yet.\n";
        return;
    }
    echo "Accounts:\n";
    foreach ($rows as $r) {
        printf("  %-38s %-22s %-6s %s\n",
            $r['email'], $r['full_name'], $r['role'],
            $r['status'] === 'active' ? '' : '(switched off)');
    }
}

if (in_array('--list', $argv, true)) {
    ms_show_everyone();
    exit(0);
}

$remove = in_array('--remove', $argv, true);
$email = '';
foreach (array_slice($argv, 1) as $a) {
    if (!str_starts_with($a, '--')) {
        $email = ms_normalise_email($a);
        break;
    }
}

if ($email === '') {
    echo "Usage: php make-admin.php <email> [--remove]\n";
    echo "       php make-admin.php --list\n\n";
    ms_show_everyone();
    exit(1);
}

$user = ms_row('select id, email, full_name, role, status from users where email = ?', [$email]);
if ($user === null) {
    echo 'No account with that address.' . "\n\n";
    ms_show_everyone();
    exit(1);
}

$role = $remove ? 'user' : 'admin';

if ((string)$user['role'] === $role) {
    echo $user['email'] . ' is already ' . ($remove ? 'an ordinary user' : 'an administrator')
        . ". Nothing changed.\n";
    exit(0);
}

/*
 * The same lockout rule the API enforces, enforced here too. This script is
 * the way back in when there is no administrator left, and it should not be
 * the way that situation is created.
 */
if ($remove && ms_admin_count() <= 1 && (string)$user['status'] === 'active') {
    exit("That is the only administrator left. Promote somebody else first, or there will be\n"
        . "no way into the admin panel except this script.\n");
}

ms_exec('update users set role = ?, updated_at = ? where id = ?', [$role, ms_now(), $user['id']]);

/*
 * Their sessions are left alone, and that is on purpose: a change of role is
 * not a change of identity, and signing somebody out to tell them they have
 * been promoted is a strange way to do it. /auth/me reports the new role on
 * their next page load.
 */

echo $user['email'] . ' is now ' . ($remove ? 'an ordinary user' : 'an administrator') . ".\n";
echo "They will see the change the next time the page loads.\n";
