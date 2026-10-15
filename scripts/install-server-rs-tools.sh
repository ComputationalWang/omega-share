#!/usr/bin/env bash
# Installs the pinned cross-build tools into the user's home, never system-wide (deploy/server-rs-build.env):
# zig into ~/.local/share/zig-<version> (checksum-verified before it is unpacked), cargo-zigbuild into
# ~/.local/share/cargo-zigbuild-<version> (cargo checks the crate against the registry checksum), and the aarch64 std.
#
#   scripts/install-server-rs-tools.sh [--dry-run]
#
# Afterwards put both bin dirs on PATH (the script prints the line).
set -euo pipefail

dry_run=0
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  *) echo "usage: scripts/install-server-rs-tools.sh [--dry-run]" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../deploy/server-rs-build.env
source "$root/deploy/server-rs-build.env"
case "$(uname -m)" in
  x86_64) arch=x86_64; sum="$ZIG_SHA256_X86_64" ;;
  aarch64 | arm64) arch=aarch64; sum="$ZIG_SHA256_AARCH64" ;;
  *) echo "no pinned zig for $(uname -m)" >&2; exit 1 ;;
esac
share="${XDG_DATA_HOME:-$HOME/.local/share}"
zig_dir="$share/zig-$ZIG_VERSION"
zb_root="$share/cargo-zigbuild-$CARGO_ZIGBUILD_VERSION"
tarball="zig-$arch-linux-$ZIG_VERSION.tar.xz"
url="https://ziglang.org/download/$ZIG_VERSION/$tarball"

run() { if (( dry_run )); then printf '%q ' "$@"; echo; else "$@"; fi; }

if [[ ! -x "$zig_dir/zig" ]]; then
  stage="$(mktemp -d)"
  trap 'rm -r -f "$stage"' EXIT
  run curl -fsSL -o "$stage/$tarball" "$url"
  if (( dry_run )); then echo "echo '$sum  $tarball' | sha256sum -c   # in the download dir"; else (cd "$stage" && echo "$sum  $tarball" | sha256sum -c); fi
  run mkdir -p "$zig_dir"
  run tar -xJf "$stage/$tarball" -C "$zig_dir" --strip-components=1
fi
run cargo install --locked --version "$CARGO_ZIGBUILD_VERSION" --root "$zb_root" cargo-zigbuild
run rustup target add aarch64-unknown-linux-gnu
echo "export PATH=\"$zb_root/bin:$zig_dir:\$PATH\""
