<?php
/**
 * api/cli/migrate.php — bring an existing database up to date.
 *
 * WHY YOU CANNOT JUST RE-RUN THE SQL. sql/hostinger-mysql.sql is written with
 * `create table if not exists`, which is what makes it safe to paste twice —
 * and is exactly why it cannot upgrade anything. Run against a database that
 * already has a `users` table, it finds one, skips it, reports success, and
 * adds none of the columns that file grew later. The first symptom would be an
 * admin panel that cannot tell who is an administrator.
 *
 * So this reads what is actually in the database, compares it against
 * api/lib/schema.php, and adds only what is missing. It never drops a column,
 * never narrows a type, and never deletes a row.
 *
 * USAGE, over SSH:
 *
 *   cd public_html/api/cli
 *   php migrate.php --dry-run     # say what is missing, change nothing
 *   php migrate.php               # add it
 *
 * NO SSH? hPanel → Advanced → Cron Jobs runs the same command once. Set it a
 * few minutes out, check /api/health, then delete the job.
 *
 * You do not have to guess whether it is needed: /api/health says so, and says
 * exactly which column or table it is waiting for.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("This script only runs from the command line.\n");
}

require dirname(__DIR__) . '/lib/config.php';
require dirname(__DIR__) . '/lib/http.php';
require dirname(__DIR__) . '/lib/db.php';
require dirname(__DIR__) . '/lib/schema.php';

$dry = in_array('--dry-run', $argv, true);

$gaps = ms_schema_gaps();

if (!$gaps) {
    echo "The database is already up to date. Nothing to do.\n";
    exit(0);
}

echo "Missing:\n";
foreach ($gaps as $g) {
    echo '  - ' . $g . "\n";
}

/*
 * A missing TABLE that this script does not own is reported and not created.
 * sql/hostinger-mysql.sql is the one description of the core tables, and
 * having two places that can create `users` is how they come to disagree —
 * one with the right character set and one without.
 */
$blocked = array_filter($gaps, static fn(string $g): bool => str_contains($g, 'run sql/'));
if ($blocked) {
    echo "\nThis needs sql/hostinger-mysql.sql run first, in phpMyAdmin.\n"
        . "That file creates the core tables; this one only adds what was\n"
        . "introduced after they were made.\n";
    exit(1);
}

if ($dry) {
    echo "\n--dry-run: nothing was changed.\n";
    exit(0);
}

echo "\nApplying…\n";
$done = ms_schema_apply();
foreach ($done as $d) {
    echo '  ✓ ' . $d . "\n";
}

$left = ms_schema_gaps();
if ($left) {
    echo "\nStill missing after the run:\n";
    foreach ($left as $g) {
        echo '  - ' . $g . "\n";
    }
    exit(1);
}

echo "\nDone. /api/health will now report the schema as current.\n";
