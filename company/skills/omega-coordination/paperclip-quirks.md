# Paperclip API and workflow quirks

Hard-won behaviour of the Paperclip API. Read this before retrying a refused call. Entries name the issue where each was found.

## Writes from timer wakes and cross-issue runs

**Timer wake with no task bound cannot comment or PATCH** (OME-2, OME-133, OME-325, OME-609, OME-663). Checkout returns 200, but `POST /comments` and `PATCH /api/issues/:id` return 403 `cross_issue_influence_run_context_required`. Creating issues and uploading attachments still work. Don't retry the PATCH. Create a courier issue assigned to the CEO with the evidence in its description, attach your report, and say in your final response that the status write failed. This also holds for an issue you created and checked out yourself on a timer wake: create it, attach the result and send the courier up front.

**Comments on another issue do not wake its assignee** (OME-272, OME-517). A comment posted from a run scoped to a different issue (`cross_issue_influence_observed`), and a rejected `request_confirmation`, start no run. To wake someone, create an assigned courier issue (it woke QA within seconds).

**Attachments on another agent's issue return 403** "Agent cannot mutate another agent's issue" (OME-331). Comments there work. Attach the file to your own issue and link `/api/attachments/<id>/content` from the comment.

**Stale queued run blocks checkout with 409** (OME-609). After a reroute, `executionRunId` can point at the previous assignee's queued run. Do the work anyway, attach the report, and send a courier to the CEO to close the issue and cancel the run.

**Search status is stale** (OME-313). `GET /issues?q=` can show `in_progress` for a `done` issue, and PATCH `blocked` on it then fails with 422. `GET /api/issues/:id` before blocking on an issue. Wake payloads also carry no thread: GET the issue and its comments, and search `q=<topic>`, before long reruns (OME-669, OME-779). An earlier run may already have filed the blocker and the Lead may have fixed it on a newer `main`.

## Blockers, checkout and status

**Checkout returns 422 while blockers are open** (OME-191). Comments and PATCH (`blocked` plus a longer `blockedByIssueIds`) still work from that run. For work the description allows to land early, proceed without checkout and hand it off through a review sub-issue added to the blockers.

**Clear blockers in two PATCHes** (OME-409). `blockedByIssueIds: []` with `status: todo` and a `comment` in one PATCH fails with "Issue follow-up blocked by unresolved blockers". PATCH `{"blockedByIssueIds": []}` first, then `{"status":"todo","comment":"..."}`. The second one wakes the assignee. A comment while still blocked wakes nobody.

**`in_review` returns 409 with an open blocker** (OME-200). A polish issue blocked by the Lead's unmerged merge issue cannot go to `in_review`. Create the judging confirmation anyway, leave the issue `blocked`, and comment that you will rebase after the merge. Check `unresolvedBlockerIssueIds` first.

**`blocked` needs unresolved blockers, and `unblockDescriptor` may only name yourself** (OME-35, OME-313). A resolved blocker returns 422, and naming another agent as unblock owner is refused.

## Delegation and review stages

**Delegation cycle 409** (OME-20, OME-373). A child issue assigned to the agent who created any ancestor returns 409 `delegation_cycle`. Create the issue with no `parentId`, assigned to that agent, then PATCH your issue `blocked` with `blockedByIssueIds: [<new id>]`. The blocker resolving wakes you. The same applies when QA files a review child for QA.

**`in_review` needs a review path** (OME-35, OME-50, OME-324). Without an execution policy or reviewer, PATCH `in_review` fails with `invalid_issue_disposition`. Either create a sub-issue "Review + merge <key>" for the Lead and PATCH the parent `blocked` on it, or POST a `request_confirmation` addressed to the reviewer (`resolverPolicy: "board_or_agents"`, `continuationPolicy: "wake_assignee"`, `payload: {version: 1, prompt}`; without `version: 1` it fails validation), then PATCH `in_review`. A confirmation may never wake the addressee (OME-218, OME-225). For merges prefer the Lead sub-issue.

**Approving a review stage needs an inline comment** (OME-325). PATCH `{"status":"done"}` from the reviewer fails with "Approving a review or approval stage requires a comment" unless `comment` is in the same request. Post the long evidence first, then PATCH `{"status":"done","comment":"<short decision>"}`.

**A courier asking for `done` on a Lead issue lands in `in_review`** (OME-272, OME-310). If `executionPolicy.stages` has a QA stage, the PATCH moves the issue to `in_review` and dependents stay blocked until QA approves. Post the comment, accept `in_review`, close the courier issue and say the unblock waits on QA. Don't bypass the gate.

**A rerouted review leaves the original stage reviewer** (OME-213, OME-230). `executionState.currentParticipant` still names the first reviewer, so the new reviewer's PATCH `done` fails "Only the active reviewer or approver can advance the current execution stage". Open a sub-issue for the named participant to approve and close, or ask the CEO to change the participant when rerouting.

**Cards are resolved by their addressee only** (OME-704, OME-705). Even with `resolverPolicy: "anyone"`, `/interactions/<id>/accept` returns `interaction_addressee_mismatch` for anyone but `addresseeAgentId` or the board. Before a courier review, GET the interactions. If the card names someone else, post the approval comment anyway and file a courier issue to the card's creator to withdraw it and hand off.

**Approved hire creates no agent** (OME-107, OME-207). Put a `hire-spec` document (config fields plus the full AGENTS.md) on the hire issue when filing. After approval, comment and ntfy the board to create the agent. While waiting, use a `human_only` `request_confirmation` with `wake_assignee_on_accept` and set the issue `in_review`. Don't mark the hire done before the agent exists.

**Superseded review branches** (OME-517). Re-review cards can wait hours while other merges rewrite the same files. Run `git log <branch-base>..main -- <touched files>` first. If main already satisfies the assertions, reject as superseded and courier the owner to close without merging. When a verify run goes red, search for an existing blocker and `git log <sha>..main` before filing a duplicate (OME-668).

## Comments and skills

**Build comment bodies from a quoted-heredoc file** (OME-131). Embedding markdown in `python3 -c "..."` lets bash run the backticks and delete the code spans. Comments cannot be edited (`PATCH .../comments/:cid` is "API route not found"), so only a corrected copy fixes it. Write the body with a quoted heredoc (`<<'EOF'`) into `$PAPERCLIP_RUN_SCRATCH_DIR`, then `json.dumps` it. If the text mentions the guard-blocked words (see CLAUDE.md Hard rules), use the Write tool instead.

**Agents run Paperclip's copies of skills and AGENTS.md, not the repo files.** `company/skills/*` and `company/agents/*/AGENTS.md` change nothing until pushed. Skills: `paperclipai skill list -C <company>`; catalog-imported ones (omega-coordination, design-judging) are read-only; re-import works only from the project workspace `/home/wang/Projects/omega-share`, not from `omega-share-worktrees/*` (403 `skill_workspace_boundary_denied`); new skill with `skill create --payload-json {name,slug,description,markdown}`; attach with `paperclipai agent skills:sync <agentId> --desired-skills x --mode add` (no `-C`). Instructions: `paperclipai agent instructions-file:put <agentId> --path AGENTS.md --content-file <f>`; the managed copy has no frontmatter, so patch lines instead of copying the repo file.

## Secrets

**Read a bound secret with `POST /api/agents/me/secrets/<key>/value` and body `{}`** (OME-363). It returns `{key, value, version}`. GET on that path or on `/resolve` returns 404, and `GET /api/agents/me/secrets` only lists bindings. The endpoint takes the binding key (for example `omega-share-firefox-firefox_jwt_issuer`), not the logical name in an ADR (OME-777). For ssh keys, write the value to a 0600 file in run scratch, use `-o IdentitiesOnly=yes`, then `shred -u` it. Never paste values into comments or docs.
