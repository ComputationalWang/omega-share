# ADR 0053 — Free walking: the server holds a standing cell per member; shirt tint

**Status:** accepted (2026-10-17) · Lead · [OME-1346](/OME/issues/OME-1346) (part of [OME-1345](/OME/issues/OME-1345)) · amends [ADR 0029](0029-room-canvas-renderer-and-walking.md) ("no contract change, the server is seat-authoritative") · keeps [ADR 0043](0043-durable-room-sessions.md) standing slots

**Context:** Avatars walk only seat to seat (`sit {seat}`), or to their standing spot (`standingSlot`, ADR 0043). People want to walk anywhere on the floor and to pick a shirt colour. Walking stays cheap only if the wire carries destinations, not steps.

**Decision:**
- **Destination only.** Client `walk {cell: {x, y}}` (column, row, integers `0..FLOOR_CELLS-1`); the server answers everyone with `walked {memberId, cell}`. Clients path there themselves with the BFS of ADR 0029, unchanged. No per-step traffic, no server pathing, no collision between people.
- **The server holds one standing cell per member,** in memory only (like seats; a graceful restart keeps seats, not cells). A member's `cell` is in `snapshot` and `member-joined`, absent when they are seated or on their standing spot (absent rather than `null`, so pre-0053 snapshots stay byte-identical and old clients ignore it).
- **Refusals.** Off the grid: `bad_message` (the schema). A cell under a solid (`object`) piece: `error: bad_cell`. Seats are solid, so a seat cell is `bad_cell` too: use `sit`. Rugs and runners are floor, so standable. `isStandable` / `RoomLayout::standable` is the one rule.
- **Seats and cells exclude each other.** `walk` from a seat stands up first: the server sends `seat-changed {seat: null}`, then `walked`. Any `sit` (taking a seat, or `sit null`) clears the cell; `sit null` goes back to the standing spot as before. Clients clear `cell` on `seat-changed` themselves; there is no `walked` for it.
- **Layout changes.** A `layout-set` that covers a standing member's cell moves them to the door (`DOOR_CELL`, the front corner `(9,9)`), or to their standing spot (`walked {cell: null}`) when the door is covered too. Each move is a `walked` sent after `layout-changed`, so clients path on the new floor.
- **Rate.** Per member `WALK_BURST` 8, refilling one every `WALK_REFILL_MS` 250 (4/s), under the per-socket frame limit. Over it the walk is dropped silently: no `rate_limited`, no streak toward a close. A path click is one walk; 4/s is ample for people and too little for a flood to matter (one small broadcast each).
- **Tint.** `tint` `0..TINT_COUNT-1` (6), 0 the avatar's own colours. Set on `join` (optional), changed with `set-tint {tint}`, relayed as `tint-changed`; setting the current tint is a no-op. It takes from the member's emote bucket (`EMOTE_BURST`, `EMOTE_REFILL_MS`, `rate_limited` over it): one cosmetic budget. Absent on a member means 0. Persisted like the avatar choice: the client remembers it (profile) and sends it on join; the server keeps it in memory with the member, and a resume keeps it.
- **Logs.** Cells, tints and room ids are never logged.
- **Frozen TS server.** It ignores `walk` and `set-tint` (PORTING.md "Deliberate differences", as for `queue-move`); its black-box cases run against the binary only.

**Consequences:** One more field each on a member (`cell`, `tint`), two client and two server message types and one error code. A rollback to the TS server would make walking and tints silently do nothing, nothing else. Pathing stays a client concern: a client that disagrees about the floor only draws a different route, never a different destination.
