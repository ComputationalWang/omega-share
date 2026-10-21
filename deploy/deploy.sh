#!/usr/bin/env bash
# Ships the current commit to the hosted box (ADR 0020, docs/ops/hosting.md).
#
#   DEPLOY_HOST=deploy@<server-ip> [DEPLOY_KEY=<private key path>] deploy/deploy.sh [--server rust|bun] [--dry-run]
#
# Everything is built here, never on the box, and from the committed tree (git archive), so
# ignored files and local env never reach a release. --server picks what runs (default rust since the
# switch PR, ADR 0050; Bun needs an explicit --server bun):
#   bun   the site (vite) and the server's production node_modules (pure JS, so arch-independent);
#   rust  the site and the aarch64 omega-server binary (scripts/build-server-rs.sh, then the artifact checks in
#         deploy/check-server-binary.sh: a binary that fails them is never uploaded).
# Bun goes to /opt/omega-share/releases/<commit>, Rust to releases/<commit>-rust (so a deploy of one kind from the
# same commit never rsyncs --delete into the other's live or rollback dir), each with the launcher bin/omega-ops; `current` is flipped and
# the server's unit restarted (omega-share.service runs a Rust release, omega-share-bun.service a Bun one);
# if /healthz doesn't answer, the previous release and ITS unit are put back. A restart is graceful (ADR 0032):
# sockets close with 1012 and clients reconnect on their own, back in their seats.
#
# Rollback after the switch (7 days, ADR 0050): `deploy/deploy.sh --server bun` from a checkout of this commit
# or later. The newest Bun release is also kept past the usual 5, so flipping back by hand works too.
set -euo pipefail

usage() {
  echo "usage: DEPLOY_HOST=deploy@<host> [DEPLOY_KEY=<key>] deploy/deploy.sh [--server rust|bun] [--dry-run]" >&2
  exit 2
}

dry_run=0
server=rust
while (( $# )); do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --server) (( $# >= 2 )) || usage; server="$2"; shift 2 ;;
    --server=*) server="${1#--server=}"; shift ;;
    *) usage ;;
  esac
done
[[ "$server" == rust || "$server" == bun ]] || usage
host="${DEPLOY_HOST:-}"
[[ "$host" =~ ^[a-z_][a-z0-9_-]*@[A-Za-z0-9.:-]+$ ]] || usage

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The site is built with Bun whichever server ships.
pin="$(tr -d '[:space:]' < "$root/.bun-version")"
[[ "$pin" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo ".bun-version is not a version: $pin" >&2; exit 1; }
have="$(bun --version)"
[[ "$have" == "$pin" ]] || { echo "local bun $have does not match .bun-version $pin" >&2; exit 1; }

# The cross-build tools, before the site build spends minutes (OME-1606).
if [[ "$server" == rust ]] && ! "$root/scripts/build-server-rs.sh" --check-tools; then
  (( dry_run )) || exit 1
  echo "# (dry run) the build tools are missing; a real deploy would refuse" >&2
fi

sha="$(git -C "$root" rev-parse HEAD)"
if [[ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]]; then
  (( dry_run )) || { echo "working tree has uncommitted changes: a release must be a commit" >&2; exit 1; }
  echo "# (dry run) working tree is dirty; a real deploy would refuse" >&2
fi

base="${OMEGA_DEPLOY_BASE:-/opt/omega-share}" # the override is for the tests, which run the remote script on a scratch dir
release="$base/releases/$sha"; [[ "$server" == rust ]] && release="$release-rust"
ssh_cmd=(ssh -o BatchMode=yes -o IdentitiesOnly=yes)
if [[ -n "${DEPLOY_KEY:-}" ]]; then ssh_cmd+=(-i "$DEPLOY_KEY"); fi
stage="$(mktemp -d)"
trap 'rm -r -f "$stage"' EXIT
src="$stage/src"
rel="$stage/release"

# Runs on the box as the deploy user: check the runtime, flip `current` atomically, restart the release's unit
# (a polkit rule allows exactly those two units), roll back if unhealthy, keep the 5 newest releases plus the newest Bun one.
# Units (deploy/omega-share.service, omega-share-bun.service): a box not yet re-provisioned has only the old
# omega-share.service, which still runs Bun; a Rust deploy refuses to touch it.
remote_template='set -eu
kind=@KIND@
base=@BASE@
release=@RELEASE@
bun_unit() { if systemctl cat omega-share-bun >/dev/null 2>&1; then echo omega-share-bun; else echo omega-share; fi; }
unit_of() { if [ -e "$1/omega-server" ]; then echo omega-share; else bun_unit; fi; }
flip() { ln -sfn "$1" "$base/current.new" && mv -T "$base/current.new" "$base/current"; }
healthy() { for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS -o /dev/null http://127.0.0.1:8787/healthz && return 0; sleep 1; done; return 1; }
if [ "$kind" = rust ]; then
  systemctl cat omega-share 2>/dev/null | grep -q omega-server || { echo "the box omega-share.service does not run omega-server: run provision.sh on the box first (docs/ops/switch-to-rust.md)" >&2; exit 1; }
  unit=omega-share
else
  test "$(/usr/local/bin/bun --version)" = "@BUN@" || { echo "box bun differs from .bun-version @BUN@" >&2; exit 1; }
  unit="$(bun_unit)"
fi
prev="$(readlink -f "$base/current" || true)"
flip @RELEASE@
# The other server must not hold the ports (and on a kind change the old unit is stopped, not restarted).
if [ "$unit" = omega-share ]; then other=omega-share-bun; else other=omega-share; fi
systemctl stop "$other" || true
systemctl restart "$unit"
if ! healthy; then
  if [ -n "$prev" ] && [ "$prev" != "$release" ]; then
    prev_unit="$(unit_of "$prev")"
    flip "$prev"
    if [ "$prev_unit" != "$unit" ]; then systemctl stop "$unit" || true; fi
    systemctl restart "$prev_unit"
    echo "unhealthy: rolled back to $prev" >&2
  fi
  exit 1
fi
cd "$base/releases"
cur="$(readlink -f "$base/current")"
keepbun=""
for d in $(ls -1t); do if [ -e "$d/apps/server/src/index.ts" ] && [ ! -e "$d/omega-server" ]; then keepbun="$d"; break; fi; done
ls -1t | tail -n +6 | while read -r old; do
  [ "$base/releases/$old" = "$cur" ] && continue
  [ "$old" = "$keepbun" ] && continue
  rm -r -f -- "$old"
done'
remote="${remote_template//@KIND@/$server}"
remote="${remote//@BASE@/$base}"
remote="${remote//@RELEASE@/$release}"
remote="${remote//@BUN@/$pin}"

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
# 2. The release: the launcher, the built site and the server.
run mkdir -p "$rel/apps/web" "$rel/bin"
run cp -a "$src/apps/web/dist" "$rel/apps/web/"
run install -m 0755 "$src/deploy/omega-ops" "$rel/bin/omega-ops"
if [[ "$server" == rust ]]; then
  # Built from the archive (reproducible, no local edits), then checked before anything leaves this machine.
  in_dir "$src" env "CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$HOME/.cache/omega-share/deploy-target}" scripts/build-server-rs.sh --out "$rel/omega-server"
  in_dir "$src" env "OMEGA_BUILD_ROOT=$src" deploy/check-server-binary.sh "$rel/omega-server"
else
  # The server + shared sources and the preset layouts it builds rooms from, with production node_modules.
  archive "$rel" package.json bun.lock .bun-version apps/server packages/shared assets/presets
  in_dir "$rel" bun install --frozen-lockfile --production --ignore-scripts --filter @omega/server
fi
# 3. Ship, flip, restart.
run rsync -a --delete --chmod=Dgo+rx,Fgo+r --link-dest="$base/current/" -e "${ssh_cmd[*]}" "$rel/" "$host:$release/"
if (( dry_run )); then
  printf '%s %s <<remote\n%s\nremote\n' "${ssh_cmd[*]}" "$host" "$remote"
  exit 0
fi
"${ssh_cmd[@]}" "$host" "$remote"
echo "deployed $sha ($server) to $host"
