<?php
/**
 * api/routes/projects.php — the project list, and the maps in it.
 *
 * ---------------------------------------------------------------------------
 * EVERY QUERY IN THIS FILE CARRIES `owner_id = :me`, AND :me IS THE SESSION
 *
 * This is the file that replaced Row Level Security, so it is worth being
 * plain about what changed. Under Supabase these queries deliberately carried
 * no ownership test — Postgres applied one to every row, from the id proven by
 * a signed token, and a client that asked for somebody else's project simply
 * received nothing. The old cloudProjects.js said so in its header, and said
 * that a leak would be a missing policy rather than a missing WHERE clause.
 *
 * It is a missing WHERE clause now. MySQL will return whatever it is asked
 * for. So the owner comes from ms_require_user() — the session cookie — on
 * every single path below, and the project id from the URL is only ever the
 * second half of the test. A caller may name any id they like; what they
 * cannot do is name whose it is.
 *
 * A row that exists but belongs to somebody else answers 404, not 403. A 403
 * would confirm the project exists, which is a small leak and a free one to
 * avoid: from outside, "not yours" and "not there" are the same answer.
 *
 * ---------------------------------------------------------------------------
 * `data` IS FETCHED ONLY WHEN A MAP IS OPENED
 *
 * The list reads the summary columns and never touches it. That is the
 * difference between a list that opens instantly and one that downloads
 * megabytes of geometry to show four names — see the note in
 * sql/hostinger-mysql.sql about why those columns are denormalised.
 */

declare(strict_types=1);

/** Columns the list needs. Never includes `data`. */
const MS_META_COLS = 'id, owner_id, name, place, n_locations, n_sites, n_routes, n_shapes, '
    . 'bytes, created_at, updated_at';

/**
 * @param list<string> $seg path after /projects
 */
function ms_route_projects(string $method, array $seg): void
{
    $user = ms_require_user();
    $first = $seg[0] ?? '';

    if ($first === '' && $method === 'GET') {
        ms_projects_list($user);
    }
    if ($first === '' && $method === 'POST') {
        ms_require_csrf();
        ms_projects_save($user);
    }
    // Before the {id} routes below, or a project could never be called
    // "storage" — and, more to the point, this would try to load one.
    if ($first === 'storage' && $method === 'GET') {
        ms_projects_storage($user);
    }

    if ($first !== '') {
        $id = $first;
        $sub = $seg[1] ?? '';

        if ($sub === '' && $method === 'GET') {
            ms_projects_load($user, $id);
        }
        if ($sub === 'meta' && $method === 'GET') {
            ms_projects_meta($user, $id);
        }
        if ($sub === 'duplicate' && $method === 'POST') {
            ms_require_csrf();
            ms_projects_duplicate($user, $id);
        }
        if ($sub === '' && ($method === 'PATCH' || $method === 'POST')) {
            ms_require_csrf();
            ms_projects_rename($user, $id);
        }
        if ($sub === '' && $method === 'DELETE') {
            ms_require_csrf();
            ms_projects_delete($user, $id);
        }
    }

    ms_fail(404, 'No such endpoint: /projects/' . implode('/', $seg), 'no_route');
}

/**
 * Present a row the way the list page expects it.
 *
 * @param array<string,mixed> $r
 * @return array<string,mixed>
 */
function ms_project_meta(array $r): array
{
    return [
        'id'       => (string)$r['id'],
        'name'     => (string)$r['name'],
        'ownerId'  => (string)$r['owner_id'],
        'place'    => (string)($r['place'] ?? ''),
        'created'  => strtotime((string)$r['created_at']) * 1000,
        'modified' => strtotime((string)$r['updated_at']) * 1000,
        'counts'   => [
            'locations' => (int)$r['n_locations'],
            'sites'     => (int)$r['n_sites'],
            'routes'    => (int)$r['n_routes'],
            'shapes'    => (int)$r['n_shapes'],
        ],
        'bytes'    => (int)$r['bytes'],
    ];
}

/** @param array<string,mixed> $user */
function ms_projects_list(array $user): void
{
    $rows = ms_rows(
        'select ' . MS_META_COLS . ' from map_projects where owner_id = ? order by updated_at desc',
        [$user['id']]
    );
    ms_send(200, ['projects' => array_map('ms_project_meta', $rows)]);
}

/** @param array<string,mixed> $user */
function ms_projects_meta(array $user, string $id): void
{
    $row = ms_project_owned($user, $id, MS_META_COLS);
    ms_send(200, ['project' => ms_project_meta($row)]);
}

/** @param array<string,mixed> $user */
function ms_projects_load(array $user, string $id): void
{
    $row = ms_project_owned($user, $id, 'id, data');

    /*
     * `data` goes back as it was stored, not re-encoded. It is already the
     * JSON the app produced, and decoding it here only to encode it again
     * costs two passes over several megabytes and risks changing it — PHP's
     * json_decode/encode round trip does not preserve large integers or the
     * distinction between an empty object and an empty array, and a map
     * project contains both.
     */
    $data = $row['data'] === null ? 'null' : (string)$row['data'];
    header('Content-Type: application/json; charset=utf-8');
    http_response_code(200);
    echo '{"data":' . $data . '}';
    exit;
}

/**
 * Create or update, in one request.
 *
 * @param array<string,mixed> $user
 */
function ms_projects_save(array $user): void
{
    $body = ms_json_body();
    $project = $body['project'] ?? null;
    if (!is_array($project)) {
        ms_fail(400, 'That save carried no map.', 'no_project');
    }

    $name = ms_body_str('name');
    if ($name === '') {
        $name = 'Untitled map project';
    }
    $name = mb_substr($name, 0, 255);
    $place = mb_substr(ms_body_str('place'), 0, 255);

    $json = json_encode($project, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        ms_fail(400, 'That map could not be encoded for storage: '
            . json_last_error_msg() . '.', 'bad_project');
    }

    /*
     * Counts come from the client because it is the client that knows the
     * project's shape — js/projects/projectStore.js counts locations, sites,
     * routes and shapes out of the live object, and reimplementing that here
     * would mean two definitions of "a site" drifting apart. They are display
     * figures on a list row and nothing is authorised by them, so accepting
     * them costs nothing; each is clamped to a sane integer anyway.
     *
     * `bytes` is NOT taken from the client. It is the stored length, measured
     * here, because it is the number the storage total is summed from.
     */
    $counts = is_array($body['counts'] ?? null) ? $body['counts'] : [];
    $n = static fn(string $k): int => max(0, min(1000000, (int)($counts[$k] ?? 0)));

    $id = ms_body_str('id');
    $now = ms_now();

    if ($id !== '') {
        if (!ms_valid_id($id)) {
            ms_fail(400, 'That project id is not valid.', 'bad_id');
        }
        $existing = ms_row('select owner_id from map_projects where id = ?', [$id]);
        if ($existing !== null && (string)$existing['owner_id'] !== (string)$user['id']) {
            // Somebody else's row. Answered as "not found" — see the file note.
            ms_fail(404, 'That project does not exist.', 'not_found');
        }
        if ($existing !== null) {
            ms_exec(
                'update map_projects
                    set name = ?, place = ?, data = ?, n_locations = ?, n_sites = ?,
                        n_routes = ?, n_shapes = ?, bytes = ?, updated_at = ?
                  where id = ? and owner_id = ?',
                [$name, $place, $json, $n('locations'), $n('sites'), $n('routes'), $n('shapes'),
                 strlen($json), $now, $id, $user['id']]
            );
            ms_send(200, ['project' => ms_project_meta(ms_project_owned($user, $id, MS_META_COLS))]);
        }
    } else {
        $id = ms_uuid();
    }

    ms_exec(
        'insert into map_projects
           (id, owner_id, name, place, data, n_locations, n_sites, n_routes, n_shapes,
            bytes, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [$id, $user['id'], $name, $place, $json, $n('locations'), $n('sites'), $n('routes'),
         $n('shapes'), strlen($json), $now, $now]
    );

    ms_send(201, ['project' => ms_project_meta(ms_project_owned($user, $id, MS_META_COLS))]);
}

/** @param array<string,mixed> $user */
function ms_projects_rename(array $user, string $id): void
{
    ms_project_owned($user, $id, 'id');       // 404s before anything is written

    $name = ms_body_str('name');
    if ($name === '') {
        ms_fail(400, 'A project needs a name.', 'no_name');
    }

    $body = ms_json_body();
    if (array_key_exists('place', $body)) {
        ms_exec('update map_projects set name = ?, place = ?, updated_at = ? where id = ? and owner_id = ?',
            [mb_substr($name, 0, 255), mb_substr(ms_body_str('place'), 0, 255), ms_now(), $id, $user['id']]);
    } else {
        ms_exec('update map_projects set name = ?, updated_at = ? where id = ? and owner_id = ?',
            [mb_substr($name, 0, 255), ms_now(), $id, $user['id']]);
    }

    ms_send(200, ['ok' => true]);
}

/** @param array<string,mixed> $user */
function ms_projects_delete(array $user, string $id): void
{
    ms_project_owned($user, $id, 'id');
    ms_exec('delete from map_projects where id = ? and owner_id = ?', [$id, $user['id']]);
    ms_send(200, ['ok' => true]);
}

/** @param array<string,mixed> $user */
function ms_projects_duplicate(array $user, string $id): void
{
    $row = ms_project_owned($user, $id,
        'name, place, data, n_locations, n_sites, n_routes, n_shapes, bytes');

    $copy = ms_uuid();
    $now = ms_now();
    ms_exec(
        'insert into map_projects
           (id, owner_id, name, place, data, n_locations, n_sites, n_routes, n_shapes,
            bytes, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [$copy, $user['id'], mb_substr((string)$row['name'] . ' (copy)', 0, 255),
         (string)$row['place'], $row['data'], (int)$row['n_locations'], (int)$row['n_sites'],
         (int)$row['n_routes'], (int)$row['n_shapes'], (int)$row['bytes'], $now, $now]
    );

    ms_send(201, ['project' => ms_project_meta(ms_project_owned($user, $copy, MS_META_COLS))]);
}

/**
 * How much this account is storing.
 *
 * `quota` is null: a shared plan's disk allowance covers the whole site — the
 * app's own files, every other database, and any mail stored on it — so a
 * per-user figure derived from it would be invented. The count and the total
 * are real; the limit is not ours to state.
 *
 * @param array<string,mixed> $user
 */
function ms_projects_storage(array $user): void
{
    $row = ms_row('select count(*) as n, coalesce(sum(bytes), 0) as b
                     from map_projects where owner_id = ?', [$user['id']]);
    ms_send(200, [
        'bytes' => (int)($row['b'] ?? 0),
        'count' => (int)($row['n'] ?? 0),
        'quota' => null,
    ]);
}

/* ---------------------------------------------------------------------------
 * The ownership gate
 * ------------------------------------------------------------------------ */

/**
 * Fetch a project that belongs to this user, or stop with a 404.
 *
 * Every read and every write in this file goes through here first. It is one
 * function so that there is one place to audit, and so that adding a route
 * later means calling it rather than remembering to write the clause.
 *
 * @param array<string,mixed> $user
 * @return array<string,mixed>
 */
function ms_project_owned(array $user, string $id, string $columns): array
{
    if (!ms_valid_id($id)) {
        ms_fail(404, 'That project does not exist.', 'not_found');
    }
    $row = ms_row('select ' . $columns . ' from map_projects where id = ? and owner_id = ?',
        [$id, $user['id']]);
    if ($row === null) {
        ms_fail(404, 'That project does not exist.', 'not_found');
    }
    return $row;
}

/**
 * Is this a plausible project id?
 *
 * Checked before the query rather than trusting the placeholder alone. The
 * parameter is safe from injection either way; this is about not asking the
 * database a question built from a 4 KB path segment, and about giving a
 * mistyped URL a clean 404 instead of a lookup.
 */
function ms_valid_id(string $id): bool
{
    return $id !== '' && strlen($id) <= 36 && preg_match('/^[A-Za-z0-9_-]{1,36}$/', $id) === 1;
}
