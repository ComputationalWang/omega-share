# ADR 0054 — Doors between rooms; `/roll` dice

**Status:** accepted (2026-10-18) · Lead · [OME-1423](/OME/issues/OME-1423) (part of [OME-1345](/OME/issues/OME-1345)) · extends [ADR 0021](0021-room-layout-v1.md) (layout) and [ADR 0028](0028-room-ownership-and-private-rooms.md) (`layout-set`)

**Context:** Rooms are islands: going from one to another means the rooms list. Owners want a door that leads to a friend's room, and people want a dice roll in chat. A door is the first piece that names something outside its room, so it is a new kind of untrusted link; dice need a value nobody can choose.

**Decision (doors):**
- **A furniture kind, `door`.** An `object` (solid), 1×1, wall-backed (on row 0 facing sw, on col 0 facing se, like the bookcase), `CAMERA` facings, 2 variants. It is in the layout, so it is stored, in the snapshot and in `layout-changed` like any piece.
- **`target` is a room id, never a URL.** Every piece has an optional `target`, parsed with `RoomIdSchema` (`^[a-z0-9-]{1,32}$`; Rust: `RoomId`). A door must have one; any other piece with one is refused. Clients build the link themselves (`/r/<target>`, same origin), so a door can't point off-site or carry a path, query or script.
- **At most `MAX_DOORS` (2) per layout**, a layout rule on both parsers. More would turn a room into a link farm and crowd the two walls.
- **Not to its own room.** The schema can't know the room, so this is a room check on `layout-set` (`hasDoorTo` / `RoomLayout::has_door_to`): refused with `error: bad_message` to the sender only, like a blocked title, and not counted toward the 4400 close (the frame was valid).
- **Format only.** The server doesn't look the target up: a door may lead to a room that doesn't exist yet or was deleted, and the client shows the existing room-not-found page. Checking existence would leak which ids exist to any owner and go stale anyway. A private target still asks for its invite key.
- **Logs.** Targets are room ids, so they are never logged.

**Decision (dice):**
- Client `roll {sides}`, `sides` an integer `DICE_MIN_SIDES..DICE_MAX_SIDES` (2..100); the server answers everyone `rolled {memberId, sides, value}`, `value` in `1..sides`. Fire-and-forget like `emoted`: never stored, never in a snapshot.
- **The server rolls,** from the OS CSPRNG (`getrandom`), uniform by rejection sampling: a 32-bit draw at or above the largest multiple of `sides` below 2^32 is drawn again, so there is no modulo bias. If the OS has no entropy, the roll is dropped.
- **It is a chat line:** it takes from the member's chat bucket (`rate_limited` over it), needs `join` (`not_joined`), a muted member gets `muted` and nobody sees the roll, and it clears the member's typing indicator.
- Neither the sides nor the value is logged.

**Frozen TS server.** It ignores `roll` and has no own-room door check (PORTING.md "Deliberate differences"); the black-box cases (`door-roll.test.ts`) run against the binary only.

**Consequences:** One furniture kind, one optional piece field, two message types, three constants. `Furniture` holds a `RoomId` now, so it is `Clone`, not `Copy`. The web editor leaves the door out of its tray until the door web issue adds a target picker and the art; until then a door from another client draws nothing. A rollback to the TS server would make `/roll` silently do nothing and allow a door to its own room, which only loops the owner's guests back in.
