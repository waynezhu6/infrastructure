#!/usr/bin/env bash
# Runs on the server after `docker compose up` (from the Deploy workflow).
# For every registered app (apps/<name>.caddy), makes sure it has a Postgres
# role and database, and that secrets/<name>.env holds its DATABASE_URL.
# Safe to re-run: existing roles, databases and passwords are left alone.

set -euo pipefail

cd "$(dirname "$0")/.."

SECRETS=secrets
install -d -m 700 "$SECRETS"

psql() { docker exec -i postgres psql -U postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

for _ in $(seq 1 30); do
  docker exec postgres pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec postgres pg_isready -U postgres >/dev/null

for f in apps/*.caddy; do
  [ -e "$f" ] || continue
  name="$(basename "$f" .caddy)"
  # Postgres identifiers can't contain '-' unquoted, so notes-api -> notes_api.
  ident="${name//-/_}"
  env_file="$SECRETS/$name.env"

  role_exists="$(psql -c "SELECT 1 FROM pg_roles WHERE rolname = '$ident'")"

  if [ -f "$env_file" ]; then
    password="$(sed -n 's|^DATABASE_URL=postgres://[^:]*:\([^@]*\)@.*|\1|p' "$env_file")"
  elif [ -n "$role_exists" ]; then
    echo "WARNING: role $ident exists but $env_file is missing; can't recover its password. Skipping $name." >&2
    continue
  else
    password="$(openssl rand -hex 24)"
  fi

  if [ -z "$role_exists" ]; then
    psql -c "CREATE ROLE \"$ident\" LOGIN PASSWORD '$password'"
    echo "Created role $ident"
  fi
  if [ -z "$(psql -c "SELECT 1 FROM pg_database WHERE datname = '$ident'")" ]; then
    # As owner, the app role also owns the public schema (pg_database_owner).
    psql -c "CREATE DATABASE \"$ident\" OWNER \"$ident\""
    echo "Created database $ident"
  fi
  # Postgres lets every role connect to every database by default. Only the
  # owning app should reach its own. Re-applied each run, so older databases
  # get it too.
  psql -c "REVOKE CONNECT, TEMPORARY ON DATABASE \"$ident\" FROM PUBLIC"

  if [ ! -f "$env_file" ]; then
    (umask 077; printf 'DATABASE_URL=postgres://%s:%s@postgres:5432/%s\n' "$ident" "$password" "$ident" > "$env_file")
    echo "Wrote $env_file"
  fi
done
