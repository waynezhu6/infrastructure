#!/usr/bin/env bash
# Registers an app: writes apps/<name>.caddy from the template.
# Merging that file to main lets the app deploy, and makes the next deploy of
# this repo serve it at waynezhu.dev/apps/<name>/ (frontend) and
# waynezhu.dev/api/<name>/ (backend). What the app needs besides (its database)
# comes from its own infra.yml, provisioned by the deployer on each app deploy.
#
# Usage: scripts/register-app.sh [--static | --root] <name>
#   <name>    the app repo's name, lowercased (e.g. notes). The app's backend
#             must be reachable as <name>-backend; the deployer does this.
#   --static  for an app with no backend (backend: false in its infra.yml):
#             only waynezhu.dev/apps/<name>/, serving its files as they are.
#   --root    the root site: a static app (backend: false) whose files serve
#             every waynezhu.dev path no app claims. Only one app can be it.

set -euo pipefail

cd "$(dirname "$0")/.."

TEMPLATE=apps/_app.caddy.tmpl
case "${1:-}" in
  --static) TEMPLATE=apps/_static.caddy.tmpl; shift ;;
  --root)   TEMPLATE=apps/_root.caddy.tmpl; shift ;;
esac
NAME="${1:-}"

if [ -z "$NAME" ]; then
  echo "Usage: $0 [--static | --root] <name>" >&2
  exit 1
fi
if ! [[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]]; then
  echo "Invalid name '$NAME': use lowercase letters, digits and dashes." >&2
  exit 1
fi

OUT="apps/$NAME.caddy"
if [ -e "$OUT" ]; then
  echo "$OUT already exists; $NAME is already registered." >&2
  exit 1
fi

if [ "$TEMPLATE" = apps/_root.caddy.tmpl ]; then
  for f in apps/*.caddy; do
    if [ -e "$f" ] && head -n 1 "$f" | grep -q '^# Root site'; then
      echo "$f is already the root site; remove it first." >&2
      exit 1
    fi
  done
fi

sed -e "s/__NAME__/$NAME/g" "$TEMPLATE" > "$OUT"
echo "Wrote $OUT"
