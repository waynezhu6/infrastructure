#!/usr/bin/env bash
# Prints the server-side environment for a registered app: its DATABASE_URL
# plus any secrets added by hand to secrets/<name>.env. App deploys append this
# to the app's .env, so credentials never live in the app repo.
#
# Usage: scripts/app-env.sh <name>

set -euo pipefail

cd "$(dirname "$0")/.."

NAME="${1:-}"
if ! [[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]]; then
  echo "Usage: $0 <name>" >&2
  exit 1
fi

if [ ! -f "apps/$NAME.caddy" ]; then
  echo "App '$NAME' is not registered. Run scripts/register-app.sh in the infrastructure repo (or its Register app workflow) and merge the PR." >&2
  exit 1
fi
if [ ! -f "secrets/$NAME.env" ]; then
  echo "App '$NAME' has no secrets/$NAME.env yet. Its database is created by its first deploy through the deployer, with 'postgres: true' in its infra.yml." >&2
  exit 1
fi

cat "secrets/$NAME.env"
