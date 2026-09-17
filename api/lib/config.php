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

    $candidates = array_values(array_filter([
        /*
         * An explicit path, when something set one. Used by the test harness
         * so a test run never writes a config into the deployed tree, and
         * available in production to anyone whose hosting lets them set an
         * environment variable and who wants the file somewhere else again.
         */
        (string)(getenv('MAPSTUDIO_CONFIG') ?: ''),
        // Preferred: beside public_html, not inside it.
        dirname(__DIR__, 3) . '/map-studio-config.php',
        // Accepted: alongside the API, for plans without shell access.
        dirname(__DIR__) . '/config.php',
    ], static fn(string $p): bool => $p !== ''));

    $found = null;
    foreach ($candidates as $path) {
        if (is_file($path) && is_readable($path)) {
            $found = $path;
            break;
        }
    }

    if ($found === null) {
        ms_config_fail(
            'No configuration file. Copy api/config.sample.php to '
            . dirname(__DIR__, 3) . '/map-studio-config.php (preferred) or to '
            . dirname(__DIR__) . '/config.php, and fill in the database details.'
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
