<?php
/**
 * diagnostics/php-router.php — the front door for `php -S`, in tests only.
 *
 * PHP's built-in server has no .htaccess, so the rewrite that sends
 * /api/anything to api/index.php does not exist. This does the same job in
 * eight lines, which is what lets diagnostics/accounts-api.cjs exercise the
 * real routing code — index.php's own three-way route detection — rather than
 * a stub of it.
 *
 * Everything that is not /api is served as a static file, so the harness can
 * also fetch login.html and the scripts beside it from the same origin.
 */

declare(strict_types=1);

$path = (string)(parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?? '/');

if (str_starts_with($path, '/api')) {
    // Shaped the way a server with the rewrite in place would present it:
    // SCRIPT_NAME names index.php, and the remainder is left in REQUEST_URI
    // for ms_route_segments() to find.
    $_SERVER['SCRIPT_NAME'] = '/api/index.php';
    $_SERVER['SCRIPT_FILENAME'] = dirname(__DIR__) . '/api/index.php';
    unset($_SERVER['PATH_INFO']);
    require dirname(__DIR__) . '/api/index.php';
    return true;
}

return false;   // let the built-in server serve the file
