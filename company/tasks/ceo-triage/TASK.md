---
name: CEO triage and quota recovery
assignee: ceo
project: omega-share
recurring: true
---

Every 30 minutes:
1. Re-queue issues whose last run failed on a usage/rate limit once the limit has reset.
2. Triage new and blocked issues by the company priority order.
3. Clear released claims and resolve overlapping claims in the Company Ops `coordination` document.
4. If the current milestone is complete and green, request board approval.

Keep it short. If nothing changed, exit.
