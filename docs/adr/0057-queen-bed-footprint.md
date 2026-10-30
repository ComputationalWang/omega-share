# ADR 0057: Queen bed footprint (2×2) and first-row seats

**Status:** accepted (2026-10-29) · Lead · [OME-1982](/OME/issues/OME-1982) (board direction on [OME-1977](/OME/issues/OME-1977): "beds need to be queen size at least, not singles")

**Context:** `bed` was `{ cols: 2, rows: 1 }`, a single bed. Until now every seat-giving piece was 1 row deep, so `layoutSeats` made every footprint cell a seat. A 2×2 bed would give 4 seats. That would change the seat total of every layout with a bed (it must be `SEAT_COUNT`) and put a sleeper on each cell, not two side by side.

## Decision

- **Footprint:** `bed` is `{ cols: 2, rows: 2 }` in `packages/shared/src/layout.ts` and `apps/server-rs/src/contract/layout.rs`. A square footprint is the same 4 cells in all four facings.
- **Seats:** a seat-giving piece seats along its **first spec row** only: the anchor row (`row === f.row`) for ne/sw, the anchor column (`col === f.col`) for the turned nw/se. Every other seat piece is 1 row deep, so nothing else changes. The bed keeps 2 seats in the same cells and order as the 2×1 bed (`corpus/out/layout-seats.json` is byte-identical), so seat indices, the seat total and the presets' seat maps stay as they were. The web lays the sleeper over both rows (separate issue).
- **Stored layouts: validated rejection, no migration.** A stored layout is parsed with the same contract when it loads (`store/rooms.rs` `parse_room`). A bed saved as 2×1 that now overlaps a solid piece or leaves the floor fails it, and the load stops with `CorruptRoom` naming the room. The row is left untouched, so nothing is lost or rewritten in silence. Production had 1 room and **0 beds** in the 2026-10-29 backup. `assets/presets/dank-dungeon.json` stays valid with 2×2 beds (checked by the preset tests). So no data needs a migration. A migration would have to move a bed somewhere, which is a guess about the owner's room.
- **Before a deploy that ships this,** whoever deploys runs `SELECT count(*) FROM rooms WHERE layout LIKE '%"bed"%'` on the live DB. If any rows come back, check them against the new contract before switching.

## Consequences

- To reverse this, set the bed back to 2×1. The first-row seat rule can stay, because it is a no-op for 1-row pieces.
- A future seat piece deeper than 1 row also seats only along its first row. If such a piece needs other seats, give it an explicit seat list in its spec.

## Amendment (2026-10-29, [OME-2008](/OME/issues/OME-2008)): sleepers and front-row seats

**Context:** the bed art ([OME-1983](/OME/issues/OME-1983)) has a `sleep` pose for two sleepers side by side and seats se/sw beds on their front half (`seatsByDir`: se (1,0)(1,1), sw (0,1)(1,1)). The first-row rule above seated se/sw beds on the back half, and `lie` allowed one lier per piece.

- **Front-row seats for `sleep` pieces.** A piece whose lie style is `sleep` (only the bed) seats along its **front** row: the anchor row for ne/nw, the last row (`f.row + rows - 1`, or `f.col + rows - 1` turned) for se/sw. This follows the art; the art is not wrong. Every other piece keeps the first-row rule. The v7 soaktub (2×2, se only) is drawn seated on its anchor column, so a general front-row rule would have moved it. Seat counts and indices don't change. `corpus/out/layout-seats.json` changes only for se/sw beds.
- **`sleep` lie style.** `LIE_STYLES` gains `sleep`, and `bed` has `lie: "sleep"`. A `sleep` piece takes up to its seat count of liers. Sleeper `i` holds the piece's seat `i` and nothing else, so someone may sit on the free side. `lie` with a `sleep` piece gets the lowest side whose seat is free (or the lier's own) and that nobody sleeps on. If none is left, the answer is `seat_taken`. A side is kept until its sleeper gets up. The other sleeper getting up never moves it (no side swap).
- **Wire.** `Member.lying` stays the piece. A new optional `Member.sleeper: 0 | 1` and `lay.sleeper` name the side. Both are present only while lying on a `sleep` piece; a `lay` with `piece: null` has none. The client's `lie` message is unchanged: the server picks the side. `lie`/`curl` pieces keep one lier who blocks all their seats.
- **Reversal:** drop `lie: "sleep"` from the bed. The seat rule then falls back to the first row, and `sleeper` is never sent.
