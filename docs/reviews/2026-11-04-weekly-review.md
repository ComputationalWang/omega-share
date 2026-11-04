# Weekly review — 2026-10-28 to 2026-11-04

Company Optimizer, OME-2207 (Wednesday, the last retry; OME-2202 waited on Tuesday). Verdict: **one workflow edit in two skills, no prompt edits, no hires and no fires.** The Lead, QA Engineer, QA Engineer 2 and the CEO were running, so none of their prompts were touched.

Sources: Paperclip issues (1,000 most recent, back to 10-22), heartbeat runs (1,000 most recent, back to 10-23), run `livenessReason` and `resultJson`, `git log --first-parent origin/main`, `git worktree list`, `gh run list` (CI durations). Runs are on subscription; the list-price equivalent was $567 ($654 last week).

## Per agent

| Agent | Issues done (routine) | Runs ok / failed / cancelled | Equiv. $ | Verdict |
|---|---|---|---|---|
| CEO | 17 (68) | 113 / 1 / 16 | 67 | keep |
| Lead Engineer | 75 | 192 / 78 / 9 | 281 | keep; fix the CI wait (skill) |
| QA Engineer | 35 | 111 / 29 / 11 | 146 | keep; same |
| QA Engineer 2 | 20 | 30 / 10 / 1 | 17 | keep; prompt tune still owed |
| Creative Designer | 4 | 19 / 0 / 16 | 25 | keep |
| Extension Engineer | 3 (2 releases) | 12 / 0 / 1 | 13 | keep, watch |
| Server Engineer | 2 | 7 / 0 / 0 | 13 | keep, watch |

- **Throughput is back:** 97 merges into `main` (91 last week): 19, 19, 17, 23, 12 a day from 10-29 to 11-02, then 1 on 11-03. The 11-03 dip lines up with 10 `claude_auth_required` failures (Lead, QA2), which the CEO's sweep cleared.
- **Background-job failures went up, 66 → 105** (Lead 71, QA 27, QA2 6), all `unmanaged background task stopped`, plus 77 retries (39 of them failed again). That's $81 of the $567. Last week's rule was loaded (the runtime reads the skills from the primary checkout, which has it) but wasn't followed. The run summaries say why: "I'll pick up again when the background watch reports back." CI takes about 11 min (`check`) and 16 min (`e2e`), which is longer than one foreground Bash call can wait (10 min). So agents fall back on Claude Code's background promise, which a Paperclip run doesn't keep. The rule said what not to do but gave no way to wait 16 min.
- **Worktrees:** 134 → 138, but merged-branch worktrees fell 66 → 45. The Lead's post-merge cleanup is partly happening; the backlog isn't cleared.
- **Server and Extension** each shipped real work (two ADR 0057 slices; releases 0.1.3 and 0.1.4), so the idle rule doesn't apply. Folding Server into the Lead would add load to the busiest agent, so it is not proposed.

## Change made (revertible)

1. **`omega-coordination` §9 and `github-flow` §3, long-job wait:** name the 10-min foreground cap and the background promise that doesn't hold, and give two working ways to wait: `timeout 540 gh pr checks <n> --watch` repeated in the foreground (124 means still running), or a scheduled issue monitor confirmed by `monitorNextCheckAt`. Revert: restore the previous §9 "Long jobs" paragraph and §3 line.

## Proposals for the board (not applied)

- **Still open from last week:** the CEO keeps 1–2 ready `todo` issues for Server, Extension and the Designer. Together they shipped 9 issues against the Lead's 75.
- **A mechanical stop** for the 10-min-cap problem: a `PreToolUse` hook that denies `run_in_background` for `gh pr checks`/`gh run watch`, with a pointer to §9. Guard hooks are the board's, so this goes to them if the text change doesn't work.

## Check next week

1. Background-task failures should drop from 105 to under 20. If the Lead's still don't, ask for the hook above.
2. QA2's prompt: delete the stale "until 2026-10-22" line. Owed for two weeks; skipped again because QA2 was running.
3. Merged-branch worktrees: 45 should keep falling.
4. Server/Extension load, if the ready-queue proposal is approved.
