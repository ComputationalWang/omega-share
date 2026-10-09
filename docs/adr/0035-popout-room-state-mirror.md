# ADR 0035 — Pop-out room: a state mirror and one renderer at a time

**Status:** accepted (2026-10-09) · Lead · [OME-600](/OME/issues/OME-600) · plan [OME-538](/OME/issues/OME-538#document-plan) item 2 · builds on ADR 0034 (pop-out chat) · design set (k) `ui-m7-popout` / `ui-m7-away`

**Context:** The board asked for "the chat **or the whole room**" on a second monitor. ADR 0034 put the chat in a window that talks to its room tab over a `BroadcastChannel` and never joins. The whole room also needs the Pixi stage there. The window could join the room itself, but that means a second member and a second socket, the problem ADR 0034 already turned down. The page could keep its renderer and stream frames to the window, but that is heavy and not crisp. Or the window could draw from the room tab's state.

## Decision

1. **A state mirror over the same channel.** The room tab still holds the one WebSocket and the only reducer. A `room.html` window (entry `src/popout/room-page.ts`) is the channel's second kind of window. It says `pop-ready` with `kind: "room"`; a W3 chat window sends no `kind`, which means chat. The tab still adopts one window, whichever kind. A room window that takes over tells the chat window to go, and the other way round.
2. **What crosses the channel:**
   - `room-view`: the slice of the view state the stage draws (status, self, room, bubbles, system lines, catching). It is sent whenever one of those changes, from dispatch, so a hidden room tab still relays (ADR 0034 §6). The comparison is by reference, because the reducer keeps unchanged objects.
   - `room-tv`: the plate text and my own catching-up flag, from the player's timer, in whole seconds.
   - `room-emote`: each emote as it arrives.
   - `room-raise`: sent by "Show the window".
   - `pop-sit`: from the window to the tab. The tab runs `sitIntent` on its own state and sends the result, so a seat click from the window passes the same checks as one in the page.

   The schema is local (`src/popout/channel.ts`, ADR 0034 §3). The room inside `room-view` is parsed with the wire's own `RoomStateSchema`, so the window only draws a room the server could have sent.
3. **One renderer at a time.** The stage moved out of `room.ts` into `src/stage.ts`, and both pages build theirs from it. While the room is in its window, the page pauses its Pixi view (`setPaused`, as full screen does), skips the stage's DOM work, and shows the set (k) placeholder ("Bring the room back", "Show the window"). The window draws on demand, as the page does (ADR 0029). Bringing the room back unpauses the page's view and draws it once as things are now. Nothing reloads and the player is never touched, so sync never drops.
4. **The page with the room out:** the picture and its shelf only. The chat row is in the window too, so the page shows only the room placeholder. In full screen the picture is alone, with no strip (`fullscreenLayout(…, "none")`).
5. **Owner tools stay in the page.** The layout editor draws on the stage, so popping the room out closes it, and "Edit room" isn't offered until the room comes back. The moderation menus hang off the page's tags, so they also wait for the room to come back.
6. **"Show the window"** posts `room-raise`, and the window calls `window.focus()`. Browsers may refuse that without a user gesture in the window. It is best effort; the window is never re-opened to raise it.
7. **Desktop only, and only where `BroadcastChannel` exists** (ADR 0034 §7).

## Consequences
- The window is its own page. It shares the stage chunk (Pixi) with the room's lazy chunk and opens no socket. The e2e suite counts sockets per page.
- The frame budget holds for each window on its own with a full room (25 members, someone always walking, chat ~8/s). These are the `poproom.*` rows in `docs/perf-budgets.md`, measured by `perf/popout-room.perf.ts`.
- The mirror sends the whole room on each change to it. That is a few KB with 25 members, and it changes on joins, seats, playback and queue changes, not per frame. If it ever shows in a profile, member deltas are the next step.
