<?php
/**
 * api/cli/import.php — load the Supabase export into this site's database.
 *
 * The other half of tools/export-supabase.js. That script pulls everything out
 * of Supabase into one JSON file; this one puts it in, using the same PDO
 * prepared statements the application uses, so no value is ever escaped by
 * hand on its way into the database.
 *
 * USAGE, over SSH:
 *
 *   cd public_html/api/cli
 *   php import.php /home/uXXXXXXXXX/map-studio-export.json
 *
 * NO SSH? hPanel → Advanced → Cron Jobs will run the same command once. Set it
 * to run in five minutes, check the site, then delete the cron job.
 *
 * SAFE TO RUN TWICE. Every row is matched on the id it had in Supabase:
 * present already, it is updated; absent, it is inserted. So a run that dies
 * half way through — a timeout, a connection drop — is fixed by running it
 * again, which is the property that matters when the alternative is wondering
 * which half arrived.
 *
 * WHAT IT WILL NOT DO. It never deletes. A map created on the new site after
 * the export was taken is left alone, and re-running an old export cannot
 * remove it. --replace overwrites a project's contents from the file; even
 * then, nothing is dropped.
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

$file = $argv[1] ?? '';
$replace = in_array('--replace', $argv, true);
$dry = in_array('--dry-run', $argv, true);

if ($file === '' || !is_file($file)) {
    exit("Usage: php import.php <export.json> [--replace] [--dry-run]\n\n"
        . "  --replace   overwrite maps that already exist here, from the file\n"
        . "  --dry-run   say what would happen, change nothing\n");
}

$raw = file_get_contents($file);
$data = json_decode((string)$raw, true);
if (!is_array($data) || !isset($data['users']) || !isset($data['projects'])) {
    exit("That file is not a Map Studio export — expected `users` and `projects` at the top.\n");
}

echo 'Reading ' . $file . ' (' . round(strlen((string)$raw) / 1048576, 1) . " MB)\n";
echo '  ' . count($data['users']) . ' accounts, ' . count($data['projects']) . " maps\n";
if ($dry) {
    echo "  --dry-run: nothing will be written\n";
}
echo "\n";

/*
 * Timestamps arrive as ISO-8601 in whatever zone Postgres reported. Every
 * datetime column here is UTC, so they are converted rather than trimmed — a
 * string chop would have quietly shifted every "created" date by the source
 * zone's offset, which nobody would notice until a list sorted oddly.
 */
$stamp = static function ($iso): string {
    if (!is_string($iso) || $iso === '') {
        return ms_now();
    }
    $t = strtotime($iso);
    return $t === false ? ms_now() : gmdate('Y-m-d H:i:s', $t);
};

$pdo = ms_db();
$pdo->beginTransaction();

$added = 0; $updated = 0; $skipped = 0;

try {
    /* ---- accounts --------------------------------------------------------
     *
     * The password hash carries over untouched. Supabase stores bcrypt, which
     * is what password_verify() reads, so everybody's existing password keeps
     * working and no plaintext exists anywhere in this process.
     *
     * An account with no hash — one that only ever used Microsoft sign-in —
     * lands with password_hash NULL. ms_password_ok() refuses every password
     * against a NULL hash, so the account exists, owns its maps, and is
     * reached through the reset link. That is the correct outcome: there is no
     * Microsoft sign-in here to carry across.
     */
    foreach ($data['users'] as $u) {
        $id = (string)($u['id'] ?? '');
        $email = ms_normalise_email((string)($u['email'] ?? ''));
        if ($id === '' || $email === '') { $skipped++; continue; }

        $existing = ms_row('select id from users where id = ? or email = ?', [$id, $email]);
        if ($existing !== null) {
            if (!$dry) {
                // Name and avatar only. A password already set on this site is
                // newer than the one in the file and must not be rolled back
                // to it — somebody who has already used the reset link would
                // otherwise be returned to a password they no longer know.
                ms_exec('update users set full_name = ?, avatar_url = ?, updated_at = ?
                          where id = ?',
                    [(string)($u['fullName'] ?? ''), (string)($u['avatarUrl'] ?? ''),
                     ms_now(), $existing['id']]);
            }
            $updated++;
            continue;
        }

        if (!$dry) {
            ms_exec('insert into users (id, email, password_hash, full_name, avatar_url,
                                        created_at, updated_at)
                     values (?, ?, ?, ?, ?, ?, ?)',
                [$id, $email,
                 isset($u['passwordHash']) && $u['passwordHash'] !== null
                     ? (string)$u['passwordHash'] : null,
                 (string)($u['fullName'] ?? ''), (string)($u['avatarUrl'] ?? ''),
                 $stamp($u['createdAt'] ?? null), ms_now()]);
        }
        $added++;
    }

    echo 'Accounts: ' . $added . ' added, ' . $updated . ' already here'
        . ($skipped ? ', ' . $skipped . ' skipped (no id or address)' : '') . "\n";

    /* ---- maps ---------------------------------------------------------- */

    $pAdded = 0; $pUpdated = 0; $pSkipped = 0; $orphans = [];

    foreach ($data['projects'] as $p) {
        $id = (string)($p['id'] ?? '');
        $owner = (string)($p['ownerId'] ?? '');
        if ($id === '' || $owner === '') { $pSkipped++; continue; }

        // A map whose owner is not in the file cannot be imported: owner_id is
        // a foreign key, and inserting it would fail the whole transaction.
        // Collected and reported rather than silently dropped, because it
        // means the export missed an account.
        if (ms_row('select id from users where id = ?', [$owner]) === null) {
            $orphans[] = $id;
            $pSkipped++;
            continue;
        }

        $json = json_encode($p['data'] ?? null, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($json === false) {
            echo '  ! could not encode the map ' . $id . ' — ' . json_last_error_msg() . "\n";
            $pSkipped++;
            continue;
        }

        $counts = is_array($p['counts'] ?? null) ? $p['counts'] : [];
        $n = static fn(string $k): int => max(0, (int)($counts[$k] ?? 0));

        $existing = ms_row('select id from map_projects where id = ?', [$id]);
        if ($existing !== null && !$replace) {
            $pUpdated++;
            continue;
        }

        if (!$dry) {
            if ($existing !== null) {
                ms_exec('update map_projects
                            set owner_id = ?, name = ?, place = ?, data = ?, n_locations = ?,
                                n_sites = ?, n_routes = ?, n_shapes = ?, bytes = ?, updated_at = ?
                          where id = ?',
                    [$owner, (string)($p['name'] ?? 'Untitled map project'),
                     (string)($p['place'] ?? ''), $json, $n('locations'), $n('sites'),
                     $n('routes'), $n('shapes'), strlen($json),
                     $stamp($p['updatedAt'] ?? null), $id]);
            } else {
                ms_exec('insert into map_projects
                           (id, owner_id, name, place, data, n_locations, n_sites, n_routes,
                            n_shapes, bytes, created_at, updated_at)
                         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [$id, $owner, (string)($p['name'] ?? 'Untitled map project'),
                     (string)($p['place'] ?? ''), $json, $n('locations'), $n('sites'),
                     $n('routes'), $n('shapes'), strlen($json),
                     $stamp($p['createdAt'] ?? null), $stamp($p['updatedAt'] ?? null)]);
            }
        }
        $existing !== null ? $pUpdated++ : $pAdded++;
    }

    echo 'Maps:     ' . $pAdded . ' added, ' . $pUpdated
        . ($replace ? ' overwritten' : ' already here (left alone — use --replace to overwrite)')
        . ($pSkipped ? ', ' . $pSkipped . ' skipped' : '') . "\n";

    if ($orphans) {
        echo "\n  ! " . count($orphans) . " map(s) name an owner who is not in the export.\n"
            . "    Their accounts were probably deleted in Supabase. They are not imported.\n";
    }

    if ($dry) {
        $pdo->rollBack();
        echo "\nDry run — nothing was written.\n";
    } else {
        $pdo->commit();
        echo "\nDone. Sign in and check the list before deleting the export file.\n";
    }
} catch (Throwable $e) {
    $pdo->rollBack();
    /*
     * Everything or nothing. A partial import is the state that is hardest to
     * reason about — some accounts present, some maps missing, no record of
     * where it stopped — so the transaction is what turns a failure into
     * "nothing happened, read the message, run it again".
     */
    echo "\nImport failed and nothing was written:\n  " . $e->getMessage() . "\n";
    exit(1);
}
