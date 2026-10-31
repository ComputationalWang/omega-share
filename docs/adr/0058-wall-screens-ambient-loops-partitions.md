# ADR 0058: Wall-mounted screens, ambient loops and generic partitions

**Status:** accepted (2026-10-31, contract [OME-2065](/OME/issues/OME-2065)) · Lead · [OME-2063](/OME/issues/OME-2063) (spike for [OME-2061](/OME/issues/OME-2061): livelier rooms, optional TV table)

**Context:** Wave 2 of OME-2061 wants a screen that hangs on a wall (no TV table), small looping animations in the room, and more presets split by a partition like Dank Dungeon. The spike read `main` at `44f198e6`. The evidence and file:line references are in the OME-2063 findings comment. Summary:

- **Screens.** `SCREEN_KINDS = ["tv", "bigscreen"]` and the "exactly one screen" check (`packages/shared/src/layout.ts:139-140, 291`; Rust `contract/layout.rs:113-115, 456`) are the only screen rules in the contract. The server has no other screen logic. The web player is **not** anchored to the screen piece: `roomLayout` puts the player above the stage at a fixed rect (`apps/web/src/layout.ts:117-139`, YouTube/Twitch minimum sizes). The cinema dim is a class toggle that ignores the piece's position (`apps/web/src/cinema.ts`, `room.ts:863-875`). The editor's "one screen" problem already uses `isScreen` (`editor/draft.ts:143`). The one place that breaks is the north view: `furniture.ts:357` skips every `wall`-layer piece, and only `tv` has a north stand-in (the flat tv at the far corner, `furniture.ts:395-399`).
- **Animation.** The room renders on demand and idles at 0 fps (`room-view.ts:1-3, 255, 262`, OME-185). There is no `AnimatedSprite`. The only ambient motion is the theme effect (snow), on its own canvas and rAF, gated by `effectAllowed` (reduced motion, walk tier; `room-view.ts:816`), an IntersectionObserver and `paused`.
- **Partitions.** The `partition` kind and walk blocking are generic. The view swap is not: `cutaway` takes the first partition only (`furniture.ts:238-242`), the wall row is the constant `DUNGEON_SPLIT = 4` (`furniture.ts:40, 481, 491`), and `ROOM_SHELLS = ["dungeon"]` (`layout.ts:273`) is the only skin.

## Decision

### 1. Wall screens are screen kinds on the wall layer

- Add two kinds to `FURNITURE` and `SCREEN_KINDS`: **`wallscreen`** (a flat panel) and **`projector`** (a pull-down screen, the cinema look). Both are `piece("wall", CAMERA, { cols: 0, rows: 0 })`, hung like `frame`: on the right wall facing sw, on the left facing se, never on `WALL_FIXTURE_SEGMENTS`.
- **Wall span.** A screen is wider than one wall segment. Add `wallSpan?: number` to `FurnitureSpec` (segments covered from the anchor toward +col/+row; absent means 1). `wallscreen` spans 2 and `projector` spans 3. `wallSegment` returns every covered segment, so the "wall pieces share a segment" check and `onItsWall` (no fixture segment, inside the wall) hold for the whole span. Every existing wall piece keeps span 1, so no stored layout changes.
- `isScreen` becomes `SCREEN_KINDS.includes(kind)`, so it can't drift from the list. "Exactly one screen" stays: a room has a `tv`, a `bigscreen`, a `wallscreen` or a `projector`. "Optional TV table" means the owner picks a wall screen instead of the `tv` piece. It does not mean zero screens.
- **Rust mirror:** `Kind::Wallscreen`, `Kind::Projector`, `Spec::wall_span`, `is_screen`, and the segment check in `contract/layout.rs`. Regenerate the layout corpora (`bun apps/server-rs/corpus/gen.ts`) with cases for span overlap, a span crossing a fixture segment, and a span running off the wall.
- **Web:** the player overlay, cinema dim and lights-down need no change. The renderer draws the screen's frame on its wall. From the north, the near walls are not drawn, so a wall screen gets the flat-tv treatment: its back-sheet frame at the mirrored segment of the far wall on the raw projection, where `furniture.ts:395-399` puts the flat tv. Without that, a partitioned room seen from the north has no screen. The editor gets labels, a wall-placement preview of the span, and art in a lazy sheet (ADR 0056: lazy, inside the 450 KB cap).

### 2. Ambient loops: one shared timer, render on frame change

- One module in `apps/web` (`ambient.ts`) owns a single `setInterval` at **8 fps**. On each tick it advances every registered loop and swaps the `sprite.texture` of loops whose frame changed. Then it calls the room's existing `requestRender` **once**. The room stays on-demand: about 8 renders/s while a loop is visible, against 60 for a running ticker. It never starts `app.ticker`.
- A loop is a list of atlas keys (`furniture/<id>/<colour>/<facing>/loop/<n>`) in the piece's existing lazy sheet. There are no new atlases and no `AnimatedSprite`. Frames load with the sheet and stop with it.
- **Gating (all of them):** off under `prefers-reduced-motion`, off in the Basic walk tier (reuse `effectAllowed`), stopped while `document.hidden` (an explicit `visibilitychange`; rAF already stops, but `setInterval` doesn't), stopped while the stage is out of view or `paused`, and stopped while the editor is open. A stopped loop shows frame 0, which is the piece's current still art.
- **Budget.** Memory: a 4-frame 64×64 loop is 64 KB decoded, so 10 loops are under 1 MB against the 150 MB heap row. Code: under 1 KB gzipped, no dependency. CPU is the risk, because ambience ends the 0 fps idle. The `walk25.ambience.*` rows (`docs/perf-budgets.md:42-44`, `perf/budgets.ts`) guard frame time and missed vsyncs under load. Nothing guards idle cost yet, so wave 2 adds a row: **an idle room with every ambient loop visible: main-thread work ≤ 2 ms per second, ≤ 8 renders/s** (desktop and Pixel 7, Smooth).

### 3. Partitions are per wall, not per preset

- The layout states its wall: the contract derives each partition line from the `partition` pieces (all on one row facing sw, or one column facing se). It rejects a layout whose partitions form more than one line. Two lines would need a per-wall `cutaway`, and no preset asks for that yet.
- The web reads the split row/column from that line in place of `DUNGEON_SPLIT`, and `cutaway` decides "behind" against it on either axis. The shell skin stays a `ROOM_SHELLS` value. A new partitioned preset with its own look adds a shell value and its wall/floor frames. A preset without `shell` gets the plain shell with the partition drawn.
- So 2 more partitioned presets need: the generic split (one web issue), one contract issue for the preset ids and shell values (`room-ownership.ts`, Rust `layout.rs`/`presets.rs`, corpus), preset JSON and thumbnails, and shell art from Design.
- The contract exports `partitionLine(layout)` (`{ axis: "row" | "col", at }` or undefined) for the web split. The shell values `penthouse` and `studio` landed with the contract (OME-2065). The preset ids land with their layouts ([OME-2071](/OME/issues/OME-2071)): an id needs its layout at build time (`presets.rs` `include_str!`, the `Record<RoomPresetId, …>` maps, `presets.json` and a thumb), so adding it earlier would ship a placeholder room to the picker.

## Consequences

- One more screen rule to keep in sync: the span check, in both languages, pinned by the corpus.
- Stored layouts stay valid. No migration.
- If ambient loops fail the idle row, set the default to off and let the owner turn it on per room, or drop to 4 fps. The timer design allows both without new code paths.
- Reversing: remove the kinds (rooms that use them would fail to load, as in ADR 0057, so a rollback first checks `SELECT count(*) FROM rooms WHERE layout LIKE '%wallscreen%' OR layout LIKE '%projector%'`).
