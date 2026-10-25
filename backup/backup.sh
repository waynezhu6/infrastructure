#!/usr/bin/env bash
# One backup: every database (pg_dumpall, roles included) and secrets/, in
# one archive under /backups, encrypted with BACKUP_PASSPHRASE, checked, and
# copied to the offsite bucket if one is configured. Keeps the newest
# BACKUP_KEEP_LOCAL archives on the server; the bucket's own lifecycle rule
# expires old ones there, so the server's key never needs delete rights.
set -euo pipefail

BACKUPS="${BACKUP_DIR:-/backups}"
keep="${BACKUP_KEEP_LOCAL:-7}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# healthchecks.io: BACKUP_PING_URL if set, otherwise the "backup" check under
# HC_PING_KEY (made on its first ping), as the monitor reports (monitor/).
ping_url="${BACKUP_PING_URL:-}" create=""
if [ -z "$ping_url" ] && [ -n "${HC_PING_KEY:-}" ]; then
  ping_url="https://hc-ping.com/$HC_PING_KEY/backup" create="?create=1"
fi
ping() {
  [ -n "$ping_url" ] || return 0
  wget -q -T 10 -O /dev/null "${ping_url}$1${create}" || true
}
trap 'ping /fail' ERR

echo "==> Backup $stamp"
# Lets healthchecks.io show how long each backup takes.
ping /start
pg_dumpall --clean --if-exists | gzip > "$work/postgres.sql.gz"
tar -C "${INFRA_DIR:-/infra}" -czf "$work/secrets.tar.gz" secrets
tar -C "$work" -cf "$work/archive.tar" postgres.sql.gz secrets.tar.gz

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  out="$BACKUPS/backup-$stamp.tar.gpg"
  printf '%s' "$BACKUP_PASSPHRASE" > "$work/pass"
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$work/pass" \
    --symmetric --cipher-algo AES256 -o "$out.partial" "$work/archive.tar"
  # Check the archive opens and the dump finished before trusting it.
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$work/pass" -d "$out.partial" \
    | tar -xOf - postgres.sql.gz | gunzip | tail -n 5 | grep -q "PostgreSQL database cluster dump complete"
else
  # Without a passphrase nothing leaves the server, so it stays unencrypted
  # next to the database it came from.
  out="$BACKUPS/backup-$stamp.tar"
  cp "$work/archive.tar" "$out.partial"
  tar -xOf "$out.partial" postgres.sql.gz | gunzip | tail -n 5 | grep -q "PostgreSQL database cluster dump complete"
fi
mv "$out.partial" "$out"
chmod 600 "$out"
# Owned like the folder, so the deploy user can read it without sudo.
chown "$(stat -c %u:%g "$BACKUPS")" "$out"
echo "    Wrote $out ($(du -h "$out" | cut -f1))"

if [ -z "${BACKUP_S3_BUCKET:-}" ]; then
  echo "    No offsite bucket configured; kept on the server only"
elif [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "    Not copying offsite: set BACKUP_PASSPHRASE so backups leave the server encrypted" >&2
  false
else
  # Uploads only, never lists or deletes, so a write-only key is enough.
  rclone copyto --s3-no-check-bucket --s3-no-head --no-check-dest "$out" "offsite:$BACKUP_S3_BUCKET/$(basename "$out")"
  echo "    Copied to $BACKUP_S3_BUCKET"
fi

# Newest $keep stay on the server.
find "$BACKUPS" -maxdepth 1 -name 'backup-*.tar*' ! -name '*.partial' | sort -r | tail -n +"$((keep + 1))" | xargs -r rm -f
find "$BACKUPS" -maxdepth 1 -name '*.partial' -mmin +60 -delete
ping ""
echo "==> Backup $stamp done"
