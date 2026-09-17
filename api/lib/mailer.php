<?php
/**
 * api/lib/mailer.php — the one email this application sends.
 *
 * WHY PHP'S mail() AND NOT SMTP. Hostinger's shared plans route mail() through
 * their own outbound server, already authenticated as the account, with SPF
 * and DKIM applied for a domain they host. Configuring SMTP by hand on top of
 * that means storing a mailbox password in the config file and re-authenticating
 * to the same server the sending process is already trusted by. The one thing
 * it would buy — a clear protocol-level error when a message is rejected —
 * is worth less than not having that password on disk.
 *
 * WHAT THIS CANNOT TELL YOU. mail() returns whether the message was handed to
 * the local mail system, not whether it was delivered. A true here means it
 * was accepted for sending; it does not mean it arrived, was not filed as
 * spam, or that the address exists. So the reset endpoint tells the caller
 * what it did ("if that address has an account, a link is on its way") rather
 * than what happened, which is also what stops it being used to discover who
 * has an account.
 *
 * The From address must be a real mailbox on the site's own domain. Sending as
 * a domain Hostinger does not host is either refused outright or accepted and
 * then filed as spam by the receiving end, and the second is worse because it
 * looks like it worked.
 */

declare(strict_types=1);

/**
 * Send a password-reset link.
 *
 * @return bool whether the message was accepted for delivery
 */
function ms_send_reset_email(string $email, string $name, string $link, int $minutes): bool
{
    $cfg = ms_config();
    $from = $cfg['mail_from'];

    if ($from === '') {
        error_log('Map Studio: password reset requested but mail_from is not set in the config.');
        return false;
    }

    $who = $name !== '' ? $name : 'there';

    $body = "Hello $who,\r\n\r\n"
        . "Someone asked to reset the password for your Map Studio account.\r\n"
        . "Open this link to choose a new one:\r\n\r\n"
        . "$link\r\n\r\n"
        . "The link stops working in $minutes minutes, and can only be used once.\r\n\r\n"
        . "If this was not you, nothing has changed and you can ignore this message —\r\n"
        . "your current password still works.\r\n";

    /*
     * Headers built from a validated address, not from anything a caller sent.
     * A newline inside a From: value would let a request append headers of its
     * own — a Bcc, most usefully — and turn this into an open relay. The
     * address comes from the config file, but it is checked anyway, because
     * the cost of being wrong here is somebody else's spam problem carrying
     * this domain's name.
     */
    if (filter_var($from, FILTER_VALIDATE_EMAIL) === false) {
        error_log('Map Studio: mail_from is not a valid address — ' . $from);
        return false;
    }
    $fromName = str_replace(["\r", "\n"], '', $cfg['mail_from_name']);

    $headers = [
        'From: ' . ms_encode_header($fromName) . ' <' . $from . '>',
        'Reply-To: ' . $from,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        'MIME-Version: 1.0',
        'Auto-Submitted: auto-generated',
        'X-Mailer: Map Studio',
    ];

    // The recipient is a stored, validated address; checked again for the same
    // reason as above.
    if (filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
        return false;
    }

    $sent = @mail(
        $email,
        ms_encode_header('Reset your Map Studio password'),
        $body,
        implode("\r\n", $headers),
        '-f' . $from
    );

    if (!$sent) {
        error_log('Map Studio: mail() refused the reset message for ' . $email);
    }
    return $sent;
}

/**
 * RFC 2047 encoding for a header that may contain non-ASCII.
 *
 * A raw UTF-8 subject line is legal in modern mail and mangled by enough older
 * software to be worth encoding, and doing so also removes any possibility of
 * a stray control character reaching the header block.
 */
function ms_encode_header(string $text): string
{
    $clean = str_replace(["\r", "\n"], '', $text);
    if (preg_match('/^[\x20-\x7E]*$/', $clean) === 1) {
        return $clean;
    }
    return '=?UTF-8?B?' . base64_encode($clean) . '?=';
}
