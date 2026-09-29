---
name: Plan and run milestone M1a
assignee: ceo
project: omega-share
---

Break **M1a** (see `docs/product-spec.md`) into small issues with acceptance criteria, owners and blockers, then drive it to board sign-off. Suggested order:

1. **Lead Engineer - contract v0** in `packages/shared`: Valibot schemas for the share request, the provider allowlist (YouTube for now), the room state and the WebSocket message union (join, leave, sit, chat, embed-changed). Blocks everything below.
2. In parallel once the contract lands:
   - **Lead Engineer:** Bun + Hono server (rooms in memory, 8 seats, share endpoint, WebSocket pub/sub) and the Vite + PixiJS site (nickname + avatar picker, Enter room, isometric room with placeholder avatars and seats, chat bubbles, embed "TV" DOM layer).
   - **Extension Engineer:** WXT MV3 extension: popup scan → canonical embed list → share to room, with a configurable server URL.
   - **QA Engineer:** Playwright harness (install Chromium via `bunx playwright install chromium`, load the unpacked extension, fixture pages, multi-context room test) and the perf budget checks.
3. **QA:** end-to-end acceptance: share from the extension → 4 contexts see the embed and each other's seated avatars.

Every engineering issue gets an execution policy review stage with the QA Engineer as reviewer. Request board approval when M1a is done.
