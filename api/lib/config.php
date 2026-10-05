<?php
/**
 * api/lib/config.php — where the database credential comes from.
 *
 * WHY THE FILE IS LOOKED FOR OUTSIDE THE WEB ROOT FIRST. A .php file inside
 * public_html is normally executed rather than served, so its contents do not
 * reach a visitor — normally. The exceptions are the ones that matter: a plan
 * whose PHP handler is switched off or misconfigured during an upgrade serves
 * .php as plain text, and a stray backup (config.php.bak, config.php~, left by
 * an editor or by hPanel's own file manager) has no handler at all and is
 * served as text by definition. Both have leaked credentials off real shared
 * hosting, and neither is something this application can prevent from inside
 * public_html.
 *
 * One directory up is outside everything the web server will serve, under any
 * configuration, including the broken ones. So that is the first place looked
 * at, and the second exists because not every plan gives you a shell to put it
 * there with.
 *
 * NOTHING HERE HAS A DEFAULT THAT WOULD WORK. An absent or unreadable config
 * stops the API with a 500 and a sentence saying which file it wanted, rather
 * than falling back to something that half-runs — a deployment that appears to
 * work while storing nothing is worse than one that refuses to start.
 */

declare(strict_types=1);

/**
 * Read the configuration, once.
 *
 * @return array<string,mixed>
 */
function ms_config(): array
{
    static $cfg = null;
    if ($cfg !== null) {
        return $cfg;
    }

    $candidates = ms_config_candidates(__DIR__, ms_account_home(__DIR__));

    $found = null;
    foreach ($candidates as $path) {
        // Suppressed, not unguarded: a host with open_basedir set warns on a
        // path outside it, and index.php turns every warning into an exception
        // — which would make a harmless "not here" into a 500.
        if (@is_file($path) && @is_readable($path)) {
            $found = $path;
            break;
        }
    }

    if ($found === null) {
        // Names the exact paths, computed from where this file actually is.
        // A sentence saying "one level above public_html" is a riddle on a
        // host whose layout you have not seen; a full path is an instruction.
        ms_config_fail(
            'No configuration file yet. Copy api/config.sample.php, fill in the database '
            . 'details, and save it as: ' . $candidates[0]
            . (count($candidates) > 1
                ? '   (also accepted: ' . implode(', ', array_slice($candidates, 1)) . ')'
                : '')
        );
    }

    /** @var mixed $raw */
    $raw = require $found;
    if (!is_array($raw)) {
        ms_config_fail('The configuration file at ' . $found . ' must return an array.');
    }

    $cfg = ms_config_normalise($raw, $found);
    return $cfg;
}

/**
 * Where the configuration file may live, best first.
 *
 * WHY THE ACCOUNT'S HOME DIRECTORY COMES FIRST. This used to look one level
 * above the site's document root, on the assumption that the document root
 * was public_html and its parent was therefore private. That holds for a site
 * at the root of a domain and fails for the way Hostinger lays out a
 * subdomain: map.example.com is served from a folder INSIDE the main domain's
 * public_html, so "one level up" is the main site's web root — a place every
 * visitor to example.com can request files from. The safest location became
 * the least safe one exactly when the app moved to a subdomain.
 *
 * The account's home directory is outside every web root on the account,
 * whatever the domain layout, so it is checked first. The parent of the
 * document root is still accepted, but only when it is not itself inside a
 * public_html — which is precisely the subdomain case.
 *
 * Pure, and separate from ms_config(), so diagnostics/config-location.cjs can
 * check it against invented paths for both layouts.
 *
 * @param string $libDir this file's directory (…/api/lib)
 * @param string $home   the account's home directory, or ''
 * @return list<string>
 */
function ms_config_candidates(string $libDir, string $home): array
{
    $apiDir = dirname($libDir);
    $siteRoot = dirname($libDir, 2);
    $aboveSite = dirname($libDir, 3);

    $insideWebRoot = static fn(string $dir): bool =>
        preg_match('#/(public_html|www|htdocs)(/|$)#', $dir) === 1;

    $out = [];

    /*
     * An explicit path, when something set one. Used by the test harness so a
     * test run never writes a config into the deployed tree, and available to
     * anyone whose hosting lets them set an environment variable.
     */
    $env = (string)(getenv('MAPSTUDIO_CONFIG') ?: '');
    if ($env !== '') {
        $out[] = $env;
    }

    if ($home !== '') {
        $out[] = rtrim($home, '/') . '/map-studio-config.php';
    }

    if (!$insideWebRoot($aboveSite)) {
        $out[] = $aboveSite . '/map-studio-config.php';
    }

    // Last resort: beside the API, refused by api/.htaccess. Works on a plan
    // with no way to write outside the site's folder; depends on .htaccess.
    $out[] = $apiDir . '/config.php';

    return array_values(array_unique($out));
}

/**
 * The hosting account's home directory, or '' if it cannot be told.
 *
 * Read from the path rather than from $HOME, which a web server process
 * frequently does not have. Hostinger, like most shared hosts, puts every
 * account under /home/<user>/, and the site files are always somewhere beneath
 * it — so the first two segments of this file's own path are the answer.
 */
function ms_account_home(string $dir): string
{
    $dir = str_replace('\\', '/', $dir);
    if (preg_match('#^(/home/[^/]+)/#', $dir, $m) === 1) {
        return $m[1];
    }
    $env = (string)(getenv('HOME') ?: '');
    return ($env !== '' && str_starts_with($dir, rtrim($env, '/') . '/')) ? rtrim($env, '/') : '';
}

/**
 * Fill in what can be defaulted, and refuse what cannot.
 *
 * @param array<string,mixed> $raw
 * @return array<string,mixed>
 */
function ms_config_normalise(array $raw, string $path): array
{
    $driver = (string)($raw['db_driver'] ?? 'mysql');

    if ($driver === 'mysql') {
        foreach (['db_host', 'db_name', 'db_user'] as $key) {
            if (!isset($raw[$key]) || $raw[$key] === '') {
                ms_config_fail('Missing ' . $key . ' in ' . $path . '.');
            }
        }
    }

    return [
        'db_driver' => $driver,
        'db_host'   => (string)($raw['db_host'] ?? ''),
        'db_port'   => (int)($raw['db_port'] ?? 3306),
        'db_name'   => (string)($raw['db_name'] ?? ''),
        'db_user'   => (string)($raw['db_user'] ?? ''),
        'db_pass'   => (string)($raw['db_pass'] ?? ''),
        // Tests only. Production never sets this.
        'db_sqlite_path' => (string)($raw['db_sqlite_path'] ?? ''),

        /*
         * Sign-up is limited to this domain. Empty allows any address.
         *
         * Enforced here, on the server, unlike the identical check in
         * js/config.js which exists only to give the common honest mistake a
         * useful sentence before the round trip.
         */
        'allowed_email_domain' => strtolower(trim((string)($raw['allowed_email_domain'] ?? ''))),

        /*
         * Whether a visitor can create their own account.
         *
         * Open by default because the domain restriction above is the real
         * gate — but a deployment with no domain restriction almost certainly
         * wants this off, and says so in the sample config.
         */
        'allow_signup' => (bool)($raw['allow_signup'] ?? true),

        /* How long a signed-in session lasts without being used. */
        'session_days' => max(1, (int)($raw['session_days'] ?? 30)),

        /* How long a password-reset link stays valid. */
        'reset_minutes' => max(5, (int)($raw['reset_minutes'] ?? 60)),

        /*
         * Sign-in throttle: how many failures from one address, or against one
         * account, inside the window before further attempts are refused.
         */
        'max_attempts'    => max(3, (int)($raw['max_attempts'] ?? 10)),
        'attempt_minutes' => max(1, (int)($raw['attempt_minutes'] ?? 15)),

        /*
         * The From: address on a password-reset email. Must be a real mailbox
         * on this domain — Hostinger's outbound mail refuses to send as a
         * domain it does not host, and a message that is accepted but forged
         * lands in spam, which is the same as not arriving.
         */
        'mail_from'      => (string)($raw['mail_from'] ?? ''),
        'mail_from_name' => (string)($raw['mail_from_name'] ?? 'Map Studio'),

        /*
         * The public origin, used to build reset links. Empty means "work it
         * out from the request", which is right in almost every case and wrong
         * behind a proxy that rewrites Host — so it can be pinned.
         */
        'app_url' => rtrim((string)($raw['app_url'] ?? ''), '/'),

        /*
         * Show PHP's own error text in API responses. Off in production: a
         * database error otherwise reports the credential in its message.
         */
        'debug' => (bool)($raw['debug'] ?? false),
    ];
}

/**
 * Stop, with a message meant for whoever is installing this.
 *
 * Deliberately not routed through the JSON error path in http.php: this can
 * fire before that file is loaded, and a configuration failure is the one
 * error where the person reading it is the operator rather than a user.
 */
function ms_config_fail(string $message): void
{
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode([
        'error' => 'Server is not configured',
        'detail' => $message,
    ], JSON_UNESCAPED_SLASHES);
    exit;
}
