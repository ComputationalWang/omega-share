# ADR 0064: Nothing on, the TV keeps a player's box

**Status:** accepted (2026-11-07) · [OME-2347](/OME/issues/OME-2347)

**Context:** From OME-2263 to OME-2323 the empty TV's curtain had a box of its own. It was 21:9 rather than 16:9, it had no ADR 0012 floor, and at a desk it took the corner over the left wall. The room got the height that the player gives up (judge rounds 10–12, audit OME-2260). Audit round 3 ([OME-2344](/OME/issues/OME-2344#document-audit) item 2) measured what that costs. When another member's Add starts a video, every member who pressed nothing sees the TV, its shelf, the room and the chat jump. That is 0.035–0.068 of CLS per video started, and it recurs on every queue switch during a movie night. The two goals conflict: a curtain sized for the empty room has to change size when a player arrives, because the player cannot get smaller than its ADR 0012 floor.

## Decision

With nothing on, the layout reserves the box of a synced player (`laidOut()` in `apps/web/src/room-layout.ts` lays out as YouTube). This covers the TV, its shelf, the room's band and its fit to the audience (ADR 0060). The curtain fills that box. Only Twitch's larger floor still resizes the TV. One exception is the owner's open editor: there the curtain still gives way to the whole room (OME-2283). Only the owner's own screen changes, and it changes because of the owner's own action. A few smaller pieces follow the same rule, so that a video starting or being skipped moves nothing for the members who didn't act:

- Wide: Report room keeps its place at the right end of its own row (`.room-wide > .room-foot`). The reaction bar's row still appears only with a video.
- Upright on a phone: the idle reaction bar keeps its row, invisible (`.reaction-bar.is-idle`). Its keys do nothing. A tablet held upright doesn't reserve the row, because its whole room would lose its floor's foot. The empty chat strip collapses in place instead of being lifted out of the flow.
- Sideways (≤ 500 px tall): Up next keeps the column's box whatever it holds, with its field at its foot. The log keeps three lines (60 px).

The perf rows `room.observerCls.{desktop,portrait,landscape}` (< 0.01) hold this. So does `e2e/room-clip.e2e.ts` ("a video coming on moves neither…").

## Consequences

- The empty room looks like the watching room. It gives up what the curtain's own box gave it: at 1280×800 the window no longer reaches the floor's front with nothing on, and on a Pixel 7 the room window is about 47 % of the height instead of ≥ 50 %. The judge-round checks for those empty-room looks are removed (OME-2347's red commit). Their playing-room counterparts still hold.
- Outside the editor, nothing in the app reaches the `empty` paths of `roomLayout` and `portraitLayout`, or the curtain's corner in `wideLayout` ([OME-2354](/OME/issues/OME-2354) deletes what's unreached).
- Sideways with an empty queue, the chat log shows three lines instead of the space the queue left (about five).
- Reverting means giving up the observer CLS rows. Measure them before doing it.
