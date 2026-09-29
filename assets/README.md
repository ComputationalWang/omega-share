# omega-share assets

Original art, CC BY-SA 4.0 (`LICENSE`). Style rules: `STYLE.md`.

```
assets/
  avatars/avatars.png   # shipped: 512×256 indexed PNG-8 sprite sheet (set a)
  avatars/avatars.json  # shipped: PixiJS v8 spritesheet atlas
  room/room.png         # shipped: 512×512 indexed PNG-8 (set b: floor, rug, walls, seats, TV, props)
  room/room.json        # shipped: PixiJS v8 spritesheet atlas + meta.omega room contract
  ui/ui.png             # shipped: 256×128 indexed PNG-8 (set c: 9-slices, cursor, icons, dots, portraits, wordmark)
  ui/ui.json            # shipped: PixiJS v8 spritesheet atlas (9-slices carry `borders`)
  ui/slices/*.png       # shipped: each 9-slice / cursor / bubble tail as its own PNG, for CSS border-image
  ui/reference.css      # design spec for the DOM chrome (generated); apps/web ports what it needs
  preview/              # not shipped: sheets, avatar scene, room@1x/@2x, ui.html + ui-*.png screenshots
  src/                  # generator (Bun, no deps) + mood boards
```

Rebuild everything (deterministic): `bun assets/src/build.ts`. It prints the byte budget.
Re-shoot the UI previews after a build: `bun assets/src/shoot-ui.ts` (uses the repo's Playwright + Chromium).
- Avatars are role-letter templates in `src/avatars.ts`. Room pieces in `src/room.ts` are ray-cast from
  3D boxes by `src/iso.ts`, so every edge sits on the exact 2:1 grid. Palette ramps are in `src/palette.ts`.
- The build fails if an avatar touches its cell border, or if a frame id repeats across sets (Pixi caches textures by key).

## Avatar atlas (PixiJS v8 native spritesheet JSON, TexturePacker "hash" style)

```ts
const sheet = await Assets.load("…/avatars/avatars.json"); // Spritesheet
sheet.textureSource.scaleMode = "nearest";
const s = new Sprite(sheet.textures["kiki/sit/sw/0"]); // anchor comes from the atlas
s.position.set(seatTileCenter.x, seatTileCenter.y);
```

- **Layout:** one row per avatar (`juno`, `pip`, `mo`, `kiki`, top to bottom). Each row has 12 cells, 32×64,
  with no trimming and no rotation. Per pose (`idle`, then `sit`), the order is
  `se/0, se/1, sw/0, sw/1, ne/0, nw/0`. The web never relies on this order; it reads the rects.
- **Frame key:** `<avatarId>/<pose>/<dir>/<n>`, where pose is `idle|sit` and dir is `se|sw|ne|nw`.
  n is `0` (open eyes) or `1` (blink).
- **Back views** (`ne`, `nw`) face away from the camera, toward the TV, and are what seated viewers use.
  Their `/1` key points at the **same rect** as `/0` (no eyes from behind), so the blink ticker needs no special case.
  Seat facing rule: `col < row` → `ne`, otherwise `nw`.
- **`animations`:** `<avatarId>/<pose>/<dir>` → `[…/0, …/1]`. This is **not** a loop. Show `1` for about 120 ms every
  3–6 s, with random jitter per avatar (`meta.omega.blink`).
- **Per-frame `anchor` = floor point** `(0.5, 0.953125)`, i.e. pixel (16, 61). For `idle` it's the feet.
  For `sit` it's the floor under the hips, so you place the sprite at the **seat tile centre**. Seats
  are drawn with their surface 8 px above that point (`meta.omega.seatHeight`).
- **`meta.omega`:** `tile {64×32}`, `cell`, `floorPoint`, `seatHeight`, `poses`, `dirs`, `blink`, and
  `avatars[] {id, label, blurb, colors {main, dark}}` (use `colors.main` for nickname tags and the picker).
- Status: accepted, see `docs/adr/0004-sprite-atlas-format.md`. `meta.format` is informational (PixiJS v8 ignores it); the PNG is indexed PNG-8.

## Room atlas (`room/room.json`, same format)

**Every frame's anchor is the floor point of the cell it belongs to:** the tile centre, `cellCenter(col,row)`
in `apps/web/src/layout.ts`. Place the sprite there, with no per-item offsets.

| Key | Size | Place at | Notes |
|---|---|---|---|
| `floor/0`, `floor/1` | 64×32 | every floor cell | Honey planks. Tiles partition pixels half-open, so they tessellate with no gaps or overlaps. |
| `rug/<c\|ne\|se\|sw\|nw\|n\|e\|s\|w>` | 64×32 | rug cells | 9-slice. Parts name the screen side of the rug rim; edge tiles include the floor planks outside the rug. |
| `wall/l/<plain\|window0\|window1\|sconce>` | 39×233 | `(0,row)` | Stands on the cell's top-left edge. `window0` at row r needs `window1` at r+1. |
| `wall/r/<plain\|poster0\|poster1\|sconce>` | 39×233 | `(col,0)` | Stands on the cell's top-right edge. `poster0` at col c needs `poster1` at c+1. |
| `wall/corner` | | `(0,0)` | Top cap of the back corner. |
| `wall/l/end`, `wall/r/end` | | `(0,9)`, `(9,0)` | Open wall ends at the front. |
| `armchair/<ne\|nw>/back`, `…/front` | 52×36 | seat cell | Faces the TV (sitter seen from behind). Draw `back`, then the seated avatar, then `front`. Seat surface is 8 px above the anchor (`seatHeight`). |
| `armchair/<se\|sw>/back`, `…/front` | 52×44 | seat cell | Faces the camera (sitter's face visible, use `sit/se` / `sit/sw`). Same three-layer draw; `front` is just the near armrest. For seats that face into the room rather than the TV. |
| `tv/0` | 347×253 | `(0,0)` | Corner media console + wall-mounted TV + dithered glow. The screen is painted "off"; `meta.omega.tv.screen` is the iframe rect. |
| `plant/0`, `lamp/0` | | any free cell | Floor props. |

- **Walls** tile as flat 32 px columns, and only their top edge is outlined, so segments butt with no seams. Draw floor → walls → `tv/0`
  as one static background (it never changes, so it can be cached into a single texture).
- **Z order** for everything else: sort by `(floorY, floorX, layer)` with `meta.omega.layers`
  (`back 2`, `avatar 3`, `front 4`).
- **`meta.omega.tv.screen = {x:-160, y:-212, w:320, h:180}`**, relative to the `tv/0` anchor. With the anchor at
  `cellCenter(0,0)` = (480,236), this is exactly today's `TV` rect in `layout.ts`.
- **The console covers the back corner cells** `col+row <= 1` (and the back half of `col+row = 2`). Don't seat or stand anyone there.
- **`meta.omega.layout`** is a suggested default room for the 10×10 floor: `floor[row][col]` keys, `walls.l[row]`,
  `walls.r[col]`, `props[]`. Seats are **not** in it; they stay in `layout.ts`. `preview/room@1x.png` renders exactly this layout
  with the `layout.ts` seats.
- Contract review: [OME-31](/OME/issues/OME-31).

## UI atlas (`ui/`, set c)

The web's chrome is DOM (accessible buttons, inputs, live regions), so set (c) ships two views of the same pixels:
`ui/ui.png` + `ui/ui.json` (same PixiJS v8 format as above, for anything drawn in Pixi) and `ui/slices/<key>.png`
(one file per 9-slice, because CSS `border-image` can't crop a sheet). `ui/reference.css` is generated from the atlas and shows
exactly how to use them; copy the rules you need into `apps/web`. The slice file name is the key with `/` → `-`.

| Key | Size | Slice | Use |
|---|---|---|---|
| `panel/0` | 24×24 | 8 | Wood-framed dusk panel with brass pins: landing form, notices, room-full card. |
| `button/primary/<idle\|hover\|press\|disabled>` | 16×20 | 5 | Mustard key with a 2 px lip. `press` loses the lip, so move the label down 2 art px (the CSS does). |
| `button/secondary/<idle\|hover\|press>` | 16×20 | 5 | Navy variant (Stand up, Leave). Disabled uses the primary `disabled`. |
| `input/<idle\|focus\|invalid>` | 18×18 | 6 | Inset well. The outer ring *is* the focus indicator (mustard) or error (rust). |
| `bubble/0` + `bubble/tail` | 16×16, 14×5 | 6 | Cream chat card. Centre the tail under it; its top 2 rows overlap the card's bottom 2 (anchor `(7,2)`). |
| `tag/0`, `tag/self` | 12×12 | 4 | Name tag; `self` has a mustard rim. |
| `picker/<idle\|hover\|selected>` | 20×20 | 7 | Avatar picker tile (a little dusk window). Put a portrait inside, bottom-aligned. |
| `cursor/<free\|mine\|taken>` | 64×33 | — | Seat cursor on the 2:1 tile, room scale, 2 px band with a plum stroke on both sides. The state reads without colour too: `free` = four corner brackets (cream), `mine` = closed ring (mustard), `taken` = dashed ring (rust). Anchor `(32,16)` = the seat tile's `cellCenter`; draw it under name tags. |
| `icon/<send\|chat\|seat\|leave\|people\|share\|close\|warn\|tv>` | 16×16 | — | Outlined like the avatars. Anchor = centre. |
| `dot/<online\|connecting\|offline>` | 8×8 | — | Connection lamps (teal / mustard / rust). |
| `portrait/<juno\|pip\|mo\|kiki>` | 32×32 | — | Head-and-shoulders crops of `idle/se/0`; one shared eye line. |
| `logo/0` | 80×17 | — | "omega-share" wordmark with extrusion. |

- **Scale:** page chrome draws 1 art px = **2 CSS px** (`--ui-px: 2px`). Inside the room stage (`.ui-room`) it's **1×**, like the room art.
  Keep `image-rendering: pixelated` and integer scales only.
- **9-slices:** Pixi reads `borders` from the frame (`new NineSliceSprite({ texture })`). CSS:
  `border-image: url(slices/panel-0.png) 8 fill / calc(8 * var(--ui-px))`. Every edge and centre is flat colour, so `stretch` is seamless.
- **Name tags** sit bottom-centre at `(floor x, floor y − meta.omega.tagLift[pose])` (`idle 48`, `sit 46`), 2 px over the tallest avatar.
  To hug each head instead, use `meta.omega.tagLiftByAvatar[id][pose]` (2 px over that avatar's own top pixel; Pip's equals `tagLift`).
- **Tokens** (`meta.omega.tokens`, mirrored as `--ui-*` in the CSS) are palette colours for text and flat fills. Text on cream/mustard is
  plum `#2b1d2f`; text on dark chrome is cream `#fff7ea`. Every text/fill pair in the tokens is ≥ 5:1 (WCAG AA).
- System font stays (no webfont bytes). Only the wordmark is lettered.

## Budget

| File | Bytes |
|---|---|
| `avatars/avatars.png` | 4 426 |
| `avatars/avatars.json` | 24 075 raw / 1 492 gz |
| `room/room.png` | 8 947 |
| `room/room.json` | 13 829 raw / 1 192 gz |
| `ui/ui.png` | 3 142 |
| `ui/ui.json` | 14 216 raw / 1 208 gz |
| `ui/slices/*.png` (21 files, palettes trimmed to the colours used) | 3 502 |
| `ui/reference.css` (if ported as-is) | 6 998 raw / 2 015 gz |
| **total shipped art** | **≈ 25.9 KB of 300 KB** (25 924 B) |

"gz" is zlib **level 9** with no file name (what `build.ts` prints; `gzip -9nc <file> | wc -c` agrees within 4 B).
Plain `gzip -c` (level 6 plus the file name in the header) reads about 20–45 B more per file, e.g. 1 227 for `ui.json`, 2 034 for `reference.css`.
