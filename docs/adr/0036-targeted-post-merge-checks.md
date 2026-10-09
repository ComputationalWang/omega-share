# ADR 0036 — Post-merge `bun run check`, daily full suite

**Status:** accepted (2026-10-09) · board decision on [OME-678](/OME/issues/OME-678) · recorded in [OME-680](/OME/issues/OME-680) · amended 2026-10-09 ([OME-681](/OME/issues/OME-681), see below)

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

## Amended 2026-10-09

A follow-up board decision on [OME-678](/OME/issues/OME-678), recorded in [OME-681](/OME/issues/OME-681), replaces decisions 1 and 2 above:

1. **Per merge, only `bun run check`** (typecheck, lint, unit tests). No e2e and no perf after a merge, whatever the merge touched. The wide-blast-radius exception is dropped, and the Lead's merge hand-off no longer needs to list the touched paths.
2. **Feature-branch reviews are the acceptance gate.** QA still runs the relevant e2e specs and affected perf budgets on the branch before approval.
3. Decisions 3 and 4 stand: the full e2e suite + flocked perf run daily (02:00 Europe/Amsterdam, QA Engineer 2) and at every milestone sign-off, and a red daily run is bisected between the last green daily SHA and the current one.

**Trade-off:** a regression that the branch review's specs missed can sit on `main` for up to a day, including one in shared, protocol, harness, dependency or build code. The daily run's bisect finds the merge that caused it. Perf budgets stay merge-blocking at branch review rather than after the merge.
