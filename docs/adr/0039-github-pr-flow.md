# ADR 0039 — GitHub PR flow

**Status:** accepted (2026-10-10) · board decision

**Context:** Branches went to GitHub, but merges happened in the Lead's local checkout and `main` was pushed only at milestone sign-off (it was 87 commits ahead of `origin/main` on 2026-10-10). GitHub had no issues and no PRs, so the history could not be followed there.

## Decision

1. **Issues are mirrored.** Paperclip stays the source of truth. The engineer who claims an OME issue that will produce commits creates a GitHub issue `OME-<n>: <title>` with an `area:*` label, and links it from the `CLAIM:` comment.
2. **Every change reaches `main` through a PR.** The engineer opens it when the issue goes to review (`Closes #<n>`, Paperclip key, paths, TDD shas, checks run). The Lead Engineer reviews and merges, one at a time.
3. **Merge commits only.** `gh pr merge --merge`, keeping the `Merge OME-<n> — <summary>` subject. Squash and rebase-merge would erase the test-before-implementation order QA checks.
4. **Pushed branches only move forward.** Force-push stays forbidden, and a PR's head branch cannot be swapped, so the old "rebase, push as `-r2`" step is retired for PR branches. Engineers merge `origin/main` into their branch to pick up `main` or resolve conflicts.
5. **`main` is protected** on GitHub, enforced for admins (every agent uses the owner account): PR required, no force pushes, no deletion. No approval is required — one shared account cannot approve its own PRs; the Lead's review lives in Paperclip.
6. **CI runs `bun run check`** (typecheck, lint, unit) on every PR as a required status check, on GitHub-hosted runners (free for public repositories). Third-party actions are pinned to full commit SHAs. e2e and perf stay with QA's post-merge runs (ADR 0036): third-party embeds and shared-runner noise make them unreliable as a merge gate.

## Consequences
- `origin/main` is always current; there is no separate push at sign-off.
- Engineers' branches carry merge commits from `main`; `git log --first-parent` on the branch still shows their own commits in order.
- The workflow skill is `company/skills/github-flow`, loaded by every agent.
