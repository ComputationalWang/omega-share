#!/usr/bin/env bash
# Ships the current commit to the hosted box (ADR 0020, docs/ops/hosting.md).
#
#   DEPLOY_HOST=deploy@<server-ip> [DEPLOY_KEY=<private key path>] deploy/deploy.sh [--dry-run]
#
# Everything is built here, never on the box, and from the committed tree (git archive), so
# ignored files and local env never reach a release: the site (vite) and the server's production
# node_modules (pure JS, so arch-independent). The release goes to
# /opt/omega-share/releases/<commit>, `current` is flipped and the service restarted; if
# /healthz doesn't answer, the previous release is put back. A restart is graceful (ADR 0032):
# sockets close with 1012 and clients reconnect on their own, back in their seats.
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
[[ "$pin" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo ".bun-version is not a version: $pin" >&2; exit 1; }
have="$(bun --version)"
[[ "$have" == "$pin" ]] || { echo "local bun $have does not match .bun-version $pin" >&2; exit 1; }

sha="$(git -C "$root" rev-parse HEAD)"
if [[ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]]; then
  (( dry_run )) || { echo "working tree has uncommitted changes: a release must be a commit" >&2; exit 1; }
  echo "# (dry run) working tree is dirty; a real deploy would refuse" >&2
fi

base=/opt/omega-share
release="$base/releases/$sha"
ssh_cmd=(ssh -o BatchMode=yes -o IdentitiesOnly=yes)
if [[ -n "${DEPLOY_KEY:-}" ]]; then ssh_cmd+=(-i "$DEPLOY_KEY"); fi
stage="$(mktemp -d)"
trap 'rm -r -f "$stage"' EXIT
src="$stage/src"
rel="$stage/release"

# Runs on the box as the deploy user: check the runtime pin, flip `current` atomically, restart
# (a polkit rule allows exactly this unit), roll back if unhealthy, keep the 5 newest releases.
remote="set -eu
test \"\$(/usr/local/bin/bun --version)\" = '$pin' || { echo 'box bun differs from .bun-version $pin' >&2; exit 1; }
prev=\"\$(readlink -f $base/current || true)\"
flip() { ln -sfn \"\$1\" $base/current.new && mv -T $base/current.new $base/current; }
healthy() { for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS -o /dev/null http://127.0.0.1:8787/healthz && return 0; sleep 1; done; return 1; }
flip $release
systemctl restart omega-share
if ! healthy; then
  if [ -n \"\$prev\" ] && [ \"\$prev\" != $release ]; then flip \"\$prev\"; systemctl restart omega-share; echo \"unhealthy: rolled back to \$prev\" >&2; fi
  exit 1
fi
cd $base/releases && ls -1t | tail -n +6 | while read -r old; do [ \"$base/releases/\$old\" = \"\$(readlink -f $base/current)\" ] || rm -r -f -- \"\$old\"; done"

show() { printf '%q ' "$@"; echo; }
run() { if (( dry_run )); then show "$@"; else "$@"; fi; }
in_dir() { local dir="$1"; shift; if (( dry_run )); then printf 'cd %q && ' "$dir"; show "$@"; else (cd "$dir" && "$@"); fi; }
archive() { # dest paths...
  local dest="$1"; shift
  if (( dry_run )); then echo "git -C $root archive $sha $* | tar -x -C $dest"; return; fi
  mkdir -p "$dest"
  git -C "$root" archive "$sha" "$@" | tar -x -C "$dest"
}

# 1. The site, built from the archived commit with a clean environment.
archive "$src"
in_dir "$src" bun install --frozen-lockfile --ignore-scripts
in_dir "$src" env -i PATH="$PATH" HOME="$HOME" OMEGA_BUILD_SHA="$sha" bun run --filter @omega/web build
# 2. The release: server + shared sources, the built site, production node_modules.
archive "$rel" package.json bun.lock .bun-version apps/server packages/shared
run mkdir -p "$rel/apps/web"
run cp -a "$src/apps/web/dist" "$rel/apps/web/"
in_dir "$rel" bun install --frozen-lockfile --production --ignore-scripts --filter @omega/server
# 3. Ship, flip, restart.
run rsync -a --delete --chmod=Dgo+rx,Fgo+r --link-dest="$base/current/" -e "${ssh_cmd[*]}" "$rel/" "$host:$release/"
if (( dry_run )); then
  printf '%s %s <<remote\n%s\nremote\n' "${ssh_cmd[*]}" "$host" "$remote"
  exit 0
fi
"${ssh_cmd[@]}" "$host" "$remote"
echo "deployed $sha to $host"
