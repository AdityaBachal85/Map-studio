<?php
/**
 * api/index.php — the only PHP file the web server is asked for.
 *
 * WHY A FRONT CONTROLLER RATHER THAN A FILE PER ENDPOINT. Files under
 * public_html are reachable, and a directory of them is a directory of things
 * that can be called directly, in any order, by anyone. With one entry point
 * the include order is fixed, the configuration is loaded before anything can
 * touch a database, and api/lib/ can be — and is — refused outright by
 * .htaccess, because nothing needs to fetch it.
 *
 * WHY THE ROUTE IS DERIVED THREE WAYS. The same package has to run on
 * Hostinger's LiteSpeed with the rewrite in api/.htaccess doing its job, on a
 * plan where mod_rewrite is off and the URL arrives as /api/index.php/auth/me,
 * and under `php -S` in the test harness, which has no .htaccess at all.
 * Guessing wrong produces a 404 on every endpoint with nothing to explain it,
 * so all three shapes are recognised rather than one being assumed.
 */

declare(strict_types=1);

require __DIR__ . '/lib/config.php';
require __DIR__ . '/lib/http.php';
require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/auth.php';
require __DIR__ . '/lib/mailer.php';
require __DIR__ . '/routes/auth.php';
require __DIR__ . '/routes/projects.php';

ms_send_common_headers();

/*
 * Errors become JSON, always.
 *
 * PHP's default is to print a warning into the response body and carry on,
 * which turns a successful-looking 200 into a document with an HTML notice
 * glued to the front of the JSON — and the client reports it as a parse error
 * at position 0, which says nothing about the actual fault. Converting
 * everything to an exception and catching it below means a failure arrives as
 * a failure, with a status code that matches.
 */
set_error_handler(static function (int $no, string $str, string $file, int $line): bool {
    if ((error_reporting() & $no) === 0) {
        return false;          // suppressed with @ — mail() uses this
    }
    throw new ErrorException($str, 0, $no, $file, $line);
});

// Never to the browser: a stack trace names the database credential often
// enough to treat it as though it always does.
ini_set('display_errors', '0');
ini_set('log_errors', '1');

try {
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

    /*
     * A preflight would only ever come from another origin, and this API is
     * same-origin by design — so it is refused here rather than being allowed
     * to reach a route. Answering it with CORS headers is what would open the
     * door; answering it with 405 closes it and says so.
     */
    if ($method === 'OPTIONS') {
        ms_fail(405, 'This API is same-origin only.', 'no_cors');
    }

    ms_dispatch();
} catch (Throwable $e) {
    ms_handle_throwable($e);
}

/**
 * Work out the route and run it.
 *
 * @return list<string>
 */
function ms_route_segments(): array
{
    $uri = (string)($_SERVER['REQUEST_URI'] ?? '/');
    $path = (string)(parse_url($uri, PHP_URL_PATH) ?? '/');

    // 1. PATH_INFO, when the server filled it in (the no-rewrite case).
    $info = (string)($_SERVER['PATH_INFO'] ?? '');
    if ($info === '') {
        // 2. Everything after this script's own directory.
        $script = (string)($_SERVER['SCRIPT_NAME'] ?? '/api/index.php');
        $dir = rtrim(str_replace('\\', '/', dirname($script)), '/');
        if ($dir !== '' && str_starts_with($path, $dir)) {
            $info = substr($path, strlen($dir));
        } else {
            $info = $path;
        }
        // 3. And, if the rewrite did not happen, the script name with it.
        $info = preg_replace('#^/index\.php#', '', $info) ?? $info;
    }

    $parts = array_values(array_filter(explode('/', trim($info, '/')), static fn($s) => $s !== ''));
    return array_map(static fn($s) => rawurldecode((string)$s), $parts);
}

function ms_dispatch(): void
{
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $seg = ms_route_segments();
    $head = $seg[0] ?? '';
    $rest = array_slice($seg, 1);

    // Written as branches rather than a switch because every one of these
    // functions exits rather than returning, and a switch whose cases never
    // break reads like a fall-through bug to anybody who has not noticed that.
    if ($head === 'auth') {
        ms_route_auth($method, $rest);
    }
    if ($head === 'projects') {
        ms_route_projects($method, $rest);
    }
    if ($head === 'health') {
        ms_route_health();
    }

    ms_fail(404,
        'No such endpoint. The accounts API answers under /auth and /projects.',
        'no_route');
}

/**
 * Does this install actually work?
 *
 * Deliberately says nothing that is not already obvious from outside: whether
 * the database answers, and which tables it found. No host, no user, no
 * version. It exists so that "is it the config or the app?" can be settled in
 * one request during a deploy, which is the question every first install asks.
 */
function ms_route_health(): void
{
    $tables = [];
    $ok = true;
    foreach (['users', 'sessions', 'map_projects', 'password_resets', 'login_attempts'] as $t) {
        try {
            ms_exec('select 1 from ' . $t . ' limit 1');
            $tables[$t] = true;
        } catch (Throwable $e) {
            $tables[$t] = false;
            $ok = false;
        }
    }
    ms_send($ok ? 200 : 503, [
        'ok' => $ok,
        'tables' => $tables,
        'hint' => $ok ? '' : 'Run sql/hostinger-mysql.sql in phpMyAdmin against this database.',
    ]);
}

/**
 * Turn anything thrown into a JSON failure.
 *
 * The message goes to the error log, where the operator can read it, and not
 * into the response, where a visitor could — with one exception: `debug` in
 * the config sends it back as well, for the first install, when the message is
 * the only thing that will explain what is wrong.
 */
function ms_handle_throwable(Throwable $e): void
{
    error_log('Map Studio API: ' . get_class($e) . ': ' . $e->getMessage()
        . ' at ' . $e->getFile() . ':' . $e->getLine());

    $debug = false;
    try {
        $debug = (bool)ms_config()['debug'];
    } catch (Throwable $ignored) {
        // Config itself failed; it has already answered.
    }

    if (headers_sent()) {
        exit;       // a route already answered; nothing useful to add
    }
    ms_send(500, array_filter([
        'error' => 'Something went wrong on the server.',
        'detail' => $debug ? get_class($e) . ': ' . $e->getMessage() : null,
    ], static fn($v) => $v !== null));
}
