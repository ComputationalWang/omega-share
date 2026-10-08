#!/usr/bin/env bash
# Off-box copy of the nightly DB snapshots (ADR 0020, docs/ops/hosting.md): pulls
# /var/backups/omega-share from the box as the deploy user and keeps 60 days here.
#
#   DEPLOY_HOST=deploy@<server-ip> [DEPLOY_KEY=<key>] [BACKUP_DIR=<dir>] deploy/pull-backups.sh
set -euo pipefail

host="${DEPLOY_HOST:-}"
[[ "$host" =~ ^[a-z_][a-z0-9_-]*@[A-Za-z0-9.:-]+$ ]] || { echo "usage: DEPLOY_HOST=deploy@<host> deploy/pull-backups.sh" >&2; exit 2; }
dest="${BACKUP_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/omega-share/backups}"
ssh_opts=(-o BatchMode=yes -o IdentitiesOnly=yes)
if [[ -n "${DEPLOY_KEY:-}" ]]; then ssh_opts+=(-i "$DEPLOY_KEY"); fi

mkdir -p "$dest"
chmod 0700 "$dest"
# Snapshots are immutable once written: never delete here what the box rotated out.
rsync -a --chmod=D700,F600 --include='omega-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].db' --exclude='*' -e "ssh ${ssh_opts[*]}" "$host:/var/backups/omega-share/" "$dest/"
dated='omega-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].db'
find "$dest" -name "$dated" -mtime +60 -delete
latest="$(find "$dest" -name "$dated" | sort | tail -n 1)"
[[ -n "$latest" ]] || { echo "no snapshot pulled" >&2; exit 1; }
# rsync -a keeps the box's mtime: no snapshot in 36 h means the nightly backup is failing.
[[ -n "$(find "$latest" -mmin -2160)" ]] || { echo "newest snapshot $latest is older than 36 h: check omega-share-backup on the box" >&2; exit 1; }
echo "latest off-box snapshot: $latest"
