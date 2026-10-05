<?php
/**
 * api/lib/http.php — reading a request and answering it.
 *
 * Every response from this API is JSON, including the failures. An HTML error
 * page in the middle of a fetch() is how you get "Unexpected token < in JSON
 * at position 0" in a browser console, which tells the person nothing about
 * what went wrong; a 500 that still parses can carry a sentence.
 */

declare(strict_types=1);

/**
 * The largest request body accepted, in bytes.
 *
 * A map project is the reason this is measured in megabytes rather than
 * kilobytes: the serialised form carries every route's geometry, and a dense
 * one runs to a few MB. Twenty is comfortably above anything seen and well
 * under the post_max_size a Hostinger plan ships with, so the refusal below is
 * ours — with an explanation — rather than PHP's, which is a truncated body
 * and a JSON parse error.
 */
const MS_MAX_BODY = 20 * 1024 * 1024;

/**
 * Headers that apply to every response, sent before any route runs.
 */
function ms_send_common_headers(): void
{
    header('Content-Type: application/json; charset=utf-8');

    /*
     * No store, not merely no cache. These responses carry the project list
     * and the signed-in identity; a shared proxy holding one and handing it to
     * the next person is the failure this prevents.
     */
    header('Cache-Control: no-store, private');

    /*
     * The API is same-origin only, and says so by sending no CORS headers at
     * all. Nothing here is meant to be called from another site, and the
     * moment an Access-Control-Allow-Origin appears, the SameSite=Lax cookie
     * in auth.php stops being the second lock it is relied on to be.
     */
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
}

/**
 * Send a JSON response and stop.
 *
 * @param int $status
 * @param array<string,mixed>|list<mixed> $payload
 */
function ms_send(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Refuse, with a message written for the person who will read it.
 *
 * `code` is a short machine-readable tag the client switches on when it needs
 * to react differently — not for display. The message is the part shown.
 */
function ms_fail(int $status, string $message, string $code = ''): void
{
    $out = ['error' => $message];
    if ($code !== '') {
        $out['code'] = $code;
    }
    ms_send($status, $out);
}

/**
 * The decoded JSON body, or an empty array for a request that has none.
 *
 * @return array<string,mixed>
 */
function ms_json_body(): array
{
    static $body = null;
    if ($body !== null) {
        return $body;
    }

    $length = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($length > MS_MAX_BODY) {
        ms_fail(413, 'That map is too large to save — ' . ms_bytes_human($length)
            . ', and the limit is ' . ms_bytes_human(MS_MAX_BODY) . '.', 'too_large');
    }

    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        $body = [];
        return $body;
    }

    /*
     * A body that arrived truncated — the connection dropped, or PHP's own
     * post_max_size cut it — parses as invalid JSON. Saying so beats the
     * generic "invalid request", because the fix is different: this one is
     * worth retrying.
     */
    if (strlen($raw) > MS_MAX_BODY) {
        ms_fail(413, 'That request body is larger than the limit of '
            . ms_bytes_human(MS_MAX_BODY) . '.', 'too_large');
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        ms_fail(400, 'The request body was not valid JSON. If this was a large map, '
            . 'it may have been cut short in transit — try saving again.', 'bad_json');
    }

    $body = $decoded;
    return $body;
}

/**
 * A string field from the JSON body, trimmed.
 */
function ms_body_str(string $key, string $default = ''): string
{
    $body = ms_json_body();
    $v = $body[$key] ?? $default;
    if (is_string($v)) {
        return trim($v);
    }
    if (is_int($v) || is_float($v)) {
        return (string)$v;
    }
    return $default;
}

/**
 * The caller's address, for throttling and for the session record.
 *
 * Hostinger terminates TLS and proxies in front of PHP, so REMOTE_ADDR is the
 * proxy on some plans rather than the visitor. X-Forwarded-For is therefore
 * read first — with the caveat that a client can send that header itself, so
 * this is a value good enough to rate-limit and log against and not one to
 * make a security decision on. Nothing here does.
 */
function ms_client_ip(): string
{
    $fwd = (string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
    if ($fwd !== '') {
        // Left-most entry is the original client; the rest are proxies.
        $first = trim(explode(',', $fwd)[0]);
        if (filter_var($first, FILTER_VALIDATE_IP) !== false) {
            return substr($first, 0, 45);
        }
    }
    $remote = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    return substr($remote, 0, 45);
}

/**
 * Whether this request arrived over HTTPS.
 *
 * Checks the forwarded header before $_SERVER['HTTPS'] for the same reason
 * .htaccess does: with TLS terminated in front of the application, HTTPS is
 * not reliably 'on' even for a visitor who arrived over it, and getting this
 * wrong means a session cookie that is never marked Secure.
 */
function ms_is_https(): bool
{
    $proto = strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''));
    if ($proto !== '') {
        return $proto === 'https';
    }
    $https = strtolower((string)($_SERVER['HTTPS'] ?? ''));
    return $https !== '' && $https !== 'off';
}

/**
 * The public origin this deployment is reached at, e.g. https://example.com.
 */
function ms_origin(): string
{
    $cfg = ms_config();
    if ($cfg['app_url'] !== '') {
        return $cfg['app_url'];
    }
    $host = (string)($_SERVER['HTTP_HOST'] ?? 'localhost');
    return (ms_is_https() ? 'https://' : 'http://') . $host;
}

/**
 * The directory the app is served from, e.g. '' for a site at the root.
 *
 * The API lives at <base>/api, so the app itself is one level above whatever
 * directory this script is in. Derived rather than configured, because the
 * same package has to work at a domain root, in a subdirectory, and on a
 * local `php -S` during testing.
 */
function ms_app_base(): string
{
    $script = (string)($_SERVER['SCRIPT_NAME'] ?? '/api/index.php');
    $dir = rtrim(str_replace('\\', '/', dirname($script)), '/');   // …/api
    $base = preg_replace('#/api$#', '', $dir);
    return $base === null ? '' : $base;
}

/** Human-readable byte count, for messages people read. */
function ms_bytes_human(int $n): string
{
    if ($n >= 1024 * 1024) {
        return round($n / (1024 * 1024), 1) . ' MB';
    }
    if ($n >= 1024) {
        return round($n / 1024) . ' KB';
    }
    return $n . ' bytes';
}

/**
 * A UUID (version 4), as canonical text.
 *
 * random_bytes() is cryptographically secure and throws rather than returning
 * weak output if the system has no entropy source — which is the behaviour
 * wanted, since these ids name sessions and reset tokens as well as rows.
 */
function ms_uuid(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);   // version 4
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);   // variant 1
    $hex = bin2hex($b);
    return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4)
        . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20, 12);
}

/** A URL-safe random token, and its storable hash. @return array{0:string,1:string} */
function ms_new_token(): array
{
    $token = bin2hex(random_bytes(32));
    return [$token, hash('sha256', $token)];
}

/** Now, as the string format every datetime column here uses (UTC). */
function ms_now(): string
{
    return gmdate('Y-m-d H:i:s');
}

/** A moment in the future, same format. */
function ms_future(int $seconds): string
{
    return gmdate('Y-m-d H:i:s', time() + $seconds);
}
