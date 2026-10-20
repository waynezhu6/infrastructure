#!/usr/bin/env bash
# Registers an app: writes apps/<name>.caddy from the template.
# Merging that file to main makes the next deploy serve the app at
# waynezhu.dev/apps/<name>/ (frontend) and waynezhu.dev/api/<name>/ (backend),
# and create its database (see scripts/provision-dbs.sh).
#
# Usage: scripts/register-app.sh <name>
#   <name>  the app repo's name, lowercased (e.g. notes). The app's backend
#           container must be <name>-backend; app-template does this.

set -euo pipefail

cd "$(dirname "$0")/.."

NAME="${1:-}"

if [ -z "$NAME" ]; then
  echo "Usage: $0 <name>" >&2
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

sed -e "s/__NAME__/$NAME/g" apps/_app.caddy.tmpl > "$OUT"
echo "Wrote $OUT"
