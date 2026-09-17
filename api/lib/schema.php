<?php
/**
 * api/lib/schema.php — what the database is supposed to look like, and whether
 * it does.
 *
 * WHY THIS EXISTS AT ALL, when sql/hostinger-mysql.sql already describes the
 * schema. Because `create table if not exists` finds an existing `users` table
 * and skips it — silently, successfully, and without adding the columns that
 * were added to that file later. So the honest advice for an upgrade cannot be
 * "run the SQL again": it would report success and change nothing, and the
 * first symptom would be an admin panel that cannot see who is an admin.
 *
 * The definitions below are read by two callers, deliberately sharing one list:
 *
 *   api/cli/migrate.php   adds whatever is missing
 *   /api/health           says whether anything is
 *
 * so a deployment cannot be in a state the health check calls fine and the
 * application then trips over.
 *
 * ADDITIVE ONLY. Nothing here drops a column, narrows a type or deletes a row.
 * A migration that can destroy data is a migration somebody will eventually run
 * against the wrong database, and the cost of that asymmetry — an old column
 * lingering after a rename — is one unused column.
 */

declare(strict_types=1);

/**
 * Columns each table must have, with the DDL to add them.
 *
 * The type strings are written to be accepted by both MySQL and SQLite, since
 * the test harness runs the same migration the deployment does. SQLite is
 * relaxed about type names and both understand `not null default <literal>`,
 * which is the whole of what is used here.
 *
 * Every added column has a DEFAULT, and that is not decoration: SQLite refuses
 * to add a NOT NULL column without one to a table that already has rows, and
 * MySQL would fill it with an implicit zero-value that means nothing.
 *
 * @return array<string, array<string, string>>
 */
function ms_schema_columns(): array
{
    return [
        'users' => [
            'role'                 => "varchar(16) not null default 'user'",
            'status'               => "varchar(16) not null default 'active'",
            'must_change_password' => 'tinyint(1) not null default 0',
            'created_by'           => 'char(36) null',
            'last_seen_at'         => 'datetime null',
        ],
    ];
}

/**
 * Tables that must exist, with the DDL to create them.
 *
 * @return array<string, string>
 */
function ms_schema_tables(string $driver): array
{
    $mysql = $driver !== 'sqlite';

    return [
        'users'          => '',      // created by sql/hostinger-mysql.sql, never here
        'sessions'       => '',
        'map_projects'   => '',
        'password_resets' => '',
        'login_attempts' => '',
        'admin_log' => $mysql
            ? 'create table if not exists admin_log (
                 id           bigint unsigned not null auto_increment,
                 actor_id     char(36)         null,
                 actor_email  varchar(190) not null default \'\',
                 action       varchar(40)  not null,
                 target_id    char(36)         null,
                 target_email varchar(190) not null default \'\',
                 detail       varchar(255) not null default \'\',
                 at           datetime     not null default current_timestamp,
                 primary key (id),
                 key admin_log_at_idx (at),
                 key admin_log_target_idx (target_id)
               ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci'
            : 'create table if not exists admin_log (
                 id           integer primary key autoincrement,
                 actor_id     text,
                 actor_email  text not null default \'\',
                 action       text not null,
                 target_id    text,
                 target_email text not null default \'\',
                 detail       text not null default \'\',
                 at           text not null
               )',
    ];
}

/**
 * Which columns a table actually has.
 *
 * Two dialects because the test harness runs SQLite and the deployment runs
 * MySQL, and asking the wrong one throws rather than returning an empty list —
 * which would look like "every column is missing" and start adding them.
 *
 * @return list<string>
 */
function ms_table_columns(string $table): array
{
    $driver = ms_config()['db_driver'];

    if ($driver === 'sqlite') {
        // No parameter binding: PRAGMA does not accept one. The table name
        // comes from the constant list above and never from a request, and it
        // is checked against that list before it gets here.
        $rows = ms_rows('pragma table_info(' . ms_safe_identifier($table) . ')');
        return array_map(static fn(array $r): string => (string)$r['name'], $rows);
    }

    $rows = ms_rows(
        'select column_name from information_schema.columns
          where table_schema = database() and table_name = ?',
        [$table]
    );
    // MySQL 8 returns COLUMN_NAME upper-cased through some drivers and lower
    // through others; normalising here saves every caller from caring.
    return array_map(
        static fn(array $r): string => strtolower((string)(($r['column_name'] ?? $r['COLUMN_NAME']) ?? '')),
        $rows
    );
}

/** Does this table exist at all? */
function ms_table_exists(string $table): bool
{
    try {
        ms_exec('select 1 from ' . ms_safe_identifier($table) . ' limit 1');
        return true;
    } catch (Throwable $e) {
        return false;
    }
}

/**
 * A table name that is safe to interpolate.
 *
 * Only ever called with a name from the constants above, so this is a guard
 * against a future edit rather than against a request — but interpolating a
 * name into SQL without one is the habit that eventually meets a variable.
 */
function ms_safe_identifier(string $name): string
{
    if (preg_match('/^[a-z_][a-z0-9_]*$/i', $name) !== 1) {
        throw new InvalidArgumentException('Unsafe identifier: ' . $name);
    }
    return $name;
}

/**
 * What is missing, as a list of human-readable sentences.
 *
 * Empty means the database matches. Used by /api/health to say so, and by
 * migrate.php to decide whether there is anything to do.
 *
 * @return list<string>
 */
function ms_schema_gaps(): array
{
    $gaps = [];
    $driver = ms_config()['db_driver'];

    foreach (ms_schema_tables($driver) as $table => $ddl) {
        if (!ms_table_exists($table)) {
            $gaps[] = $ddl === ''
                ? 'the table `' . $table . '` does not exist — run sql/hostinger-mysql.sql'
                : 'the table `' . $table . '` does not exist';
            continue;
        }
        $have = ms_table_columns($table);
        foreach (ms_schema_columns()[$table] ?? [] as $column => $type) {
            if (!in_array(strtolower($column), $have, true)) {
                $gaps[] = '`' . $table . '` is missing the column `' . $column . '`';
            }
        }
    }
    return $gaps;
}

/**
 * Add whatever is missing. Returns what it did.
 *
 * @return list<string>
 */
function ms_schema_apply(): array
{
    $done = [];
    $driver = ms_config()['db_driver'];

    foreach (ms_schema_tables($driver) as $table => $ddl) {
        if ($ddl !== '' && !ms_table_exists($table)) {
            ms_exec($ddl);
            $done[] = 'created the table `' . $table . '`';
        }
    }

    foreach (ms_schema_columns() as $table => $columns) {
        if (!ms_table_exists($table)) {
            continue;       // reported as a gap; creating it is not this file's job
        }
        $have = ms_table_columns($table);
        foreach ($columns as $column => $type) {
            if (in_array(strtolower($column), $have, true)) {
                continue;
            }
            ms_exec('alter table ' . ms_safe_identifier($table)
                . ' add column ' . ms_safe_identifier($column) . ' ' . $type);
            $done[] = 'added `' . $table . '`.`' . $column . '`';
        }
    }

    return $done;
}
