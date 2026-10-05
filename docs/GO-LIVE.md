# Going live at map.dbotrealty.tech

Step by step, from an empty Hostinger account to every map and every password
moved across from Supabase. Each step ends with **✅ Check** — how you know it
worked before moving on. If a check fails, stop there: every later step depends
on the earlier ones, and the failure is cheapest to fix where it first shows.

Two domains are involved and they do different jobs — worth fixing in your head
before starting:

| | |
|---|---|
| **`dbotrealty.tech`** | where the site lives: `https://map.dbotrealty.tech` |
| **`dbotrealty.com`** | people's work email addresses. Only these can have accounts. |

Wherever this guide says `u123456789`, use your own Hostinger username (it is in
hPanel, and in every database name hPanel creates).

---

## Part 1 — Put the site up

### 1. Create the subdomain

hPanel → **Domains** → **Subdomains** → choose `dbotrealty.tech` → type `map` → **Create**.

If `dbotrealty.tech`'s DNS is managed somewhere other than Hostinger (hPanel
will warn that the domain isn't pointed to it), also add an **A record** for
`map` at your DNS provider, pointing at the IP address hPanel shows for your
hosting.

**✅ Check:** `map.dbotrealty.tech` appears in the subdomain list, with a folder
next to it. Note that folder — the site's files go there.

### 2. Turn on HTTPS for it

hPanel → **Security** → **SSL** → make sure `map.dbotrealty.tech` has a
certificate. Install the free one if it doesn't. It can take a few minutes to
become active.

Do this *before* testing anything. The site forces HTTPS, and sign-in uses a
cookie the browser only sends over HTTPS — on plain HTTP you would sign in
successfully and immediately appear signed out.

**✅ Check:** `https://map.dbotrealty.tech` opens with a padlock (it may show an
empty folder — that's fine for now).

### 3. Upload the site

hPanel → **Files** → **File Manager** → open the subdomain's folder from step 1
→ upload **`map-studio-<version>-hostinger.zip`** → right-click → **Extract** →
delete the zip.

You should now see `index.html`, `login.html`, `projects.html`, `admin.html`,
`404.html`, an `api` folder, and **`.htaccess`**. If you can't see `.htaccess`,
turn on "show hidden files" in the File Manager's settings — it must be there.

**✅ Check:** `https://map.dbotrealty.tech` shows the sign-in page.

### 4. Create the database

hPanel → **Databases** → **MySQL Databases** → create one, e.g. name `mapstudio`,
user `mapstudio`, a strong password.

Write down all three **exactly as hPanel shows them** — with the prefix, e.g.
`u123456789_mapstudio`. Leaving the prefix off is the most common reason a first
install can't connect.

### 5. Create the tables

hPanel → **Databases** → **phpMyAdmin** → open your database → **SQL** tab →
paste the whole of **`hostinger-mysql.sql`** → **Go**.

**✅ Check:** in the same SQL tab, run

```sql
select table_name, engine from information_schema.tables
 where table_schema = database();
```

Six rows — `users`, `sessions`, `map_projects`, `password_resets`,
`login_attempts`, `admin_log` — and every `engine` says **InnoDB**.

### 6. Write the configuration

Open **`https://map.dbotrealty.tech/api/health`**. Before the config exists it
answers with the exact path it wants, something like:

```
save it as: /home/u123456789/map-studio-config.php
```

That's your account's home folder — outside every website on the account.
(Keep this page open: the "also accepted" path it shows tells you the full
server path of the site folder, which step 11 needs.)

In the File Manager, go to that home folder. Copy `api/config.sample.php` from
the site folder into it and rename the copy to **`map-studio-config.php`**. Edit
it:

```php
'db_name' => 'u123456789_mapstudio',     // from step 4, exactly
'db_user' => 'u123456789_mapstudio',
'db_pass' => 'the password from step 4',

'allowed_email_domain' => 'dbotrealty.com',   // .com — people's work email
'allow_signup' => false,

'mail_from' => '',                            // step 16, later
'app_url' => 'https://map.dbotrealty.tech',

'debug' => true,                              // set back to false at step 12
```

**✅ Check:** `https://map.dbotrealty.tech/api/health` now says `"ok": true` and
`"schema": "current"`.

| If it says | Fix |
|---|---|
| the database is not reachable | the three values don't match hPanel — check the prefix, and that the user is assigned to the database |
| a table is `false` | step 5 didn't run, or ran on a different database |
| it's still asking for the config file | the file isn't at the path it named, or isn't named exactly `map-studio-config.php` |

### 7. Sign yourself up — before importing anything

Open `https://map.dbotrealty.tech`, choose **Create one**, and sign up with
**`aditya.bachal@dbotrealty.com`** — the same address you used on the old site.

The first account on an empty database becomes the **administrator**. And
because it's the same address as your Supabase account, the import in step 11
recognises it and attaches all your old maps to it. (Your new password stays;
the old one is not brought over for an account that already exists.)

**✅ Check:** **People** appears in the left-hand rail.

---

## Part 2 — Bring the data across from Supabase

### 8. Get the Supabase connection string

In the Supabase dashboard:

1. If the project says **Paused**, click **Restore** and wait. Free projects pause
   after a week without use.
2. **Project Settings** → **Database** → **Connection string** → choose **Session
   pooler** (its host ends `.pooler.supabase.com`). Not the direct connection —
   that one is IPv6-only and simply times out from most networks.
3. Copy it and put your database password where it says `[YOUR-PASSWORD]`.

> ⚠️ If you don't know the database password, **don't reset it yet.** The AI
> Reports backend on Render may be using this same database; resetting the
> password would break AI reports until Render's `DATABASE_URL` is updated too.
> Check Render → your service → Environment first.

### 9. Export, on your computer

1. Install **Node.js LTS** from nodejs.org if you don't have it.
   (In a terminal, `node -v` should print a version.)
2. On GitHub, open **AdityaBachal85/Map-studio**, switch to the branch
   **`Map-Studio_Hostinger`**, then **Code** → **Download ZIP**. Extract it.
3. Open a terminal **in the extracted folder** (Windows: open the folder,
   Shift + right-click → *Open in Terminal*).
4. Run:

```
npm install --no-save pg
node tools/export-supabase.js --dsn "PASTE-THE-CONNECTION-STRING-HERE"
```

Keep the quotes around the connection string.

**✅ Check:** it ends with something like

```
Wrote …\map-studio-export.json
  12 accounts (10 with a password that will carry over, 2 who will need the reset link)
  87 maps
```

Write those numbers down — step 11 should match them.

> 🔒 That file holds every account's password hash and every map. Treat it as a
> backup of the whole database: don't email it, don't commit it, and delete it
> at step 12.

### 10. Upload the export

File Manager → your **home folder** (the same place as `map-studio-config.php`,
**not** inside any `public_html`) → upload `map-studio-export.json`.

### 11. Import it

You need to run one command on the server. The site folder is the "also
accepted" path from step 6 without `/api/config.php` — below it's written as
`SITE`; on Hostinger it is usually
`/home/u123456789/domains/dbotrealty.tech/public_html/map`.

**If hPanel → Advanced → SSH Access is available** (turn it on there; it shows
the IP and port, usually `65002`):

```
ssh -p 65002 u123456789@YOUR-SERVER-IP
cd SITE/api/cli
php import.php ~/map-studio-export.json --dry-run
```

The dry run does the whole import and then undoes it, so what it prints is
exactly what the real one will do. If the numbers match step 9, run it for real:

```
php import.php ~/map-studio-export.json
```

**If there is no SSH:** hPanel → **Advanced** → **Cron Jobs** → create a job
with this command, to run every minute:

```
php SITE/api/cli/import.php /home/u123456789/map-studio-export.json --dry-run > /home/u123456789/import-dryrun.txt 2>&1
```

Wait two minutes, **delete the cron job**, and open `import-dryrun.txt` in the
File Manager. If it looks right, do the same again without `--dry-run`, writing
to `import-log.txt` — and **delete that job as soon as it has run once**.
(Running twice does no harm — the import is safe to repeat — but there is no
reason to leave it running.)

**✅ Check:** the output says something like

```
Accounts: 11 added, 1 already here
  1 already had an account on this site under the same address — their maps are attached to that account:
    aditya.bachal@dbotrealty.com
Maps:     87 added, 0 already here
Done.
```

The "1 already here" is you, from step 7. If it reports maps with an owner
"not in the export", those belong to accounts that were deleted in Supabase.

If the log says *syntax error* or *unexpected*, the cron's PHP is older than the
site's — use SSH instead, or ask Hostinger support for the PHP 8 command-line
path.

### 12. Check, and clean up

1. Sign in. Your old maps are in the list. Open one.
2. **People** shows everybody. Anyone tagged **no password** only ever used
   Microsoft sign-in — click **New password** for them and pass it on; they'll
   choose their own when they sign in.
3. Everybody else signs in with their **old Supabase password**, unchanged.
4. **Delete `map-studio-export.json`** — from the Hostinger home folder *and*
   from your computer.
5. In `map-studio-config.php`, set `'debug' => false`.

---

## Part 3 — Finish

### 13. Google Maps

Google Cloud console → **APIs & Services** → **Credentials** → the browser key →
**Website restrictions** → add `https://map.dbotrealty.tech/*`. Keep the
restriction on — it is what stops anyone else spending against the key.

### 14. Geoapify

Geoapify dashboard → your project → **Allowed referrers** → add
`https://map.dbotrealty.tech/*`.

Wait five minutes after 13 and 14 — both are cached, and testing straight away
shows a failure that's already fixed.

**✅ Check:** in the studio, search for a place. Results appear, and the map
draws.

### 15. AI reports (if you use them)

Render → the AI reports service → **Environment** → `ALLOWED_ORIGIN` → add
`https://map.dbotrealty.tech`, comma-separated if you want the old address to
keep working for a while.

### 16. Email for password resets (optional, any time)

hPanel → **Emails** → create a mailbox on **`dbotrealty.tech`**, e.g.
`no-reply@dbotrealty.tech`, and put it in `mail_from`. It must be a mailbox on a
domain Hostinger hosts for you — sending as `dbotrealty.com` from here would be
refused or land in spam.

Until then, "Forgot password" says plainly that email isn't set up, and you
issue passwords from **People** instead.

### 17. When to switch Supabase off

Only after the site has been in use for a few days and nobody has reported a
missing map. And check first whether Render's `DATABASE_URL` points at Supabase:
if it does, pausing Supabase stops AI reports — that database is separate from
everything above and isn't moved by it.
