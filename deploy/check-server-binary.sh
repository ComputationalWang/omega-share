#!/usr/bin/env bash
# Artifact checks for the Rust server binary, run by deploy.sh before anything is uploaded (OME-1174, S10 hardening list).
#
#   deploy/check-server-binary.sh <omega-server> [max-glibc]     (default: GLIBC in deploy/server-rs-build.env)
#
# Needs readelf and objdump with aarch64 support (binutils-multiarch or a full binutils). Prints one FAIL line per
# broken property and exits 1; exits 0 with "ok" otherwise.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin="${1:-}"
[[ -f "$bin" ]] || { echo "usage: check-server-binary.sh <omega-server> [max-glibc]" >&2; exit 2; }
if [[ -n "${2:-}" ]]; then max="$2"; else
  # shellcheck source=server-rs-build.env
  source "$here/server-rs-build.env"
  max="$GLIBC"
fi

failed=0
fail() { echo "FAIL: $*"; failed=1; }

hdr="$(readelf -h "$bin" 2>&1)"
grep -q 'Class:.*ELF64' <<< "$hdr" && grep -q 'Machine:.*AArch64' <<< "$hdr" || fail "not an aarch64 ELF64 binary"
grep -q 'Type:.*DYN' <<< "$hdr" || fail "not PIE (ELF type is not DYN)"

prog="$(readelf -lW "$bin" 2>&1)"
grep -q 'INTERP' <<< "$prog" || fail "not dynamically linked against glibc (no INTERP)"
grep -q 'GNU_RELRO' <<< "$prog" || fail "no RELRO segment"
# GNU_STACK flags are the tokens after the memory size, before the alignment: `RW`, or `R E` when executable.
stack="$(awk '/GNU_STACK/ { f = ""; for (i = 7; i < NF; i++) f = f $i; print f }' <<< "$prog")"
[[ -n "$stack" && "$stack" != *E* ]] || fail "executable or missing stack (GNU_STACK flags '${stack:-none}')"

dyn="$(readelf -dW "$bin" 2>&1)"
grep -Eq 'BIND_NOW|FLAGS_1.*NOW' <<< "$dyn" || fail "lazy binding: no BIND_NOW, so RELRO is partial"

grep -Eq '\.symtab|\.debug_' <<< "$(readelf -SW "$bin" 2>&1)" && fail "not stripped (.symtab or .debug_* present)"

newest="$(objdump -T "$bin" 2>/dev/null | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/^GLIBC_//' | sort -V | tail -1)"
if [[ -n "$newest" && "$(printf '%s\n%s\n' "$max" "$newest" | sort -V | tail -1)" != "$max" ]]; then
  fail "needs GLIBC_$newest, newer than the pinned $max"
fi

for needle in /__test/ OMEGA_TEST_ load_extension /home/; do
  grep -aq -- "$needle" "$bin" && fail "contains '$needle'"
done

size="$(wc -c < "$bin")"
(( size >= 1000000 && size <= 40000000 )) || fail "size $size bytes is outside 1 MB .. 40 MB"

(( failed )) && exit 1
echo "ok: $bin (${size} bytes, glibc <= $max)"
