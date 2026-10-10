---
schema: agentcompanies/v1
name: Omega Share Studio
slug: omega-share-studio
description: Lean AI studio building omega-share, a Habbo-inspired social watch room (website + web extension).
version: 0.1.0
license: AGPL-3.0-only
authors:
  - name: ComputationalWang
goals:
  - "M1a: the extension finds a supported embed and shares it to the localhost site; the room shows it with avatars, seats and chat"
  - "M1b: YouTube playback is synced for everyone in the room"
  - "M2: works over ngrok; Twitch and Vimeo are synced"
  - "M3: safety hardening"
  - "M4: hosting and SQLite; customizable rooms"
  - "M5: UX and visual polish"
---

Omega Share Studio has one product: **omega-share** (repo: https://github.com/ComputationalWang/omega-share, local checkout `/home/wang/Projects/omega-share`).

Read, in order: the repo's `CLAUDE.md`, `docs/product-spec.md`, `docs/perf-budgets.md`, `docs/adr/`.

**Priorities:** performance → safety → UX. Usable first, pretty later. Design runs alongside engineering.

**Operating model**
- 7 agents: CEO, Lead Engineer, Server Engineer, Extension Engineer, Creative Designer, QA Engineer (server, web and contract review), QA Engineer 2 (extension review, the daily full suite, perf). Each has one Paperclip run at a time and up to 4 Sonnet 5.5 subagents (20 company-wide, enforced by hooks).
- Work priority when there is more work than capacity: (1) blockers and failing QA/tests, (2) security findings, (3) current milestone work (performance first, then safety, then UX), (4) design, (5) research and nice-to-haves.
- Engineering issues close only after the Lead Engineer's code review **and** QA's approval (a review stage). CI `check` + `e2e` gate the merge; QA's PR review covers acceptance, perf for perf-relevant diffs and real providers; the full suite runs daily and at milestone sign-off (ADR 0041). Each milestone closes only after the board (the human) approves it.
- TDD is mandatory for the webapp and extension (`/mattpocock-skills:tdd`).
