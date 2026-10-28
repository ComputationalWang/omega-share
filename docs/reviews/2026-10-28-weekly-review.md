# Weekly review — 2026-10-21 to 2026-10-28

Company Optimizer, OME-1912. Verdict: **two workflow edits in skills, no prompt edits, no hires and no fires.** The review ran on Wednesday, the last retry day, with QA Engineer, QA Engineer 2 and the CEO mid-run. So none of their prompts were touched.

Sources: Paperclip issues (1,000 most recent, back to 09-29), heartbeat runs (1,000 most recent, back to 10-19, so the week is covered), `Cause:` lines, run logs of the failed runs, `git log --first-parent origin/main`, `git worktree list`. Runs are on subscription (`subscription_included`), so nothing was billed. The list-price equivalent was $654.

## Per agent

| Agent | Issues done (non-routine) | Median cycle | Runs ok / failed / cancelled | Equiv. $ | Verdict |
|---|---|---|---|---|---|
| CEO | 73 (12) | 0.6 h | 92 / 94 / 5 | 56 | keep |
| Lead Engineer | 69 | 5.1 h | 157 / 31 / 13 | 244 | keep |
| QA Engineer | 57 | 2.1 h | 137 / 44 / 5 | 169 | keep |
| QA Engineer 2 | 27 | 0.1 h | 40 / 14 / 2 | 14 | keep; tune next week |
| Creative Designer | 9 | 2.5 h | 41 / 3 / 7 | 76 | keep |
| Extension Engineer | 8 | 5.1 h | 19 / 1 / 1 | 66 | keep |
| Server Engineer | 3 | 0.4 h | 7 / 0 / 5 | 18 | keep, watch |

- **The week stopped on Monday.** 91 merges into `main`: 16, 30, 19, 20 and 5 a day from 10-21 to 10-25, 1 on 10-26, then none. From 10-26 07:00 to 10-28 17:00, every CEO, QA and Optimizer run failed with `acpx_turn_failed`: the Codex adapter's model `gpt-6.1-sol` isn't supported on a ChatGPT account. That was 115 failed runs and 21 CEO routine issues left stranded in `blocked`. The board moved every agent to `claude_local` at 17:00 today. This is an adapter fault, not a prompt fault. The CEO's sweep (OME-1924) is now clearing the strandings.
- **Not much work was queued even before that.** The only open product work is the serial responsive pass (OME-1796 → QA round 3, OME-1890). Server has had no run since 10-23, Extension and Designer since 10-24, the Lead since 10-26. They were idle for lack of issues, not by choice, so the two-week idle rule doesn't apply.
- **Background-job failures: 196 → 66** (−66%) after last week's github-flow rule. First-run rate since 10-23: Lead 5/84, QA 4/53, **QA Engineer 2 7/34**. QA2's are almost all the daily full suite (OME-1766, 1861 ×3, 1884). The daily suite never goes through github-flow §3, which only covered PR CI.
- **Rework is low:** 6 rejections with a cause (3 `bug`, 2 `environment`, 1 `e2e`), and **0 flakes** (5 last week).
- **Worktrees: 78 → 134 (13 GB).** 66 of them hold branches already merged, spread over every agent and the unnamed implementer worktrees. The author-side cleanup in github-flow §5 isn't happening.

## Changes made (each revertible on its own)

1. **`omega-coordination` §9:** the long-job rule moved here from github-flow §3 and now covers every long job (CI, e2e, daily suite, perf, soak, deploy). Every agent reads this skill every heartbeat. github-flow §3 keeps a one-line pointer. Evidence: QA2's daily-suite failures above. Revert: drop the §9 paragraph and restore the old §3 paragraph.
2. **`github-flow` §4/§5:** right after a merge, the Lead removes the merged branch's worktree and local branch. `git worktree remove` refuses a dirty one, which stays with its author (§5). §4 also lost the stale "hand off to QA after merge (ADR 0036)" line, which ADR 0041 §1 replaced. Evidence: the worktree count. Revert: restore the old §4 bullet and the §5 title. A one-time sub-issue asks the Lead to sweep the 66 merged worktrees that already exist.

## Proposals for the board (not applied)

- **The CEO keeps a small ready queue per role** (about 1–2 `todo` issues each for Server, Extension and Designer) whenever the current milestone is serial. This week four agents sat idle for 2–5 days behind one QA audit. This edits the CEO's prompt, so the board decides.
- **Adapter health:** a model or adapter error that fails every run of an agent could page the board on the first hour, not after 2.5 days. Today the stranding only surfaced as `blocked` routine issues.

## Check next week

1. Background-job failures (`adapter_failed`, exit 143) should be near 0, QA2's daily suite included. If QA2 still fails, edit QA2's prompt (its daily-suite section). It wasn't edited this week because QA2 was running.
2. QA2's prompt has a stale line ("until 2026-10-22 … also runs `bun run check` and the 30-minute soak"). Delete it in the same edit as item 1.
3. The worktree count should go down after the Lead's sweep, and stay down.
4. Server Engineer: 3 issues this week, 4 last week, and the Lead now owns the contract and Rust-mirror work. If the queue is still empty for Server next week, merging the role into the Lead becomes the proposal.
