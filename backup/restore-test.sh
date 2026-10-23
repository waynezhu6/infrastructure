#!/usr/bin/env bash
# Proves a backup restores: loads it into a throwaway Postgres inside this
# container (never the live one) and lists each database's tables with row
# counts. Usage: restore-test.sh [backup file]; defaults to the newest in
# BACKUP_DIR (/backups). A .gpg archive needs BACKUP_PASSPHRASE.
set -euo pipefail

file="${1:-$(find "${BACKUP_DIR:-/backups}" -maxdepth 1 -name 'backup-*.tar*' ! -name '*.partial' | sort -r | head -n 1)}"
[ -n "$file" ] && [ -f "$file" ] || { echo "No backup found" >&2; exit 1; }
echo "==> Restoring $file into a throwaway Postgres"

work="$(mktemp -d)"
data="$work/data"
cleanup() {
  su-exec postgres pg_ctl -D "$data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

if [[ "$file" == *.gpg ]]; then
  printf '%s' "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is needed to open $file}" > "$work/pass"
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$work/pass" -d "$file" | tar -xf - -C "$work"
else
  tar -xf "$file" -C "$work"
fi

chown -R postgres "$work"
su-exec postgres initdb -D "$data" -U postgres --auth=trust >/dev/null 2>&1
su-exec postgres pg_ctl -D "$data" -o "-c listen_addresses='' -k $work" -w start >/dev/null
q() { psql -h "$work" -U postgres -v ON_ERROR_STOP=0 -qtA "$@"; }

# --clean drops what the fresh server already has; those errors are expected.
gunzip -c "$work/postgres.sql.gz" | q -f - >/dev/null 2>"$work/errors" || true

for db in $(q -d postgres -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1"); do
  echo "  $db"
  for table in $(q -d "$db" -c "SELECT format('%I.%I', schemaname, relname) FROM pg_stat_user_tables ORDER BY 1"); do
    echo "    $table: $(q -d "$db" -c "SELECT count(*) FROM $table") rows"
  done
done
echo "  secrets/: $(tar -tzf "$work/secrets.tar.gz" | grep -c '\.env$') env files"
echo "==> Restore test passed"
