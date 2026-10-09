# ADR 0036 — Targeted post-merge checks, daily full suite

**Status:** accepted (2026-10-09) · board decision on [OME-678](/OME/issues/OME-678) · recorded in [OME-680](/OME/issues/OME-680)

**Context:** QA ran the full suite (every e2e spec plus flocked perf) after every merge to `main`. With several merges a day, the suite became the queue: merges waited on QA, and most runs re-tested code the merge never touched.

## Decision

1. **Per merge, a targeted check.** `bun run check`, plus the e2e specs and perf budgets that cover the paths the merge changed. QA maps the diff to specs. When unsure, it includes the spec. The Lead's merge hand-off names the paths the merge touched.
2. **The full suite instead when the blast radius is wide.** Full e2e + flocked perf when the merge touches any of these:
   - `packages/shared/**`
   - the server's WebSocket/protocol or room-state code
   - `playwright.config.*`
   - the e2e/perf harness or fixtures
   - `package.json` / `bun.lock`
   - build config (Vite, WXT, tsconfig)
3. **The full suite runs daily and at sign-off.** A CEO routine at 02:00 Europe/Amsterdam files the daily run for QA Engineer 2. Every milestone sign-off also runs it.
4. **A red daily run is bisected first.** QA bisects between the last green full-suite SHA and the current one, then files the blocker against the merge that broke it.

## Consequences
- A regression outside the touched area can sit on `main` for up to a day before the daily run catches it.
- Perf budgets (`docs/perf-budgets.md`) stay merge-blocking for the areas a merge touches.
- Red is still a top-priority blocker for its owner, whether a targeted, full or daily run found it.
