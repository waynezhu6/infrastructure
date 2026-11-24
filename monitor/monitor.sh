#!/usr/bin/env bash
# Every MONITOR_INTERVAL seconds: check each deployed app's /api/health and
# Caddy's request counts, and report to healthchecks.io under HC_PING_KEY
# (README, "Monitoring"). healthchecks.io runs off this server, so if the
# server or this container dies, the "monitor" check stops getting pings and
# it alerts. Without a key it only logs what fails.
set -uo pipefail

interval="${MONITOR_INTERVAL:-60}"
limit="${TRAFFIC_LIMIT_PER_MINUTE:-300}"
APPS="${APPS_DIR:-/infra/apps}"
STATE="${STATE_DIR:-/deploys/apps}"

# ping <check> [/fail] [message]. ?create=1 makes the check on its first ping.
ping() {
  [ -z "${3:-}" ] || echo "$1: $3"
  [ -n "${HC_PING_KEY:-}" ] || return 0
  wget -q -T 10 -O /dev/null --post-data "${3:-}" "https://hc-ping.com/$HC_PING_KEY/$1${2:-}?create=1" ||
    echo "Couldn't reach healthchecks.io to report $1" >&2
}

# Apps the deployer has deployed, unless their infra.yml says monitor: false.
# Registered apps that never deployed have no backend to check yet.
monitored() {
  local state="$STATE/$1/state.json"
  [ -f "$state" ] && jq -e '(.manifest // "null") | (fromjson // {}) | .monitor != false' "$state" > /dev/null
}

healthy() {
  wget -q -T 5 -O /dev/null "http://$1-backend:3001/api/health"
}

check_apps() {
  local file app
  for file in "$APPS"/*.caddy; do
    app="$(basename "$file" .caddy)"
    case "$app" in _*) continue ;; esac
    monitored "$app" || continue
    # One retry, so a backend restarting mid-deploy isn't an outage.
    if healthy "$app" || { sleep 5; healthy "$app"; }; then
      ping "$app"
    else
      ping "$app" /fail "/api/health didn't answer twice in a row"
    fi
  done
}

check_traffic() {
  local over
  over="$(traffic.sh --raw 1 | awk -v limit="$limit" '$2 > limit { printf "%s: %d API requests in the last minute (limit %d)\n", $1, $2, limit }')"
  if [ -n "$over" ]; then
    ping traffic /fail "$over"
  else
    ping traffic
  fi
}

if [ -n "${HC_PING_KEY:-}" ]; then
  echo "Checking every ${interval}s, reporting to healthchecks.io"
else
  echo "Checking every ${interval}s; HC_PING_KEY isn't set, so failures are only logged here"
fi
while true; do
  check_apps
  check_traffic
  ping monitor
  sleep "$interval"
done
