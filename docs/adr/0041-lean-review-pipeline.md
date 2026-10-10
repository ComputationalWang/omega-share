# ADR 0041 — Lean review pipeline

**Status:** accepted (2026-10-10) · board decision · point 1 takes effect when OME-822 (CI e2e as a required check) is done

**Context:** A run-log analysis (30 Sep–10 Oct) found:
- QA and QA2 used 57% of all agent run time, mostly on perf and on waiting for perf (OME-818/819 address that).
- Every issue got QA twice: a pre-merge review stage (35 reviews, about 18 h) and a per-merge targeted check (46 checks, about 28 h).
- Several issues needed 2–4 review rounds.
- Per issue, most cycle time was the wait before an engineer picked the work up, not QA.
- All seven agents woke every 30 minutes, which produced about 143 runs that did next to nothing.

## Decision

1. **QA reviews each issue once, before the merge.** Once CI runs e2e on every PR as a required check (OME-822), QA's review on the PR covers what CI can't:
   - the acceptance criteria end to end
   - perf budgets when the diff touches perf-relevant paths (OME-818)
   - real-provider specs when providers change
   
   The per-merge post-check from ADR 0036 §1–2 goes away. The daily full suite and the milestone full suite stay (ADR 0036 §3–4).
2. **Ready for review means green.** An engineer requests review only when CI is green on the PR and `bun run affected` (OME-820) passes locally for the diff. A rejection names its cause (bug, missing test, flake, environment) so bounce rates can be measured.
3. **The Lead reviews design, not checks.** The Lead's review covers architecture, safety, the contract and perf risk. It doesn't re-run what CI ran. A PR that changes only docs (`docs/**`, ADRs, QA reports) with green CI may be merged by its author, with a merge commit, following `github-flow`.
4. **A ready queue per engineer.** The CEO keeps 2–3 `todo` issues per engineer with acceptance criteria written and claims checked, and tops the queues up on each triage run. An engineer who finishes an issue picks the next one in the same run instead of waiting for a wake.
5. **Wake on events.** Agents wake on assignment and comments. The timer fallback is 4 h and the CEO triage routine runs every 2 h (configured 2026-10-10).
6. **Model trial.** QA Engineer 2 runs on Sonnet 5.5 from 2026-10-10 to 2026-10-17. The CEO compares QA2's reviews against QA's: reopened issues, regressions that slipped past, and rejections caused by environment noise. Keep Sonnet or revert based on that comparison.

## Consequences
- A regression that CI's e2e lanes and the QA review both miss is found by the daily full run, at most a day later. This is the same trade ADR 0036 accepted for untouched areas.
- QA's per-issue time roughly halves on top of the perf work in OME-818–821.
- The Lead's queue holds only code PRs.
