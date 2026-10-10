# ADR 0036 — Targeted post-merge checks, daily full suite

**Status:** accepted (2026-10-09) · board decision on [OME-678](/OME/issues/OME-678) · recorded in [OME-680](/OME/issues/OME-680) · amendment of 2026-10-09 ([OME-681](/OME/issues/OME-681)) reverted 2026-10-10, see below · amended 2026-10-10: perf off the per-merge path ([OME-818](/OME/issues/OME-818)) · amended 2026-10-10: deterministic e2e moves to CI before the merge ([OME-822](/OME/issues/OME-822)) · amended 2026-10-10: `bun run affected` picks the specs ([OME-820](/OME/issues/OME-820)) · §1–2 (per-merge post-check) superseded by ADR 0041

**Context:** QA ran the full suite (every e2e spec plus flocked perf) after every merge to `main`. With several merges a day, the suite became the queue: merges waited on QA, and most runs re-tested code the merge never touched.

## Decision

1. **Per merge, a targeted check.** `bun run check`, plus the e2e specs and perf budgets that cover the paths the merge changed. `bun run affected` maps the diff to specs (amendment of [OME-820](/OME/issues/OME-820) below); before it, QA did this by hand. When unsure, it includes the spec. The Lead's merge hand-off names the paths the merge touched.
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

## Amendment reverted 2026-10-10

A 2026-10-09 amendment ([OME-681](/OME/issues/OME-681)) cut the per-merge check to `bun run check` only. The board reversed it on [OME-678](/OME/issues/OME-678) on 2026-10-10 ([OME-688](/OME/issues/OME-688)), so the original decision above stands: targeted checks per merge, the full suite for wide-blast-radius merges, daily and at sign-off.

## Amendment 2026-10-10: perf off the per-merge path ([OME-818](/OME/issues/OME-818))

Board decision on [OME-818](/OME/issues/OME-818), from a run-log analysis of 30 Sep–10 Oct. QA and QA2 used 57% of all agent run time. Perf runs took about 27 h of it and the sleep/poll loops waiting on them about 23 h, while the full e2e suite took about 4 h. Perf is where QA's time goes, so perf leaves the per-merge path unless the merge needs it. E2e stays as decided above.

1. **Perf per merge only for a perf-relevant diff.** A merge gets a targeted perf run only when it touches a path below, and then only the specs that cover what it touched. Every other merge gets `bun run check` and its e2e specs; the daily full run covers its perf. A wide-blast-radius merge (decision 2) still gets the full suite, flocked perf included. `bun run affected` encodes this list ([OME-820](/OME/issues/OME-820), amendment below). When unsure, the merge is perf-relevant.
   - **Render, room and UI code the perf specs measure:** `apps/web/src/**`, `apps/web/index.html`, `apps/web/room.html`, `apps/web/chat.html`, `apps/web/public/**`, and the shipped art under `assets/**` that the web build bundles.
   - **Room state, sync and relay on the server:** `apps/server/src/{ws,room,rooms,playback,queue,rate-limit,relay-latency,server}.ts`.
   - **Extension runtime and manifest:** `apps/extension/src/**` (popup → embeds listed, content scripts, background).
   - **The perf harness and the budgets:** `perf/**`, `e2e/support/**`, `playwright.config.*`, `docs/perf-budgets.md`.
   - **Build config and dependencies:** `apps/web/vite.config.ts`, `apps/extension/wxt.config.ts`, `tsconfig*.json`, `package.json` / `bun.lock`, `packages/shared/**`.

   Not perf-relevant, so no per-merge perf: docs (other than the budgets), e2e specs (`e2e/*.e2e.ts`), unit tests (`**/test/**`, `*.test.ts`), store listings and release tooling (`apps/extension/store/**`, `scripts/**`), the server's admin, CLI, reports, secrets, legal and site-meta code, agent config (`.claude/**`) and deploy files.
2. **One measured pass, not ×3.** A single flocked pass of the specs is the verdict. A failing row gets one confirm rerun of **its spec only**, never the whole set. The confirm decides: pass means the first result was noise, and the report shows both numbers; fail means red, and it is filed as before. The sampling rule is in `docs/perf-budgets.md` ("Sampling and verdicts"). Where a spec's single pass is not stable enough, the spec takes more samples per run: more windows or rounds, with a median or p95 over them. More whole-suite reruns are not the fix.
3. **Build once per sha.** `bun run perf` writes a stamp into each build output dir: HEAD's sha, plus the server URL for the web build. A run rebuilds only when a stamp is missing or names something else. Uncommitted changes under the build inputs (`apps/`, `packages/`, `assets/`, the root package files) always rebuild. `--rebuild` forces a build and `--no-build` skips it (`perf/build-stamp.ts`). A confirm rerun therefore reuses the build.

**Consequences.** A perf regression from a merge outside the list can sit on `main` for up to a day before the daily full run catches it, and the daily run bisects it as in decision 4. The list errs towards perf-relevant: all of `apps/web/src/**` is on it, because nearly all of it runs in a measured room.

## Amendment 2026-10-10: deterministic e2e runs in CI before the merge ([OME-822](/OME/issues/OME-822))

Board decision on [OME-822](/OME/issues/OME-822). The Lead spent about 10 h in 10 days running e2e and perf locally before merging, and QA re-ran much of it after. GitHub Actions now runs the deterministic lanes (`e2e`, `e2e-sync`, `e2e-tunnel`) on every PR, sharded 4 ways (`.github/workflows/e2e.yml`); its merged `e2e` check is required on `main` (ADR 0039 §7).

1. **A PR merges only with green CI e2e.** This takes effect when the `e2e` check becomes required on `main` protection, after its first green run on `main`; until then the previous flow applies. The Lead no longer runs e2e or perf locally before merging. The review covers design, safety, the contract and perf risk; CI covers the deterministic e2e.
2. **QA's per-merge check covers only what CI doesn't:** perf (decision 1 of the OME-818 amendment still picks when), the real-provider lane (`e2e-real`) when the merge touches a provider or embed path, and acceptance checks. The diff→spec script ([OME-820](/OME/issues/OME-820)) chooses them. QA does not re-run the deterministic e2e lanes per merge, including for wide-blast-radius merges (decision 2); for those it runs the full perf suite.
3. **The daily and sign-off full suite stays** (decision 3), including all e2e lanes locally, so a local-only difference between the runner and the operator machine still surfaces within a day.
4. **Flakes on the runner are filed, not retried away.** CI keeps the config's one retry (`retries: 1` under `CI`); a spec Playwright reports as flaky on the 4-vCPU runners gets an issue for its owner. Global retries are not raised.

## Amendment 2026-10-10: `bun run affected` picks the specs ([OME-820](/OME/issues/OME-820))

Board decision on [OME-820](/OME/issues/OME-820). Mapping a diff to specs was manual work at the start of every check. It is now a command, used at review time (ADR 0041 §1–2), not after the merge:

1. **`bun run affected <base> [head]`** prints the e2e specs, perf specs and `e2e-real` specs that `git diff base...head` needs, from the manifest `e2e/affected.json`. For a PR that's `bun run affected origin/main`. `--run` runs the perf (flocked), `e2e-real` and Firefox-lane specs it picked; `--run --e2e` also runs the e2e specs, which CI already runs on the PR.
2. **Who runs it.** The engineer runs it before requesting review and pastes its last lines (`selection:` onward) into the hand-off. QA's PR review runs the perf and `e2e-real` it names, next to acceptance.
3. **The full suite when unsure.** A changed path that no rule maps selects the full suite, and so does every path of decision 2 (`full` rules). The script prints which path made it choose the full suite, and why.
4. **The manifest can't go stale silently.** `scripts/affected.test.ts` (in `bun run check`) fails when a spec isn't listed by a source rule, a listed spec doesn't exist, a tracked file isn't mapped, or a glob no longer matches anything. A new directory or spec therefore lands with its mapping.
