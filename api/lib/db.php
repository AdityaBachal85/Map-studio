<?php
/**
 * api/lib/db.php — the one connection, and the only place a credential is read.
 *
 * PDO with emulated prepares OFF and exceptions ON. Both matter:
 *
 * Emulated prepares make PDO interpolate parameters into the SQL string
 * itself, which puts the escaping back in PHP's hands — the thing parameters
 * exist to avoid. Off, the values travel to MySQL separately from the
 * statement and cannot change its shape whatever they contain.
 *
 * ERRMODE_EXCEPTION because the alternative is silence: without it a failed
 * INSERT returns false, and code that does not check every return value
 * carries on as though the row were written. A save that reports success and
 * stores nothing is the worst failure this application could have.
 */

declare(strict_types=1);

/**
 * The shared connection, opened on first use.
 */
function ms_db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $cfg = ms_config();

    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ];

    try {
        if ($cfg['db_driver'] === 'sqlite') {
            // Tests only — see diagnostics/accounts-api.cjs. Never production:
            // a file-backed database on shared hosting would be world-readable
            // in public_html and would lose writes under concurrency.
            $pdo = new PDO('sqlite:' . $cfg['db_sqlite_path'], null, null, $options);
            $pdo->exec('PRAGMA foreign_keys = ON');
        } else {
            $dsn = sprintf(
                'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
                $cfg['db_host'],
                $cfg['db_port'],
                $cfg['db_name']
            );
            $pdo = new PDO($dsn, $cfg['db_user'], $cfg['db_pass'], $options);
        }
    } catch (PDOException $e) {
        /*
         * The exception message from a failed connection contains the host,
         * the database name and sometimes the user — which is why it is logged
         * and not returned. What the caller gets back is the fact, plus the
         * three things that are actually wrong when this happens on Hostinger,
         * in the order they happen.
         */
        error_log('Map Studio: database connection failed — ' . $e->getMessage());
        $detail = ms_config()['debug'] ? ' (' . $e->getMessage() . ')' : '';
        ms_fail(503,
            'The database is not reachable.' . $detail . ' Check that the database name, user and '
            . 'password in the config file match hPanel → Databases exactly, that the user is '
            . 'assigned to that database, and that the host is "localhost".',
            'db_unreachable');
    }

    return $pdo;
}

/**
 * Run a statement with parameters.
 *
 * @param array<string,mixed>|list<mixed> $params
 */
function ms_exec(string $sql, array $params = []): PDOStatement
{
    $st = ms_db()->prepare($sql);
    $st->execute($params);
    return $st;
}

/**
 * One row, or null.
 *
 * @param array<string,mixed>|list<mixed> $params
 * @return array<string,mixed>|null
 */
function ms_row(string $sql, array $params = []): ?array
{
    $row = ms_exec($sql, $params)->fetch();
    return is_array($row) ? $row : null;
}

/**
 * Every row.
 *
 * @param array<string,mixed>|list<mixed> $params
 * @return list<array<string,mixed>>
 */
function ms_rows(string $sql, array $params = []): array
{
    /** @var list<array<string,mixed>> $rows */
    $rows = ms_exec($sql, $params)->fetchAll();
    return $rows;
}
