# Accounts — sign-in and cloud projects on Hostinger

Everyone at DBOT gets an account on this site itself. Projects are saved to the
MySQL database in hPanel, so a map started on one machine opens on another, and
nobody sees anybody else's work.

This replaced Supabase. If you are looking for the old setup — the anon key,
the SQL editor, Microsoft sign-in through Entra — none of it applies any more;
[Bringing the Supabase data across](#bringing-the-supabase-data-across) is the
part of this document that still concerns it.

**What you need:** a Hostinger plan with PHP 8.1 or newer and one MySQL
database. Both are on every Premium, Business and Cloud plan. Nothing else —
no third-party account, no key, no monthly bill.

---

## What protects the data

Worth reading before the steps, because the answer changed and the change is
the kind that matters.

Under Supabase the browser held a public key and queried Postgres directly, and
the database defended itself: Row Level Security policies were evaluated inside
Postgres, on every row of every query, against the user id proven by a signed
token. A hostile client asking for every project got back only its own.

There is no equivalent in MySQL, and there does not need to be, because **the
browser no longer talks to the database at all**. It talks to `api/` on this
domain over a session cookie it cannot read, and PHP decides what it may have.
Every query in `api/routes/projects.php` carries `where owner_id = :me`, where
`:me` comes from the session and never from the request.

That is a real transfer of responsibility. Under RLS a forgotten WHERE clause
returned nothing; here it would return everyone's rows. Three things hold it up:

- **One gate, not many.** Every read and write goes through
  `ms_project_owned()`. Adding a route means calling it, not remembering a
  clause.
- **It is attacked in the test suite.** `diagnostics/accounts-api.cjs` signs in
  as two people and has each try to read, rename, duplicate, delete and
  overwrite the other's project by naming its id. All five must answer "does
  not exist" — not "not yours", which would confirm it is there.
- **The database credential is the whole perimeter.** It lives in a file the
  web server will not serve, and it is the one secret in this system.

Passwords are stored with PHP's `password_hash()` — bcrypt today, whatever PHP
considers current tomorrow, upgraded on the owner's next sign-in. Sessions are
random 32-byte tokens; the database stores only their SHA-256, so a copy of the
`sessions` table does not let anybody sign in as anyone.

---

## 1. Create the database

**hPanel → Databases → MySQL Databases.** Create a database and a user, and
give the user access to the database.

Copy all three values as hPanel shows them. Both names carry your account
prefix — `u123456789_mapstudio`, not `mapstudio` — and leaving it off is the
single most common reason a first install cannot connect.

## 2. Create the tables

**hPanel → Databases → phpMyAdmin**, pick the database, open the **SQL** tab,
paste the whole of **`sql/hostinger-mysql.sql`**, and run it.

It is safe to run more than once. Afterwards, run this on its own to confirm:

```sql
select table_name, engine from information_schema.tables
 where table_schema = database()
   and table_name in ('users','sessions','map_projects','password_resets',
                      'login_attempts','admin_log');
```

Six rows, and every `engine` must say **InnoDB**. A MyISAM table would have
accepted the statement and silently dropped every foreign key, so deleting a
user would leave their projects behind as rows nothing can reach.

## 3. Write the configuration

Copy **`api/config.sample.php`** and fill in the three database values.

**Put the copy one directory above `public_html`,** named
`map-studio-config.php`:

```
/home/u123456789/map-studio-config.php      ← here
/home/u123456789/public_html/               ← the site
```

Nothing the web server serves can reach it there, under any configuration —
including the broken ones where a PHP handler is off and `.php` files are
served as plain text. If your plan gives you no way to write outside
`public_html`, the second-choice location is `public_html/api/config.php`,
which `api/.htaccess` refuses; that refusal depends on `.htaccess` being
honoured, which is why it is second choice.

While you are in there, set:

| Setting | What it does |
|---|---|
| `allowed_email_domain` | Only addresses at this domain may sign up. `'dbotrealty.com'`. |
| `allow_signup` | **Leave this off.** Accounts are issued from the People page instead. With it on, anybody holding a work address can create their own and the People page decides nothing. The very first account is allowed through regardless — see below. |
| `mail_from` | A real mailbox on this domain, for password resets. See step 5. |

## 4. Check it

Open **`https://your-domain.com/api/health`**. You want:

```json
{"ok":true,"tables":{"users":true,"sessions":true,"map_projects":true,
 "password_resets":true,"login_attempts":true,"admin_log":true},
 "schema":"current"}
```

This one request separates everything that goes wrong on a first install, and
it tells you which:

| It says | What to fix |
|---|---|
| the database is unreachable | step 1 or 3 — the credentials do not match hPanel |
| a table is `false` | step 2 did not run, or ran against another database |
| `schema` lists missing columns | the database is from an earlier version — see [Upgrading](#upgrading-a-database-you-already-set-up) |
| HTML instead of JSON | PHP is not running for that folder at all |

Then open the site and **create an account with your work address**. The first
account on an empty database becomes the administrator, whatever
`allow_signup` says — otherwise nothing would be startable, since
administrators create accounts and administrators are accounts. That window is
one account wide and shuts the moment you use it.

Save a map, then go to **People** in the left-hand rail.

## 5. Password resets need a mailbox

Resets are emailed, so outbound mail has to work.

**hPanel → Emails → Email Accounts** — create something like
`no-reply@your-domain.com`, and put that address in `mail_from`.

It must be a mailbox **on this site's own domain**. Hostinger's outbound mail
signs for domains it hosts; sending as anything else is either refused outright
or accepted and then filed as spam by the receiving end, and the second is
worse because it looks like it worked.

If `mail_from` is empty, a reset request refuses with a message saying exactly
that, rather than silently not arriving.

### Setting a password without email

For the first day, before the mailbox exists — and for anyone who cannot
receive mail:

**With SSH** (Business plans and above):

```
cd public_html/api/cli
php set-password.php someone@dbotrealty.com
```

It asks for the password rather than taking it as an argument, because an
argument is written to shell history and is visible in `ps` to every other
account on the machine while it runs.

**Without SSH:** hPanel → Advanced → **Cron Jobs** runs the same command once.
Set it a few minutes out, then delete the job.

---

## Adding people

**People** in the left-hand rail, visible to administrators only.

**Add someone** creates the account and shows you a password **once**. Pass it
on however you normally would. It is stored the same way every other password
is — as a hash nothing can read back — so nobody, including you, can look it up
afterwards; if you lose it before passing it on, issue another.

The account is marked as needing a password of its own, and the first time they
sign in they are asked to choose one before the app opens. That is what makes
it acceptable to send a password through a chat application: the credential two
people have seen stops working as soon as it is used.

### The rest of what the page does

| | |
|---|---|
| **New password** | For somebody who has lost theirs, or whose reset email will not arrive. Their existing sessions end immediately. |
| **Make admin** / **Make a user** | Administrators can add and remove people. That is the whole difference — see below for what it does *not* include. |
| **Switch off** | Revokes access now: they are signed out within the second and cannot sign back in. Everything they own stays exactly where it is. This is what you want when somebody leaves. |
| **Move maps** | Gives every map one person owns to a named colleague. The answer to "they have left and their work must not go with them". |
| **Delete** | Permanent, and it takes their maps with it. The page makes you confirm the number of maps that will be destroyed, and the server refuses if that number is wrong — so the confirmation cannot be satisfied by clicking through. |

### What an administrator cannot do

**Open anybody else's maps.** There is no endpoint that returns another
person's project, and that is a decision rather than an omission. The question
administration actually has to answer is what happens to a leaver's work, and
the honest answer is to move it to a named colleague — visibly, and in the log
— rather than to give one account a quiet key to everyone's drawings.

**Lock everybody out.** Nobody can demote, switch off or delete their own
account, and none of the three may take the last remaining administrator. Both
rules exist because they fail differently: the first stops a slip, the second
stops two administrators removing each other in either order.

### The first administrator, after a Supabase import

The first-account rule never fires on an imported database, because the
accounts are already there. Promote yourself from the command line:

```
cd public_html/api/cli
php make-admin.php you@dbotrealty.com
php make-admin.php --list
```

Same cron-job fallback as everything else here if the plan has no SSH.

### The log

At the bottom of the page: every account created, disabled, promoted,
re-passworded, moved or deleted, with who did it. Both addresses are stored as
text rather than as references, so the record survives either account being
deleted later — which is exactly when somebody asks who granted access.

---

## Upgrading a database you already set up

`sql/hostinger-mysql.sql` is written with `create table if not exists`, which
is what makes it safe to paste twice — and is exactly why re-running it cannot
upgrade anything. Against a database that already has a `users` table it finds
one, skips it, reports success, and adds none of the columns that file grew
later.

So:

```
cd public_html/api/cli
php migrate.php --dry-run     # say what is missing
php migrate.php               # add it
```

It only ever adds; it never drops a column, narrows a type or deletes a row.
And you do not have to guess whether it is needed — **/api/health** says so,
and names the column it is waiting for.

---

## Bringing the Supabase data across

Every account and every map moves, **and so does every password**. Supabase
stores standard bcrypt hashes, which is exactly what PHP's `password_verify()`
reads, so they transfer verbatim: nobody has to reset anything, and no
plaintext password exists anywhere in this process.

The exception is anyone who only ever signed in with Microsoft. They have no
password to carry across — there is no Microsoft sign-in here — so their
account arrives with none, and they set one through the reset link. Signing in
tells them that in those words rather than rejecting their password as wrong.

### 1. Export

You need the Supabase database connection string: **Project Settings →
Database → Connection string → Session pooler**. Use the pooler one — its host
ends `.pooler.supabase.com`. The direct connection is IPv6-only and will simply
time out from most networks.

```
cd server && npm install        # for the `pg` driver, once
cd ..
node tools/export-supabase.js --dsn "postgresql://postgres:PASSWORD@aws-0-….pooler.supabase.com:5432/postgres"
```

It writes `map-studio-export.json` and tells you how many accounts and maps it
found, and how many of those accounts have a password that will carry over.

**That file is a database backup.** It contains password hashes and every map
you have. Do not commit it — `.gitignore` covers the name — and delete it from
both machines once the import is confirmed.

### 2. Import

Upload the file somewhere outside `public_html` (the File Manager will do), then:

```
cd public_html/api/cli
php import.php /home/u123456789/map-studio-export.json --dry-run
php import.php /home/u123456789/map-studio-export.json
```

The dry run reports exactly what the real one would do and writes nothing.

The import is **safe to run twice**: rows are matched on the id they had in
Supabase, so a run interrupted half way is fixed by running it again. It never
deletes, and it never overwrites a password that was set on this site after the
export was taken — somebody who has already used a reset link is not sent back
to a password they no longer know.

Maps that already exist here are left alone. `--replace` overwrites their
contents from the file.

### 3. Check, then turn Supabase off

Sign in with an account that existed before, with the password it had before.
Open a map. Count the rows in the list against what the export reported.

Only then pause the Supabase project. If the AI Reports backend on Render
points its `DATABASE_URL` at that same Supabase Postgres — check Render's
environment settings — pausing it will stop AI reports working. That database
is a separate question from this one and is not moved by any of the above.

---

## When it does not work

**`/api/health` returns HTML, or a 404.** PHP is not running for that folder,
or `api/` did not make it into the upload. Check the folder exists in the File
Manager, with `index.php` inside it.

**"The database is not reachable."** The three values in the config do not
match hPanel. Check the account prefix on both the database name and the user
name, and that the user is actually assigned to that database — creating both
does not connect them.

**"The project tables do not exist yet."** Step 2 did not run, or it ran
against a different database.

**Sign-in says the address and password do not match, and you are sure they
do.** If the account came from Supabase and only ever used Microsoft, it has no
password — the message will say so specifically. Otherwise use the reset link.

**"Too many sign-in attempts."** The throttle: ten failures in fifteen minutes,
counted by address and by account. It clears itself. `max_attempts` and
`attempt_minutes` in the config change it.

**Signing in works, then the next page says you are signed out.** The session
cookie is not coming back. Almost always the site is being reached over plain
HTTP on one page and HTTPS on another — the cookie is marked Secure when it is
set over HTTPS and will not be sent over HTTP. The root `.htaccess` forces
HTTPS; check it survived the upload.

**A reset link says it has already been used, seconds after it arrived.**
Not a bug here. Corporate mail security — Microsoft Defender Safe Links and its
equivalents — opens every link in an incoming message to scan it, which spends
a single-use token before the human clicks. The sign-in page explains this when
it happens. Ask for a new link and open it from a different mail app.

---

## Running it locally

```
php -S 127.0.0.1:8000 -t . diagnostics/php-router.php
```

That serves the site and routes `/api` the way `api/.htaccess` does on the real
server. Point the config at a throwaway database, or at SQLite:

```php
'db_driver' => 'sqlite',
'db_sqlite_path' => '/tmp/mapstudio.sqlite',
```

and create the tables from `diagnostics/accounts-sqlite.sql`. SQLite is for
tests and local work only — never for a deployment.

## The tests

```
node diagnostics/accounts-api.cjs     # the API, and the browser client against it
node diagnostics/migration.cjs        # the Supabase import, passwords included
```

Both run real PHP. `accounts-api.cjs` also drives `login.html` in a real
browser, creates an account through the form, and round-trips a map through the
app's own store — which is where a disagreement between the client and the API
would show up, and where it would not show up in a server-only test.

## What is not built yet

- **Sharing a project with a colleague.** Every project belongs to one person.
  Moving all of somebody's maps at once, from the People page, is as close as
  this gets.
- **Two people editing one map at once.** Saving writes the whole project, so
  the last save wins and the other person's changes are gone without a warning.
- **Emailed invitations.** An administrator is handed the password to pass on
  rather than the person being emailed a link. Deliberate, for now: a fresh
  install has no working mailbox on day one, and an administrator who cannot
  add anybody until the mail is fixed is an administrator who cannot start.
