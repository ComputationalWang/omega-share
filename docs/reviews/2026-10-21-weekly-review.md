# Weekly review — 2026-10-14 to 2026-10-21

Company Optimizer, OME-1568. Verdict: **one workflow change, no prompt edits, no hires and no fires.** The review started on Wednesday after five `WAITING` rounds (see "Check next week" 1).

Sources: Paperclip issues (1,000 most recent, back to 2026-09-29, so the whole week is covered), heartbeat runs (1,000 most recent, from 10-14 04:00, so the whole week is covered), `Cause:` lines in issue descriptions, `git log --first-parent origin/main`, `git worktree list`. All runs are on subscription, so cost is $0.

## Per agent

| Agent | Issues done | Median cycle | Runs ok / failed / cancelled | Verdict |
|---|---|---|---|---|
| CEO | 97 (73 triage sweeps, 12 judge, 7 daily suite) | 0.0 h | 135 / 0 / 6 | keep |
| Lead Engineer | 118 | 1.6 h | 282 / 114 / 9 | keep |
| QA Engineer | 101 | 0.8 h | 163 / 51 / 7 | keep |
| QA Engineer 2 | 30 | 1.1 h | 42 / 23 / 2 | keep |
| Creative Designer | 16 | 0.9 h | 60 / 5 / 3 | keep |
| Extension Engineer | 4 | 1.1 h | 16 / 4 / 0 | keep, watch |
| Server Engineer | 4 | 1.2 h | 4 / 0 / 1 | keep, watch |

- **Throughput is up:** 192 merges into `main` (first-parent), 409 issues created and 394 of them already done. Lead and both QAs carry the load.
- **Failed runs: 197 of 939 (21%).** 196 are the same failure: exit 143, "unmanaged background task stopped; no durable live path". In 68 of the 71 longer ones the agent opened a PR or started CI/e2e/perf and ended the run with "a background watcher will notify me". The runtime kills that job and marks the run failed. The automatic retry then dies within a minute with no output: 117 of the 196 are such empty retries. By agent: Lead 107, QA 50, QA2 23, Designer 4, Extension 4. Failures per day went from 8 (10-14) to 45 (10-17) and have stayed at 26–43 since. The paperclip skill already says that watchers don't outlive a run. `github-flow`, where agents wait for CI, didn't say it.
- **QA rejections with a cause:** 20 `bug`, 5 `flake` (OME-1269, 1368, 1373, 1472, 1473), 1 `perf` (OME-1451), 0 `environment`. Flakes went from 1 last week to 5.
- **Server and Extension Engineers closed 4 issues each** (Server: 34 last week). Server contract work now lands with the Lead (contract + Rust mirror in one issue, as CLAUDE.md asks). Both did useful work, so the two-week idle rule doesn't apply.
- **No bottleneck to hire for:** the Lead's open queue is 2 backlog + 3 blocked, and isn't growing.

## Changes made

1. `company/skills/github-flow/SKILL.md` §3: one paragraph. While waiting for CI or a long gate, stay in the run until it finishes, or end the run with a scheduled issue monitor. Never end a run with a background job still going. Evidence: the 196 failed runs above. Revert: drop that paragraph. Since it's a skill change, no agent's prompt changed, so nobody needs a sub-issue.

## Proposals for the board (not applied)

- **My wake rule never finds the company idle.** This review waited five rounds (10-20 18:00 → 10-21 10:45). Each time an issue closed, another one started (OME-1563/1564/1567 → 1566 → 1345 → 1599/1606 → 1593). The review only reads and blocks nobody, so I propose this for `company/tasks/optimizer-weekly/TASK.md` and my AGENTS.md: "on the last retry day (Wed), run even if agents are busy; never edit the prompt of an agent that has a run going". This is my own prompt, so the board decides.

## Check next week

1. **Background-task failures:** `adapter_failed` runs should fall from about 30/day to near 0. If they don't, add the rule to the Lead and QA prompts directly.
2. **Flakes:** 5 this week. If it's still ≥ 3 next week, give the QA Engineer a flake-quarantine step.
3. **Worktree cleanup (github-flow §5) is still skipped:** 78 worktrees, up from 39. 35 of the 40 branch worktrees are already merged into `main`, spread over every agent. If it grows again, add the cleanup to each owner's hand-off step (last week's item 3, deferred to keep one change at a time).
4. **Server and Extension Engineer load:** two quiet weeks in a row would make "merge into Lead" a candidate.
