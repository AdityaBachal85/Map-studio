#!/usr/bin/env bash
# Fetch the MCGM ArcGIS REST responses listed in tools/mcgm-urls.txt and save
# each one to a JSON file.
#
# Usage:  ./tools/fetch-mcgm-responses.sh [output-dir]
# Default output dir: mcgm-responses/
#
# Filenames are derived from the request: <index>_<service>_L<layer>[_<qualifier>].json
# so repeated queries against the same layer (different spatialRel / where /
# distance) land in distinct files.

set -uo pipefail

URL_FILE="$(dirname "$0")/mcgm-urls.txt"
OUT_DIR="${1:-mcgm-responses}"
mkdir -p "$OUT_DIR"

urldecode() { printf '%b' "${1//%/\\x}"; }

# Pull a query parameter's raw (still percent-encoded) value out of a URL.
param() {
  local url="$1" key="$2"
  [[ "$url" =~ (\?|\&)"$key"=([^\&]*) ]] && printf '%s' "${BASH_REMATCH[2]}"
}

slug() {
  # lowercase, strip quotes, collapse anything non-alphanumeric to a single dash
  printf '%s' "$1" \
    | tr 'A-Z' 'a-z' \
    | tr -d "'\"" \
    | sed -e 's/[^a-z0-9]\+/-/g' -e 's/^-//' -e 's/-$//'
}

name_for() {
  local url="$1" idx="$2"
  local service layer parts=()

  if [[ "$url" =~ /services/(.+)/(MapServer|GeometryServer|FeatureServer) ]]; then
    service="$(slug "${BASH_REMATCH[1]}")"
  else
    service="service"
  fi

  if [[ "$url" =~ /(MapServer|FeatureServer)/([0-9]+)/query ]]; then
    layer="l${BASH_REMATCH[2]}"
  elif [[ "$url" =~ GeometryServer/([a-zA-Z]+) ]]; then
    layer="$(slug "${BASH_REMATCH[1]}")"
  else
    layer="req"
  fi

  local rel where dist
  rel="$(param "$url" spatialRel)"
  [[ -n "$rel" && "$rel" != "esriSpatialRelIntersects" ]] && \
    parts+=("$(slug "${rel#esriSpatialRel}")")

  where="$(urldecode "$(param "$url" where)")"
  [[ -n "$where" ]] && parts+=("$(slug "$where")")

  dist="$(param "$url" distance)"
  [[ -n "$dist" ]] && parts+=("d$(slug "$dist")m")

  local qualifier=""
  (( ${#parts[@]} )) && qualifier="_$(IFS=_; echo "${parts[*]}")"

  printf '%02d_%s_%s%s.json' "$idx" "$service" "$layer" "$qualifier"
}

idx=0
ok=0
fail=0
: > "$OUT_DIR/_failures.log"

while IFS= read -r url; do
  [[ -z "$url" || "$url" == \#* ]] && continue
  idx=$((idx + 1))
  file="$OUT_DIR/$(name_for "$url" "$idx")"

  # Retry transient network failures with exponential backoff.
  code=""
  for delay in 0 2 4 8; do
    (( delay )) && sleep "$delay"
    # curl prints 000 itself when the connection never completed.
    code="$(curl -sS -m 120 --compressed -o "$file" -w '%{http_code}' "$url")"
    [[ "$code" == "200" ]] && break
  done

  if [[ "$code" == "200" ]] && python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$file" 2>/dev/null; then
    printf 'ok   %-3s %s\n' "$code" "$file"
    ok=$((ok + 1))
  else
    printf 'FAIL %-3s %s\n' "$code" "$file"
    echo "$code $url" >> "$OUT_DIR/_failures.log"
    fail=$((fail + 1))
  fi
done < "$URL_FILE"

echo
echo "saved $ok/$idx responses to $OUT_DIR/"
if (( fail )); then
  echo "$fail failed - see $OUT_DIR/_failures.log"
  exit 1
fi
