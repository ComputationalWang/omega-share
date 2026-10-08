#!/usr/bin/env bash
# Restore a nightly snapshot on the box (runbook: docs/ops/backup.md). Run as root.
#
#   deploy/backup/restore.sh /var/backups/omega-share/omega-2026-10-08.db
#
# 1. verify the snapshot as the service user (a bad snapshot costs no downtime),
# 2. stop the service, 3. restore it to DB_PATH as the service user (owner right, mode 0600,
# the old DB kept aside), 4. start the service and list the rooms it serves.
# If step 3 refuses, the service starts again on the old database and this exits 1; if DB_PATH
# is gone by then, the service stays stopped (it would create and serve an empty database).
set -euo pipefail

usage() {
  echo "usage: restore.sh <snapshot.db>   (env: DB_PATH, OMEGA_SERVICE, OMEGA_USER, OMEGA_BUN, OMEGA_APP_DIR, OMEGA_CHECK_URL)" >&2
  exit 2
}
[[ $# -eq 1 ]] || usage
snap=$1
[[ -f $snap ]] || { echo "restore.sh: no such snapshot: $snap" >&2; exit 2; }

service=${OMEGA_SERVICE:-omega-share}
user=${OMEGA_USER:-omega-share}
bun=${OMEGA_BUN:-/usr/local/bin/bun}
app=${OMEGA_APP_DIR:-/opt/omega-share/current}
db=${DB_PATH:-/var/lib/omega-share/omega.db}
check=${OMEGA_CHECK_URL:-http://127.0.0.1:8787/rooms}
backup=("$bun" "$app/apps/server/scripts/backup.ts")

echo "1/4 verify $snap"
runuser -u "$user" -- "${backup[@]}" verify "$snap"

echo "2/4 stop $service"
systemctl stop "$service"

echo "3/4 restore to $db"
if ! runuser -u "$user" -- env DB_PATH="$db" "${backup[@]}" restore "$snap"; then
  # Never start on a missing DB: the server would create an empty one and serve it.
  if [[ ! -f $db ]]; then
    echo "restore.sh: restore failed and $db is missing; $service stays stopped. Put back the newest $db.pre-restore-* (with its -wal) or rerun this script" >&2
    exit 1
  fi
  echo "restore.sh: restore refused; starting $service again on the previous database" >&2
  systemctl start "$service"
  exit 1
fi

echo "4/4 start $service"
systemctl start "$service"
for _ in $(seq 1 30); do
  if body=$(curl -fsS --max-time 2 "$check" 2>/dev/null); then
    echo "serving: $body"
    echo "now join a room in the browser and check its furniture is where it was"
    exit 0
  fi
  sleep 1
done
echo "restore.sh: $service did not answer $check within 30 s; see journalctl -u $service" >&2
exit 1
