#!/bin/sh
# Nightly consistent snapshot of the SQLite DB while the server runs (research §2.5, ADR 0020).
# Run by omega-share-backup.service as the service user. Keeps 14 days; deploy/pull-backups.sh
# copies them off the box. Restore: docs/ops/hosting.md.
set -eu
dir=/var/backups/omega-share
db=/var/lib/omega-share/omega.db
# A dot name: never matches the omega-*.db glob that rotation and the off-box pull use.
tmp="$dir/.omega-new.db"
rm -f "$tmp"
sqlite3 -cmd '.timeout 5000' "$db" "VACUUM INTO '$tmp'"
[ "$(sqlite3 -readonly "$tmp" 'PRAGMA integrity_check')" = ok ] || { echo "snapshot failed integrity_check" >&2; exit 1; }
mv "$tmp" "$dir/omega-$(date -u +%F).db"
find "$dir" -name 'omega-*.db' -mtime +14 -delete
