#!/usr/bin/env bash
# Ships the current commit to the hosted box (ADR 0020, docs/ops/hosting.md).
#
#   DEPLOY_HOST=deploy@<server-ip> [DEPLOY_KEY=<private key path>] deploy/deploy.sh [--dry-run]
#
# Everything is built here, never on the box: the site (vite) and the server's production
# node_modules (pure JS, so arch-independent). The release goes to
# /opt/omega-share/releases/<commit>, then `current` is flipped and the service restarted.
# A restart drops sockets for a second or two; clients reconnect with backoff.
set -euo pipefail

usage() {
  echo "usage: DEPLOY_HOST=deploy@<host> [DEPLOY_KEY=<key>] deploy/deploy.sh [--dry-run]" >&2
  exit 2
}

dry_run=0
(( $# <= 1 )) || usage
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  *) usage ;;
esac
host="${DEPLOY_HOST:-}"
[[ "$host" =~ ^[a-z_][a-z0-9_-]*@[A-Za-z0-9.:-]+$ ]] || usage

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pin="$(tr -d '[:space:]' < "$root/.bun-version")"
have="$(bun --version)"
[[ "$have" == "$pin" ]] || { echo "local bun $have does not match .bun-version $pin" >&2; exit 1; }

sha="$(git -C "$root" rev-parse HEAD)"
if [[ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]]; then
  (( dry_run )) || { echo "working tree has uncommitted changes: a release must be a commit" >&2; exit 1; }
  echo "# (dry run) working tree is dirty; a real deploy would refuse" >&2
fi

base=/opt/omega-share
release="$base/releases/$sha"
ssh_opts=(-o BatchMode=yes -o IdentitiesOnly=yes)
if [[ -n "${DEPLOY_KEY:-}" ]]; then ssh_opts+=(-i "$DEPLOY_KEY"); fi
stage="$(mktemp -d)"
trap 'rm -r -f "$stage"' EXIT

# Runs on the box as the deploy user: check the runtime pin, flip `current` atomically,
# restart (a polkit rule allows exactly this unit), keep the 5 newest releases.
remote="set -eu
test \"\$(/usr/local/bin/bun --version)\" = '$pin' || { echo 'box bun differs from .bun-version $pin' >&2; exit 1; }
ln -sfn $release $base/current.new && mv -T $base/current.new $base/current
systemctl restart omega-share
for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS -o /dev/null http://127.0.0.1:8787/healthz && break; sleep 1; done
curl -fsS -o /dev/null http://127.0.0.1:8787/healthz
cd $base/releases && ls -1t | tail -n +6 | while read -r old; do [ \"$base/releases/\$old\" = \"\$(readlink -f $base/current)\" ] || rm -r -f -- \"\$old\"; done"

steps=(
  "cd $root && bun run --filter @omega/web build"
  "git -C $root archive $sha package.json bun.lock .bun-version apps/server packages/shared | tar -x -C $stage"
  "mkdir -p $stage/apps/web && cp -a $root/apps/web/dist $stage/apps/web/"
  "cd $stage && bun install --frozen-lockfile --production --ignore-scripts --filter @omega/server"
  "rsync -a --delete --chmod=Dgo+rx,Fgo+r --link-dest=$base/current/ -e 'ssh ${ssh_opts[*]}' $stage/ $host:$release/"
)

for s in "${steps[@]}"; do
  if (( dry_run )); then echo "$s"; else bash -c "$s"; fi
done
if (( dry_run )); then
  printf 'ssh %s %s <<remote\n%s\nremote\n' "${ssh_opts[*]}" "$host" "$remote"
  exit 0
fi
ssh "${ssh_opts[@]}" "$host" "$remote"
echo "deployed $sha to $host"
