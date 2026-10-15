# Draft (c): board checklist to resume the company

Do this only after the production switch succeeded (`docs/ops/switch-to-rust.md` § 3 green) and the PR carrying this file has merged.

Pause snapshots: `/tmp/claude-1000/-home-wang-Projects-omega-share/cb2ee54c-4e75-4b63-b637-fa877b3247c3/scratchpad/{agents-before.json,routines-before.json}`. Before the pause every agent had heartbeats enabled and `status: idle`, except QA Engineer 2 (`status: error`, look at its last run before resuming it). Each agent was paused with `pauseReason: manual`.

- [x] Fill `<date>` and `<date+7>` in `docs/adr/0050-rust-server.md` (a docs-only PR or direct board edit) and in the drafts below.
- [ ] Sync the instruction bundles: each agent reads its managed `instructions/AGENTS.md` under `~/.paperclip/instances/default/companies/3cbbb61c-a24b-4200-aaa0-00a320534649/agents/<id>/instructions/`, not the repo copy. Copy the merged `company/agents/<slug>/AGENTS.md` into it for server-engineer, lead-engineer, qa-engineer and qa-engineer-2, or the agents will not see the Rust rules. `CLAUDE.md` is read from the repo checkout (make sure each worktree has `main` merged in).
- [ ] Post draft (a), `coordination-update.md`, to the Coordination document on OME-1.
- [ ] Create the four courier issues from `courier-issues.md` (Server Engineer, Lead Engineer, QA Engineer, QA Engineer 2), assigned to each agent.
- [ ] Resume agents (paused, `manual`), in this order so the reviewers are ready before the authors:

  | Order | Agent | id |
  |---|---|---|
  | 1 | Lead Engineer | `7cfa1415-67fc-4650-b72d-db860eb7e599` |
  | 2 | QA Engineer | `0e8d6a7c-edbf-478b-b6f5-c90fb4e25023` |
  | 3 | QA Engineer 2 (was `error`) | `d72569af-a258-4057-8723-7b94b7d96755` |
  | 4 | Server Engineer | `fc06a562-1f73-422f-afa7-de30baf59c1c` |
  | 5 | Extension Engineer | `2bd40b31-37bc-463a-97c4-f48cb05a8c09` |
  | 6 | Creative Designer | `d1caac00-d9da-43ba-aa57-f8668438a995` |
  | 7 | CEO | `fe40d344-b9ef-40f1-aeef-e76cbae8c787` |
  | 8 | Company Optimizer | `ccb54cec-6e56-47db-b4bb-4fb3b32f4045` |

- [ ] Resume routines (all three were `active` with one enabled schedule trigger):

  | Routine | id | Schedule (Europe/Amsterdam) |
  |---|---|---|
  | CEO triage and quota recovery | `ea776958-2e04-4d8a-a7e6-3c1efcb13337` | `0 */2 * * *` |
  | Daily full suite on main: file it for QA Engineer 2 | `19d5ec2d-93e2-45c2-b29c-f9b7bd5ddc49` | `0 2 * * *` |
  | Company Optimizer weekly review | `b0959874-0e9d-447e-b339-d4abf625d934` | `0 20 * * 0,1,2,3` |

- [ ] Watch the first day: server journal (`docs/ops/switch-to-rust.md` § 5), the first daily full suite (it builds the Rust binary on a cold cache), and that no agent runs `--server bun`.
- [ ] After 2026-10-22 with no rollback: tell the CEO to plan S13 (rename, delete the TS server, drop Bun from the box, update ADR 0001).
