#!/usr/bin/env bash
# Registers an app: writes apps/<name>.caddy from the template.
# Merging that file to main makes the next deploy route the domain to the app
# and create its database (see scripts/provision-dbs.sh).
#
# Usage: scripts/register-app.sh <name> [domain]
#   <name>    the app repo's name, lowercased (e.g. notes). The app's backend
#             container must be <name>-backend; app-template does this.
#   [domain]  the public hostname; defaults to <name>.$APPS_DOMAIN

set -euo pipefail

# Every app gets its own subdomain of this by default. A wildcard DNS record
# (*.$APPS_DOMAIN -> server IP) means new apps need no DNS change; Caddy gets
# a certificate per hostname on its own.
APPS_DOMAIN=waynezhu.dev

cd "$(dirname "$0")/.."

NAME="${1:-}"
DOMAIN="${2:-}"

if [ -z "$NAME" ]; then
  echo "Usage: $0 <name> [domain]" >&2
  exit 1
fi
if ! [[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]]; then
  echo "Invalid name '$NAME': use lowercase letters, digits and dashes." >&2
  exit 1
fi
DOMAIN="${DOMAIN:-$NAME.$APPS_DOMAIN}"
if ! [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$DOMAIN" == *.* ]]; then
  echo "Invalid domain '$DOMAIN'." >&2
  exit 1
fi

OUT="apps/$NAME.caddy"
if [ -e "$OUT" ]; then
  echo "$OUT already exists; $NAME is already registered." >&2
  exit 1
fi
if grep -qsx "$DOMAIN {" apps/*.caddy; then
  echo "Domain $DOMAIN is already used by another app." >&2
  exit 1
fi

sed -e "s/__NAME__/$NAME/g" -e "s/__DOMAIN__/$DOMAIN/g" apps/_app.caddy.tmpl > "$OUT"
echo "Wrote $OUT"
