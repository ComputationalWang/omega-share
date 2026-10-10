---
name: github-flow
description: How work reaches GitHub - mirrored GitHub issues, branch pushes, pull requests, merges into main and branch/worktree cleanup. Use when you claim an issue that will produce commits, push a branch, open or update a PR, (Lead) merge into main, or finish an issue.
---

# GitHub flow

Paperclip stays the source of truth. GitHub mirrors it so the history is traceable: every OME issue that produces commits has a GitHub issue, every change reaches `main` through a pull request, and the PR closes the issue. `main` is protected: a direct push to it is rejected, for every agent. Rationale: ADR 0039 (`docs/adr/0039-github-pr-flow.md`).

All agents share one GitHub account, so who did what is carried by the branch name, the OME key and the Paperclip thread.

## 1. Mirror the issue (at claim time)

When your claim will produce commits, create the GitHub issue together with your `CLAIM:` comment and put its URL in that comment. Issues with no commits (research, coordination, couriers) get no mirror.

```sh
gh issue create --title "OME-794: <OME issue title>" --label area:<area> \
  --body "Paperclip: OME-794 (/OME/issues/OME-794)
Paths: apps/extension/**"
```

Areas: `web`, `server`, `extension`, `shared`, `design`, `qa`, `docs`, `infra` (CI, hooks, build). Several labels are fine.

## 2. Branch and push

- Branch from a fresh `origin/main`: `git fetch origin && git switch -c <agent-slug>/OME-794-<short> origin/main`.
- Push with tracking: `git push -u origin <branch>`. After that, plain `git push`.
- **A pushed branch only moves forward.** Add commits; to pick up `main` or resolve a conflict, `git merge origin/main` into your branch and push. Rebase only before the first push.
- TDD order stays visible on the branch: the failing-test commit precedes the implementation commit.

## 3. Open the PR (when the issue goes to review)

Write the body to a file with a quoted heredoc (backticks survive), then:

```sh
gh pr create --base main --head <branch> --title "OME-794: <short summary>" --body-file <file>
```

Body:

```
Closes #<github issue number>
Paperclip: OME-794 (/OME/issues/OME-794)

Paths: apps/extension/**
TDD: test <sha> → implementation <sha>
Checks: bun run check ✓, e2e/<spec> ✓, perf/<budget> ✓
```

Put the PR URL in your Paperclip review comment. Review feedback is answered with new commits on the same branch; the PR updates itself.

## 4. Merge (Lead Engineer only)

- Merge one PR at a time, with a merge commit (squash and rebase-merge erase the TDD order QA checks):

  ```sh
  gh pr merge <n> --merge --subject "Merge OME-794 — <summary> (Lead review OME-795)"
  ```

- GitHub reports the PR not mergeable → send it back to the author to merge `origin/main` into the branch.
- Then sync the local checkout: `git fetch origin && git merge --ff-only origin/main`. Hand off to QA as before (ADR 0036), naming the touched paths and the PR.
- The `Closes #n` line closes the GitHub issue on merge. Paperclip status follows the existing review/QA flow; GitHub closing it does not mark the OME issue done.

## 5. Clean up (author, once the PR is merged or abandoned)

Leave nothing behind: a merged or abandoned issue has no worktree, no local branch and no remote branch.

- Merged: GitHub deletes the remote branch on merge. Locally: `git fetch --prune origin`, `git worktree remove <path>`, `git branch -d <branch>`. `-d` refuses an unmerged branch, which is the safety check: stop and look before reaching for `-D`.
- Abandoned or superseded: close the PR with a one-line reason, then `git push origin --delete <branch>` and the same local steps.
- `git worktree remove` refuses a worktree with changes. Commit what belongs on the branch, delete your own scratch files, then remove it.
- Your own work only: branches with your agent-slug prefix and the worktrees that have them checked out. One long-lived scratch worktree per agent is fine; per-issue worktrees go.
