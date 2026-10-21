#!/usr/bin/env bash
# Cross-compiles the Rust server for the aarch64 box (ADR 0050, deploy/server-rs-build.env pins the tools).
#
#   scripts/build-server-rs.sh [--dry-run] [--out <file>]
#   scripts/build-server-rs.sh --check-tools    # only checks zig and cargo-zigbuild (deploy.sh runs it before anything else)
#
# zig is only the C compiler/linker; the target's `.<glibc>` suffix links against that glibc, so the binary runs on
# every Ubuntu at least that old. apps/server-rs/.cargo/config.toml's LIBSQLITE3_FLAGS (no load_extension, SQLITE_DQS=0)
# apply to this cross build too: cargo reads it for every target, and deploy/check-server-binary.sh proves it.
# Tools: scripts/install-server-rs-tools.sh; their install dirs go first on PATH here, so nobody edits PATH. Output: $CARGO_TARGET_DIR/aarch64-unknown-linux-gnu/release/omega-server.
set -euo pipefail

usage() {
  echo "usage: scripts/build-server-rs.sh [--dry-run] [--out <file>] | --check-tools" >&2
  exit 2
}

dry_run=0
check_only=0
out=""
while (( $# )); do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --check-tools) check_only=1; shift ;;
    --out) (( $# >= 2 )) || usage; out="$2"; shift 2 ;;
    *) usage ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../deploy/server-rs-build.env
source "$root/deploy/server-rs-build.env"
target="aarch64-unknown-linux-gnu.$GLIBC"
# Build paths never reach the binary: the workspace becomes /src, the cargo registry /cargo.
rustflags="--remap-path-prefix=$root=/src --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
bin="${CARGO_TARGET_DIR:-$root/target}/aarch64-unknown-linux-gnu/release/omega-server"

# Where scripts/install-server-rs-tools.sh puts them.
share="${XDG_DATA_HOME:-$HOME/.local/share}"
export PATH="$share/cargo-zigbuild-$CARGO_ZIGBUILD_VERSION/bin:$share/zig-$ZIG_VERSION:$PATH"
check_tools() {
  local have_zig have_zb
  have_zig="$(zig version 2>/dev/null || true)"
  [[ "$have_zig" == "$ZIG_VERSION" ]] || { echo "zig is '${have_zig:-missing}', need $ZIG_VERSION: run scripts/install-server-rs-tools.sh" >&2; exit 1; }
  have_zb="$(cargo-zigbuild --version 2>/dev/null || true)"
  [[ "$have_zb" == *" $CARGO_ZIGBUILD_VERSION" ]] || { echo "cargo-zigbuild is '${have_zb:-missing}', need $CARGO_ZIGBUILD_VERSION: run scripts/install-server-rs-tools.sh" >&2; exit 1; }
}
if (( check_only )); then check_tools; exit 0; fi

if (( dry_run )); then
  echo "RUSTFLAGS=\"$rustflags\" cargo zigbuild --release --locked --target $target -p omega-server"
  [[ -z "$out" ]] || echo "cp $bin $out"
  exit 0
fi

check_tools
cd "$root"
RUSTFLAGS="$rustflags" cargo zigbuild --release --locked --target "$target" -p omega-server
if [[ -n "$out" ]]; then
  mkdir -p "$(dirname "$out")"
  cp "$bin" "$out"
fi
echo "built $bin"
