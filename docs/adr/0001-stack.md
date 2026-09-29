# ADR 0001 — Stack

**Status:** accepted (2026-09-29)

**Decision**
- **Tooling:** Bun for installs, workspaces, the server runtime and unit tests (`bun test`). Playwright + Chromium for e2e.
- **Language:** TypeScript 6 (pinned: typescript-eslint doesn't support TS 7 yet; revisit when it does) with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. Linting with `typescript-eslint` `strictTypeChecked`.
- **Contract:** Valibot schemas in `packages/shared` are the single source of every wire type (HTTP + WebSocket). Types come from `InferOutput`. Every boundary parses.
- **Server:** Hono on `Bun.serve` with Bun's built-in WebSockets (pub/sub per room).
- **Site:** Vite + PixiJS (WebGL) isometric renderer. The video player lives in a DOM layer over the canvas, positioned like a "TV" in the room.
- **Extension:** WXT, Manifest V3, Chromium first. Firefox builds come later from the same code.

**Why:** performance is priority #1. Bun's built-in WebSockets and PixiJS batching fit the budgets. Valibot is about 1 KB against Zod's about 13 KB. Mastra was considered and rejected: it's an AI-agent framework, not a web/realtime framework.

**Consequences:** anything that doesn't run on Bun needs an ADR. Paperclip (the company runtime) still runs separately on Node.
