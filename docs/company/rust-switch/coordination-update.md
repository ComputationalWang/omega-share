# Draft (a): Coordination document update, "Company Ops" issue OME-1

Not posted. The board pastes this into the Coordination document after the production switch succeeds.

---

## Rust server switch (OME-1141, ADR 0050) — from 2026-10-15

**What changed**
- Production runs the Rust server, `apps/server-rs` (binary `omega-server`; axum/tokio, rusqlite, serde + `validator`). The Paperclip company was paused during the port and resumes now.
- `apps/server` (Bun + Hono) is **frozen**: parity reference for the comparison and black-box tests, and the rollback target until 2026-10-22. After that S13 renames `apps/server-rs` to `apps/server` and deletes the TS server.
- Gate: `bun run check` now includes `check:rs` (fmt, clippy `-D warnings`, cargo tests, cargo-deny, black-box suite). CI `e2e` runs the Playwright lanes against the Rust server; `e2e-rust.yml` is gone; `E2E_SERVER=bun` runs the TS server locally.
- `deploy/deploy.sh` defaults to `--server rust`. `--server bun` is only the documented rollback (`docs/ops/switch-to-rust.md` § 4).
- CLAUDE.md and the Server Engineer, Lead Engineer, QA Engineer and QA Engineer 2 instructions are updated. Read `apps/server-rs/PORTING.md` before touching the server.

**New claim paths**
- `apps/server-rs/**` (incl. `corpus/`, `blackbox/`, `interop/`, `tests/`), `Cargo.toml`, `Cargo.lock`, `deny.toml`, `rust-toolchain.toml`, `perf/server-*.ts`: Server Engineer. The Lead Engineer owns `src/contract/**` together with `packages/shared/**` (one contract issue changes both and regenerates `corpus/out`).
- `apps/server/**` (TS): nobody claims it. No feature work.
- `deploy/**`, `docs/ops/**`: Lead Engineer, with the board for anything that runs on the box.
- `e2e/**`, `perf/**` (other than `server-*.ts`), root `package.json` scripts: QA, as before.

**Rollback window rules (until 2026-10-22)**
1. No migration lands (the TS server refuses a database with a newer `user_version`; a test pins the migration list against the Rust binary).
2. No change to `apps/server` (TS) except a board-ordered rollback fix.
3. Ordinary Rust deploys are fine with `deploy.sh` (default rust); each keeps the newest Bun release. Nobody runs `--server bun` except the board for a rollback.
4. A server crash, a restart loop or a rising RSS goes to the CEO as a top-priority blocker and the board decides on rollback. Do not roll back on your own.
5. After 2026-10-22 with no rollback and the board's sign-off: S13 (rename, delete the TS server, drop Bun from the box).

**Machine rules (unchanged, now with cargo)**: one `CARGO_TARGET_DIR=$HOME/.cache/omega-share/cargo-target-<issue>` per worktree, `CARGO_BUILD_JOBS=4`, never delete outside your worktree, perf only under the flock.
