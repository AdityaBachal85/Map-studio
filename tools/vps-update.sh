#!/usr/bin/env bash
#
# tools/vps-update.sh — update PHP, put the latest build on the server,
# restart, and check what comes back.
#
# FOR THE VPS. map.dbotrealty.tech is served from a Hostinger VPS (Ubuntu
# 24.04, no control panel), not from shared hosting — and hPanel's "deploy
# from GitHub" is a shared-hosting feature that does nothing on a VPS. A push
# builds the hostinger-build branch on GitHub; this script is what brings that
# build onto the server.
#
# Run it as root in hPanel → VPS → Browser terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/AdityaBachal85/Map-studio/Map-Studio_Hostinger/tools/vps-update.sh | bash
#
# To have every later push appear by itself within five minutes:
#
#   curl -fsSL https://raw.githubusercontent.com/AdityaBachal85/Map-studio/Map-Studio_Hostinger/tools/vps-update.sh | bash -s -- --auto
#
# Options:
#   --auto        also install a five-minute check for new builds
#   --site-only   only bring the files up to date: no apt, no restarts
#   --root DIR    the site's folder, when the web server's config does not say
#   --quiet       print problems only (what the five-minute check uses)
#
# SAFE TO RUN AGAIN. It never prints or replaces the database settings; backs
# the site folder up before changing a file; refuses to write into a folder
# that holds some other site; and restarts the web server only after its own
# configuration test passes — a broken config is reported, not switched on.

set -uo pipefail

DOMAIN="map.dbotrealty.tech"
REPO="AdityaBachal85/Map-studio"
BRANCH="hostinger-build"
SELF_URL="https://raw.githubusercontent.com/$REPO/Map-Studio_Hostinger/tools/vps-update.sh"
STATE_DIR="/var/lib/map-studio"
BACKUP_DIR="/var/backups/map-studio"
LOG="/var/log/map-studio-update.log"
# Ubuntu 24.04's own PHP. Current, and patched by Ubuntu's security updates —
# no third-party package source needed. The API needs 8.0 or newer.
PHPV="8.3"

AUTO=0; SITE_ONLY=0; QUIET=0; ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --auto)      AUTO=1 ;;
    --site-only) SITE_ONLY=1 ;;
    --quiet)     QUIET=1 ;;
    --root)      ROOT="${2:-}"; shift ;;
    *)           echo "Unknown option: $1"; exit 2 ;;
  esac
  shift
done

PROBLEMS=()
say()  { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }
step() { say ""; say "== $*"; }
ok()   { say "   ok   $*"; }
note() { say "   ..   $*"; }
bad()  {
  [ "$QUIET" = 1 ] && printf '%s  ' "$(date '+%F %T')"
  printf '   !!   %s\n' "$*"
  PROBLEMS+=("$*")
}

if [ "$(id -u)" != 0 ]; then
  echo "Run this as root. (The hPanel browser terminal already is; elsewhere, put sudo in front of bash.)"
  exit 1
fi

running()  { systemctl is-active --quiet "$1" 2>/dev/null; }
has_unit() { systemctl cat "$1" >/dev/null 2>&1; }

is_map_studio() { [ -f "$1/js/constants.js" ] && grep -q "APP_VERSION" "$1/js/constants.js" 2>/dev/null; }
version_in()    { sed -n "s/.*const APP_VERSION = '\([^']*\)'.*/\1/p" "$1/js/constants.js" 2>/dev/null | head -1; }
# Empty, or holding nothing but a web server's own placeholder page.
is_fresh() {
  [ -d "$1" ] || return 1
  [ -z "$(ls -A "$1" 2>/dev/null | grep -vxE 'index\.nginx-debian\.html|\.well-known')" ]
}

# ---------------------------------------------------------------------------
step "Web server"
# ---------------------------------------------------------------------------

SERVER=""
for s in nginx apache2 caddy lshttpd lsws; do
  if running "$s"; then SERVER="$s"; break; fi
done
if [ -n "$SERVER" ]; then
  ok "$SERVER is running"
else
  bad "No nginx, Apache, Caddy or LiteSpeed service is running on this server."
  if command -v ss >/dev/null; then
    note "listening on ports 80/443:"
    ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | sed 's/^/          /'
  fi
  if command -v docker >/dev/null; then
    note "containers:"
    docker ps --format '          {{.Names}}  {{.Image}}  {{.Ports}}' 2>/dev/null
  fi
fi

# The server blocks / virtual hosts that name the domain, as text.
site_config() {
  case "$SERVER" in
    nginx)
      # nginx -T prints every file it loaded, each after a "# configuration
      # file" line, so includes are already resolved. Braces are counted to
      # find each top-level `server { … }`; the ones naming the domain print.
      nginx -T 2>/dev/null | awk -v d="$DOMAIN" '
        /^# configuration file / { depth = 0; inblk = 0; next }
        {
          line = $0; sub(/#.*/, "", line)
          if (depth == 0 && line ~ /^[ \t]*server[ \t]*\{/) { inblk = 1; name = 0; buf = "" }
          if (inblk) buf = buf $0 "\n"
          if (inblk && line ~ /^[ \t]*server_name[ \t]/ && index(line, d)) name = 1
          o = gsub(/\{/, "{", line); c = gsub(/\}/, "}", line); depth += o - c
          if (inblk && depth == 0) { if (name) printf "%s", buf; inblk = 0 }
        }' ;;
    apache2)
      cat /etc/apache2/sites-enabled/* 2>/dev/null | awk -v d="$DOMAIN" '
        /<VirtualHost/ { inv = 1; name = 0; buf = "" }
        inv { buf = buf $0 "\n" }
        inv && /^[ \t]*Server(Name|Alias)[ \t]/ && index($0, d) { name = 1 }
        /<\/VirtualHost>/ { if (name) printf "%s", buf; inv = 0 }' ;;
    caddy)
      cat /etc/caddy/Caddyfile 2>/dev/null | awk -v d="$DOMAIN" '
        index($0, d) && /\{/ { inb = 1; depth = 0 }
        inb { print; o = gsub(/\{/, "{"); c = gsub(/\}/, "}"); depth += o - c; if (depth <= 0) inb = 0 }' ;;
  esac
}

CONF="$(site_config)"
if [ -z "$ROOT" ] && [ -n "$CONF" ]; then
  case "$SERVER" in
    nginx)   ROOT="$(printf '%s' "$CONF" | awk '/^[ \t]*root[ \t]/ { r = $2; sub(/;.*/, "", r); gsub(/["\x27]/, "", r); print r; exit }')" ;;
    apache2) ROOT="$(printf '%s' "$CONF" | awk '/^[ \t]*DocumentRoot[ \t]/ { r = $2; gsub(/"/, "", r); print r; exit }')" ;;
    caddy)   ROOT="$(printf '%s' "$CONF" | awk '$1 == "root" { print $NF; exit }')" ;;
  esac
  [ -n "$ROOT" ] && ok "$DOMAIN is served from $ROOT"
fi
if [ -n "$SERVER" ] && [ -z "$CONF" ]; then
  bad "$SERVER has no site configured for $DOMAIN."
fi

# Nothing in the config: look where a hand install would usually be.
if [ -z "$ROOT" ]; then
  for d in "/var/www/$DOMAIN" "/var/www/$DOMAIN/public_html" "/var/www/map" "/var/www/html"; do
    if is_map_studio "$d"; then ROOT="$d"; note "found Map Studio in $ROOT"; break; fi
  done
fi
ROOT="${ROOT%/}"

# ---------------------------------------------------------------------------
if [ "$SITE_ONLY" = 0 ]; then
step "PHP"
# ---------------------------------------------------------------------------

  was="$(php -v 2>/dev/null | head -1)"
  note "before: ${was:-PHP was not installed}"
  export DEBIAN_FRONTEND=noninteractive
  {
    echo; echo "=== $(date '+%F %T') vps-update"
  } >>"$LOG"
  if ! apt-get update -q >>"$LOG" 2>&1; then
    bad "apt-get update failed — see $LOG"
  fi

  # Apache running PHP as its own module keeps doing so; everything else
  # (nginx, Caddy, Apache through FastCGI) talks to PHP-FPM.
  want="php$PHPV-cli php$PHPV-mysql php$PHPV-mbstring"
  if [ "$SERVER" = apache2 ] && apache2ctl -M 2>/dev/null | grep -q php_module; then
    want="$want libapache2-mod-php$PHPV"
  else
    want="$want php$PHPV-fpm"
  fi
  # shellcheck disable=SC2086
  if apt-get install -y -q $want >>"$LOG" 2>&1; then ok "installed/updated: $want"
  else bad "could not install $want — see $LOG"; fi

  # And every PHP package already on the server, to the newest Ubuntu has.
  installed="$(dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 'php*' 'libapache2-mod-php*' 2>/dev/null | awk '$1 == "ii" { print $2 }' | tr '\n' ' ')"
  if [ -n "$installed" ]; then
    # shellcheck disable=SC2086
    apt-get install -y -q --only-upgrade $installed >>"$LOG" 2>&1 \
      || bad "upgrading the installed PHP packages failed — see $LOG"
  fi
  ok "now: $(php -v 2>/dev/null | head -1)"

  for m in pdo_mysql mbstring; do
    php -m 2>/dev/null | grep -qix "$m" || bad "PHP module $m is missing — the API needs it"
  done

  # Which PHP the site is actually handed to, which is not necessarily the
  # one just updated: a site pointed at php8.1-fpm keeps using 8.1.
  if [ "$SERVER" = nginx ]; then
    sock="$(printf '%s' "$CONF" | awk '/fastcgi_pass/ { r = $2; sub(/;.*/, "", r); print r; exit }')"
    if [ -n "$sock" ]; then
      ok "nginx hands .php files to $sock"
      case "$sock" in
        *php$PHPV*|127.0.0.1:*|localhost:*) ;;
        *php[0-9]*) bad "the site uses $sock, not PHP $PHPV — it was updated within its own version, not moved to $PHPV" ;;
      esac
    elif [ -n "$CONF" ]; then
      bad "nginx's config for $DOMAIN never passes .php to PHP, so /api — sign-in, saving maps, the People page — cannot work. Send this output to Claude for the exact config."
    fi
  fi
fi

# ---------------------------------------------------------------------------
step "Site files"
# ---------------------------------------------------------------------------

DEPLOYED=0
if [ -z "$ROOT" ]; then
  bad "Could not tell which folder $DOMAIN is served from. Run again with --root /path/to/the/site"
elif [ ! -d "$ROOT" ]; then
  bad "The site folder $ROOT does not exist."
elif ! is_map_studio "$ROOT" && ! is_fresh "$ROOT"; then
  bad "$ROOT holds something that is not Map Studio, so nothing was copied into it. If that really is where the site belongs, empty the folder and run this again."
elif git -C "$ROOT" -c safe.directory="$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # A git checkout: pull its own branch, fast-forward only, so a change made
  # by hand on the server is reported rather than overwritten.
  g() { git -C "$ROOT" -c safe.directory="$ROOT" "$@"; }
  before="$(g rev-parse --short HEAD)"
  if g fetch -q origin && g merge -q --ff-only '@{u}' >>"$LOG" 2>&1; then
    after="$(g rev-parse --short HEAD)"
    if [ "$before" = "$after" ]; then ok "git checkout on $(g rev-parse --abbrev-ref HEAD) is already up to date ($after)"
    else ok "git checkout updated $before -> $after"; DEPLOYED=1; fi
  else
    bad "$ROOT is a git checkout that could not be fast-forwarded (changed by hand on the server?) — see $LOG"
  fi
else
  want_sha="$(curl -fsSL -m 30 -H 'Accept: application/vnd.github.sha' \
    "https://api.github.com/repos/$REPO/commits/$BRANCH" 2>/dev/null || true)"
  have_sha="$(cat "$STATE_DIR/deployed-sha" 2>/dev/null || true)"
  if ! printf '%s' "$want_sha" | grep -qE '^[0-9a-f]{40}$'; then
    bad "Could not ask GitHub for the latest build (no internet from this server, or GitHub is down)."
  elif [ "$want_sha" = "$have_sha" ] && is_map_studio "$ROOT"; then
    ok "already on the latest build (${want_sha:0:7}, v$(version_in "$ROOT"))"
  else
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    if ! curl -fsSL -m 120 "https://codeload.github.com/$REPO/tar.gz/$want_sha" -o "$tmp/build.tgz"; then
      bad "Could not download the build from GitHub."
    else
      mkdir "$tmp/site"
      tar -xzf "$tmp/build.tgz" -C "$tmp/site" --strip-components=1 --no-same-owner --no-same-permissions
      if ! is_map_studio "$tmp/site"; then
        bad "The download does not look like a Map Studio build — nothing was changed."
      else
        # The backup holds api/config.php if it lives there, database
        # password included — so it is readable by root alone.
        mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
        bk="$BACKUP_DIR/site-$(date +%Y%m%d-%H%M%S).tgz"
        if (umask 077; tar -czf "$bk" -C "$ROOT" . 2>>"$LOG"); then
          note "backed up the old files to $bk"
          ls -1t "$BACKUP_DIR"/site-*.tgz 2>/dev/null | tail -n +6 | xargs -r rm -f
        fi
        old="$(version_in "$ROOT")"
        # Read before copying: copying "site/." would also stamp the temp
        # folder's owner (root) onto the site folder itself, and everything
        # after would then be handed to root instead of the web server's user.
        owner="$(stat -c '%U:%G' "$ROOT")"
        # Copied over the top, never mirrored: nothing on the server that is
        # not in the build is deleted — the config file, certbot's
        # .well-known, anything put there by hand all stay where they are.
        # Entry by entry, so the site folder's own owner and mode are left be.
        find "$tmp/site" -mindepth 1 -maxdepth 1 -exec cp -a {} "$ROOT/" \;
        (cd "$tmp/site" && find . -mindepth 1 -print0) | (cd "$ROOT" && xargs -0 chown -h "$owner")
        mkdir -p "$STATE_DIR"; printf '%s\n' "$want_sha" >"$STATE_DIR/deployed-sha"
        ok "site updated ${old:+v$old }-> v$(version_in "$ROOT") (build ${want_sha:0:7})"
        DEPLOYED=1
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
if [ "$SITE_ONLY" = 0 ]; then
step "Restart"
# ---------------------------------------------------------------------------

  if has_unit "php$PHPV-fpm" && ! running "php$PHPV-fpm" && [ "$SERVER" != apache2 ]; then
    systemctl enable --now "php$PHPV-fpm" >>"$LOG" 2>&1 && ok "started php$PHPV-fpm"
  fi
  for u in $(systemctl list-units --type=service --state=running --no-legend 'php*-fpm*' 2>/dev/null | awk '{ print $1 }'); do
    if systemctl restart "$u"; then ok "restarted $u"; else bad "could not restart $u"; fi
  done

  if [ -n "$SERVER" ]; then
    passed=1
    case "$SERVER" in
      nginx)   test_out="$(nginx -t 2>&1)" || passed=0 ;;
      apache2) test_out="$(apache2ctl configtest 2>&1)" || passed=0 ;;
      caddy)   test_out="$(caddy validate --config /etc/caddy/Caddyfile 2>&1)" || passed=0 ;;
      *)       test_out="" ;;
    esac
    if [ "$passed" = 1 ]; then
      if systemctl restart "$SERVER"; then ok "restarted $SERVER"
      else bad "$SERVER failed to restart — run: systemctl status $SERVER"; fi
    else
      bad "$SERVER's configuration test failed, so it was NOT restarted and is still running the old configuration: $(printf '%s' "$test_out" | tail -2 | tr '\n' ' ')"
    fi
  fi
fi

# ---------------------------------------------------------------------------
if [ "$QUIET" = 0 ] && [ -n "$ROOT" ] && [ -n "$SERVER" ]; then
step "Check"
# ---------------------------------------------------------------------------

  # Asked of this server directly, past DNS and any CDN, so the answer is
  # about these files and nothing in between.
  get() {
    curl -sLk -m 15 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$1" 2>/dev/null \
      || curl -sL -m 15 -H "Host: $DOMAIN" "http://127.0.0.1$1" 2>/dev/null
  }

  served="$(get "/js/constants.js?nocache=$$" | sed -n "s/.*const APP_VERSION = '\([^']*\)'.*/\1/p" | head -1)"
  ondisk="$(version_in "$ROOT")"
  if [ -z "$served" ]; then
    bad "The server did not return js/constants.js for $DOMAIN."
  elif [ "$served" = "$ondisk" ]; then
    ok "the server is serving v$served"
  else
    bad "The server is serving v$served, but $ROOT holds ${ondisk:+v$ondisk}${ondisk:-no Map Studio build} — $SERVER is serving $DOMAIN from another folder."
  fi

  # WHETHER THE DATABASE SETTINGS EXIST IS ASKED OF THE API, NOT OF THE DISK.
  # This used to look for the file in three folders and report it missing
  # when it was in none — on a server where the API was happily reading it
  # from a path set by MAPSTUDIO_CONFIG, which no folder list can know about.
  # The API knows exactly where it looked: a health check that reaches the
  # database proves the file is in place, and one that cannot names the path
  # it wanted.
  health="$(get /api/health)"
  if printf '%s' "$health" | grep -q '"ok":true'; then
    ok "the API has its database settings, reaches the database, and the tables are current"
  elif printf '%s' "$health" | grep -q 'Server is not configured'; then
    bad "No database settings yet, so sign-in cannot work. The API says: $(printf '%s' "$health" | sed -n 's/.*"detail":"\([^"]*\)".*/\1/p' | head -c 400)"
  elif printf '%s' "$health" | grep -q '<?php'; then
    bad "/api returns PHP source code instead of running it — PHP is not connected to $SERVER for this site."
  elif printf '%s' "$health" | grep -qE '"(ok|error)"'; then
    # PHP is running; what it says is about the database or the schema.
    bad "the API is running but reports a problem: $(printf '%s' "$health" | head -c 300)"
  else
    bad "/api/health did not answer as the API: $(printf '%s' "$health" | tr -s '\n' ' ' | head -c 200)"
  fi

  # The one check that matters most if PHP is not wired up: a .php file the
  # server does not run is a file it sends, password and all.
  if get /api/config.php | grep -q "db_pass"; then
    bad "SECURITY: https://$DOMAIN/api/config.php can be downloaded, database password included. Fix this before anything else — send this output to Claude."
  else
    ok "api/config.php cannot be downloaded"
  fi
fi

# ---------------------------------------------------------------------------
if [ "$AUTO" = 1 ]; then
step "Automatic updates"
# ---------------------------------------------------------------------------

  if [ -z "$ROOT" ]; then
    bad "Not installed: the site folder is not known."
  elif curl -fsSL -m 30 "$SELF_URL" -o /usr/local/sbin/map-studio-update; then
    chmod 755 /usr/local/sbin/map-studio-update
    cat >/etc/cron.d/map-studio-update <<EOF
# Installed by tools/vps-update.sh --auto. Every five minutes, asks GitHub
# whether there is a new build of $DOMAIN and copies it in if there is.
# Delete this file to stop it.
*/5 * * * * root /usr/local/sbin/map-studio-update --site-only --quiet --root "$ROOT" >>$LOG 2>&1
EOF
    chmod 644 /etc/cron.d/map-studio-update
    ok "every push now reaches the site within five minutes (log: $LOG)"
  else
    bad "Not installed: could not download the script from GitHub."
  fi
fi

# ---------------------------------------------------------------------------

if [ "$QUIET" = 1 ]; then
  [ ${#PROBLEMS[@]} -eq 0 ]; exit $?
fi
say ""
if [ ${#PROBLEMS[@]} -eq 0 ]; then
  say "All done. Open https://$DOMAIN and press Ctrl+Shift+R once — the version in the sidebar should read v$(version_in "$ROOT")."
  exit 0
fi
echo "Finished with ${#PROBLEMS[@]} problem(s). Copy everything above into the chat with Claude:"
printf '   - %s\n' "${PROBLEMS[@]}"
exit 1
