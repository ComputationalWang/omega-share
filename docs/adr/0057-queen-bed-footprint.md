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
