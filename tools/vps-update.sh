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
#   --no-relay    do not set up the Overpass relay (below)
#   --root DIR    the site's folder, when the web server's config does not say
#   --quiet       print problems only (what the five-minute check uses)
#
# THE OVERPASS RELAY. A ring scan asks OpenStreetMap's Overpass servers
# straight from the browser, and an office firewall or DNS filter that blocks
# them makes every scan fail in under a second. On nginx this adds
# /osm/overpass/… to the site: the browser asks the site, the server asks
# Overpass. Signed-in users only, checked by the API, and nothing from the
# browser — cookie, session, address — is passed on with the query.
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

# The four Overpass mirrors the app uses (js/services/ringFeatures.js,
# OVERPASS_MIRRORS), under the ids the relay serves them at.
OVERPASS_RELAYS=(
  "de      overpass-api.de/api/interpreter"
  "kumi    overpass.kumi.systems/api/interpreter"
  "coffee  overpass.private.coffee/api/interpreter"
  "mailru  maps.mail.ru/osm/tools/overpass/api/interpreter"
)
SNIPPET="/etc/nginx/snippets/map-studio-overpass.conf"
sock=""

AUTO=0; SITE_ONLY=0; QUIET=0; RELAY=1; ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --auto)      AUTO=1 ;;
    --site-only) SITE_ONLY=1 ;;
    --no-relay)  RELAY=0 ;;
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

# The relay's nginx config. $1 = where to write it, $2 = PHP-FPM's address.
write_relay_snippet() {
  local dns id path host
  # nginx resolves the mirrors itself, at request time, so a mirror whose name
  # does not resolve today cannot stop nginx starting — which a hostname
  # written straight into proxy_pass would.
  dns="$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ { printf "%s ", $2 }' /etc/resolv.conf 2>/dev/null)"
  [ -n "$dns" ] || dns="1.1.1.1 8.8.8.8 "
  {
    cat <<'EOF'
# Map Studio — the Overpass relay. Written by tools/vps-update.sh and
# rewritten every time it runs: change the script, not this file.
#
# Lets a signed-in user's ring scan reach OpenStreetMap's Overpass servers
# through this site, for browsers on networks that block them. The app asks
# /osm/overpass/ping once per page and uses these routes when it answers.

location = /osm/overpass/ping {
    default_type text/plain;
    add_header Cache-Control "no-store" always;
    return 200 "map-studio-overpass\n";
}

# Who is signed in, asked of the API before every relayed query: 200 lets it
# through, 401 stops it. Not an open relay — that would let anyone spend this
# server's Overpass allowance and get its address rate-limited for everybody.
location = /osm/overpass/_auth {
    internal;
    fastcgi_pass __SOCK__;
    fastcgi_pass_request_body off;
    fastcgi_param CONTENT_LENGTH  "";
    fastcgi_param SCRIPT_FILENAME $document_root/api/index.php;
    fastcgi_param SCRIPT_NAME     /api/index.php;
    fastcgi_param DOCUMENT_ROOT   $document_root;
    fastcgi_param REQUEST_URI     /api/auth/check;
    fastcgi_param PATH_INFO       "";
    fastcgi_param QUERY_STRING    "";
    fastcgi_param REQUEST_METHOD  GET;
    fastcgi_param SERVER_PROTOCOL $server_protocol;
    fastcgi_param SERVER_NAME     $host;
    fastcgi_param REMOTE_ADDR     $remote_addr;
    fastcgi_param HTTPS           $https if_not_empty;
}
EOF
    for entry in "${OVERPASS_RELAYS[@]}"; do
      read -r id path <<<"$entry"
      host="${path%%/*}"
      cat <<EOF

location = /osm/overpass/$id {
    auth_request /osm/overpass/_auth;
    limit_except POST { deny all; }
    client_max_body_size 64k;

    resolver __DNS__ valid=300s ipv6=off;
    resolver_timeout 5s;
    set \$overpass_upstream https://$path;
    proxy_pass \$overpass_upstream;
    proxy_ssl_server_name on;
    proxy_ssl_verify on;
    proxy_ssl_verify_depth 3;
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;

    # The query and nothing else: no cookie, no session, no address of the
    # person asking reaches the mirror.
    proxy_pass_request_headers off;
    proxy_set_header Host $host;
    proxy_set_header Content-Type "application/x-www-form-urlencoded";
    proxy_set_header Accept "application/json";
    proxy_set_header User-Agent "DBOT Map Studio relay (https://map.dbotrealty.tech)";
    proxy_hide_header Set-Cookie;

    # Overpass may take the 25 s the query allows it, plus the download.
    proxy_connect_timeout 10s;
    proxy_send_timeout 30s;
    proxy_read_timeout 60s;
}
EOF
    done
  } | sed -e "s#__SOCK__#$2#" -e "s#__DNS__#${dns% }#" >"$1"
}

# ---------------------------------------------------------------------------
if [ "$SITE_ONLY" = 0 ] && [ "$RELAY" = 1 ]; then
step "Overpass relay"
# ---------------------------------------------------------------------------

  if [ "$SERVER" != nginx ]; then
    note "set up automatically on nginx only; this server runs ${SERVER:-no web server}"
  elif [ -z "$sock" ]; then
    bad "Overpass relay not set up: it asks the API who is signed in, and nginx passes nothing to PHP for this site yet."
  elif [ -z "$ROOT" ] || ! grep -q "ms_auth_check" "$ROOT/api/routes/auth.php" 2>/dev/null; then
    bad "Overpass relay not set up: the site's API is too old to answer its sign-in check — the site files did not update."
  else
    # The files that configure the domain, from nginx's own account of what it
    # loaded. readlink: sites-enabled entries are usually links, and editing
    # the link would replace it with a copy.
    files="$(nginx -T 2>/dev/null | awk -v d="$DOMAIN" '
      /^# configuration file / { f = $4; sub(/:$/, "", f); next }
      /^[ \t]*server_name[ \t]/ && index($0, d) { print f }' | sort -u)"
    if [ -z "$files" ]; then
      bad "Overpass relay not set up: could not find the nginx file that configures $DOMAIN."
    else
      stamp="$(date +%Y%m%d-%H%M%S)"
      mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
      had_snippet=0
      [ -f "$SNIPPET" ] && { cp -p "$SNIPPET" "$BACKUP_DIR/relay-$stamp.conf"; had_snippet=1; }
      mkdir -p "$(dirname "$SNIPPET")"
      write_relay_snippet "$SNIPPET" "$sock"

      edited=()
      for f in $files; do
        real="$(readlink -f "$f")"
        grep -qF "include $SNIPPET;" "$real" && continue
        cp -p "$real" "$BACKUP_DIR/nginx-$(basename "$real")-$stamp"
        # After every server_name that names the domain: these routes belong
        # to this site's server blocks and to nobody else's.
        sed -i "/^[[:space:]]*server_name[[:space:]].*${DOMAIN//./\\.}/a\\    include $SNIPPET;" "$real"
        edited+=("$real")
      done

      if test_out="$(nginx -t 2>&1)"; then
        if [ ${#edited[@]} -gt 0 ]; then ok "added to ${edited[*]} (the originals are in $BACKUP_DIR)"
        else ok "already in place; its settings were rewritten"; fi
      else
        # Put everything back exactly as it was, so the restart below finds
        # the configuration that was working before this ran.
        for f in "${edited[@]}"; do cp -p "$BACKUP_DIR/nginx-$(basename "$f")-$stamp" "$f"; done
        if [ "$had_snippet" = 1 ]; then cp -p "$BACKUP_DIR/relay-$stamp.conf" "$SNIPPET"; else rm -f "$SNIPPET"; fi
        bad "Overpass relay not set up: nginx refused its configuration, so it was taken out again: $(printf '%s' "$test_out" | grep -m1 -iE 'emerg|error' | head -c 300)"
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

  if [ "$SERVER" = nginx ] && { [ "$RELAY" = 1 ] || [ -f "$SNIPPET" ]; }; then
    post_code() {
      local c
      c="$(curl -sk -m 20 -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" \
        -X POST --data 'data=' "https://$DOMAIN$1" 2>/dev/null)"
      if [ -z "$c" ] || [ "$c" = 000 ]; then
        c="$(curl -s -m 20 -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" \
          -X POST --data 'data=' "http://127.0.0.1$1" 2>/dev/null)"
      fi
      printf '%s' "$c"
    }
    if [ "$(get /osm/overpass/ping | tr -d '\r\n')" = "map-studio-overpass" ]; then
      ok "the Overpass relay is on"
      code="$(post_code /osm/overpass/de)"
      case "$code" in
        401) ok "and it refuses anyone who is not signed in" ;;
        200) bad "SECURITY: the Overpass relay answers anyone, signed in or not. Run again with --no-relay and send this output to Claude." ;;
        *)   bad "the relay answered a signed-out request with HTTP $code instead of 401 — its sign-in check is not working." ;;
      esac
    elif [ -f "$SNIPPET" ]; then
      bad "the Overpass relay is installed, but $DOMAIN does not answer its ping."
    fi

    # The relay is only as good as this server's own way out.
    reach=0
    for entry in "${OVERPASS_RELAYS[@]}"; do
      read -r id path <<<"$entry"
      c="$(curl -s -m 25 -o /dev/null -w '%{http_code}' \
        --data-urlencode 'data=[out:json][timeout:10];node(1);out ids;' "https://$path" 2>/dev/null)"
      if [ "$c" = 200 ]; then reach=$((reach + 1))
      else note "this server got no answer from ${path%%/*} (HTTP ${c:-none})"; fi
    done
    if [ "$reach" -gt 0 ]; then ok "this server reaches $reach of ${#OVERPASS_RELAYS[@]} Overpass servers"
    else bad "this server cannot reach any Overpass server either, so the relay cannot help yet."; fi
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
