# ADR 0034 — Pop-out chat: one socket, a local BroadcastChannel, one window per tab

**Status:** accepted (2026-10-09) · Lead · [OME-598](/OME/issues/OME-598) · plan [OME-538](/OME/issues/OME-538#document-plan) item 2 · follows research R-M7a Q3 option (a) (`docs/research/m7-fullscreen-and-popout.md`) · design set (k) `ui-m7-popout` / `ui-m7-away`

**Context:** The board asked for chat on a second monitor. A second window that joins the room on its own would be a second member (two seats, two nicknames, two sockets against the per-address caps of ADR 0016) and would need the share token, which is per tab. A SharedWorker owning the socket would rewrite the connection layer for no visible gain, and Document Picture-in-Picture has no Safari and an unverified CSP story.

## Decision

1. **The room tab keeps the one WebSocket.** The pop-out (`apps/web/chat.html`, entry `src/popout/page.ts`) is a view: no socket, no `join`, no Pixi, no provider SDK. It is opened with `window.open(url, "_blank", "noopener,popup,…")`, so it holds no reference to the room tab and the room tab none to it (COOP `same-origin` stays as is).
2. **They talk over a `BroadcastChannel`** named `omega-chat:<room>:<tab>`. The tab id is random **per page load**, never stored: a duplicated tab can't share a channel (and double-send), and a reload leaves the window on the set (k) plug with "Open the room here".
3. **The channel's messages are a local contract, not wire.** They never leave the browser, so the Valibot schema lives in `apps/web/src/popout/channel.ts`, not `packages/shared`; no contract issue is needed to change it. It is still a boundary: every message is parsed on receipt (strict objects, bounded strings and arrays) and anything else is dropped.
4. **One window per tab.** The newest window that says `pop-ready` is adopted; any other is told to go and is ignored. Chat from the window carries a sequence number; the room tab sends each sequence once, under its own cooldown and mute, and answers ok / not ok. The window sends one message at a time.
5. **Liveness:** the window says `pop-bye` on `pagehide` and pings every 5 s; the room tab lets a silent window go after 150 s (generous for intensive throttling of a minimised window) and tells it to close.
6. **Relay from dispatch, not from the frame.** A tab behind the window may be hidden and draw no frames; lines and state go to the window as the socket delivers them. Sync in a hidden tab runs on throttled timers and recovers by seek on return (clock resync on `visibilitychange`).
7. **Desktop only, and only where `BroadcastChannel` exists**; a room tab narrowed to the phone layout takes its chat back.

## Consequences
- One member per person holds with the window open (e2e counts room sockets per page).
- The window's JS is its own ~15 KB gz chunk; the room tab's frame budget with the window open is its own row (`pop.*`, `docs/perf-budgets.md`).
- A whole-room pop-out (W3b, [OME-600](/OME/issues/OME-600)) needs a second renderer or a state mirror and is decided separately.
