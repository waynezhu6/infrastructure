#!/usr/bin/env bash
# Client side of the deployer (deployer/src/server.ts). Run by action.yml with
# DIGEST, DEPLOY_URL and DEPLOY_ENV set.
set -euo pipefail

if ! [[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "::error::digest must be sha256:<64 hex characters>, got '$DIGEST'"
  exit 1
fi
if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
  echo "::error::The deploy job needs 'permissions: id-token: write' so the server can tell which repo is deploying."
  exit 1
fi

# DEPLOY_ENV is NAME=value lines (or a JSON object). The job's own GitHub token
# is dropped if passed; the backend has no use for it.
if ! body="$(jq -cn --arg digest "$DIGEST" --arg env "${DEPLOY_ENV:-}" '
  ($env | ltrimstr(" ")) as $raw
  | (if ($raw | startswith("{")) then ($raw | fromjson)
     else [$raw | split("\n")[] | select(test("\\S")) | (capture("^\\s*(?<key>[^=\\s]+)=(?<value>.*)$") // error("bad line"))] | from_entries end)
  | if type == "object" then with_entries(select(.key | ascii_upcase != "GITHUB_TOKEN")) else error("not an object") end
  | {digest: $digest, env: .}' 2>/dev/null)"; then
  echo "::error::The env input must be NAME=value lines, e.g. RAPIDAPI_KEY=\${{ secrets.RAPIDAPI_KEY }}."
  exit 1
fi

# A fresh token per request: they're short-lived and each may start one deploy.
token() {
  curl -sSf --retry 3 -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
    "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$DEPLOY_URL" | jq -r .value
}

verdict() {
  case "$1" in
    succeeded) exit 0 ;;
    superseded) echo "::notice::A newer push is being deployed instead of this one."; exit 0 ;;
    *) echo "::error::Deploy $2 $1. Its log is above, and on the server in ~/infrastructure/deploys/logs/."; exit 1 ;;
  esac
}

out="$(mktemp)"
headers="$(mktemp)"
TOKEN="$(token)"
echo "::add-mask::$TOKEN"

# The response is the deploy's output as it happens, ending in
# "==> deploy <id> <succeeded|failed|superseded>".
set +e
curl -sS -N --connect-timeout 20 --fail-with-body -D "$headers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @- "$DEPLOY_URL" <<<"$body" | tee "$out"
code="${PIPESTATUS[0]}"
set -e

last="$(tail -n 1 "$out")"
if [[ "$last" =~ ^"==> deploy "([0-9a-f]+)" "(succeeded|failed|superseded)$ ]]; then
  verdict "${BASH_REMATCH[2]}" "${BASH_REMATCH[1]}"
fi

id="$(tr -d '\r' < "$headers" | sed -n 's/^[Xx]-[Dd]eploy-[Ii]d: *//p' | tail -n 1)"
if [ "$code" = 22 ] || [ -z "$id" ]; then
  echo
  echo "::error::The deployer refused the request or couldn't be reached (curl exit $code)."
  exit 1
fi

# The connection dropped mid-deploy. The server carries on, so follow it by id.
echo
echo "Connection lost (curl exit $code); following deploy $id."
from="$(grep -c '' "$out" || true)"
for _ in $(seq 1 240); do
  sleep 5
  status_json="$(curl -sS --fail-with-body -H "Authorization: Bearer $(token)" "$DEPLOY_URL/jobs/$id?from=$from")" || continue
  jq -r '.lines[]' <<<"$status_json"
  from="$(jq -r .next <<<"$status_json")"
  status="$(jq -r .status <<<"$status_json")"
  case "$status" in
    succeeded|failed|superseded) verdict "$status" "$id" ;;
  esac
done
echo "::error::Gave up waiting for deploy $id after 20 minutes."
exit 1
