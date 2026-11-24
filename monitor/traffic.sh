#!/usr/bin/env bash
# Requests per app in the last MINUTES (default 60), from Caddy's access logs.
# `make traffic` prints a table; --raw prints "<app> <api> <pages>" lines for
# monitor.sh.
set -euo pipefail

raw=false
if [ "${1:-}" = "--raw" ]; then raw=true; shift; fi
minutes="${1:-60}"
LOGS="${LOG_DIR:-/logs}"

since=$(($(date +%s) - minutes * 60))
# The current file and the newest rolled one (named by when it rolled, so
# the glob's last), so a roll inside the window doesn't hide its first part.
files=()
rolled=("$LOGS"/access-*.log)
[ ! -e "${rolled[-1]}" ] || files+=("${rolled[-1]}")
[ ! -e "$LOGS/access.log" ] || files+=("$LOGS/access.log")
if [ "${#files[@]}" -eq 0 ]; then
  $raw || echo "No access logs in $LOGS yet"
  exit 0
fi

# Caddy logs each URI cut to /api/<app> or /apps/<app> (Caddyfile).
counts=$(cat "${files[@]}" | jq -r --argjson since "$since" '
  select(.ts >= $since) | .request.uri // "" |
  capture("^/(?<kind>api|apps)/(?<app>[^/]+)")? | "\(.app) \(.kind)"' |
  awk '{ if ($2 == "api") api[$1]++; else pages[$1]++; seen[$1] = 1 }
    END { for (a in seen) printf "%s %d %d\n", a, api[a], pages[a] }' | sort -k2,2nr)

if $raw; then
  [ -z "$counts" ] || echo "$counts"
  exit 0
fi
echo "Requests in the last $minutes minutes:"
{
  echo "APP API PAGES"
  [ -z "$counts" ] || echo "$counts"
} | awk '{ printf "  %-20s %8s %8s\n", $1, $2, $3 }'
