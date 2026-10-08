#!/usr/bin/env bash
# Off-box copy (runbook: docs/ops/backup.md). Runs on the operator's machine, not the box:
# pulls the box's finished nightly snapshots over SSH and keeps the newest 14 here.
#
#   OMEGA_BACKUP_SOURCE=deploy@box.example.org:/var/backups/omega-share/ \
#   OMEGA_BACKUP_DEST=~/omega-share-backups \
#   OMEGA_BACKUP_SSH_KEY=~/.ssh/omega_deploy \
#   deploy/backup/pull.sh
#
# On the box the snapshots are 0600 and owned by the service user, so the remote rsync runs as
# that user (OMEGA_BACKUP_RSYNC_PATH); deploy/backup/sudoers.omega-backup allows only the
# read-only sender side. A failed pull prunes nothing.
set -euo pipefail

src=${OMEGA_BACKUP_SOURCE:-}
dest=${OMEGA_BACKUP_DEST:-}
keep=${OMEGA_BACKUP_KEEP:-14}
rsync_path=${OMEGA_BACKUP_RSYNC_PATH:-sudo -n -u omega-share rsync}
if [[ -z $src || -z $dest || ! $keep =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: OMEGA_BACKUP_SOURCE=user@host:/var/backups/omega-share/ OMEGA_BACKUP_DEST=<dir> [OMEGA_BACKUP_SSH_KEY=<key>] [OMEGA_BACKUP_KEEP=14] pull.sh" >&2
  exit 2
fi

ssh_cmd="ssh -o BatchMode=yes -o IdentitiesOnly=yes"
if [[ -n ${OMEGA_BACKUP_SSH_KEY:-} ]]; then
  [[ $OMEGA_BACKUP_SSH_KEY != *[[:space:]]* ]] || { echo "pull.sh: OMEGA_BACKUP_SSH_KEY must not contain spaces" >&2; exit 2; }
  ssh_cmd+=" -i $OMEGA_BACKUP_SSH_KEY"
fi

pattern='omega-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].db'
umask 077
mkdir -p -- "$dest"
chmod 700 -- "$dest"

# Only finished snapshots: the hidden .omega-*.tmp files still being written never match.
rsync -rtp --chmod=D700,F600 --include="$pattern" --exclude='*' \
  -e "$ssh_cmd" --rsync-path="$rsync_path" -- "$src" "$dest/"

mapfile -t snaps < <(find "$dest" -maxdepth 1 -type f -name "$pattern" -printf '%f\n' | sort -r)
for old in "${snaps[@]:keep}"; do
  rm -f -- "${dest:?}/$old"
  echo "pruned $old"
done
newest=$(find "$dest" -maxdepth 1 -type f -name "$pattern" -printf '%f\n' | sort | tail -n 1)
[[ -n $newest ]] || { echo "pull.sh: no snapshot pulled" >&2; exit 1; }
# rsync -t keeps the box's mtime: nothing newer than 36 h means the nightly snapshot is failing.
if [[ -z $(find "$dest/$newest" -mmin -2160) ]]; then
  echo "pull.sh: newest snapshot $newest is older than 36 h: check omega-share-backup.service on the box" >&2
  exit 1
fi
echo "pulled to $dest: newest $newest"
