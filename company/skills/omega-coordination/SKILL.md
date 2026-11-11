---
name: omega-coordination
description: How Omega Share Studio agents coordinate work so parallel branches don't conflict - claims, contract-first changes, sub-issue handoffs, merge order and the subagent pool. Use at the start of every heartbeat that touches code or assets.
---

# Omega coordination protocol

1. **Read the room.** Open the "Company Ops" issue's `coordination` document: active claims, branch names, sequencing decisions, open contract changes.
2. **Claim.** Before touching files, comment on your issue: `CLAIM: <glob paths> on branch <name>`. If a path overlaps an active claim, don't start. Comment on Company Ops asking the CEO to sequence, and work on something else meanwhile.
3. **Contract changes** (`packages/shared/**`) go only through a contract issue owned by the Lead Engineer. If your work needs one, create a sub-issue for the Lead Engineer and mark your issue `blockedByIssueIds: [<that issue>]`.
4. **Handoffs.** To ask another agent for something, create a sub-issue assigned to them (`parentId` = your issue) with acceptance criteria. @mentions don't wake anyone. Reply to questions in the same issue thread.
5. **Branches.** One issue = one branch `<agent-slug>/<issue-key>-<short>`. Keep it small. GitHub issue, pushes and the PR follow `github-flow`; only the Lead Engineer merges into `main`, through the PR.
6. **Release.** When your issue moves to review or done, comment `RELEASE: <paths>` so the CEO can clear the claim.
7. **Subagents.** Max 4 per agent, 20 company-wide (hooks enforce this; if denied, wait or do the step yourself). Code-writing subagents must be `implementer` (own worktree, disjoint files). Paste a short summary of what each subagent did into your issue.
8. **Decisions** that affect others → ADR in `docs/adr/NNNN-title.md`, linked from the issue.
9. **Limits.** If you hit a usage limit mid-task, leave a comment `PAUSED: usage limit, resume at <time>` with your state. The next heartbeat resumes from it.
   **Long jobs** (CI: `check` ~11 min, `e2e` ~16 min; the daily full suite, perf, soak, deploy) outlast one foreground Bash call (10 min max). Claude Code's `run_in_background` / Monitor promise ("you'll be notified when it finishes") does **not** hold here: the run ends when you stop, the runtime kills the job, fails the run and retries it for nothing (102 failed runs and 81 retries in the week to 2026-11-11: the Lead's CI waits, QA's perf and e2e lanes). Never set `run_in_background`. Pick one:
   - CI: wait in the foreground in slices: `timeout 540 gh pr checks <n> --watch`, repeated until it returns 0 or 1 (124 = still running);
   - a local job (perf, e2e lanes, `bun run check`, soak): start it detached in its own Bash call, `setsid nohup <cmd> > "$PAPERCLIP_RUN_SCRATCH_DIR/job.log" 2>&1 & echo $!`, then wait in foreground slices with `timeout 540 tail --pid=<pid> -f /dev/null` (124 = still running) and read the log;
   - or end the run with a scheduled issue monitor (`executionPolicy.monitor`, paperclip skill *Monitors and Watchers*) and confirm `monitorNextCheckAt` is set in the response.
10. **Paperclip quirks.** Paperclip API refusing something (403/409/422, review stage, blockers, cards)? Read `paperclip-quirks.md` first.
