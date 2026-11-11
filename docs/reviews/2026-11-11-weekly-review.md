# Weekly review — 2026-11-04 to 2026-11-11

Company Optimizer, OME-2574 (Wednesday, the last retry). Verdict: **two skill edits, no prompt edits, no hires and no fires.** Only the CEO was running. I still couldn't edit any prompt: reading or writing a managed AGENTS.md returns 403 `agents:suggest-changes`, so the prompt edits I owe go to the board below.

Sources: Paperclip issues (1,000 most recent), heartbeat runs (1,000 most recent, back to 11-01; complete for the week), run `livenessReason` and `resultJson`, `git log --first-parent origin/main`, `git worktree list`. Runs are on subscription; the list-price equivalent was $836 ($567 last week).

## Per agent

| Agent | Issues done (routine) | Runs ok / failed / cancelled | Background-job deaths | Equiv. $ | Verdict |
|---|---|---|---|---|---|
| CEO | 105 (91) | 150 / 0 / 10 | 0 | 97 | keep |
| Lead Engineer | 81 | 271 / 57 / 14 | 51 | 399 | keep; hook (board) |
| QA Engineer | 76 | 152 / 46 / 11 | 43 | 229 | keep; local-job recipe (skill) |
| QA Engineer 2 | 28 (8) | 39 / 4 / 4 | 2 | 28 | keep; prompt tune still owed (board) |
| Creative Designer | 6 | 22 / 4 / 10 | 4 | 40 | keep |
| Extension Engineer | 2 (release 0.1.5) | 10 / 0 / 0 | 0 | 12 | keep, watch |
| Server Engineer | 1 (Bar preset) | 17 / 2 / 8 | 2 | 24 | keep, watch |

- **Throughput is up:** 119 merges into `main` (97 last week), 11–26 a day. QA closed 76 issues (35).
- **Background-job deaths didn't move: 105 → 102**, plus 81 retries. That's $96 + $44 of the $836, and most of the CEO's triage notes this week are repairs of the stalls they leave behind (OME-2530, 2538, 2562). This is the third week the skill text failed (196 → 105 → 102). The Lead's run summaries still say "a background watch is running, I'll be woken". QA's deaths are a second cause that §9 never covered: local perf and e2e lanes, with no recipe to wait on them.
- **Worktrees: 138 → 220**, 77 of them on merged branches (70 clean). 82 sit *inside* the main checkout (`omega-share/omega-share-worktrees/`), because QA2's and the Server Engineer's prompts and the QA habit use a relative path. Nested worktrees are what break the root gate (`docs/qa/harness-gotchas.md`, OME-581).
- **Server and Extension:** 3 issues between them (9 last week). Both shipped real work, so the idle rule doesn't apply. The ready-queue proposal is still pending with the board.

## Changes made (each revertible on its own)

1. **`omega-coordination` §9:** "Never set `run_in_background`", plus a recipe for local long jobs: `setsid nohup … & echo $!`, then `timeout 540 tail --pid=<pid> -f /dev/null` in foreground slices. Evidence: QA's 43 deaths on perf/e2e lanes. Revert: restore the 11-04 §9 paragraph.
2. **`github-flow` §2:** branch in your own worktree at an absolute path under `/home/wang/Projects/omega-share-worktrees/`. This replaces `git switch -c`, which would switch the shared checkout. Evidence: the 82 nested worktrees. Revert: restore the old one-line bullet.

## Board approval requested (not applied)

1. **A `PreToolUse` hook** (`.claude/hooks/`, Bash matcher) that denies `run_in_background: true` when `PAPERCLIP_RUN_ID` is set, with a message pointing to omega-coordination §9. Interactive sessions are not affected. I promised this last week if the text fix failed, and it failed. Hooks are the board's to approve.
2. **Grant the Company Optimizer `agents:suggest-changes`** (or say who pushes prompt edits). Without it, step 3 of my role can't run.
3. **Prompt edits owed** (apply them, or let me once item 2 is granted):
   - QA2: delete the stale "Until 2026-10-22 (the rollback window) …" sentence (owed 3 weeks);
   - QA2 and Server Engineer: worktree paths `omega-share-worktrees/qa2` and `omega-share-worktrees/server` become absolute `/home/wang/Projects/omega-share-worktrees/…`.
4. **Still open:** the CEO keeps 1–2 ready `todo` issues for Server, Extension and the Designer.

## Check next week

1. Background-job deaths: under 20 if the hook lands. If it doesn't land, expect about 100 again.
2. Worktrees nested in the main checkout: 82 should stop growing. Merged-branch worktrees: 77 should fall.
3. Server Engineer: a third low week (1–2 issues) with an empty ready queue makes merging the role worth proposing.
