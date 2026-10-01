# ADR 0021 — Room layout v1: furniture in the snapshot

**Status:** accepted (2026-10-01) · contract [OME-271](/OME/issues/OME-271) · plan [OME-270](/OME/issues/OME-270) · research `docs/research/m4-hosting-and-sqlite.md` §3 ([OME-260](/OME/issues/OME-260)) · art: room atlas (ADR 0008), set (g) furniture ([OME-261](/OME/issues/OME-261)) · builds on ADR 0003, ADR 0016

**Context:** Until M4 the room is hard-coded in `apps/web/src/layout.ts`: a 10×10 floor, the TV in the back corner, a 7×7 rug, a lamp, a plant and eight armchairs at `SEAT_CELLS`. M4 starts customizable rooms, so the layout has to become data the server stores (SQLite) and sends. The research proposed a contract with five kinds and "exactly `SEAT_COUNT` armchairs". Since then set (g) added 11 pieces, and the sofa and couch seat two people each, so "one armchair = one seat" no longer holds.

## Decision

### 1. Wire contract (`packages/shared/src/layout.ts`)

| Name | Shape |
|---|---|
| `FLOOR_CELLS` | `10`, moved from the web into `constants.ts`; the web re-exports it. |
| `MAX_FURNITURE` | `32` pieces per layout. |
| `FacingSchema` | `"ne" \| "nw" \| "se" \| "sw"`, where a sitter looks. ne/nw face the TV corner, se/sw face the camera. |
| `FurnitureKindSchema` | the keys of `FURNITURE`: `armchair tv lamp plant rug` (room atlas) + `sofa couch wingback beanbag sidetable arclamp monstera popcorn bookshelf runner frame` (set (g)). |
| `FurnitureSchema` | `{ kind, col, row, facing, variant? }`. `col`/`row` are integers in `0..FLOOR_CELLS-1`, the anchor cell. `variant` is an integer, absent means 0. |
| `RoomLayoutSchema` | `{ furniture: Furniture[] }`, at most `MAX_FURNITURE`. |
| `RoomStateSchema.layout` | `v.optional(RoomLayoutSchema)`. |
| `DEFAULT_LAYOUT` | today's room as data. |
| `layoutSeats(layout)`, `footprintCells(piece)` | pure helpers the server and web share. |

There is no client → server message in v1. Layouts are set server-side (seed, new room from the default, an operator CLI). Layout editing needs room ownership first and is a later contract (research §3, "room ownership + layout editing"). So every client message stays a `strictObject` and there is no new abuse surface.

### 2. The catalogue lives in the contract

`FURNITURE` restates, per kind, what the art manifests say: layer (`floor`, `object`, `wall`), the facings that have sprites, the footprint, whether it seats people, the number of variants, and whether it backs onto a wall. The server validates a layout without loading asset files. A contract test reads `assets/room/room.json` and `assets/furniture/furniture.json` and fails if the two disagree, so new art can't silently drift from the contract.

- Set (g)'s kilim is atlas id `rug`. The contract already uses `rug` for the room's 7×7 rug, so the kilim is the kind **`runner`**. The web maps it back to its atlas id.
- One-sprite pieces (tv, lamp, plant, rug) take the single facing `se`.
- Footprints: `cols × rows` facing ne/sw, swapped facing nw/se, covering the anchor toward +col and +row.
- `variant` is in the contract because set (g) ships colour variants (sofa, couch, beanbag, monstera, runner, frame). It's an index, not a colour, so the art can change without a contract change.

### 3. Rules (`RoomLayoutSchema` / `FurnitureSchema` checks)

- Every footprint cell is on the floor. A rug, runner or sofa can't hang off the edge.
- The piece has a sprite for its `facing` and its `variant`.
- **Exactly one `tv`.** The player is anchored to it.
- **Object pieces don't overlap** each other. **Floor pieces** (rug, runner) don't overlap each other, but objects may stand on them.
- **Wall pieces** (frame) hang on the right wall at `(col, 0)` facing sw or on the left wall at `(0, row)` facing se. They can't share a segment and can't go on a window, poster or sconce segment (`WALL_FIXTURE_SEGMENTS`, pinned to `room.json`). The bookshelf is wall-backed: it stands on row 0 facing sw or col 0 facing se.
- **The seat cells total exactly `SEAT_COUNT`** (below).

### 4. Seat rule: seat `i` is the `i`-th seat cell

Seat-giving pieces are armchair, wingback and beanbag (one cell each) and sofa and couch (two cells each). Every footprint cell of a seat-giving piece is a seat facing the piece's way, which matches `seatsByDir` in the set (g) manifest. `layoutSeats` walks `furniture` in order and lists each piece's seat cells in footprint order. **Seat `i` is entry `i`**, and a layout is valid only if there are exactly `SEAT_COUNT` entries.

Why this rule:

- **`seats[]` and `SeatIndexSchema` keep their length and meaning.** `seats` is still `SEAT_COUNT` slots, and `sit { seat }` still names a slot. The server's seat logic, the wire messages and the load tests don't change. Only the point a client draws a seat at moves into data.
- **Counting cells, not pieces,** lets a room have four sofas or one armchair and three sofas without a per-piece seat count in the wire format. The alternatives were worse: "exactly 8 armchairs" bans sofas; letting the seat count vary changes `SeatIndexSchema` and every client's seat array, which is a much bigger contract.
- **Order is the identity.** v1 has no per-item ids (research §3). Reordering `furniture` renumbers seats, so whoever edits a layout later (the ownership contract) must keep the order or unseat everyone. That is acceptable while layouts change only offline.

### 5. Compatibility and size

- `layout` is optional. A pre-M4 server sends none, and a client then draws `DEFAULT_LAYOUT`. An old client strips the unknown key (server → client objects are non-strict, ADR 0016 §6) and draws its hard-coded room, which equals `DEFAULT_LAYOUT`. The extension parses neither.
- `DEFAULT_LAYOUT` is pinned by a contract test: it parses, and its seats equal the pre-M4 `SEAT_CELLS` in order and facing, so M4 draws the same room.
- Size: `DEFAULT_LAYOUT` is ~0.6 KB of JSON; a full 32-piece layout is ~2 KB. The worst-case snapshot (25 members, max-length ids and names, full layout) stays under `MAX_SERVER_MESSAGE_BYTES` (16 KB), pinned by a test. A later `layout-set` message (~2 KB) would fit `MAX_CLIENT_MESSAGE_BYTES` (4 KB).
- Bundle: the web parses snapshots with `RoomStateSchema`, so the catalogue and the checks ship to the site. Measured on the web build: the `index` chunk grows from 6,353 B to 7,286 B gzipped (+0.9 KB), far inside the 200 KB initial-JS budget.

## Consequences

- The server layout wiring (SQLite store, snapshot) and the web layout rendering can start in parallel against this contract.
- New furniture art means a new `FURNITURE` entry in a contract issue; the manifest test makes that impossible to forget.
- Seats bound by order make layout editing a careful change: the later ownership contract must decide what happens to seated members when a layout changes.
