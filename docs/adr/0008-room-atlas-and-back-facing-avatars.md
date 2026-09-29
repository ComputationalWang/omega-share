# ADR 0008 — Room atlas and back-facing avatar directions

**Status:** accepted (2026-09-29) · [OME-31](/OME/issues/OME-31) · extends [ADR 0004](0004-sprite-atlas-format.md) · art in [OME-2](/OME/issues/OME-2)

**Avatars:**
- `meta.omega.dirs` is `["se","sw","ne","nw"]`. Every avatar has `idle` and `sit` in all four directions. The sheet is 512×256.
- `ne`/`nw` keep a `/1` frame that points at the same rect as `/0` (no eyes from behind), so the blink ticker has no special case.
- Seat facing is derived, not stored: a seat at `(col,row)` faces `ne` if `col < row` and `nw` if `col > row`. No seat may sit on `col == row`; the web asserts this in a test.

**Room atlas** (`assets/room/room.{png,json}`, same format rules as ADR 0004, sheet ≤ 1024×1024):
- Every anchor is a cell's floor point, `cellCenter(col,row)`. `floor/<v>` and `rug/<part>` are 64×32 half-open tiles that tessellate at `cellCenter` spacing. `wall/l/<v>` sits on the top-left edge of `(0,row)` and `wall/r/<v>` on the top-right edge of `(col,0)`, anchored at that cell's centre.
- `armchair/<ne|nw>/back` and `/front` share the seated avatar's anchor. `seatHeight` is 8.
- `stage/0` is anchored at `cellCenter(0,0)` and covers the cells with `col+row <= 4`. Nobody is seated or standing there.
- Draw order: floor and walls go in a **static container** that is drawn once and cached. Everything else (stage, props, chair backs, avatars, chair fronts) goes in one sorted container keyed by `(floorY, floorX, layer)` with `back=0, avatar=1, front=2`. Stage and props use `back`. There is no other layer numbering.
- `meta.omega.tv.screen = {x,y,w,h}` is relative to the stage anchor and must be integer, 16:9 and inside the 960×600 stage. `layout.ts` keeps the `TV` constant, so the iframe is placed before the atlas loads (TTI budget). A unit test asserts `cellCenter(0,0) + tv.screen === TV`. Changing either side is a `meta.omega` change (ADR 0004 condition 8).
- `meta.omega.layout` is a suggested default room. `floor[row]` and `walls.l[row]` / `walls.r[col]` are 10-character strings, one character per cell, resolved through a required `legend: Record<char, frameKey>`. `.` means empty. `props[]` must avoid stage cells, seat cells and standing cells (`col+row >= 12`). The web validates this at load and rejects an invalid layout. Seat cells stay in `layout.ts`.
- Room frame keys share Pixi's global texture cache with avatars. Avatar ids must not collide with the room prefixes (`floor`, `rug`, `wall`, `armchair`, `stage`, `plant`, `lamp`), and the asset build enforces cross-set uniqueness.

**Why:** back-facing viewers are what the room layout implies. One sorted container with three layers plus a cached static background keeps the room to a couple of draw calls and avoids per-frame sorting of tiles. The TV rect stays in code so first paint never waits on an image fetch, and the atlas copy is kept honest by a test.
