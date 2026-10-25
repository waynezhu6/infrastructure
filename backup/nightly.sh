#!/usr/bin/env bash
# Runs backup.sh once a day at BACKUP_HOUR_UTC. A loop rather than crond,
# because crond doesn't pass the container's environment to its jobs.
set -uo pipefail

hour="${BACKUP_HOUR_UTC:-3}"
echo "Backing up daily at ${hour}:00 UTC"
while true; do
  now="$(date -u +%s)"
  next="$(date -u -d "$(date -u +%Y-%m-%d) ${hour}:00:00" +%s)"
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  sleep $((next - now))
  backup.sh || echo "Backup failed; trying again tomorrow" >&2
done
