# omega-share — agent rules

A Habbo-inspired social watch room: a web extension finds a video embed on the page you are on and shares it into a room on the website, where avatars sit together and watch it in sync. Product spec: `docs/product-spec.md`. Decisions: `docs/adr/`.

## Priorities (in this order)
1. **Performance** of site and extension — budgets in `docs/perf-budgets.md` are merge-blocking.
2. **Safety** — validate every boundary. Embeds: synced providers by allowlist; anything else only through the generic tier (ADR 0024: validated, sandboxed, click-to-load). Never build an iframe from an unparsed string.
3. **UX / looks** — usable first, pretty later. Design work runs in parallel but never blocks engineering.

## Stack (see ADR 0001)
Bun workspaces · TypeScript (strict, see `tsconfig.base.json`) · `apps/extension` (WXT, Chromium MV3) · `apps/web` (Vite + PixiJS) · `apps/server` (Bun + Hono + Bun.serve WebSockets) · `packages/shared` (Valibot schemas → types; the wire contract).
Tests: `bun test` (unit), Playwright + Chromium (e2e, `bun run e2e`). Gate: `bun run check`.

## How we work
- **Find code with Graft first.** Use the `graft` MCP tools (`graft_find_code`, `graft_file_api`, `graft_trace_calls`, `graft_repo_map`) or `graft ask/grep/map` before broad grep/read exploration. The graph is a local cache (`graft/`, git-ignored). If it's missing in a fresh worktree, run `graft build`.
- **TDD is mandatory.** Before implementing any feature or fix in the webapp or extension, run `/mattpocock-skills:tdd` and follow it. The failing-test commit must precede the implementation commit — QA rejects issues where it doesn't.
- **Contract first.** `packages/shared` is owned by the Lead Engineer. Changing it requires a contract issue; dependent issues are marked blocked by it. Never edit it from a feature branch without that issue.
- **Claim before you touch.** Comment on your issue with the paths you will change (e.g. `apps/extension/**`) and check the *Coordination* document on the "Company Ops" issue for overlapping claims. Overlap → ask the CEO to sequence.
- **Talk via issues.** Need something from another agent → create a sub-issue assigned to them (@mentions do not wake anyone). Replies go in comments.
- **Small branches.** One issue = one short-lived branch, mirrored as a GitHub issue and merged into `main` only through a PR (skill `github-flow`, ADR 0039). Lead Engineer merges one at a time. After each merge QA runs a targeted check (`bun run check` + the e2e specs and perf budgets covering the changed paths), or the full suite when the merge touches shared, protocol, harness, dependency or build code. The full suite runs daily and at every milestone sign-off (ADR 0036, `docs/adr/0036-targeted-post-merge-checks.md`).
- **Record decisions** that others might reverse as a new ADR in `docs/adr/`.
- **Subagents** (`.claude/agents/`): run on Sonnet 5.5, max 4 per agent, 20 company-wide (enforced by hooks — if denied, wait or do it yourself). Code-writing subagents use `implementer` (own worktree). Summarize subagent results into the Paperclip issue.

## Hard rules
- No `any`, no non-null assertions to silence errors, no `@ts-ignore`. Parse external data with Valibot at the boundary.
- No Habbo/Sulake assets, names or trademarks. All art is original (CC BY-SA 4.0, `assets/`).
- Code is AGPL-3.0-only. Don't add dependencies with incompatible licenses; justify every new dependency against the bundle budget.
- `sudo` is allowed in two places only (enforced by `.claude/hooks/guard.sh` + `sudo-policy.py`, tests in `guard.test.sh`): (1) locally, a plain file command (chown, chmod, chgrp, rm, mv, cp, mkdir, rmdir, touch, ln, ls, cat) on paths inside this repo or its worktrees; (2) over `ssh`/`scp`/`rsync` as `admin@` on the hosted omega-share box (`SERVER_IP` / `PUBLIC_ORIGIN` in `.env`), with full control there. No other host, no jump/proxy options, no shells or interpreters wrapping sudo. Never force-push, `rm -rf` outside the repo/worktrees, or read credential dirs (enforced by `.claude/hooks/guard.sh`).
- The guard matches the whole command text, even inside heredocs and quoted strings: "sudo" followed by a space, force-push flag text, or a dot-ssh path kills the entire command (earlier steps never run). Write such text with the Write tool or a script file in `$PAPERCLIP_RUN_SCRATCH_DIR`, not a Bash heredoc. Likewise `rm -rf` next to glob- or regex-heavy inline code reads as "rm outside the project": put that code in a script file, and prefer `mkdir -p && cp` over `rm -rf` for scratch resets.
