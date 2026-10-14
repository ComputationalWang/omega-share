# Weekly review — 2026-10-07 to 2026-10-14

Company Optimizer, OME-1047. First weekly review. Verdict: **no change.** No prompt edits, no workflow edits, no hires and no fires. The numbers show last week's changes (ADR 0041) are working, and the one open trial (QA2 on Sonnet) ends on 2026-10-17. Changing prompts now would muddy both.

Sources: Paperclip issues (1,000 most recent, from 2026-09-29), heartbeat runs (1,000 most recent, so per-agent run counts cover only 10-10 to 10-14), the dashboard's daily run activity, `Cause:` lines on QA issues, git log, and `costs/by-agent` (cumulative; all runs are on subscription, so cost is $0 and output tokens stand in for spend).

## Per agent

| Agent | Issues done | Median cycle (created → done) | Bounced | Runs 10-10..14 ok / failed / cancelled | Verdict |
|---|---|---|---|---|---|
| CEO | 214 (158 triage sweeps) | 0.0 h | — | 344 / 11 / 6 | keep |
| Lead Engineer | 204 | 0.7 h | 4 (OME-905, 906, 908, 909) | 210 / 29 / 15 | keep |
| Server Engineer | 34 | 1.1 h | 0 | 19 / 9 / 7 | keep |
| Extension Engineer | 23 | 2.6 h | 0 | 34 / 2 / 0 | keep |
| Creative Designer | 13 | 0.7 h | 0 | 23 / 8 / 5 | keep |
| QA Engineer | 125 | 0.5 h | — | 103 / 20 / 33 | keep (trial pending) |
| QA Engineer 2 | 82 | 0.6 h | — | 60 / 8 / 13 | keep (trial pending) |

- **QA rejections** with a cause this week: 13. 8 `bug` (OME-882, 939, 978, 1001, 1014, 1017, 1036, 1038), 4 `environment` (OME-733, 931, 952, 1068) and 1 `flake` (OME-949). 4 of the 5 non-bug rejections fall on 10-10/10-11, during the real-provider Twitch environment work. The CEO's QA2 trial review (ADR 0041 §6, 10-17) measures exactly this, so QA prompts stay as they are.
- **Triage routine** (every 2 h): 42 sweeps since 10-11, and 38 of them did something (re-queued orphaned runs, sequenced work, cleared stale blockers). It pays for itself. No proposal to change it.
- **Couriers** (status changes relayed through the CEO): 19 between 10-08 and 10-10, none since ADR 0041.
- **Per-merge post-checks**: 37 on 10-09/10-10, none since ADR 0041 removed them. New issues per day fell from 218 (10-09) to 19–79.
- **Failed runs** are mostly platform problems, not agent problems: 10-07 all 19 failed (`claude` not on PATH, fixed); 10-11 provider quota (13) plus `acpx_turn_failed` (10); 10-13 a server restart orphaned 10 runs, which the next triage re-queued.
- **Reassignment churn:** 77 runs were cancelled with `issue_reassigned`, 49 of them on 10-11. They clustered on the M10 phone issues (OME-905, 909), which went back and forth between Lead, QA and the board. QA lost about 4 h of run time to this. It fell to 10 on 10-12 and 6 on 10-13, so no change for now.
- **Nobody is idle enough to fire** (every agent closed issues this week). **No proven bottleneck to hire for:** the Lead queue the CEO flagged on 10-10 has since drained.

## Changes made

None. Nothing to revert.

## Check next week

1. **Ready queues are empty.** On 10-14 no engineer has a `todo` issue (ADR 0041 §4 asks for 2–3). The board's uncommitted CEO prompt edit, "Always plan the next step", targets this. Next week: idle time per engineer, and whether the queues are refilled.
2. **QA2 trial outcome (10-17)** and whether `environment`/`flake` rejections keep appearing after the Twitch work.
3. **Worktree cleanup (github-flow §5) is skipped.** 7 merged branches still have worktrees under `omega-share-worktrees/` (OME-734, 813, 837, 838, 882, 933, ome-356), and the repo has 39 worktrees overall. If they are still there next week, add the cleanup check to the hand-off step of the owners' prompts.
4. **`issue_reassigned` cancellations**: if they rise again, look at how reviews are rerouted between QA and QA2.
