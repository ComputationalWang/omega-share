# Draft (b): courier issues, one per affected agent

Not created. The board creates each as a Paperclip issue assigned to that agent (@mentions wake nobody), after merging this PR. Priority: high; close it with a one-line comment when read.

## 1. Server Engineer

**Title:** The server is Rust now: read PORTING.md and your updated instructions

Production switched from `apps/server` (Bun) to `apps/server-rs` (Rust, `omega-server`) on 2026-10-15. You now own `apps/server-rs/**`. `apps/server` is frozen (parity reference and rollback until 2026-10-22; S13 then renames and deletes it).

Read first, in this order:
1. `apps/server-rs/PORTING.md` (commands, rules, lock order, deliberate differences, black-box suite).
2. Your instructions `company/agents/server-engineer/AGENTS.md` (rewritten for Rust), `CLAUDE.md`, ADR 0050 and 0051.

What changes for you: Rust hard rules (no unsafe, no unwrap/expect/panic/indexing, `validator` at boundaries, secret newtypes with `ct_eq`, never log ids/titles/nicknames/addresses); the gate is `bun run check` including `check:rs`; contract changes still go through a Lead contract issue, which now also covers the Rust mirror and the corpus; the black-box manifest and the corpus grow with your slices; no migrations until 2026-10-22. Set `CARGO_TARGET_DIR` per worktree and `CARGO_BUILD_JOBS=4`. Claim `apps/server-rs/**` on your issues.

## 2. Lead Engineer

**Title:** The server is Rust now: merging Rust PRs and the contract rule

Production switched to `apps/server-rs` on 2026-10-15. `apps/server` (TS) is frozen until 2026-10-22, then S13 renames and deletes it.

Read first: `company/agents/lead-engineer/AGENTS.md` ("Merging Rust PRs"), `CLAUDE.md`, ADR 0050 and 0051, `apps/server-rs/PORTING.md`.

What changes for you: `check` now includes `check:rs`; `e2e` runs against the Rust server (the `e2e-rust` workflow is merged into it); a contract issue changes `packages/shared` and the Rust mirror `apps/server-rs/src/contract` together and regenerates `corpus/out` (`bun apps/server-rs/corpus/gen.ts`); review for the clippy rules, TDD order (red commit with tests and minimal stubs), and manifest/corpus growth; no migrations and no TS-server changes during the rollback window. Plan S13 for 2026-10-22 only after the board's sign-off.

## 3. QA Engineer

**Title:** The server is Rust now: e2e, black-box suite, soak and deploys

Production switched to `apps/server-rs` on 2026-10-15; the TS server is a frozen reference and rollback until 2026-10-22.

Read first: `company/agents/qa-engineer/AGENTS.md` ("The Rust server"), `apps/server-rs/PORTING.md` ("The black-box suite", "Performance"), ADR 0051, `docs/ops/switch-to-rust.md`.

What changes for you: e2e defaults to the Rust server (`E2E_SERVER=bun` for the TS one; use your own `CARGO_TARGET_DIR`); `bun run check` includes `check:rs`; review server PRs for TDD order, manifest and corpus growth; the black-box suite excludes virtual-time (B), white-box (D) and shell (E) tests by design; add a short soak (`bun run soak -- --server "<omega-server serve>" --minutes 30`, flocked) to every milestone sign-off and the 24 h run before big releases; deploys use `deploy/deploy.sh` (default rust), `--server bun` only for the documented rollback.

## 4. QA Engineer 2

**Title:** The server is Rust now: the daily full suite runs against it

Production switched to `apps/server-rs` on 2026-10-15; the TS server is a frozen reference and rollback until 2026-10-22.

Read first: `company/agents/qa-engineer-2/AGENTS.md` ("The Rust server"), `docs/ops/switch-to-rust.md`, ADR 0051.

What changes for you: the daily full suite on `main` now runs e2e against the Rust server (default; first run builds the binary, so allow a few minutes and set your own `CARGO_TARGET_DIR` and `CARGO_BUILD_JOBS=4`); include `bun run check` (with `check:rs`) and a short soak (`--minutes 30`, under the perf flock) in the daily run during the rollback window; a red result is a blocker for its owner as before, and a server crash or a restart loop goes to the CEO at once. Never deploy with `--server bun` yourself.
