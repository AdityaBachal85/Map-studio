# Deploying Map Studio on Hostinger

This branch (`Map-Studio_Hostinger`) is `Map-Studio_V6` plus the files a
Hostinger deploy needs: a `.htaccess`, a `404.html`, a packaging script, and
the VPS service definitions in `deploy/hostinger/`. Nothing in the application
itself is changed, so the branch can be re-merged from `Map-Studio_V6` at any
time without conflicts outside these files.

**There is no build step.** The files in the repository are the files that are
served. What `tools/build-hostinger.js` does is *select* them, not compile
them.

---

## Which of these are you on?

Hostinger sells two different kinds of thing, and they need different work.

| Plan | Web server | Node? | What you do |
|---|---|---|---|
| Premium / Business / Cloud (shared, hPanel) | LiteSpeed | **No** | **Path A** below. `.htaccess` does the configuration. |
| VPS | whatever you install | Yes | **Path B** below. nginx + systemd or Supervisor. |

If you are not sure: hPanel → the plan name is at the top of the dashboard. A
VPS has an hPanel section called **VPS** with an IP address and a root password.

**The AI reports feature is the only thing the choice changes.** The map, the
dashboard, sign-in, cloud projects, every export — all of it is static files
plus the PHP accounts API in `api/`, and all of it works identically on both.
The AI reports backend (`server/`) is Node and cannot run on a shared plan.
Its buttons are already hidden in the interface, and `AI_FUNCTIONS_BASE_URL`
already points at the existing Render deployment, so **on a shared plan there
is nothing to do about it** — it keeps working exactly as it does now.

---

## Path A — shared hosting (Premium / Business / Cloud)

### A1. Build the package

On your own machine, in a checkout of this branch:

```bash
node tools/stamp-assets.js --check     # must pass before packaging
node tools/build-hostinger.js
```

That writes `dist/` and `map-studio-<version>-hostinger.zip` — about 2 MB.

The script refuses to run if the tree is not stamped at one version, and
refuses if any file referenced by a page is missing from the package. Both
refusals are deliberate: a half-stamped upload puts every visitor into a
reload loop, and this app loads 125 scripts in a load-bearing order where one
missing file blanks the whole studio.

> **Why package at all?** The repository is 487 MB. The site inside it is
> 5.7 MB. `legacy/` alone is 473 MB of build snapshots — 129 complete copies
> of the app, regenerable with `tools/build-single-file.js`, that no visitor
> will ever request. Uploading the repository would spend most of a shared
> plan's disk quota, and a large share of its inode allowance, on files that
> exist to be looked at once.

### A2. Upload it

hPanel → **Files → File Manager** → open `public_html`.

1. Delete Hostinger's placeholder `default.php` / `index.html` if they are there.
2. **Upload** the zip.
3. Right-click it → **Extract** → into `public_html`.
4. Delete the zip.

`index.html` must end up at `public_html/index.html`. If it lands at
`public_html/dist/index.html` the site answers with a 403 — move the contents
up one level. (The zip is built from *inside* `dist/` precisely so this does
not happen, but a re-zip by hand usually adds the folder back.)

### A3. Check the `.htaccess` actually arrived

This is the step that gets missed, because the file starts with a dot and the
File Manager hides it by default.

File Manager → **Settings** (gear, top right) → tick **Show hidden files**.
You should see `.htaccess` in `public_html`. If it is not there, the ZIP
extraction dropped it — upload it on its own from `dist/.htaccess`.

Without it: no HTTPS redirect, no compression, `.js` possibly served with the
wrong type, and — the one that will bite — **HTML cached**, so people keep
seeing an old build after every deploy.

### A4. Domain and SSL

hPanel → **Websites → your site → Dashboard**.

- **Domains** — point the domain at this hosting account, or add it as an
  addon domain. DNS takes up to a few hours.
- **Security → SSL** → **Install SSL** (free, Let's Encrypt). Then switch
  **Force HTTPS** on. The `.htaccess` redirect does this too; the panel switch
  is belt and braces and costs nothing.

**Wait for the certificate to issue before testing anything else.** Sign-in,
"use my location", and the clipboard are all refused by browsers over plain
HTTP, and they fail separately with unrelated-looking errors.

### A5. Tell the external services about the new domain

**This is the step that decides whether the site works.** Every one of these
is keyed to the old GitHub Pages origin. Skip one and the failure is quiet:
a search box that returns nothing, or a map that will not load.

Sign-in is no longer on this list. It used to be — Supabase had to be told
every origin the app would be served from — and it now runs in `api/` on this
domain, against the MySQL database in hPanel, so there is nothing to keep in
step. Setting that up is **docs/ACCOUNTS-SETUP.md**, and it is the one step
here that has to happen after the upload rather than before.

Replace `https://your-domain.com` with your real origin — scheme and host, no
trailing slash, no path.

| Service | Where | What to add |
|---|---|---|
| **Google Maps Platform** — search, nearby places, routing | Cloud console → APIs & Services → **Credentials** → the browser key in `MAP_PROVIDER_KEYS.google` → **Website restrictions** | Add `https://your-domain.com/*`. Keep the restriction: it is the only thing stopping a third party spending against the key. |
| **Geoapify** — search and nearby places | Geoapify dashboard → the project → **Allowed referrers** | Add `https://your-domain.com/*`. |
| **AI reports backend** (Render) | Render dashboard → the service → **Environment** | Set `ALLOWED_ORIGIN` to `https://your-domain.com`. Comma-separate to keep the old origin working during a cutover. |

Mappls is disabled in `js/config.js` (`MAPPLS_ENABLED = false`) pending an
account entitlement, so its domain whitelist does not matter yet. If it is
ever turned on, its console needs the same treatment.

After changing a Google or Geoapify restriction, **wait five minutes** —
both propagate on a cache, and testing immediately shows a failure that has
already been fixed.

### A6. Verify

Open the site and check these in order. Each one fails differently, so the
first that fails tells you which step above to revisit.

```
https://your-domain.com/                        → the sign-in page
https://your-domain.com/nonsense                → the styled 404, not Hostinger's
```

Then, with the browser's **Network** tab open on a hard reload (Ctrl/Cmd+Shift+R):

| Check | Expected | If not |
|---|---|---|
| The address bar | `https://`, with a padlock | A4 |
| `index.html` response headers | `cache-control: no-cache, must-revalidate` | A3 — `.htaccess` did not arrive |
| any `.js` response headers | `content-type: text/javascript`, `cache-control: …immutable` | A3 |
| any `.js` response headers | `content-encoding: gzip` or `br` | A3 |
| The version, bottom of the sign-in page | matches `APP_VERSION` in `js/constants.js` | you uploaded an older build |
| Sign in | lands on the projects list | docs/ACCOUNTS-SETUP.md — the database and the API config |
| Search for a place in the studio | results appear | A5 — Google / Geoapify referrers |
| The map draws tiles | imagery, not grey | A5 — Google key restriction |

### A7. Updating the site later

Same three commands, same upload:

```bash
node tools/stamp-assets.js --bump      # after any .js or .css change
node tools/build-hostinger.js
```

…then replace the contents of `public_html`. Because the `.htaccess` sends
`no-cache` on HTML, a visitor picks up the new build on their next page load —
no hard refresh, no waiting out a CDN.

**Do not delete `.htaccess` when clearing `public_html` for a new upload.**
It is in the package, so re-extracting restores it — but only if hidden files
were shown when you selected everything to delete, which is its own trap. The
safe order is: extract the new zip *over* the old files, then remove anything
left that is not in `BUILD.txt`.

---

## Path B — VPS

You have root, so this is the ordinary Linux deployment and everything can
live on one machine, including the AI reports backend.

```bash
sudo adduser --system --group mapstudio
sudo mkdir -p /var/www && cd /var/www
sudo git clone -b Map-Studio_Hostinger https://github.com/AdityaBachal85/Map-studio.git map-studio
cd map-studio
sudo -u mapstudio node tools/build-hostinger.js --no-zip     # writes dist/
```

Then:

1. **The site** — `deploy/hostinger/nginx-map-studio.conf`. Its header has the
   install commands, including certbot. `root` points at `dist/`, not at the
   checkout.
2. **The backend** — pick **one** of:
   - `deploy/hostinger/map-studio-ai.service` (systemd — preferred; it is
     already running on every current Hostinger VPS template), or
   - `deploy/hostinger/supervisor-map-studio-ai.conf` (Supervisor — if you
     already manage services with it).

   Running both means two servers fighting over one port.
3. **Secrets** go in `/etc/map-studio.env` (chmod 600, root-owned), never in
   the files under version control. Both service definitions say so and both
   read from there.
4. **Point the app at it.** In `js/config.js`, set
   `AI_FUNCTIONS_BASE_URL = '/api'` and rebuild `dist/`. The nginx config
   proxies `/api/` to `127.0.0.1:8080`, so the browser makes same-origin
   requests and CORS never enters it. Set `ALLOWED_ORIGIN` on the backend
   anyway — it still checks the `Origin` header on requests that carry one.
5. **A5 above still applies.** Google and Geoapify do not care which server
   you run; they care about the origin in the browser's address bar.

   Note the collision if you take this route: the accounts API also lives at
   `/api`. Proxy the reports backend somewhere else — `/ai/` — or the two will
   fight over the same prefix, and the symptom is sign-in returning the AI
   backend's 404 as HTML.

Then the same A6 verification, plus:

```bash
curl -fsS https://your-domain.com/api/health && echo   # the backend answers
systemctl status map-studio-ai                          # or: supervisorctl status
journalctl -u map-studio-ai -n 50                       # what it said on boot
```

The backend prints its CORS mode on every boot. If that line says it is
accepting requests from **any** origin, `ALLOWED_ORIGIN` did not reach it.

---

## When something is wrong

Ordered by how often each one happens on a first deploy.

### The whole site returns 500 Internal Server Error

A directive in `.htaccess` that this plan does not allow. Everything that can
be is wrapped in `<IfModule>`, which turns "the module is not loaded" into a
skipped block rather than a 500 — but `AllowOverride` is a separate thing, and
a plan can have a module loaded and still refuse to let `.htaccess` use it.

Bisect it: rename `.htaccess` to `htaccess.off` (the site should come back
immediately, unstyled caching and all), then add the blocks back a few at a
time. The two most likely culprits, in order:

1. `Options -Indexes` — needs `AllowOverride Options`. Comment it out and
   instead switch directory listings off in hPanel, or add `IndexIgnore *`.
2. `ErrorDocument 404 /404.html` — needs `AllowOverride FileInfo`.

Both are permitted on Hostinger's current plans. This matters if you move the
file to another host.

### 403 Forbidden on the front page

`index.html` is one level too deep — `public_html/dist/index.html` rather than
`public_html/index.html`. Move the contents up. See A2.

### Everyone keeps seeing an old build after a deploy

`.htaccess` did not arrive. See A3 — it starts with a dot and the File Manager
hides it until **Show hidden files** is ticked.

Confirm from the browser rather than the panel: hard-reload, and in the Network
tab click `index.html`. Its response headers must include
`cache-control: no-cache, must-revalidate`. If they say anything else, the file
is not being read.

### The map is grey, or search returns nothing

A referrer restriction still naming the old origin. See A5 — Google and
Geoapify both propagate on a cache, so wait five minutes after changing one
before deciding it did not work.

The distinction worth making: **grey tiles with the interface working** is a
key or basemap problem, and the app counts tile auth failures and says so in
the status line. **A blank page** is a missing file, which is A2/A3.

### Sign-in bounces back to the sign-in page

The session cookie is not coming back. Two causes, in order of likelihood:

1. **The site is being reached over plain HTTP somewhere.** The cookie is
   marked Secure when it is set over HTTPS, so it will not be sent back over
   HTTP, and the next page sees nobody signed in. A3 and A4 — the `.htaccess`
   HTTPS redirect has to be in place.
2. **The API is not answering.** Open `https://your-domain.com/api/health`. If
   it is not JSON saying `"ok":true`, the problem is the accounts setup, not
   the sign-in page — docs/ACCOUNTS-SETUP.md.

### AI reports say the backend is unreachable

On a shared plan, check `ALLOWED_ORIGIN` on Render (A5). On a VPS, check the
service is up and the proxy is reaching it — the `curl .../api/health` and
`journalctl` lines in Path B.

Note the buttons for this feature are hidden in the interface by default, so
if you have not deliberately unhidden them, this is not your problem.

---

## What has and has not been tested

Verified here, by building the package and loading it in a real browser
(`node diagnostics/hostinger-package.cjs`, 26 checks): the package contains
every file the three pages ask for and nothing that should not be published,
the studio boots from it with all 125 scripts in order, the 404 page draws
standalone, and the build script refuses an unstamped tree.

**Not verified here:** the `.htaccess` has not been run through a live
LiteSpeed or Apache — this environment has neither. Its container tags are
balanced and every directive is standard, but the first real test is A6's
header check on your own domain. Do that check; it takes a minute and it is
the difference between "it looks fine" and "it is serving what it should".

Also not verifiable from here: anything involving the four external services.
They all key off the origin in the browser's address bar, which does not exist
until the site is live.

## What is deliberately not here

**A `git` deploy straight into `public_html`.** hPanel offers it, and it works,
but it clones the whole 487 MB repository into the web root — `.git` included,
which holds every version of every file and the remote URL. The `.htaccess`
blocks `.git` and the tooling directories, and that is a second lock rather
than the first one. Uploading only what the site serves is the first one.

**A Content-Security-Policy header.** The map loads tiles, fonts, routing,
Overpass and Google from a set of origins that grows whenever a basemap is
added. A CSP one origin out of date is a blank map with an error
only the console shows. It is worth adding — with the network panel open and a
deliberate pass over every request the app makes — and it is not worth copying
from a hardening checklist.

**Node on shared hosting.** Hostinger's shared plans do not run it, and the
"Node.js app" entries in some tutorials are Cloud/VPS features. If AI reports
matter and you are on a shared plan, leave the backend on Render.

---

## Related

- `.htaccess` — every rule in it says why it is there.
- `docs/DEPLOY-NOTES.md` — the GitHub Pages deploy, and the caching problem
  this branch's `.htaccess` finally fixes.
- `docs/ACCOUNTS-SETUP.md` — the database, the accounts API, and moving the
  Supabase data across. **Read it after A2**: the site will load without it,
  and nobody will be able to sign in.
- `docs/AI-REPORTS-SETUP.md` — the backend's environment variables.
