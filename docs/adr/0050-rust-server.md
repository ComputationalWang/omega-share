# ADR 0050 — The server in Rust

**Status:** accepted (2026-10-14), board decision. Partly supersedes [ADR 0001](0001-stack.md): its **Server** bullet (Hono on `Bun.serve`) ends at promotion (§6). Tracking: OME-1141.

## Decision

1. **Rewrite `apps/server` in Rust as `apps/server-rs`**, next to the TS server, and switch once it is proven. At promotion it is renamed to `apps/server`, the TS server is deleted, and Bun leaves the box.
2. **Stack**: Rust (toolchain pinned in `rust-toolchain.toml`), axum + tokio, rusqlite (bundled SQLite) on the same migrations and data, serde/serde_json, the `validator` crate for field rules, `url` (WHATWG) for URLs. One binary, `omega-server`, with `serve`, `admin …` and `backup …` commands.
3. **Contract**: `packages/shared` (Valibot) stays the source of truth for the web app and the extension. The server's copy lives in `apps/server-rs/src/contract` and is checked against Valibot by a comparison test in CI: the same inputs go through `v.safeParse` and the Rust parser, and both must accept or reject alike, except for the three deliberate differences in `apps/server-rs/PORTING.md` (Rust rejects duplicate keys, `1.0`-style integers and lone surrogates). A `packages/shared` change updates the Rust copy in the same PR. Small contract changes that make the Rust side simpler, faster or the flow better are allowed (the extension is pre-alpha and not released); each one updates `packages/shared`, the web app, the extension and `server-rs` together and is recorded here.
4. **Validation and safety**: every boundary (socket frame, HTTP body, header, URL, SQLite row, env var) parses once into a domain type: serde → `validator` → a newtype only its constructor can build. Size caps apply before parsing. `unsafe` is forbidden; `unwrap`/`expect`/`panic`/unchecked indexing/string slicing are clippy errors outside tests. Every security behaviour of the TS server is kept as is: CSP and security headers, the Host and Origin checks, `TRUST_PROXY`, rate limits and their close codes, connection and in-flight caps, the embed allowlist and generic tier (ADR 0024), report and log redaction, the admin socket's permissions; tokens come from the OS CSPRNG, are hashed as today (stored hashes keep verifying) and compared in constant time. `cargo-deny` gates advisories, licences (AGPL-compatible allow list) and sources (crates.io only).
5. **Gates, in order**:
   1. *Correct*: the TS server suite run black-box against the binary, Rust unit tests for the white-box cases, the comparison test, the full e2e suite pointed at Rust, and 1 h of fuzzing per `parse` function with no crash.
   2. *Better*: an external load generator measures both servers on the box (relay latency p50/p95/p99, normal and under flood; RSS with N rooms of 25; CPU). Rust must beat TS on p99 latency and RSS and lose on nothing, with 3 runs agreeing. The CPU part is relaxed to "no more than about 35% above Bun" by [ADR 0051](0051-rust-server-cpu-gate.md).
   3. *Secure*: a full `/security-review` of the crate plus an adversarial pass (oversized and slow connections, Unicode tricks, token timing, path traversal on static files, header injection).
   4. *Stable*: 24 h local soak under load (no panic, no restart, flat RSS), then production with the Bun release kept for an instant rollback (`current` flip) for 7 days, with no new migrations in that window.
6. **Promotion** after the window: rename, delete the TS server, drop Bun from the box, update ADR 0001.
7. **Build and deploy**: `deploy.sh` cross-compiles for `aarch64-unknown-linux-gnu` with `cargo-zigbuild`, pinned to the box's glibc (not musl: its allocator is slow), and ships the binary in the release dir as today. Same systemd hardening, `MemoryMax=512M`, `LimitNOFILE=4096`.

## Why

Performance is priority #1 (CLAUDE.md). Relay latency is a budgeted number (`docs/perf-budgets.md`: ≤ 50 ms, ≤ 50 ms p95 under flood), the box is one small aarch64 machine, and a GC runtime puts pauses in the tail. Rust gives predictable latency and memory, and its type system makes "parse at the boundary, never panic" checkable by the compiler and clippy rather than by review. Doing it now is cheaper than later: the server is ~6.6k lines with a thorough black-box suite to referee the port.

## Process

The company was paused (all agents and routines) for the port, and the TS server and `packages/shared` are frozen until the switch. The board runs the port with implementer and reviewer subagents, one slice per PR (OME-1142…OME-1154). The company resumes at the switch, with server work going to `server-rs` only.

## Consequences

- `bun run check` runs `bun run check:rs` too: `cargo fmt --check`, `clippy -D warnings`, `cargo test`, `cargo deny check`. Agents need the pinned toolchain (`mise` installs `rust`) and `cargo-deny`. Worktrees share one Cargo target dir (`CARGO_TARGET_DIR`), and at most 2 builds run at once.
- `apps/server-rs/PORTING.md` is the working guide: module map, rules, contract hazards, the black-box suite plan.
- ADR 0001's "anything that doesn't run on Bun needs an ADR": this is that ADR.
