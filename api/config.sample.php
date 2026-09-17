<?php
/**
 * api/config.sample.php — copy this, fill it in, and put the copy somewhere
 * the web server will not serve.
 *
 * WHERE TO PUT IT, in order of preference:
 *
 *   1. /home/uXXXXXXXXX/map-studio-config.php
 *      One level above public_html, so no URL can reach it under any server
 *      configuration — including the broken ones where .php is served as text.
 *      Use the File Manager or SSH to place it. This is the first path
 *      api/lib/config.php looks at.
 *
 *   2. public_html/api/config.php
 *      Works, and is refused by api/.htaccess, but the refusal now depends on
 *      .htaccess being honoured. Use this only if you cannot write outside
 *      public_html.
 *
 * DO NOT commit the filled-in copy. .gitignore already covers both names.
 *
 * The values come from hPanel → Databases → Management. Take them from that
 * page rather than typing them: the user and database names carry the account
 * prefix (uXXXXXXXXX_), and leaving it off is the single most common reason a
 * first install cannot connect.
 */

return [
    /* ---- database ------------------------------------------------------ */

    // Always 'localhost' on Hostinger shared hosting. The database runs on the
    // same machine as PHP; a remote host here needs Remote MySQL turned on in
    // hPanel and this server's address added to it.
    'db_host' => 'localhost',
    'db_port' => 3306,

    // Both carry the uXXXXXXXXX_ prefix hPanel shows. Copy them exactly.
    'db_name' => 'uXXXXXXXXX_mapstudio',
    'db_user' => 'uXXXXXXXXX_mapstudio',
    'db_pass' => '',

    /* ---- accounts ------------------------------------------------------ */

    // Only addresses at this domain may sign up. Empty allows any address —
    // in which case set allow_signup to false, or the sign-up form is an open
    // door onto your database.
    'allowed_email_domain' => 'dbotrealty.com',

    // Whether a visitor can create their own account.
    //
    // OFF, because accounts are meant to be issued from the People page: an
    // administrator adds somebody, hands them a password, and they are asked
    // to choose their own the first time they sign in. With this left on, that
    // whole arrangement decides nothing — anybody holding a work address can
    // simply make their own account instead.
    //
    // The very first account on an empty database is allowed through whatever
    // this says, because otherwise nothing is startable: administrators create
    // accounts, administrators are accounts, and there would be neither. That
    // window is one account wide and closes as soon as it is used.
    'allow_signup' => false,

    // How long someone stays signed in without using the app.
    'session_days' => 30,

    /* ---- password resets ----------------------------------------------- */

    // How long a reset link lasts.
    'reset_minutes' => 60,

    // The From: address on that email. MUST be a real mailbox on this site's
    // own domain — create it in hPanel → Emails first. Sending as a domain
    // Hostinger does not host is either refused or delivered straight to spam,
    // and the second looks like it worked.
    //
    // Leave this empty and password resets will refuse with a message saying
    // so, rather than silently not arriving.
    'mail_from'      => 'no-reply@your-domain.com',
    'mail_from_name' => 'Map Studio',

    /* ---- this deployment ------------------------------------------------ */

    // The public origin, used to build the link inside a reset email. Leave
    // empty to work it out from the request, which is right unless something
    // in front of the server rewrites the Host header.
    'app_url' => '',

    /* ---- sign-in throttle ----------------------------------------------- */

    // Failures from one address, or against one account, inside the window
    // before further attempts are refused.
    'max_attempts'    => 10,
    'attempt_minutes' => 15,

    /* ---- diagnostics ---------------------------------------------------- */

    // Returns PHP's own error text in API responses. Useful for exactly as
    // long as the first install takes, and a liability afterwards: a database
    // error's message contains the credential often enough to assume it always
    // does. Turn it off once the site works.
    'debug' => false,
];
