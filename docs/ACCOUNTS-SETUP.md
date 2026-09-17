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
   and table_name in ('users','sessions','map_projects','password_resets','login_attempts');
```

Five rows, and every `engine` must say **InnoDB**. A MyISAM table would have
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
| `allow_signup` | Whether colleagues can create their own accounts. Reasonable to leave on while the domain restriction is set — only someone who already has a work address can use it. |
| `mail_from` | A real mailbox on this domain, for password resets. See step 5. |

## 4. Check it

Open **`https://your-domain.com/api/health`**. You want:

```json
{"ok":true,"tables":{"users":true,"sessions":true,"map_projects":true,
 "password_resets":true,"login_attempts":true}}
```

This one request separates the two things that go wrong on a first install. If
it says the database is unreachable, step 1 or 3 is wrong. If it says a table
is missing, step 2 did not run. If it returns HTML rather than JSON, PHP is not
running for that folder at all.

Then open the site, create an account with your work address, and save a map.

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
- **Any notion of an administrator.** There is no page that lists accounts or
  resets somebody else's password; `api/cli/set-password.php` is the whole of it.
- **Two people editing one map at once.** Saving writes the whole project, so
  the last save wins and the other person's changes are gone without a warning.
