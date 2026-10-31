# omega-share assets

Original art, CC BY-SA 4.0 (`LICENSE`). Style rules: `STYLE.md`.

```
assets/
  avatars/avatars.png   # shipped: 512×256 indexed PNG-8 sprite sheet (set a)
  avatars/avatars.json  # shipped: PixiJS v8 spritesheet atlas
  avatars/motion.png    # set d (M5, lazy-load): 1024×512 indexed PNG-8, walk / breathe / wave / emote icons; set l: walk8 in-betweens
  avatars/expressions.png  # set p (OME-1104, lazy-load): 1024×256 indexed PNG-8, cheer + yawn/doze, 2 frames × pose × dir × avatar
  avatars/expressions.json # set p: PixiJS v8 atlas, motion.json's schema (frames, animations, meta.omega.anims, gestures)
  avatars/watching.png  # OME-1640 (lazy): 512×256 indexed PNG-8, the theatre's seated-from-behind base + laugh + gasp, ne/nw × avatar
  avatars/watching.json # OME-1640: PixiJS v8 atlas, expressions.json's schema (frames, animations, meta.omega.{states, anims})
  avatars/tints.json    # OME-1347: 6 shirt tints per avatar, a runtime PLTE swap table (no extra sheets)
  avatars/hairs.json    # OME-1436: 6 hair colours per avatar, the same PLTE swap (hair slots disjoint from tint slots)
  avatars/motion.json   # set d: PixiJS v8 atlas + meta.omega.anims (frames, per-frame ms, loop)
  room/room.png         # shipped: 512×512 indexed PNG-8 (set b: floor, rug, walls, seats, corner console + projector, props)
  room/room.json        # shipped: PixiJS v8 spritesheet atlas + meta.omega room contract
  ui/ui.png             # shipped: 256×512 indexed PNG-8 (256×256 until set i) (set c: 9-slices, cursor, icons, dots, portraits, wordmark;
                        #   set e: playback keys, seek/volume, chips, system line, catching-up hourglass; M1b: tvframe/* TV frame)
  ui/ui.json            # shipped: PixiJS v8 spritesheet atlas (9-slices carry `borders`)
  ui/slices/*.png       # shipped: each 9-slice / cursor / bubble tail as its own PNG, for CSS border-image
  ui/popup/*.png        # set f: the extension popup's key icon as standalone files, drawn at 16 px (1×) and 32 px (2×)
  ui/popup/kit.css|png  # set o (OME-1041): the popup's own stylesheet + sprite cut; its 9-slices are ui/slices files
  ui/scenes/*.png       # sets i + j (lazy): the "room closed", "invite required", "room not found" and "you were removed" vignettes, standalone 72×64 PNGs;
                        #   set k (lazy): the "chat / room is in its own window" vignettes, 56×40
                        #   OME-1799 (lazy): curtain-pelmet|drape|hem|seam, repeat tiles for the empty TV (see below)
  ui/reactions.png|json # OME-1641 (lazy): 128×128 PNG-8, heart/laugh/wow/clap reaction glyphs (6 frames) + moments-strip minis
  ui/moments.css        # OME-1641 (lazy): moments strip, recap card, lights-down chrome
  ui/edit.png           # set h (lazy, owners only): 256×1024 indexed PNG-8, edit grid, placement markers, handles, tray thumbnails, swatches
  ui/edit.json          # set h: PixiJS v8 atlas for ui/edit.png
  furniture/furniture.png  # set g (M4/M5, lazy-load): 1024×512 indexed PNG-8, furniture catalogue v1
  furniture/furniture.json # set g: PixiJS v8 atlas + meta.omega.pieces (footprint, z-sort point, seats, layers per facing)
  furniture/furniture-v2.png  # catalogue v2 (OME-1103, lazy-load): 512×1024 indexed PNG-8 (512×512 until OME-1424), 7 more pieces + catalogue v3's 6 (OME-1348) + the door (OME-1424)
  furniture/furniture-v2.json # catalogue v2: same atlas schema as furniture.json
  furniture/recolours.json # OME-1462: 2 extra colours for sofa, rug, beanbag, pouf, stool, runner (+ frame, garland; OME-1688: lamps, plants, shelves), a runtime PLTE swap table (no sheet changes)
  furniture/furniture-v4.png  # batch 6 (OME-1437, lazy-load): 256×1024 indexed PNG-8, hammock, stool, bar counter, piano, fireplace + their loops, teleport pad (OME-1546)
  furniture/furniture-v4.json # batch 6: same atlas schema as furniture.json (+ `animations`, `useKey`)
  furniture/furniture-v5.png  # theatre set v2 (OME-1639, lazy-load): 256×1024 indexed PNG-8, raised rows, curtain, big screen, aisle lights, carpet
  furniture/furniture-v5.json # theatre set v2: v4's schema + `seatLiftByColour`
  furniture/furniture-v6.png|json  # Dank Dungeon (OME-1670, lazy): 256×2048 PNG-8, bed, whirlpool, mirror, minibar, desk, washbasin, partition (v4 schema + cutKey)
  avatars/dungeon.png|json  # Dank Dungeon (OME-1670, lazy): 256×512 PNG-8, the bendover / thrust emote poses, 48×64 cells
  themes/halloween/halloween.png|json  # OME-1185 (lazy, only during the theme): 256×128 PNG-8, wall/window decor, bat frames, a witch hat per avatar frame
  themes/{sinterklaas,christmas,valentines,easter}/<id>.png|json  # OME-1187: the same format, one lazy sheet per theme
  accessories/accessories.png|json  # OME-1388 + OME-1530 (lazy): 256×256 PNG-8, eight head accessories, each a hat per avatar frame (theme hat format)
  accessories/bare.png|json         # OME-1409 (lazy): 1024×512 PNG-8, Pip and Mo bare-headed for every avatar frame key (32×64 cells)
  store/                # set j: Chrome Web Store kit (extension icons 16/32/48/128, 440×280 promo tile, two 1280×800 screenshots)
  site/                 # set m (M9): the website's favicon.ico + PNGs, apple-touch 180, manifest 192/512 + maskable 512, og-card.png 1200×630,
                        #   how-1-find / how-2-share / how-3-watch.png landing panels (368×224 each)
  ui/reference.css      # design spec for the DOM chrome (generated); apps/web ports what it needs
  preview/              # not shipped: sheets, avatar scene, room@1x/@2x, ui.html + ui-*.png screenshots (ui-playback*.png = set e, ui-tv.png = M1b TV frame, ui-owner*.png = set h, ui-rooms*@1x/@2x.png = set i, ui-house*/ui-queue/ui-setj-states@1x/@2x.png = set j), m7.html + ui-m7-*@1x/@2x.png (set k, M7 layouts), store.html (set j store kit source),
                        #   owner-edit@1x/@2x.png (set h edit mode in the room),
                        #   walk-/breathe-/emote-strip@4x.png, motion-scene@1x.png (frame strip) + .apng (animated),
                        #   m8.html + ui-m8-*@1x/@2x.png (set l), walk8-strip@4x.png + walk-tiers@2x.apng (set l, Basic vs Smooth walk),
                        #   m9.html + ui-m9-*@1x/@2x.png (set m: icons, share card crops, the panels on light and dark pages)
                        #   ui-sheet@4x.png is ui/ui.png at 4×, so it is 1024×2048 on purpose: the sheet's height is a power of two with headroom
                        #   for later sets, and about 40% of it is still empty (the wall-colour band at the bottom). Not a packing bug.
  src/                  # generator (Bun, no deps) + mood boards
```

Rebuild everything (deterministic): `bun assets/src/build.ts`. It prints the byte budget.
Re-shoot the UI previews after a build: `bun assets/src/shoot-ui.ts` (uses the repo's Playwright + Chromium); the M7 mock-ups: `bun assets/src/shoot-m7.ts`.
- Avatars are role-letter templates in `src/avatars.ts`. Room pieces in `src/room.ts` are ray-cast from
  3D boxes by `src/iso.ts`, so every edge sits on the exact 2:1 grid. Palette ramps are in `src/palette.ts`.
- The build fails if an avatar touches its cell border, if a frame id repeats across sets (Pixi caches textures by key), or if a
  9-slice would stretch anything but flat colour (a corner poking past its slice).

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

## Shirt tints (`avatars/tints.json`, OME-1347)

Each avatar has 6 shirt/accent tints; tint 0 is the shipped look. A tint swaps the avatar's swatch ramp (Juno's hoodie,
Pip's jumper + beanie band + pom-pom, Mo's bomber, Kiki's pinafore) for another ramp. Skin, hair, trousers, shoes and
props never change. No new frames, no new sheet bytes.

| avatar | 0 (shipped) | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| `juno` | mustard | teal | lilac | olive | ice | denim |
| `pip` | teal | lilac | lemon | ice | denim | berry |
| `mo` | rust | mustard | teal | lilac | ice | berry |
| `kiki` | lilac | rust | lemon | ice | berry | denim |

- **Tint-only ramps (OME-1360).** `denim`, `ice`, `lemon` and `berry` (`TINT_RAMPS` in `src/tints.ts`) exist only in
  `tints.json`, never in `PALETTE`, so the shipped sheets keep their PLTE. They were needed because no 6-ramp pick from
  the shared palette stays apart under colour-blind vision: under deutan/protan the palette collapses to lightness plus
  a blue–yellow axis, where rust/ginger/mustard/olive merge, as do lilac/teal/navy. Denim replaces navy (2.0:1 on the
  dark bg) and berry replaces velvet (2.4:1).

- **Runtime palette swap, not a bake.** Baking 5 more copies of `avatars.png` + `motion.png` + `expressions.png` would add
  about 170 KB (5 × 34 KB) against the 300 KB art budget. The swap costs 0 bytes: the three sheets share one PLTE, and the
  avatar's swatch ramp sits at 3 fixed PLTE entries (`slots`, highlight/base/shade).
- **How (client):** for an (avatar, tint ≠ 0) in the room, copy the sheet's PNG bytes, overwrite PLTE entry `slots[t]`
  with `tints[n].colors[t]` (3 bytes each at PLTE data offset `3 × slot`), recompute that chunk's CRC-32, decode, and
  use the texture **only for that avatar's frames** (the same ramp may mean a different part on another avatar, e.g.
  mustard is Kiki's popcorn). CPU: a 3-entry byte patch + one image decode per (avatar, tint) pair, done once, nothing per frame.
  Memory: each pair is one more texture; crop to the avatar's rows if that matters (each avatar owns its own row band:
  1 row of 64 px in `avatars.png` and `expressions.png`, 2 rows in `motion.png`; the `emote/*` icons share Juno's second motion row, so always draw them from the untinted sheet).
- `tints.json`: `{ sheets, avatars: { <id>: { slots: [hi, base, shade], tints: [{ id, colors: [hi, base, shade] }] × 6 } } }`.
- **Checks** (`src/tints.test.ts`): the swatch ramp sits only on shirt roles; no tint reuses a ramp the avatar already wears;
  within an avatar, tints are ΔE ≥ 20 apart with normal vision and with simulated deuteranopia and protanopia
  (Machado 2009, severity 1; lowest pair 23.4) and ≥ 20 from skin and hair; each tint has ≥ 3:1 contrast (lowest: denim 3.33)
  and ΔE ≥ 25 against the dark site bg (`#1d1a2b`, and `#1c1a2e`), and ΔE ≥ 25 against the light floor; Pip never gets
  both olive and mustard; `slots` hold the tint-0 colours in all three shipped sheets.
- Contact sheet: `preview/tints-sheet@1x.png` / `@2x.png` (rows = avatars, columns = tints, each cell idle SE + walk SW).
  Panels top to bottom: light floor, dark site bg, then the floor panel as seen with deuteranopia and with protanopia.

## Hair colours (`avatars/hairs.json`, OME-1436)

Each avatar has 6 hair colours; hair 0 is the shipped look. Same technique as the shirt tints: a runtime PLTE swap of the
avatar's hair ramp (3 entries), no new frames. Skin, shirt tint, trousers, shoes, props and accessory colours never change.

| avatar | hair slots (hi, base, shade) | 0 (shipped) | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|---|
| `juno` | `hairDark` | dark brown | ginger | blonde | silver | cherry | sky |
| `pip` | `hairGinger` | ginger | dark brown | chestnut | silver | mint | violet |
| `mo` (+ beard) | `hairDark` | dark brown | ginger | blonde | silver | sky | violet |
| `kiki` | `hairPink` | pink | dark brown | ginger | chestnut | sky | violet |

- **Hair-only slots.** Kiki's hair used to share `pink` with her shoes and popcorn stripes, and Pip's `ginger` is also the
  Halloween witch hat band, so a slot swap would have recoloured those. Their hair now uses `hairPink` / `hairGinger`
  (`src/palette.ts`): the same colours one blue step off (invisible), appended at the end of `PALETTE` so every older index
  stays put. Cost: +6 PLTE entries in every sheet, +349 B across all shipped PNGs (309 B in the art sheets + 40 B in `site/`). Hair-only colours (blonde, chestnut,
  silver, cherry, sky, mint, violet; `HAIR_RAMPS` in `src/hairs.ts`) live only in `hairs.json`.
- **Order with tints: none needed.** Hair slots and tint slots are disjoint PLTE entries for every avatar (checked), so
  patch both into the same sheet copy in either order: one copy per (avatar, tint, hair) in use. The colours are written,
  not indexes, so a hair colour equal to some tint colour can't cascade.
- **Which sheets:** `sheets` (`avatars.png`, `motion.png`, `expressions.png`, `accessories/bare.png`: Pip's and Mo's bare
  heads use the same hair slots) and also `overlays` (`accessories/accessories.png`, every `themes/<id>/<id>.png`): a hat
  overlay redraws the hair around the hat in the avatar's hair slots, so swap it for that avatar's hat frames too, or a
  dyed avatar wears a ring of its old hair under a hat. Safe because no hat colour uses a hair ramp (checked). Paths are
  relative to `avatars/`. As with tints, draw `emote/*` from the unswapped sheet.
- `hairs.json`: `{ sheets, overlays, avatars: { <id>: { slots: [hi, base, shade], hairs: [{ id, colors: [hi, base, shade] }] × 6 } } }`,
  767 B gz.
- **Checks** (`src/hairs.test.ts`): the hair ramp sits only on hair roles (`H`, `q`, Mo's beard `b`) and on no tint slot; a
  hair swap changes only hair pixels on front, back and bare-head frames; for all 36 hair × tint pairs, tint-then-hair and
  hair-then-tint give the same pixels; within an avatar the hair colours are ΔE ≥ 20 apart with normal vision and with
  simulated deuteranopia and protanopia, ≥ 20 from its skin and ≥ 20 from every one of its 6 tints; no hat role uses a hair
  colour; `slots` hold the hair-0 colours in every listed sheet.
- Contact sheet: `preview/hairs-sheet@1x.png` / `@2x.png`. Rows = avatars, columns = hair 0–5; each cell is idle SE, idle
  NW (back of the head) and the bare head (Pip, Mo) or sitting SW (Juno, Kiki). Last row mixes hair × tint: avatar `k % 4`,
  hair `k`, tint `5 − k`. Panels: light floor, dark site bg.

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
| `tv/0` | 162×62 | `(0,0)` | Corner media console with a little retro projector (lit lens, two film reels), a succulent and a tape stack. Since M1b the live screen is page chrome above the stage (ADR 0012, see *M1b TV frame* below), so there's no TV on the wall. |
| `plant/0`, `lamp/0` | | any free cell | Floor props. |

- **Walls** tile as flat 32 px columns, and only their top edge is outlined, so segments butt with no seams. Draw floor → walls → `tv/0`
  as one static background (it never changes, so it can be cached into a single texture).
- **Z order** for everything else: sort by `(floorY, floorX, layer)` with `meta.omega.layers`
  (`back 2`, `avatar 3`, `front 4`).
- **`meta.omega.tv.screen = {x:-12, y:-13, w:16, h:9}`**, relative to the `tv/0` anchor: the 16:9 bounding box of the projector's
  lit lens (teal inner ring, glow glass, a 3 px white glint top-left so it reads as a lens at 1×). It's decorative. Never put the iframe there: the player is page chrome (ADR 0012).
- **The console covers the back corner cells** `col+row <= 1` (and the back half of `col+row = 2`). Don't seat or stand anyone there.
- **`meta.omega.layout`** is a suggested default room for the 10×10 floor: `floor[row][col]` keys, `walls.l[row]`,
  `walls.r[col]`, `props[]`. Seats are **not** in it; they stay in `layout.ts`. `preview/room@1x.png` renders exactly this layout
  with the `layout.ts` seats, plus two preview-only camera-facing chairs (`armchair/sw` at (1,8), `armchair/se` at (8,1)) so the `se`/`sw` sprites are checked in context.
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

## Playback chrome (set e, M1b synced controls)

Same files as set (c): the frames are in `ui/ui.png` / `ui/ui.json`, the 9-slices in `ui/slices/`, and the rules are at the end of
`ui/reference.css`. Previews: `preview/ui-playback.png` (in the room) and `preview/ui-playback-states.png` (every state at 2× and 1×).

**The one rule: the material says who a control affects.** Shared (everyone) = the TV's **wood + brass**, inside a wood `panel/0`,
labelled by `chip/shared` + `glyph/everyone`. Personal (only you) = **night blue in the mustard "you" rim** (the rim `tag/self` uses),
inside its own `panel/self` pod, labelled by `chip/self` + `glyph/you`. Never put a personal control in the wood panel or the other way round.
The TV's cool **glow** marks what the video says: seek progress and chat system lines.

| Key | Size | Slice | Use |
|---|---|---|---|
| `button/shared/<idle\|hover\|press>` | 16×20 | 5 | Wood key for play/pause. Same lip/press rules as `button/primary`. Disabled uses `button/primary/disabled`. |
| `button/self/<idle\|hover\|press>` | 16×20 | 5 | Night key in a mustard rim, for mute. Disabled uses `button/primary/disabled`. |
| `icon/<play\|pause\|sound\|muted>` | 16×16 | — | Key icons, flat in the highlight tone (no shade edge) so they stay crisp on the keys at 1×. `icon/<name>-off` are the disabled versions (cream shade + charcoal); the CSS swaps them on `:disabled`. |
| `icon/you` | 16×16 | — | Headphones: the "only you" mark at icon size. |
| `seek/track`, `seek/track-disabled` | 12×10 | 4 | Sunken night groove (charcoal when disabled). Fixed height 10. |
| `seek/fill` | 4×6 | 1 top/bottom | Glow progress, drawn inside the track from its content box's left edge (see CSS `.ui-seek-fill`). |
| `seek/head/<idle\|hover\|press\|disabled>` | 10×16 | — | Wood grip, brass cap. Anchor `(5,8)` = centre on the fill end. Hover = cream cap; press sits 1 px lower. |
| `volume/track` | 10×8 | 4 | Thinner groove (fixed height 8, no stretchable rows). |
| `volume/fill` | 4×4 | 1 top/bottom | Mustard fill. Hide it when muted. |
| `volume/knob/<idle\|hover\|press\|disabled>` | 10×10 | — | Round mustard bead. Anchor = centre. Round vs the seek's tall grip, so the two sliders never read alike. |
| `readout/0` | 10×10 | 4 | Time well: cream tabular digits, `12:30` / `1:02:45`. |
| `panel/self` | 16×16 | 6 | The personal pod (mustard rim between plum lines, night fill). |
| `chip/shared`, `chip/self` | 12×12 | 4 | "EVERYONE" / "ONLY YOU" labels. Always with their glyph, so it's not colour alone. |
| `chat/system` | 14×12 | 4 (left 5) | System line: dark strip with a glow bar down the left. No tail. |
| `glyph/<play\|pause\|seek\|catchup\|everyone\|you>` | 8×8 (`everyone` 12×8) | — | One-line glyphs for system lines and chips. |
| `catchup/<0..3>` | 16×16 | — | Hourglass sticker: sand on top, running, below, then the glass lying on its side mid-turn (sand slumped into the left bulb). Loops at `meta.omega.catchupFrameMs` (320 ms). Anchor `(8,15)`. |

- **Shared transport** (`.ui-panel > .ui-transport`): `chip/shared` · play/pause key · `readout` (current) · seek · `readout` (duration).
  The head of the panel also says who acted last ("last: **Ana** paused"), which repeats that the controls are shared. Give the group
  `aria-label="Shared playback: affects everyone"`, and label the key "Play for everyone" / "Pause for everyone".
- **Seek / volume:** the art is decoration. Set `--pos` / `--vol` (0..1) on the track and lay a transparent `<input type="range">` over it
  for keyboard and screen readers. Pixi: `NineSliceSprite` for the track and fill, a sprite for the head at `(fillEnd, trackCentreY)`.
- **Personal volume** (`.ui-volume`): `chip/self` · mute key (`icon/sound` ↔ `icon/muted`) · volume track. `aria-label="Your volume: only you hear this"`.
- **Chat system line** (`.ui-sysline`): glyph + **actor** (glow, bold) + verb + `<time>` in cream. User chat stays in cream bubbles over the
  avatar, so the two can't be confused (dark strip + glow bar + glyph vs cream card + tail). Recommended home: a caption rail at the stage's
  bottom-left, room scale, newest at the bottom, at most 3 lines, each fades after about 6 s; mirror it in an `aria-live="polite"` region.
- **Catching up:** put `.ui-sprite.ui-catchup` inside that user's name tag and add `.catching` to the tag. The hourglass hangs off the tag's left
  end (overlapping it by 3 art px), and the name goes lilac italic. Everyone else keeps playing: nothing else in the room changes.
  For yourself, show a `panel/0` notice with the same hourglass ("You're catching up: the room kept playing…"). `prefers-reduced-motion`
  holds frame 0.
- **Scale:** everything follows `--ui-px`: 2× below the stage, 1× inside `.ui-room`. Text sizes: readout 13 px / 11 px, chips 11 px / 9 px.
  Sprites in `reference.css` now scale with `--ui-px` too (they were fixed 2× before; values at 2× are unchanged).

## M1b TV frame (OME-92, `ui/`)

Since ADR 0012 the YouTube player and its control bar are **unscaled page boxes above the stage**. `roomLayout(width)` in
`apps/web/src/layout.ts` places them: a 16:9 player between 356×200 and 560×315 at `tv.y = 6`, then an 8 px gap, a 44 px control bar
(same x and width), another 8 px gap, and the stage. Two 9-slices dress those boxes in the room's wood **without moving or resizing them**:

| Key | Size | Slice (t r b l) | Put it on | Notes |
|---|---|---|---|---|
| `tvframe/bezel` | 14×16 | 6 6 8 6 | the player box | Charcoal lip, wood (highlight top/left, shade bottom/right), plum outline, cream corner glint top-left, brass knob bottom-left and glow power light bottom-right (all inside the corner slices, so they never stretch). Centre transparent. |
| `tvframe/shelf` | 78×51 | 1 38 6 38 | the control bar box | Media shelf: the bar box *is* its sunken night transport slot. Speaker cabinets (woofer ring on a dot mesh) either side, rail under it. **Fixed height 44**: only the slot stretches, sideways. |

- **CSS** (`ui/reference.css`, end): `.ui-tv-frame` on the player box and `.ui-tv-shelf` on the control bar. Both use `border-image-outset`,
  so the art is painted *outside* each box as ink overflow: no layout change, no scrollbars, and **nothing is ever drawn over the player**.
  Plain CSS px (1 art px = 1 CSS px, like `roomLayout`), not `--ui-px`.
- **It fits the gaps exactly:** the bezel needs 6 px above the player (`tv.y` is 6) and fills the 8 px gap below it. The shelf's top outline shares
  the bezel's last row: the bezel's 8 px bottom outset and the shelf's 1 px top outset overlap by exactly 1 px, and both paint the plum
  outline there, so the overlap is harmless (whichever box paints last wins, same colour). Its lip, rail and outline take 6 of the 8 px above the stage. Speakers take 38 px each side of the bar.
- **Slot contents:** one row of `.ui-transport` straight in the bar, no `.ui-panel` (the shelf is the panel): `chip/shared` · play/pause key
  · readout · seek · readout. The 28 px key leaves 8 px above and below it. Personal volume stays elsewhere in page chrome: it's "only you",
  so it never goes on the shared TV.
- **Narrow containers:** add `.compact` to the shelf when `container width < bar width + 76 px` (76 = the two 38 px speaker outsets; the
  speakers are dropped, the rails stay). Add it to the bezel on a 360 px viewport, where the 356 px player leaves 2 px a side (only the top and bottom bars stay). The art is ink
  overflow, so without `.compact` it's clipped at the viewport edge, never scrolled.
- Preview: `preview/ui-tv.png`, the page at a 960 px container (560×315 player) and at a 360 px viewport (356×200, `.compact`).
  `preview/tv-video@1x.png` is the stand-in video frame it uses.

## M2 live chrome (OME-120, `ui/`)

Additions to set (e) for M2's providers. They're in the same files (`ui/ui.png` / `ui.json`, `ui/slices/`, the end of `ui/reference.css`) and
follow the same rule: **wood = shared**. Two new materials each have one job: **rust = on air** (a status light, never a control) and
**brass = the TV's nameplate** (what kind of source is on). Previews: `preview/ui-live.png` (in the TV shelf at 560 px and 356 px) and
`preview/ui-live-states.png` (every piece at 2× and 1×).

| Key | Size | Slice | Use |
|---|---|---|---|
| `pill/live` | 12×12 | 4 | LIVE pill at the live edge: bright rust rim, dark rust fill, cream text (7.5:1). A status, not a button. |
| `pill/behind` | 12×12 | 4 | Same pill with the light off (paused live, or behind the edge): dim rust rim, charcoal fill, lilac text. |
| `glyph/onair/<0\|1>` | 8×8 | — | On-air lamp inside the pill: cream ↔ rust blink, loops at `meta.omega.onairFrameMs` (700 ms). |
| `glyph/onair-off` | 8×8 | — | Lamp out: charcoal ring. Used in `pill/behind`. |
| `icon/tolive`, `icon/tolive-off` | 16×16 | — | Back-to-live key icon (play's 2:1 stair running into a bar). Goes on a `button/shared` key: it moves everyone. |
| `chip/hint` | 12×12 | 4 | Seek-only hint: charcoal on charcoal, the quietest chip. With `glyph/hop`. |
| `glyph/hop` | 8×8 | — | Glow staircase: "keeps in sync in steps", not a smooth ramp. Also the system-line glyph for a resync jump. |
| `resync/<0..2>` | 16×16 | — | One-shot tag sticker: a glow double chevron slides right and lands (`meta.omega.resyncFrameMs` = 160, 200, 640 ms). Anchor `(8,8)`. |
| `plate/source` | 12×12 | 4 | Brass provider plate with four corner rivets. Plum system-font text (8:1). |
| `glyph/src-<video\|live>` | 8×8 | — | Glyphs engraved in the plate: a screen with a play mark (on-demand) and a plain broadcast dot (live), the on-air lamp cut into brass. Generic kinds of source, not provider marks. |

- **Live transport** (`.ui-tv-shelf > .ui-transport`, the same slot as set (e)): `chip/shared` · play/pause key · `.ui-live` pill ·
  `.ui-live-note` (one muted line where the scrubber was, e.g. "Live: everyone watches the same moment") · `.ui-readout.behind` ("−0:42",
  hidden at the edge) · back-to-live key · `.ui-plate`. There's **no seek** in live mode, so don't render `.ui-seek` at all (a disabled
  scrubber would suggest it could come back).
  - **At the live edge:** `.ui-live` (lamp blinking), readout hidden, back-to-live `disabled`.
  - **Paused live / behind:** `.ui-live.is-behind` (lamp out), the readout shows the gap, back-to-live enabled. Label it
    "Back to live for everyone"; the play key keeps "Play for everyone" (it resumes from the paused point).
- **Seek-only hint:** for a provider that can't nudge its playback rate, drift is fixed with small jumps. Add
  `<span class="ui-hint" title="…"><span class="ui-sprite ui-glyph-hop"></span><span class="ui-hint-text">syncs by skipping</span></span>`
  just before the plate. It's static and never animates. At 1× (`.ui-room`) it's **glyph-only by default**: the words are visually
  hidden but kept for screen readers, and the `title` spells them out. Add `.wordy` to show them anyway.
  **Wiring:** always render `.ui-hint-text` with the full words (don't drop it at 1×; the CSS hides it visually, and `display: none`
  would hide it from screen readers too). Set the chip's `title` to the longer sentence, e.g. "This source can't change speed, so it
  keeps in sync with small jumps." Don't add an `aria-label` to the chip, because it would replace the text screen readers already read.
  Keep `glyph/hop` decorative (`aria-hidden="true"` on the sprite span). The chip isn't focusable, so the `title` is for mouse users only. When a viewer is jumped back into sync, add `.resynced` to their tag
  with a `.ui-sprite.ui-resync` inside (left of the tag, clear of the name: the CSS moves it 1 art px left and its art keeps 1 empty column, so the visible gap is 2 art px, 4 screen px at 2×) and remove it after 1 s, optionally with a system line
  (`glyph/hop` · "**Oli** skipped ahead to stay in sync"). Buffering and ads still use the set (e) hourglass.
- **Provider plate:** `<span class="ui-plate"><span class="ui-sprite ui-glyph-src-live"></span><span class="ui-plate-name">Twitch</span></span>`.
  The name is **plain text in the system font, in plum on brass**: never a provider's logo, colour or lettering, and never an image of a name.
  Pick the glyph by content kind, not provider (`src-live` for a live stream, `src-video` for anything on demand, including a Twitch VOD).
  It ends every transport, VOD or live, so the TV always says what's on.
- **`.compact` shelf** (360 px viewport): the note and the plate/hint words drop (`.ui-plate-name`, `.ui-hint-text`), and the lamp, pill,
  glyphs and keys stay. Keep the full name in the plate's `title`/`aria-label`.
- **Motion:** `prefers-reduced-motion` holds `glyph/onair/0` and shows `resync/2` straight away.
- **Blink cost (OME-201):** the lamp blinks by `opacity` only (`glyph/onair/1` on a `::after` layer over `/0`), so Chromium runs it on
  the compositor and a live room does no per-frame style work. When porting, keep `.ui-onair` `position: relative` and never animate its
  `background-position`. The catching-up hourglass (`.ui-catchup`, 4 frames) still steps `background-position`: it only shows while
  someone is behind, and 4 frames don't fit on the 2 pseudo-elements.
- **Scale:** these pieces follow `--ui-px` like set (e). The shelf is `.ui-room` (1×). Text is 11 px at 2× and 9 px at 1×, except the plate name (10 px at 1×); the note is 12 px / 11 px.

## Set (f) safety states (OME-193, `ui/`)

M3's limits, drawn as "wait a moment" and never as an alarm: **no rust and no warn icon anywhere in this set** (rust means on air or
a real error). They use the same files as sets (c)/(e) (`ui/ui.png` / `ui.json`, `ui/slices/`, the end of `ui/reference.css`) plus
two standalone popup PNGs. Previews: `preview/ui-safety.png` (in context: shelf, system lines, popup 1×/2×, notices, room list) and
`preview/ui-safety-states.png` (every piece at 2× and 1×). **Each motif has one job:** snail = too fast · round arrow = try your share again · timer dial = how long to wait ·
mustard bar = only you see this · plug = the network dropped · mug = the room paused you · shut door with a hanger = the room is full.
OME-200 polish: the snail, the 16 px arrow and the dial were redrawn for 1×, and the server-close icon is a mug now, so the snail means one thing only.

| Key | Size | Slice | Use |
|---|---|---|---|
| `button/shared/cool` | 16×20 | 5 | A rate-limited shared key resting: still wood (it's still everyone's key), a ramp step darker, charcoal lip. Not `disabled` (charcoal all over). |
| `wait/<0..7>` | 16×16 | — | Timer dial. `0` is full; each frame spends one more eighth, clockwise from 12 o'clock (a filled cream wedge on plum, so every frame drops a whole slice and the middle ones read apart at 1×). One-shot over the server's retry-after: frame = `floor(elapsed / total × 8)`. Anchor = centre. |
| `glyph/snail` | 12×8 | — | "Take it slow": the slow-down chip and rate-limit system lines, nothing else. Heading right: round mustard shell with one plum curl, cream foot, raised head on a bold eye stalk. |
| `chat/system-self` | 14×12 | 4 (left 5) | System line only you see: set (e)'s strip with a **mustard** bar instead of the glow bar. |
| `glyph/retry` | 8×8 | — | Round mustard arrow, for "your share didn't go through". |
| `icon/retry`, `icon/retry-2x` | 16×16, 32×32 | — | One bold round arrow, clockwise, with a wide gap at the top right and nothing inside (a clock face there read as a target at 1×): "try again". The 32 px one is drawn, not upscaled. Also shipped as `ui/popup/retry-16.png` / `retry-32.png`. |
| `icon/unplugged` | 16×16 | — | Normal disconnect: a mustard plug pulled out of its cream socket (prongs line up with the holes). |
| `glyph/dots/<0..2>` | 12×8 | — | "Reconnecting" loader: one dot lifted in turn, `meta.omega.dotsFrameMs` (240 ms), loop. |
| `icon/resting` | 16×16 | — | Closed by the server (flood/policy): a cream mug with the paused lamp's two plum bars on it and steam: "take a breather". Still, never animated. |
| `dot/paused` | 8×8 | — | Top-bar lamp for "paused by the room": a pale lamp with two plum pause bars (a shape, so it isn't colour alone next to the plain `dot/*` discs). |
| `card/room/<idle\|hover\|full>` | 16×16 | 6 | Room-list card: dusk glass in a wood rim (hover = cream lit edge). `full` = shade rim, charcoal glass. |
| `door/<open\|full>` | 16×24 | — | Card thumbnail, anchor bottom centre `(8,24)`. `open`: lamplight in the doorway and on the floor. `full`: door shut, a cream hanger on the knob with three little heads. |
| `pill/full` | 12×12 | 4 | Calm "Full" pill: charcoal, cream rim, cream text (≥ 5:1). |

- **1 · Slow down** (`.ui-button.shared.is-cooling`): swap the key's icon for `<span class="ui-sprite ui-wait" style="--cool: 3s">`,
  and the CSS drains the dial once over `--cool`. Use `aria-disabled="true"`, not `disabled`, so the key keeps focus. Relabel it
  ("Pause for everyone: available again in 3 seconds"), and drop `.is-cooling` when the dial is empty. Next to it, put a `.ui-chip.self`
  with `glyph/snail` + "Slow down". It's in the "only you" rim because only you are slowed. Optionally, show a self line: `glyph/snail` · "**Easy!** You can skip again in `<time>3 s</time>`".
- **2 · Share retry.** Room: `.ui-sysline.self` · `glyph/retry` · "**Your share** didn't go through. Try again in `<time>12 s</time>`". Recount the
  `<time>` each second and drop the line when it reaches 0. Popup (plain HTML): `<img src="retry-16.png" srcset="retry-16.png 1x, retry-32.png 2x" width="16" height="16" alt="">`
  before the status text. The icon has a plum outline, so it holds on the popup's white as well as on dark chrome.
- **Popup states (OME-842, after the set).** The popup's three empty/error lines each get a 48×40 vignette above them, as standalone files
  in `ui/popup/` (1× plus an exact nearest 2×, so use `srcset="<name>.png 1x, <name>@2x.png 2x"`, `width="48" height="40"`, `alt=""`, with
  `image-rendering: pixelated`). The line beside it carries the meaning. Transparent ground and every piece in its own plum outline, so
  they sit on the popup's white. Generator: `src/popup.ts`. Mock-up: `preview/popup-states.html`, shot to `preview/ui-popup-states@1x|2x.png` by
  `bun assets/src/shoot-popup-states.ts`.

  | File | Size | Bytes (1× + 2×) | Shows | For |
  |---|---|---|---|---|
  | `ui/popup/nothing-found(@2x).png` | 48×40 | 377 + 464 | A small browser page with a dashed charcoal ghost where a video would be, and the brass magnifier that looked | "No supported video found on this page." |
  | `ui/popup/cant-read(@2x).png` | 48×40 | 311 + 372 | A greyed window (wider, dim lines) behind a brass padlock with a cream shackle: the browser keeps this tab to itself | "Can't read this tab. Open a regular web page and try again." |
  | `ui/popup/server-away(@2x).png` | 48×40 | 349 + 441 | The wood TV (the product mark), screen dark, its cord's big plug (brass prongs) held 3 px clear of the wall socket | Server unreachable |
  | **total** | | **2 314 B** of the 3 KB cap (the build throws over it) | | |

  They ship in the extension, not the site; the build counts them with `ui/popup/*.png` in the art total (130 263 → 132 577 B of 307 200).
- **3 · Connection.** They differ in lamp, icon, motion and action:
  - **Normal drop:** `dot/connecting` + "Reconnecting" + `.ui-dots`, and a `panel/0` notice with `icon/unplugged` ("Connection dropped.
    Reconnecting by itself…"). There's **no button**: it retries by itself.
  - **Closed by the server:** `dot/paused` + "Paused by the room", and a `panel/0` notice with `icon/resting` ("The room paused your
    connection: lots of messages at once.") plus a primary **Rejoin** key. Until the delay is over it's `.ui-button.is-waiting` with `aria-disabled="true"` ("Rejoin in 20 s"): the charcoal
    disabled face with full cream text (9:1), because the countdown is meant to be read. Nothing moves.
- **4 · Room full** (ADR 0006, the 26th member): `.ui-card.is-full` with `door/full`, the count "25 / 25" and a `.ui-pill-full`. Render the card as a
  `div` with `aria-disabled="true"`, not a link. Open rooms are `a.ui-card` with `door/open` (hover/focus = the cream edge).
- **Motion:** `prefers-reduced-motion` stops the dots and shows `wait/0` (the countdown text still carries the time).
- **Scale:** follows `--ui-px` like the other sets (2× page chrome, 1× in `.ui-room`, e.g. on the TV shelf). No new colours: still the 67.

## Set (h) owner edit mode, furniture tray, private rooms (OME-276, `ui/`)

Chrome for M4 room ownership and M5 customization. The page chrome (toggle, tray, tabs, cubbies, tickets, pills, icons, the private door) joins
sets (c)/(e)/(f) in `ui/ui.png` / `ui.json`, `ui/slices/` and the end of `ui/reference.css`. **The owner's edit kit is a separate lazy atlas,
`ui/edit.png` + `ui/edit.json`:** the grid, placement markers, handles, tray thumbnails and swatches. Load it when an owner presses "Edit room".
Guests never fetch it. Previews: `preview/owner-edit@1x.png` / `@2x` (edit mode in the room, Pixi scale), `preview/ui-owner.png` (in context),
`preview/ui-owner-tray.png` (the whole catalogue in the tray at 2× and 1×) and `preview/ui-owner-states.png` (every piece and state, create room,
invites, room list). **Each motif has one job:** mustard rim on night = only you (the owner) see or do this · wood = the room's furniture ·
closed teal ring + dots = fits · dashed rust ring + hatching = can't go there · ticket = invite link · key = invite only · little house = the host.

**Room scale (Pixi, 1×, `ui/edit.json`).** All anchors follow the furniture rule (the anchor cell's floor point, `cellCenter(col, row)`):

| Key | Size | Anchor | Use |
|---|---|---|---|
| `edit/grid` | 64×32 | (32, 16) | One floor cell's share of the edit grid. Draw it at **every** floor cell centre, on the floor layer, over rugs and under walls, the console and objects. Each pixel belongs to one cell, so neighbours never overdraw. Together they make a dashed 3 px groove (7 on, 1 off): cream then cream shade on the top edges, plum on the lower ones, lit like everything else. The 2 px lit edge keeps it readable at 1× over the starry carpet and the parquet. |
| `place/<ok\|no\|sel>/<C>x<R>` | 64×33 … 160×81 | (32·R, 16) | Footprint marker on the floor layer under the piece, anchored like the piece. `C×R` = `footprintByDir[dir]` (1x1, 2x1, 1x2, 3x2, 2x3). `ok` = closed teal ring + a dot field (fits). `no` = dashed rust ring + hatching (blocked: occupied, off the floor, in the console's `col + row <= 2` corner). `sel` = closed mustard ring (the placed piece you picked). State is shape first, so it never relies on colour alone. |
| `place/<ok\|no>/wall-<se\|sw>` | 37×55 | same as `furniture/frame/*/<dir>/back` | Wall-slot marker for a print: a ring 2 px outside the print's silhouette, so it follows the wall's slant. Draw it with the walls, before the wall layer. |
| `handle/<rotate\|remove>/<idle\|hover>` | 20×20 | centre | Round night handles in the mustard rim (hover = cream rim), floating over the picked piece. Suggested spot: 52 px above its anchor, 14 px either side. `rotate` = a quarter-turn arrow over a floor diamond (next facing in `dirs`). `remove` = arrow into an open box: "pack it back in the tray" (not a bin; nothing is lost). Hit area = the whole 20 px disc. |

- **The held piece** (picked from the tray or being moved) draws at **alpha 0.75** over its marker, depth-sorted like a placed piece. The PNG preview
  shows it dithered, because the indexed preview has no alpha.
- **Order on the floor layer:** floor tiles → rugs → `edit/grid` → `place/*` → (walls, console, wall markers, prints) → objects → handles.
- Only the owner sees any of this. Guests see the room as usual while the owner edits.

**Page chrome (DOM, 2× page / 1× in `.ui-room`, `ui/ui.png` + slices):**

| Key | Size | Slice | Use |
|---|---|---|---|
| `button/self/on` | 16×20 | 5 | The "Edit room" key latched on (`.ui-button.self[aria-pressed="true"]`): a filled mustard face, pressed (no lip), plum label "Done". Idle/hover are set (e)'s `button/self/*` with `icon/arrange`. |
| `tray/0` | 24×24 | 10 | Furniture tray: a planked wooden drawer with a sunken night well (`.ui-tray`, under the stage). |
| `tab/<idle\|hover\|on>` | 16×14 | 5 5 4 5 | Tray tabs (`.ui-tabs > .ui-tab[role=tab]`). `on` (`aria-selected="true"`) is the lit wood face whose bottom runs into the tray rim (1 art px overlap, already in the CSS). Tabs: Seats `glyph/tab-seats`, Decor `glyph/tab-decor`, Floor & wall `glyph/tab-floor`. |
| `slot/<idle\|hover\|held\|off>` | 16×16 | 6 | Cubby, one per piece (`.ui-slot`): dusk glass in a wood rim. hover/focus = cream edge, `held` (`aria-pressed="true"`) = mustard double rim (it's in your hand), `off` (`aria-disabled="true"`) = charcoal glass (the room has `MAX_FURNITURE` pieces). |
| `thumb/<id>/<colour>` *(edit.png)* | ≤ 44×40 | — | Tray thumbnail for every catalogue piece and colour (29: 17 for v1, 12 for v2). The catalogue model re-cast at ≤ ½ scale (same light, tones, outline), not a shrunk sprite. Seats face `se`, the runner `ne`. Centre it in the cubby. The five room atlas pieces have one each too (OME-1847, from `presets.ts` `buildRoomThumbs`): `thumb/armchair/velvet`, `thumb/tv/charcoal`, `thumb/lamp/cream`, `thumb/plant/rust`, and `thumb/rug/navy` (a 3×3 corner of the big rug). The armchair and TV have no colours, so the editor maps them to those names. |
| `glyph/fp-<1x1\|2x1\|1x2\|3x2\|2x3\|wall>` | 10×6 · 14×8 · 22×12 · wall 10×7 | — | Footprint glyph, bottom-left in each cubby (`.ui-fp`): the piece's floor cells as a tiny iso plan (8×4 px per cell, plum seams and outline), or "wall". Pick `footprintByDir[dir]` for the facing the thumbnail shows, so the plan slants like the piece: the two-seaters and the bookcase show `se`, which is `1x2`. |
| `swatch/<colour>` + `swatch/ring` *(edit.png)* | 10×10, 14×14 | — | Variant chips under the tray (`.ui-swatches > .ui-swatch[role=radio]`), one per colour in the piece's `colours`. The picked one shows its mustard ring. Prints get a tiny picture of their art. |
| `ticket/<idle\|copied\|expired>` | 34×20 | 4 6 4 15, fixed height | Invite link field (`.ui-ticket`): a cinema ticket, plum mono text on cream. `copied` stamps a teal check on the stub. `expired` tears the stub off, greys the card and strikes the text. |
| `pill/private` | 12×12 | 4 | "Invite only" pill: night with a cream rim, always with `glyph/key` and the words. |
| `door/private` | 16×24 | — | Room-list card thumbnail for a private room (like `door/open` / `door/full`): shut door with a brass key in the lock. |
| `icon/<arrange\|create\|key\|copy\|copied\|expired>` | 16×16 | — | Edit room · Create room (door + spark) · Invite (brass key) · Copy (the ticket and a copy behind it) · Copied (the ticket with a check) · Expired (the torn ticket). |
| `glyph/<host\|key\|check\|pieces>` | 8×8 | — | The host's little house (before the owner's name on their tag and in the room list) · invite only · copied · piece count. |

- **Edit toggle:** only the owner gets the key, in the top bar next to Invite. `aria-pressed` carries the state; the label swaps "Edit room" ↔ "Done".
- **Tray:** a tab row over the tray, cubbies in a scrolling row, and beside it the picked piece's name, its swatches and the count ("19 / 32 pieces";
  `MAX_FURNITURE = 32` per the M4 research). At the cap every cubby is `off`; moving placed pieces still works.
- **Create room:** `.ui-panel` form with `icon/create`, a name `.ui-input`, and a "Who can come in" radio pair built from `.ui-picker` (open: `door/open`,
  invite only: `door/private`), then the primary "Create room" key.
- **Invite states** (`.ui-panel` + `.ui-ticket` + key). The text says each state, so neither colour nor the stamp has to do it alone:
  - **idle:** `icon/key` "Invite link: anyone with it can come in." + ticket + secondary key `icon/copy` "Copy".
  - **copied:** `icon/copied` "Copied. Paste it to a friend." + `ticket.is-copied` + key `glyph/check` "Copied". Back to idle after about 2 s.
  - **expired:** `icon/expired` "This link has expired." + `ticket.is-expired` + primary key `icon/key` "New link".
  - **full:** opening an invite to a full room reuses set (f)'s `.ui-card.is-full` + `door/full` + `.ui-pill-full`, and says the invite itself is still good
    ("Your invite is fine. The room is full. Try again soon"). An expired invite on landing gets the dimmed card with `door/private` and `icon/expired`.
- **Room list:** private rooms use `door/private` + `.ui-pill-private` next to the name. "You're invited: …" cards are links (`a.ui-card`).
- **Scale:** like the other sets, `--ui-px` (2× page chrome, 1× in `.ui-room`). No new colours: still the 67.
- **`ui/edit.png` is 256×1024, and rows 709–1023 are reserved.** Sheets are powers of two (ADR 0004). The edit kit's frames cover
  138 570 px², more than a 256×512 sheet holds (131 072), so the next size down can't fit them. The frames end at y 753 (OME-1437's thumbnails). The rows below
  are room for M5 growth (thumbnails and markers for catalogue v2) without changing the sheet size. Empty rows cost almost nothing in the PNG
  (they compress to a few bytes), and the 1 MB texture only exists for an owner in edit mode.
- **Bytes:** counted on the basis in § Budget. The edit kit is 10 259 B (lazy, owners only); set (h) as a whole is in that table.

## Set (i) rooms you own + emotes (OME-416, `ui/`)

Chrome for M5 Wave R (create room, your rooms, 4004, private rooms) and W-emote. It joins sets (c)/(e)/(f)/(h) in `ui/ui.png` / `ui.json`,
`ui/slices/` and the end of `ui/reference.css`. The two state vignettes are standalone lazy PNGs in `ui/scenes/`. Previews (each at 1× and 2×
device pixels): `preview/ui-rooms@*.png` (create form, your rooms), `ui-rooms-closed@*.png` (4004, invite required), `ui-rooms-live@*.png`
(emote picker in the room, 4004 mid-film) and `ui-rooms-states@*.png` (every piece and state, page 2× and room 1×).
**Each motif has one job:** moon = closed or closing (lights out) · keyhole with no key = you need an invite · door/key switch = who can come in ·
mustard rim = only you · rust key = the one irreversible action.

| Key | Size | Slice | Use |
|---|---|---|---|
| `switch/<public\|private>/<idle\|hover\|off>` | 32×16 | — (sprite) | Invite-only switch (`button.ui-sprite.ui-switch[role=switch]`, `aria-checked`). A night track and a wood knob that slides like a bolt: off = knob left with the open door, on = knob right with the brass key. The other option is ghosted in the track. Always put the state in words next to it ("Invite only: on"). `off` = disabled (charcoal knob). Pressed (`:active`, `.is-press`) = the hover frame 1 art px lower; it flips on release. Focus (`:focus-visible`, `.is-focus`) = set (c)'s 1 art px cream ring. |
| `card/mine/<idle\|hover\|confirm>` | 18×18 | 7 | "Your rooms" row (`.ui-mine`): set (f)'s room card with the mustard "only you" line inside the wood rim. `confirm` (`.is-confirm`) = rust line, charcoal glass, while it asks "Close <title> for good?". |
| `button/danger/<idle\|hover\|press>` | 16×20 | 5 | `.ui-button.danger`: the rust key, only on that confirm step, always with `icon/closed` + "Close room". |
| `button/self/cool` | 16×20 | 5 | `.ui-button.self.is-cooling`: your emote key resting after a burst (`aria-disabled`), with set (f)'s `.ui-wait` dial over the retry-after. |
| `ticket/slot-<idle\|focus>` | 34×20 | 4 6 4 17, fixed height | `.ui-slot-ticket`: paste an invite link. Set (h)'s ticket outline as an empty sunken night slot; focus = mustard edge. `aria-invalid="true"` reuses `ticket/expired`. |
| `emotes/tray` + `emotes/tail` | 16×16, 16×6 | 6 | `.ui-emotes[role=menu]`: the picker, night in the mustard rim, with a 2:1 tail down to the emote key. Set `--ui-tail-x` to the key's centre (from the tray's padding edge). The tail's top 3 rows open the tray's bottom rim. |
| `emotes/slot/<idle\|hover\|press\|cool>` | 12×12 | 4 | `.ui-emote[role=menuitem]`, 24 art px. idle = flat, hover/focus = sunken well with a cream lit edge, press = mustard rim, cool (`aria-disabled`) = charcoal well. |
| `emotes/sep` | 2×14 | — | Groove between the 5 stickers and the wave. |
| `emote-pick/<heart\|laugh\|question\|exclaim\|clap\|wave\|cheer\|yawn>` | 16×16 | — | Picker icons: the motion atlas's settled emote frame (same roles, so the same pixels), centred, except two thin ones drawn a size up so they hold their own at 1× next to the 11 px heart and laugh: `exclaim` (6×12, a heavier bar and a 4 px dot) and `clap` (12×10, the same V palms, taller). Each sits in a 24 art px `emotes/slot` cell, at page 2× and room 1× alike. `wave` is new: an open blush palm with two cream motion ticks, in the sticker style. `cheer` and `yawn` (OME-1122) stand in for set (p)'s gestures the same way: `cheer` a raised blush fist on a mustard cuff, a plum thumb crease, cream pump ticks either side (a closed block, never the wave's open palm); `yawn` laugh's mustard face with the eyes shut flat, the mouth a tall O, a cream z off its brow. In the room (1×) they double as a static fallback for the floating sticker. Keys 1–8 (`aria-keyshortcuts`, said in the title; no digits on the cells). |
| `scrim/0` | 2×4 | — (tile) | `.ui-scrim`: 1-bit plum dither, 50 %, to dim the stage behind the 4004 card mid-session. No alpha. |
| `door/<closed\|locked>` | 16×24 | — | Room-list thumbnails beside `door/open\|full\|private`: closed = dark wood, plum sill, moon hanger. locked = shut, empty keyhole, lamplight under the door. |
| `icon/<closed\|emote>` | 16×16 | — | Close room / room closed (a door hanger with a hole, a slit and a crescent moon) · the emote key (a cream line face, so it can't be mistaken for the filled laugh sticker). |
| `glyph/<moon\|open>` | 8×8 | — | "Closes in N days if nobody visits" · "anyone can come in" (beside the switch). In `.ui-mine` the moon gets 3 art px of margin before the words (its crescent sits on its right edge). |
| `scene/<closed\|invite>` *(ui/scenes/\*.png)* | 72×64 | — | `.ui-scene.ui-scene-<closed\|invite>`, page chrome 2× (144×128 CSS px). Not in the sheet. closed = lights out: night in the fanlight, the sconce off, no light under the door, the moon hanger on the knob. invite = someone's home: warm fanlight, lit sconce, lamplight under the door, an empty keyhole, a dashed ghost ticket on the wall. |
| `scene/not-found` *(ui/scenes/not-found.png)* | 72×64 | — | `.ui-scene.ui-scene-not-found` (OME-841, M9 W2 "Room not found"), page chrome 2×. The same lit wall and floor, but no door: the wallpaper and wainscot run straight through, a dashed cream ghost of the door frame and doormat marks where it would be (dashed cream = missing, like the ghost ticket), a mustard question mark inside, and the sconce off (nobody lives here). Not `closed` (a real door, lights out) and not `removed` (a real lit door). |

- **Create room:** `.ui-panel` form: `icon/create` heading, the name `.ui-input` with a hint and an `n / max` count, the switch row, then the primary key.
  Too many new rooms: the key becomes set (f)'s `.is-waiting` with `.ui-wait` and "New room in 9 min", and the line under it says the existing rooms still work.
  The name error is set (c)'s `input/invalid` + `icon/warn` + words.
- **Your rooms:** a heading with `glyph/host` and a secondary "New room" key, then `.ui-mine` rows: door thumb, title (+ `.ui-pill-private`), a meta line,
  then "Enter" + (private) a square `icon/copy` key + a square `icon/closed` key. A room near the GC sweep says so with `glyph/moon`. Close is two steps:
  the row turns `.is-confirm` with "Keep it" and the danger key. Empty list: `icon/create` + one line.
- **Room closed (4004):** `.ui-panel` with `scene/closed`, a heading, one line and "Find a room" (primary) / "Make your own". Mid-session, lay
  `.ui-scrim` over the stage and centre the same card (1× inside `.ui-room`).
- **Room not found:** the 4004 panel with `scene/not-found` instead of `scene/closed`, a heading ("This room doesn't exist"), one line and
  "Find a room" (primary) / "Make your own". Use it for a link to a room that never existed or was swept; `scene/closed` stays for a room its host closed.
- **Invite required:** `scene/invite`, a line, then the `.ui-slot-ticket` + primary `icon/key` "Go in". A bad link: `aria-invalid` + `icon/warn` + words.
- **Invite copy** is set (h)'s ticket (idle/copied/expired); set (i) only adds the paste slot and the square copy key on your-rooms rows.
- **Emote picker:** opens above the emote key (`.ui-button.self` + `icon/emote`, `aria-expanded`), 5 stickers, the groove, the wave. Pressing one sends it and
  closes the picker. When the server slows you, the key goes `is-cooling` and the cells `aria-disabled`.
- **Sheet:** `ui.png` is now 256×512. The frames cover 59 346 px² (90 % of 256×256), more than the skyline packer fits with its 1 px gutters, so the
  next power of two is the honest size. Rows 282–511 are free for M5/M6. The PNG grows by bytes, not by the empty rows; decoded it's 512 KB of RGBA.
- No new colours: still the 67.
- **States sheet:** `ui-rooms-states@*` marks the cells a piece doesn't have as "n/a" (the close key has no disabled state: it only exists on the
  confirm step; the paste slot is a text field, so it has no hover; a your-rooms row has no off state, it's either there or closed).

**Set (i) bytes, per file** (what each one costs on the wire; the sheet frames have no file of their own, so they're counted in `ui.png`):

| File | Bytes | Loaded |
|---|---|---|
| `ui/ui.png` set (i) share (switch ×6, emote-pick ×6, `emotes/sep`, `door/closed\|locked`, `icon/closed\|emote`, `glyph/moon\|open`) | +2 213 | eager (whole sheet) |
| `ui/ui.json` set (i) frames | +541 gz | eager |
| `ui/reference.css` set (i) rules | +1 809 gz | eager (via `apps/web/src/style.css`) |
| `slices/button-danger-idle\|hover\|press.png` | 155 + 155 + 149 | on the confirm step |
| `slices/button-self-cool.png` | 155 | when the emote key cools |
| `slices/card-mine-idle\|hover\|confirm.png` | 191 × 3 | your-rooms page |
| `slices/ticket-slot-idle\|focus.png` | 214 × 2 | invite-required page |
| `slices/emotes-tray.png` + `emotes-tail.png` | 168 + 135 | picker open |
| `slices/emotes-slot-idle\|hover\|press\|cool.png` | 116 + 147 + 148 + 144 | picker open |
| `slices/scrim-0.png` | 104 | 4004 mid-session |
| `scenes/closed.png` | 547 | 4004 page / card |
| `scenes/invite.png` | 784 | invite-required page |
| `scenes/not-found.png` (OME-841, after the set) | 731 | room-not-found page |
| **set (i) total** | **8 471 B** (slices 2 577, scenes 1 331, sheet + atlas + CSS 4 563) | |

## Set (j) house rules, queue panel, Web Store kit (OME-422, `ui/` + `store/`)

Chrome for M6: the host's moderation menu on an avatar, the "who controls playback" setting, the three notices (removed with the
10 min wait, chat muted, only the host controls playback), the "Up next" queue panel, and the Chrome Web Store kit. The UI pieces join
sets (c)/(e)/(f)/(h)/(i) in `ui/ui.png` / `ui.json`, `ui/slices/` and the end of `ui/reference.css` (code: `src/moderation.ts`, `src/queue.ts`);
the removed vignette is a lazy `ui/scenes/removed.png` like set (i)'s. Previews (each at 1× and 2× device pixels):
`preview/ui-house@*.png` (menu open in the room, host-only shelf, notices, muted chat), `ui-house-page@*.png` (the setting, the removed page),
`ui-queue@*.png` (full, empty, errors) and `ui-setj-states@*.png` (every piece and state, page 2× and room 1×).
**Each motif has one job:** remote = who controls playback (the house badge = only the host) · pointing hand into a lit doorway = shown out ·
zip = chat muted by the host · timer dial = how long (set f) · tiny screen = the kind of source (never the provider) · seek bars in step / out of
step = synced / not synced (ADR 0024) · ghost reels = nothing queued · wood = shared · mustard rim = only you.

| Key | Size | Slice | Use |
|---|---|---|---|
| `menu/row/<idle\|hover\|press\|ask>` | 12×12 | 4 | `.ui-modrow[role=menuitem]` inside the moderation menu. The menu itself is `.ui-emotes.ui-modmenu` (set i's tray + tail: mustard rim = only the host sees it), tail on the member's name tag. idle = flat, hover/focus = sunken well with the cream lit edge, press = mustard rim (the emote cell's recipe, stretched into a row). `ask` (`.is-ask`) = the row turned into "Remove Moss for 10 min?" with Keep / Remove keys: charcoal well, cream-shade edge. |
| `menu/sep` | 4×2 | — (repeat-x) | `.ui-modsep`: groove under the menu's header (portrait, name, the wood × that closes it). |
| `button/shared/held` | 16×20 | 5 | `.ui-button.shared.is-held` (`aria-disabled`): a shared key when only the host controls playback, as everyone else sees it. Still wood, sunk into the shelf (plum shadow top-left, lit lip bottom-right, no lip to press), icon in its `-off` tone. Not charcoal (= off) and no dial (= resting). The shelf chip becomes `glyph/host` + "Host". |
| `input/muted` | 18×18 | 6 | `.ui-input.is-muted` (readonly): your chat field while the host has muted you. Charcoal well, no ring, the reason as its placeholder; Send is disabled. |
| `queue/row/<idle\|hover\|next>` | 16×16 | 4 | `.ui-qrow` in `ol.ui-qlist` (≤ 20, scrolls after 8). Dusk glass without a wood rim, so 20 stay calm. hover = cream lit edge. `next` (`.is-next`, the first row) = the TV's glow bar down the left: plays next. |
| `chip/solo` | 12×12 | 4 | `.ui-chip.solo` + `glyph/outsync` + "Not synced": ADR 0024's generic tier, a flat cream-shade rim on charcoal (not the TV's wood). Synced uses the existing `.ui-chip` (wood) + `glyph/insync` + "Synced". Always with the words. |
| `qx/<idle\|hover\|press>` | 12×12 | — (sprite) | `button.ui-sprite.ui-qx`: remove a queue row (and close the moderation menu). A little wood key (shared) with a cream ×. Focus = set (c)'s cream ring. Only rendered for the host and whoever added the row. |
| `qsrc/<video\|live\|generic>` | 14×12 | — | The row's kind of source, a tiny wood-bezelled screen: play mark (a synced video), the rust on-air dot (a live stream, like the LIVE pill) or a chain link on a dark screen (a pasted page, not synced). Never a provider logo or colour; the provider's name can go in words. |
| `head/<juno\|pip\|mo\|kiki>` | 12×13 | — | "Added by": the avatar's head at word size, each with its set (a) silhouette cue (puff + headphones, beanie + pom + glasses, bucket hat + beard, twin buns), before the name. |
| `queue/empty` | 48×32 | — | `.ui-qempty`: the room's cream projector on its shelf, lens dark, reel arms empty with dashed ghost reels. With one line: "Nothing up next. Paste a video link to load a reel." |
| `icon/<remove\|chat-mute\|remote\|remote-host\|queue\|queue-add\|link>` | 16×16 | — | Remove from room (a cream hand pointing into a lit doorway) · mute chat (the chat bubble zipped shut; unmute uses `icon/chat`) · everyone controls playback (the wood remote: glow lens, play key, keypad) · only the host does (the remote + the cream house) · the queue (three rows of tiny screen + title) · add to the queue · paste a link (two chain links). |
| `glyph/<chat-mute\|remote\|insync\|outsync>` | 8×8 | — | In a muted member's tag (host's view) and on the "muted your chat" line · on the "only the host controls playback" line · the synced chip (two seek bars, heads in step, glow) · the not-synced chip (heads out of step, cream shade). |
| `scene/removed` *(ui/scenes/removed.png)* | 72×64 | — | `.ui-scene.ui-scene-removed`, page chrome 2×. Set (i)'s doorway, lit (people are still inside), shut, no lock, and a wall clock beside it whose cream wedge is the 10 min wait as the set (f) timer dial. |

- **Moderation menu (host only, never on yourself):** click a member's avatar → `.ui-emotes.ui-modmenu[role=menu]` with a header (`.ui-portrait-<avatar>`,
  the name, `.ui-qx` close, Esc), `.ui-modsep`, then "Mute chat" (`icon/chat-mute`) ↔ "Unmute chat" (`icon/chat`) and "Remove from room" (`icon/remove`).
  Remove asks first (`.is-ask`). Remove isn't rust: rust stays for the one irreversible action (closing a room); a removal ends after 10 min.
- **Who controls playback (room setting):** two `.ui-picker[role=radio]` tiles (set c's frames, the mustard double rim = your choice): `icon/remote`
  "Everyone" / `icon/remote-host` "Only me", and a line that says what it means. The host's own shelf shows the chip as `glyph/host` "Host".
- **Only the host controls playback (everyone else):** shared keys `.is-held`, scrubber `.is-disabled`, chip `glyph/host` "Host", and once in the log
  a `.ui-sysline` (glow bar = room news) with `glyph/remote`: "Only the host controls playback now" / "Wren gave the remote to everyone".
- **The host muted your chat:** `.ui-sysline.self` (mustard bar = only you) with `glyph/chat-mute`, the chat field `.is-muted`, Send disabled. Emotes still work.
  In the host's view, the muted member's tag carries `glyph/chat-mute`.
- **You were removed:** a `.ui-panel` with `scene/removed`, "You were removed from this room", the wait in words, then set (f)'s `.ui-button.is-waiting`
  with `.ui-wait` over 600 s ("Rejoin in 8 min"), which turns into the primary "Rejoin" when it's done, plus "Find a room". Mid-film, lay set (i)'s
  `.ui-scrim` over the stage and centre the same card (1× inside `.ui-room`).
- **Queue panel:** `.ui-panel.ui-queue` with `icon/queue` "Up next" and the count "n / 20"; rows: `qsrc/*`, the title (one line, ellipsis) over
  `head/*` + the name, the synced chip, `.ui-qx`. Then the paste row: `icon/link`, `.ui-input` "Paste a video link", primary "Add" (`icon/queue-add`).
  A bad link: set (c)'s `aria-invalid` + `icon/warn` + words. Full: "20 / 20", Add disabled, set (f)'s "Full" pill + "Remove one to add another".
- No new colours: still the 67. The sheet stays 256×512 (set j uses some of the rows set (i) left free).

**Set (j) bytes, per file** (bytes on the wire, the README's one basis):

| File | Bytes | Loaded |
|---|---|---|
| `ui/ui.png` set (j) share (icons ×7, glyphs ×4, `qx/*` ×3, `qsrc/*` ×3, `head/*` ×4, `queue/empty`, plus the slices' sheet copies) | +1 448 | eager (whole sheet) |
| `ui/ui.json` set (j) frames | +402 gz | eager |
| `ui/reference.css` set (j) rules | +2 109 gz | eager (via `apps/web/src/style.css`) |
| `slices/menu-row-idle\|hover\|press\|ask.png` + `menu-sep.png` | 116 + 147 + 148 + 148 + 107 | menu open (host) |
| `slices/button-shared-held.png` | 148 | host-only playback (guests) |
| `slices/input-muted.png` | 155 | when you're muted |
| `slices/queue-row-idle\|hover\|next.png` | 151 + 151 + 160 | queue has rows |
| `slices/chip-solo.png` | 140 | a not-synced row |
| `scenes/removed.png` | 793 | removed page / card (lazy) |
| **set (j) total** | **6 323 B** (slices 1 571, scene 793, sheet + atlas + CSS 3 959) | eager 5 530, lazy 793 |

### Chrome Web Store kit (`store/`)

Not site art: the icons ship inside the extension package, the rest is the store listing. Mock rooms, names and titles only: no real channels,
sites or logos (the mock page's address is a reserved `.test` name).

| File | Size | What |
|---|---|---|
| `store/icon-16.png` | 16×16, 192 B | The room's wood TV showing the dusk stand-in picture (lilac sky, the sun on a teal sea). Drawn at 16 art px. |
| `store/icon-32.png` | 32×32, 268 B | + rabbit-ear antenna, the sun's glitter, the glow power light. Drawn at 32 art px. |
| `store/icon-48.png` | 48×48, 429 B | + two avatars watching from behind (Juno's cloud puff over a mustard hood, Kiki's twin buns over a lilac collar). Drawn at 48 art px. |
| `store/icon-128.png` | 128×128, 612 B | The 64 art px icon at 2× (whole pixels, never resampled), with Chrome's 16 px transparent margin (96 px of art). |
| `store/promo-440x280.png` | 440×280 | Small promo tile: the furnished room (set g) at 2× with the wordmark and one line on a panel. RGB, no alpha. |
| `store/screenshot-1-room.png` | 1280×800 | A watch room: the TV and its shelf, the room with tags, bubbles and an emote, the queue panel, system lines and chat. |
| `store/screenshot-2-share.png` | 1280×800 | Share from any page: a mock video page with the real extension popup open (shot by `src/shoot-popup.ts` from the e2e build against a throwaway server: a YouTube video found, "Movie night (3)" selected, Share and Add to queue live; shown at 1.5×), the video waiting in "Up next" under the site's own title for it, the host's moderation menu in a furnished room, and the playback setting with the site's wording. |
| `store/screenshot-3-chat.png` | 1280×800, 78 919 B | Round 2 (OME-843), chat and emotes: the wide desktop layout (set l), with the TV and shelf, the seats with floating chat bubbles (two stacked cards name their speaker), a heart and a laugh over two heads, your emote wheel open over you with Heart selected, and the chat column with the "Press Enter to chat" composer. |
| `store/screenshot-4-queue.png` | 1280×800, 88 407 B | Round 2 (OME-843), the shared queue: the TV near the end of a video, the room with name tags, and "Up next" with five rows (the first plays next, one live, one not synced), a link being pasted with Add under the pointer, and the system lines for who added what. |
| `store/marquee-1400x560.png` | 1400×560, 54 997 B | Round 2 (OME-843), the optional marquee: the furnished room (set g) at 2× with the wordmark and "Find a video on any page. Watch it together in a cosy pixel room." on a panel, bottom left. |

Each icon is drawn natively per size by `src/store.ts` (so each keeps the plum outline and whole pixels); `bun assets/src/build.ts` writes them and
prints their bytes (1 498 B for all four; the 128 px icon is 96×96 of art in 16 px of margin) apart from the art budget. The promo tile and screenshots are composed in `preview/store.html` from the
real reference CSS and preview renders, and `bun assets/src/shoot-ui.ts` shoots them at their exact sizes. `src/store-kit.test.ts` checks every kit file's
pixel size and that it stays under 1 MB. Screenshot 2's popup is
`preview/store-popup.png`: refresh it with `bun run --filter @omega/extension build:e2e && bun assets/src/shoot-popup.ts` before `shoot-ui.ts`
(ports 4470/8877, override with `OMEGA_SHOT_PAGE_PORT` / `OMEGA_SHOT_SERVER_PORT`).

## Set (k) full screen, pop-out, phone watch-only (OME-541, M7, `ui/`)

Mock-ups and chrome for M7: full screen with a chat strip (desktop: strip open and collapsed to the input bar; phone: portrait, landscape,
landscape while typing), the pop-out chat window and whole-room window, what stays in the page and how it comes back, and the phone
watch-only layout, the per-viewer quality menu (item 5) and the report-room key and dialog (item 6). The pieces join the other sets in `ui/ui.png` / `ui.json`, `ui/slices/` and the end of `ui/reference.css` (code: `src/fullscreen.ts`);
the two "it's in its own window" vignettes are lazy `ui/scenes/*-away.png`. Mock-ups: `preview/m7.html`, shot by `bun assets/src/shoot-m7.ts` (runs the build first, prints the budget line; animations stopped, so re-runs leave git clean)
into `preview/ui-m7-<pieces|desktop|band|phone|popout|away|watch|quality|report|motion>@1x|2x.png`. The white numbered badges on the mock-ups are the focus order
(annotation, not product). The rules are in `STYLE.md` § Set (k).
**The player is sacred in full screen too:** the dashed rects on the mock-ups are the player; no strip, band, line or field is ever inside one.

| Key | Size | Slice | Use |
|---|---|---|---|
| `fs/strip` | 16×16 | 2 2 2 5 | `aside.ui-fs-strip` (`role` on its log: `ol.ui-fs-lines[role=log][aria-live=polite]`): the TV cabinet's side panel. Dusk glass, the wood spine on its left (the picture's side). Head · lines · foot (emotes, field, Send). |
| `fs/line/<fresh\|settled>` | 12×12 | 4 | `.ui-fs-line` (fresh: cream card, plum words) → `.is-settled` (night card, cream words) → `.is-faded` (no card, lilac words) → removed. Ages in `ui.json` `meta.omega.stripAges` (6 s, 20 s, 45 s). On each change add `.is-turning` for one 120 ms frame (set i's `scrim/0` dither over the card; none under reduced motion). `.ui-fs-strip:hover`, `:focus-within` or `.is-pinned` = nothing ages and faded lines show settled. |
| `fs/pop` | 14×14 | 6 | `.ui-pop`: the content of a popped-out window (chat-only or whole room) in a 2 px mustard rim: yours, on the other monitor. |
| `icon/fullscreen`, `icon/fullscreen-exit` | 16×16 | — | On a `.ui-button.self.icon` at the end of the TV shelf (`aria-keyshortcuts="F"` when focus isn't in a field). Corner brackets out = enter; turned in = exit. Same key, same place. |
| `icon/strip-hide`, `icon/strip-show` | 16×16 | — | Collapse the strip to the band (in the strip's head, `aria-expanded="true"`) · show it again (in the band, with a `.ui-chip.self` "3 new" after it and the count in its label). |
| `icon/popout`, `icon/popout-room` | 16×16 | — | Pop out the chat (at the end of the chat row) · the whole room (in the room's top bar). A wood window with a bubble / a floor tile and seat, the mustard arrow leaving through its open corner. Desktop only. |
| `icon/popout-back`, `icon/popout-room-back` | 16×16 | — | Bring it back: in the popped-out window's head and on the page placeholder (`.ui-button.self` with the words). The arrow comes in. |
| `scene/<chat\|room>-away` *(ui/scenes/\*.png)* | 56×40 | — | `.ui-scene.ui-scene-<chat\|room>-away` in `.ui-panel.ui-away` (a `role=status` placeholder where the chat row or the stage was). The room's wall with a wood window: through it two bubbles / the floor with two chairs facing the TV's glow; on this side a dashed ghost; a mustard arrow to the window. |
| `icon/quality` | 16×16 | — | `.ui-button.self.icon` at the end of the shelf before full screen (in full screen: the strip head), `aria-haspopup="menu"`, label "Quality: Auto (720p60). Only you." Opens `.ui-emotes.ui-modmenu.ui-qmenu.is-below` (`role=menu`): `.ui-modrow[role=menuitemradio][aria-checked]` with a `glyph/check` (hidden unless checked) and an optional `.q-note`; `.foot` "Only on this device." Collapsed strip: `.ui-qmenu.is-row` replaces the band. No API (YouTube, generic, Vimeo without a paid owner): no key at all. Twitch quality echo: `.ui-button.self.is-switching` + `aria-busy` with a `.ui-wait` on the key for 5 s, and one `.ui-sysline.self` (see STYLE). |
| `icon/report` | 16×16 | — | "Report room" on a `.ui-button.secondary` with words (foot of the chat column / last line of the phone page; hidden for owners). Opens `form.ui-panel.ui-report[role=dialog][aria-modal]`: `h2`, `p`, `fieldset` of `label.ui-reason` (visually hidden `input[type=radio]` + `glyph/radio-off\|on`; `.is-focus` = `:focus-within`), `textarea.ui-input` (300) + `.count`, `.acts` (Cancel `.secondary`, Send). |
| `glyph/radio-off`, `glyph/radio-on` | 8×8 | — | The report reasons. A cream-shade ring round a night well; picked = cream ring and pip. |

**Touch targets (phones):** put `.ui-touch` on the root of every phone layout (full screen portrait and landscape, watch-only, the report dialog); a coarse pointer gets the
same rules anywhere. Every key, menu row, reason row and × gets a transparent `::before` hit area of at least **44×44 CSS px** centred on it (the art keeps its 24–28 px
size), icon keys get 9 px side margins so neighbouring hit areas never overlap, fields grow to 44 px and the seek bar's hit area is 44 px tall. The dashed boxes on
`ui-m7-phone` / `ui-m7-watch` are those hit areas (annotation). **Scroll cue:** `.ui-fs-rail` (`--top` 0–1 = where you are, `--size` = the visible share), a 3 px rail with a cream thumb on
the strip log's right edge, shown only when there's more above.

Layout numbers the mock-ups use (CSS px): desktop 1280×720 with the strip open = picture 980×551 at (0, 58), shelf under it, strip 300 wide;
collapsed = picture 1187×668 at (46, 0), one 44 px band. Phone portrait 390×844 = picture 390×219 on top; landscape 844×390 = picture 693×390
plus a 151 px column; typing = picture 242×136 top-left and the field on the keyboard. Watch-only = the stage at 1× cropped to 390×250 around the seats.

## Set (l) bubbles, emote wheel, smooth walk, wide desktop (OME-644, M8, `ui/` + `avatars/motion.*`)

M8's polish set: floating chat bubbles over the speakers, the radial emote wheel (T), the 8-frame walk for the Smooth tier and refinements for the wide
desktop layout ([OME-642](/OME/issues/OME-642)). The UI pieces join the other sets in `ui/ui.png` / `ui.json`, `ui/slices/` and the end of `ui/reference.css`
(code: `src/chatfloat.ts`); the walk in-betweens are in `avatars/motion.*` (code: `src/motion.ts`). Mock-ups: `preview/m8.html`, shot by `bun assets/src/shoot-m8.ts`
(runs the build first, prints the budget line; bubbles frozen at fixed ages, so re-runs leave git clean) into `preview/ui-m8-<pieces|bubbles|float|wheel|desktop>@1x|2x.png`.
Walk: `preview/walk8-strip@4x.png` (every frame, in-betweens on the odd columns) and `preview/walk-tiers@2x.apng` (Basic on top, Smooth below, live speed). Rules: `STYLE.md` § Set (l).

| Key | Size | Slice | Use |
|---|---|---|---|
| `bubble/float`, `bubble/float-self` | 14×14 | 5 5 6 5 | `p.ui-float` (room scale, in the stage overlay): set (k)'s fresh cream card one size up, with a 2 px plum foot so it lifts off busy floors. `-self` (`.is-self`) = your own message, in tag/self's mustard rim. |
| `bubble/tail-<s\|sw\|se>` | 12×7 | — (slice file) | The tail, on `::after`. Top 3 rows open the card's lip, outline and foot; 4 rows show. Anchor = the tip. `s` (default) points straight down; `sw` / `se` (`.tail-sw`, `.tail-se`) lean 2:1 toward a speaker the box had to leave at the stage (or visible window) edge. |
| `wheel/disc` | 77×77 | — | `.ui-wheel[role=menu]` (page chrome, `--ui-px`): night tray, mustard rim, eight spoke grooves, a sunk ring round the hub. |
| `wheel/slot/<idle\|hover\|selected\|press\|cool>` | 21×21 | — | `.ui-wheel-slot[role=menuitem]`, each holding set (i)'s `.ui-emote-pick-<id>`. idle = sunken well · hover = cream lit edge · selected (`aria-current`, `:focus-visible`, `.is-selected`) = mustard rim · press = mustard rim, deeper well, sticker 1 px down · cool (`aria-disabled`) = charcoal, sticker dimmed. 42 CSS px at 2×. |
| `wheel/focus` | 27×27 | — | Keyboard focus ring round a slot (`:focus-visible::after`, 3 art px out): 1 px cream between plum, set (c)'s focus language made round. Never on hover. |
| `wheel/hub` | 21×21 | — | `.ui-wheel-hub`: wood bezel, deep well. Shows the selected sticker (`icon/emote` before a pick, set (f)'s `wait/<n>` while cooling). |
| `wheel/tail` | 9×7 | — (slice file) | From the rim down to your head. `.no-tail` when the wheel docks (no avatar in view) or is clamped vertically. |
| `icon/wheel` | 16×16 | — | The touch key by the chat input (`.ui-button.self.icon`, `aria-haspopup="menu"`, `aria-expanded`): eight beads round a face, the top one lit. |
| `kbd/0` | 12×12 | 3 4 4 4, fixed height | `kbd.ui-kbd`: a keycap for hints ("Press [Enter] to chat", "[T] emotes", the wheel's label chip). Page chrome (2×) only. |

**Bubbles: geometry, motion, stacking.** All numbers are in `ui.json` `meta.omega.bubbles` (ms and stage px) and baked into the CSS.
- **Box:** 12/15 px words, at most 168 px wide (border box) and 3 lines (`.say` clamps; the full text is in the chat log). Bubbles are decorative:
  the layer is `aria-hidden="true"`, the chat log stays the live region.
- **Anchor:** the tail tip, at `(floor x, floor y − tagLiftByAvatar[id][pose])`, 2 px over that avatar's head. The card's bottom is 4 px above it (`tailBelow`).
  JS sets `left`/`top` to the card's resting border box and `--tail-x` to the speaker's x inside it.
- **Life (default):** 5 s. Opacity 0 → 1 over 120 ms in 3 steps, holds to 3.6 s, then `cubic-bezier(.55, 0, 1, .45)` (ease-in) to 0 at 5 s. It rises 24 px over the whole
  life in `steps(24)`: one whole stage px every ~208 ms, so the art never blurs between pixels. `opacity` + `translate` only: compositor work, no layout or paint per frame.
- **Reduced motion:** no rise, no push slide, no fade-in. Shows at once, holds to 4 s, fades linearly to 0 at 5 s; an early exit is instant.
- **In the room: stepped by script** (`meta.omega.bubbles.room`, ADR 0040, OME-830). Running CSS animations cost a restyle on every main frame, so the room
  turns the keyframes off and one shared clock writes the motion: 24 ticks a life (one every ~208 ms), the same for every bubble. The rise and the ease-in fade are
  unchanged, the fade sampled on the ticks (about 7 levels over 1.4 s). Three changes, all accepted for the look: no fade-in (the bubble shows whole, a crisp pop);
  a push is instant (the stack snaps, it doesn't slide); an early exit drops to half opacity, then goes on the first tick at least 160 ms later.
  The keyframes above stay for the standalone component. Any extra motion comes back as ticks on that clock, never as a CSS animation or transition.
- **Stacking rule** (reference implementation: the script in `preview/m8.html`). Lay out on every add/remove and when a speaker moves, newest first:
  1. Each bubble takes its anchor, clamped sideways inside the stage (or the visible window on a phone) with a 4 px margin.
  2. Its **path** is the box plus the 24 px it will rise. If its path would come within 3 px of a newer bubble's path, it moves straight up until it clears
     (repeat until nothing touches). So nothing ever overlaps at any moment of the float, and newer lines are always nearest the heads.
  3. A bubble that moved up is `.is-stacked`: no tail (it can't point at its speaker any more), and the words start with `<b class="who">Name</b>`.
     A bubble that didn't move but was clamped so the speaker is within 6 px of its edge uses `.tail-sw` / `.tail-se`.
  4. Up to 2 per speaker (a 3rd retires that speaker's oldest) and 8 on screen (a 9th retires the oldest). A bubble whose path would leave the top of the stage retires too.
     Retiring = `.is-leaving` (160 ms fade, 4 steps), then removed.
  5. A moved bubble slides to its new place with `--push` (a `transform`, 160 ms, 4 steps), never by animating `top`.
- The mock-up's six speakers (`ui-m8-bubbles`) show two stacks (Remy twice over Ana; Sol pushing "You" up) and your own bubble. The white anchor dots are annotation only.
- **Known limit:** a stacked card can cover the heads of people seated behind its speaker (Remy's older card in the mock-up). Accepted: name tags hang under the
  feet (`TAG_OFFSET_Y`), so identity stays readable, and the card is gone within 5 s. Don't push stacks sideways to dodge heads: a sideways stack loses the speaker.

**Emote wheel.** Geometry in `meta.omega.wheel` (art px): slot `k` (0–7, `order`: heart, laugh, question, exclaim, clap, wave, cheer, yawn = keys 1–8) has its top-left at `slots[k]`,
every 45° clockwise from 12 o'clock on a 27 px radius (OME-1122; the least that keeps eight round slots apart, so the outer ones sit on the rim like set beads); the hub at `hubOrigin`. The CSS places them already (`.ui-wheel-slot:nth-child(k)`).
- **Where:** page chrome at `--ui-px: 2px` (never inside the scaled stage, so it's always 154 CSS px and the slots are touch-sized), its tail tip on your bubble anchor
  (`stageToPage`). The label chip (`.ui-chip.self.ui-wheel-label`, the emote name + its key in a `kbd.ui-kbd.is-small`) sits above the wheel, not on your avatar.
  Clamp it inside the stage box; clamped vertically, or with no avatar of yours in view (phone watch-only, panned away), it docks centred above the composer with `.no-tail`.
- **Keyboard:** T (focus not in a text field) opens it with Heart selected and focused (roving tabindex). → / ↓ next clockwise, ← / ↑ back, Home / End, 1–8 send at once,
  Enter / Space send the selected one, Esc or T close; Tab closes and moves on. Focus returns to where it was. `role=menu` `aria-label="Emotes"`, items `role=menuitem` with
  `aria-label` and `aria-keyshortcuts`.
- **Pointer:** hovering a slot shows `hover` and previews it in the hub; click sends and closes; a click outside closes.
- **Touch:** the `icon/wheel` key left of the message field opens the same wheel. Slots are 42 CSS px and 3 art px apart, so `.ui-touch` 44 px hit areas don't overlap.
- **Cooling:** every slot `aria-disabled` (charcoal), the hub shows `wait/<n>`, the chip says "Emotes in 3 s".
- **Motion:** opens with 4 opacity steps over 80 ms; nothing scales (pixel art never resamples). Reduced motion: it just appears.

**Wide desktop (OME-642 refinements).** `.ui-wide` (≥ 1024 px, landscape) puts `.ui-chatcol` (320 px) beside the TV + shelf + stage, full viewport height, no page scroll.
- The column is set (k)'s strip (`fs/strip`) standing beside the room, its wood spine on the stage side: head (`icon/chat` "Chat", the count, the pop-out key), the log (1× lines,
  `role=log`), the composer (`.ui-composer`: wheel key, field, Send) and a hint line ("[T] emotes [Esc] back to the room").
- **"Press Enter to chat":** `.ui-chat-hint` (with a `kbd.ui-kbd`) lies over the empty, unfocused field; it hides on focus, on any text and on coarse pointers. It's `aria-hidden`;
  the field's label and `aria-keyshortcuts="Enter"` say the same thing. Use `placeholder=" "` so `:placeholder-shown` works.
- **The stage at 1280×720:** after the 560×315 TV and its shelf, 339 px are left. Show the stage as a **1× window** panned to the seats (the phone's `panTo`), not
  the whole stage scaled to 0.56: avatars, tags and bubbles stay at native size. At ≥ 1080 px tall the full stage fits. (Recommendation for engineering; OME-642 can ship either.)
- Focus order is on the mock-up (`ui-m8-desktop`, white badges): pause · seek · the room · pop out · log · emotes · message · send.

**Bytes:** eager +5 455 B (`ui.png` +1 107, `ui.json` +794 gz, 7 new slices +952, `reference.css` +2 602 gz); lazy +4 978 B (`motion.png` +3 734, `motion.json` +1 244 gz). Set (l) total **+10 433 B**.

## Set (m) site icons, share card, "how it works" panels (OME-762, M9, `site/`)

The website's own files. They're served from the site root or the landing page, not from a Pixi atlas, so each is a standalone PNG (or ICO).
Everything is drawn by `src/site.ts` and written by `bun assets/src/build.ts`. The build fails if a landing panel goes over 25 KB, the three panels go over 60 KB together,
the share card reaches 150 KB, or the maskable icon's art leaves the safe zone. Preview: `preview/m9.html`, shot by `bun assets/src/shoot-m9.ts` into
`preview/ui-m9-{icons,og,steps-light,steps-dark}@1x|2x.png`.

### Site icons

The mark is the extension's wood TV (`store/`), so the browser tab, the toolbar and the home screen show one product. Each size is drawn natively in art px and
scaled by a whole number, never resampled.

| File | Size | Bytes | Art | Use |
|---|---|---|---|---|
| `site/favicon.ico` | 16 + 32 | 506 | the two PNGs below, stored as PNG-in-ICO | `/favicon.ico` (browsers and crawlers ask for it unprompted) |
| `site/favicon-16.png` | 16×16 | 192 | 16 art px at 1×: TV + dusk picture | `<link rel="icon" sizes="16x16">` |
| `site/favicon-32.png` | 32×32 | 276 | 32 art px at 1×: + antenna, glitter, a 2×2 glow power LED | `<link rel="icon" sizes="32x32">` |
| `site/apple-touch-icon.png` | 180×180 | 752 | 45 art px at 4×, **opaque** on the dusk wallpaper, with the two watchers | `<link rel="apple-touch-icon">` (iOS fills transparency with black and rounds the corners itself) |
| `site/icon-192.png` | 192×192 | 719 | 48 art px at 4×, transparent, with the two watchers | manifest, `purpose: "any"` |
| `site/icon-512.png` | 512×512 | 1 803 | 64 art px at 8×, transparent, with the two watchers | manifest, `purpose: "any"` |
| `site/icon-maskable-512.png` | 512×512 | 1 905 | 64 art px at 8×, full-bleed wallpaper, art 14 art px in from each edge | manifest, `purpose: "maskable"` |

**Maskable safe zone:** the farthest opaque pixel corner is 182 px from the centre, about 10% inside the W3C safe circle (radius 40% = 204.8 px). `assertSafeZone` checks it on every build.

**The watchers** (45 px and up) are drawn by `src/site.ts`, not by the extension icon's drawer: two audience silhouettes inside the screen, each a round head on a neck over shoulders,
cut by the screen's bottom edge. Juno is a dark cloud puff over a mustard hoodie, Kiki a pink head with two buns over a lilac collar, and the sun shows between them. The extension's
`store/` icons are unchanged (they ship in the released extension package).
The wallpaper is the room's wall shade with lit lozenges. It sits behind the art, so the plum outline still rings the TV.

Suggested head (engineering owns the real one; W1):

```html
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16">
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#2b1d2f">
<meta property="og:image" content="https://<origin>/og-card.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="…see the alt text below…">
<meta name="twitter:card" content="summary_large_image">
```

```json
"icons": [
  { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
  { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
  { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
]
```

`theme-color` / `background_color`: `#2b1d2f` (the page plum, `--ui-page`).

### Share card

| File | Size | Bytes |
|---|---|---|
| `site/og-card.png` | 1200×630 (600×315 art px at 2×), indexed PNG-8, opaque | 14 171 (cap 150 KB) |

The real room (set b), its back corner centred, with a big wood TV standing on the corner console. A TV in the corner faces the camera head-on in this projection,
so it's drawn flat. The screen shows a title card: the `logo/0` wordmark at 2× and "watch together" in a 5×7 lowercase pixel face, both on night sky, over the dusk
sea. Juno, Pip, Mo and Kiki watch it from their armchairs.

- **Crops:** the TV, the name and all four avatars sit inside the centre 630 px, so a square centre crop keeps them all. The full card is the 1.91:1 crop.
  `preview/ui-m9-og@1x.png` shows the card at 480 px (a chat unfurl), at 382×200, square at 240 px and at 120 px.
- **Alt text** (`og:image:alt`): *omega-share: four pixel-art friends in armchairs watch a big wood TV that reads "omega-share, watch together" in a cosy dusk room.*

### "How it works" panels

Three framed vignettes in one size. Each has its own plum outline and a 2 px wood frame (lit top-left, shaded bottom-right) round an opaque scene, so it reads the same on
a white, cream, plum or near-black page. No lettering in the art: the landing's own text says the step, so it can be translated and read by screen readers.

| File | Size | Bytes | Alt text |
|---|---|---|---|
| `site/how-1-find.png` | 368×224 (184×112 art px at 2×) | 1 491 | A browser window with a video on the page. The omega-share icon in the toolbar has a tick badge, and gold corner brackets mark the video it found. |
| `site/how-2-share.png` | 368×224 | 2 197 | The omega-share popup under its toolbar icon, showing the video and a room, with a hand pressing the gold Share key. The video flies through an open door where a friend is waiting. |
| `site/how-3-watch.png` | 368×224 | 3 231 | Four friends in armchairs, seen from behind, watch the same sunset video on a wood TV in a cosy room. |
| **all three** | | **6 919 of 61 440** | |

- **Display sizes:** `width="368" height="224"` (1 art px = 2 CSS px), or `184×112` CSS on narrow phones (1 art px = 1 CSS px = 2 device px on a 2× screen).
  Any other size resamples the pixels. Always use `image-rendering: pixelated`.
- **Format:** PNG-8 rather than WebP. Indexed pixel art at 2× is already 1.5 to 3.2 KB a panel. Lossless WebP (tested with ImageMagick) would save about 1.6 KB across all three
  (6 919 → 5 348 B), which isn't worth a second format or an encoder dependency in the zero-dependency build.
- **Suggested step captions** (the landing owns the words): *1 · The extension finds the video*, *2 · Share it into a room*, *3 · Sit together and watch*.

## Movie night: reaction glyphs, moments strip, recap card, lights-down (OME-1641, `ui/`, lazy)

Drawn by `src/reactions.ts`, written by `bun assets/src/build.ts`. Previews: `preview/moments.html`, shot by `bun assets/src/shoot-moments.ts`
into `preview/ui-moments-{room,frames,16,strip,recap,lights}@1x|2x.png`; the sheet at 4× is `preview/reactions-sheet@4x.png`.
**One meaning per motif:** a glyph that rises and dithers out = somebody reacted just now · a 9 px mini = the same reaction, remembered
(strip pips, recap counts) · the dusk bands = the share card's title screen, so the recap is the film's own end card. No new colours; fading is
1-bit dither (sets i and k), never alpha.

| File | Size | Bytes | Loaded |
|---|---|---|---|
| `ui/reactions.png` | 128×128 indexed PNG-8, palette trimmed | 1 321 | with the reaction bar / first reaction |
| `ui/reactions.json` | PixiJS v8 atlas | 595 gz | same |
| `ui/moments.css` | the strip, the recap card, lights-down, the bar's key icons | 1 649 gz | with the strip or the card (needs `reference.css`) |

### Reaction glyphs (`react/<heart|laugh|wow|clap>/<0..5>`, room scale, 1 art px = 1 stage px)

- **Cell 16×28**, one glyph per row, frames left to right. The glyph **rises inside the cell** (2 px a frame), so a burst is frame swaps
  only: place the sprite once, no position tween. **Anchor (0.5, 27/28)** = bottom centre = the spawn point, just above the name tag.
- **Sequence** (`animations["react/<id>"]`, `meta.omega.ms`): pop 80 · settle 120 · beat 200 · rise 180 · dither 50 % 120 · dither 25 % 120 ms =
  820 ms, one shot (`loop: false`). Glyphs are ≤ 15 px wide with the outline, so they read at 16 px.
- Heart and laugh are the motion atlas's emote-sticker pixels (pop / settle / accent), so reactions and emotes are one family.
  **Wow** is new: a teal face with tall dot eyes and a round "O" (laugh: shut eyes, wide grin, mustard); its beat throws two sparks.
  **Clap** is its own art (OME-1657; the sticker's V read as wings at 16 px): two cream palms, fingers up and thumbs in, a wood rim
  under the cream so it holds on the tan floor, mustard impact marks above; the beat presses the palms together.
- **Perf (engineering, OME-1631):** pool the sprites, `meta.omega.maxLive` = 12, off on Basic, drop on Smooth near the 8 ms frame.

### Moments strip and reaction bar (`ui/moments.css`, page chrome at `--ui-px`)

- `.ui-react.ui-react-<id>`: 16 art px key icon (the settled frame), inside a `.ui-button.secondary` with an `aria-label` and `aria-keyshortcuts`.
- `.ui-mini.ui-mini-<heart|laugh|wow|clap|top|catchup>`: 9 art px minis (`moments/<id>` in the atlas; 18 CSS px in page chrome). `top` = a
  mustard star for the recap's top moments; `catchup` = cream fast-forward for "Catch me up" (`.ui-button.secondary` + mini + words).
- `<div class="ui-moments" role="group" aria-label="Moments">`: `.ui-moments-bars` holds plain `<i style="--h: 0..1">` density bars
  (mustard on a night groove), and up to 8 `<button class="ui-moment-pip" style="--at: 0..1">` with one mini each, titled "Wow at 9:30".
  `:disabled` when the room's control policy doesn't let you seek. DOM only, no canvas.

### Recap card

`<section class="ui-panel ui-recap" role="dialog" aria-labelledby>`: set (c)'s wood panel, `inline-size: min(360px, 100%)`.
`.ui-recap-screen` (kicker `.ui-recap-kicker` "the end" + `.ui-recap-title`, 2 lines then ellipsis) on night with the share card's dusk bands
along its foot (they sit in the padding, so text never lands on them) · `.ui-recap-close` (`.ui-button.secondary` + `icon/close`, Esc too) ·
`.ui-recap-label` + `ol.ui-recap-moments` of `button.ui-recap-moment` (top mini, `<time>`, `.ui-recap-counts`), seeking like a pip ·
`ul.ui-recap-who` of `.ui-tag` (`.self` for you; nicknames as text) · a totals `.ui-recap-counts`. It never covers the composer.
**Contrast** (`RECAP_TEXT`, checked by `src/reactions.test.ts`, all ≥ 4.5:1): cream on night 13.6 · mustard on night 7.5 · light mustard time 10.0 ·
lilac on the panel 6.6 · cream on the panel 12.8 · cream on the hover row 10.5.

### Lights-down

`<div class="ui-lights-down" aria-hidden="true">` inside the stage, under every DOM chrome layer and never over the player (ADR 0012); `.is-on`
fades it in over 900 ms in 6 steps (none with reduced motion). Engineering sets `--ui-screen-x/-y` (the screen's centre) and `--ui-screen-tint`
(the poster's average colour, never a video frame; default glow). A smooth falloff (12 smoothstep stops, OME-1657) from the tinted
screen to a flat dim; flat from 75 % of the ellipse out, so every seat dims the same.

**Bytes:** +3 565 B, all lazy (305 223 → 308 788 of 409 600), as `bun assets/src/build.ts` measures it: `reactions.png` 1 321, `reactions.json`
595 gz, `moments.css` 1 649 gz (OME-1657 polish: +151 B). (`gzip -9c` reads 15 B more a file, the gzip header; README § Budget uses zlib level 9 with no header.)
Eager bytes are unchanged. The cap went from 300 KB to 400 KB for Movie night (ADR 0056, CEO on OME-1656).

## Motion atlas (`avatars/motion.json`, set d)

Same format as the avatar atlas (PixiJS v8, 32×64 cells, no trim, no rotation, anchor = floor point `(16, 61)`).
It's a second sheet so the room's first paint doesn't pay for it: load it after the room is up (walking is M5).
Frame keys start with `walk`, `breathe`, `wave` or `emote`, so they never collide with avatar ids or room keys in Pixi's cache.

| Key | Frames | Notes |
|---|---|---|
| `walk/<id>/<dir>/<0-3>` | 4 per dir | Contact (kick-up) → passing → contact (open V) → passing. The body rises 1 px on passing frames, the supporting sole is always on y 60, and both arms swing against the legs (Kiki's popcorn arm stays put). |
| `walk8/<id>/<dir>/<1\|3\|5\|7>` | 4 per dir (set l) | The Smooth tier's in-betweens: 1 recoil (free foot starts its swing), 3 reach (swinging foot 1 px off the floor), 5 and 7 the same for the other leg; arms at half swing (1 row). In each avatar's second row, columns 16–31. |
| `breathe/<id>/<pose>/<dir>/1` | 1 per pose × dir | Breathing out: the head settles 1 px onto the collar. Breathing in is the set (a) frame `<id>/<pose>/<dir>/0`. |
| `wave/<id>/<pose>/<dir>/<0-1>` | 2 per pose × dir | One arm (the other at rest): `0` forearm upright, hand high; `1` forearm 45° out, hand at cheek height. Standing and seated, all four dirs (seated viewers wave from behind too). |
| `emote/<heart\|laugh\|question\|exclaim\|clap>/<0-2>` | 3 each, 16×16 | `0` pop-in, `1` settled, `2` pulse. Anchor = bottom centre `(8, 16)`. |

- **`meta.omega.anims`** is the source of truth: `<name> → { frames: key[], ms: number[], loop }`. Names are
  `walk/<id>/<dir>`, `breathe/<id>/<pose>/<dir>`, `wave/<id>/<pose>/<dir>` and `emote/<id>`. Build `AnimatedSprite` from
  `frames.map((k, i) => ({ texture: Texture.from(k), time: ms[i] }))`. Keys resolve from either sheet once both are loaded.
  The Pixi-native `animations` map has everything except `breathe/*`, because those start on a set (a) frame.
- **Walk:** `meta.omega.walk = { frameMs: 150, tilesPerCycle: 1, stepPx: {x: 8, y: 4} }`. One 600 ms cycle (two steps) crosses one tile.
  Advance the sprite `(±8, ±4)` per frame along the 2:1 axis of travel, or tween and round to whole pixels on that axis.
  Screen direction → facing: `+col` = `se`, `+row` = `sw`, `−row` = `ne`, `−col` = `nw`. When the walk stops, show `<id>/idle/<dir>/0`.
- **Smooth walk (set l, M8):** `walk8/<id>/<dir>` is an 8-frame loop at 75 ms (`meta.omega.walk8 = { frameMs: 75, frames: 8, tilesPerCycle: 1, stepPx: {x: 4, y: 2} }`),
  still one tile per 600 ms cycle. **Its even frames are the 4-frame cycle's own keys** (`walk8` frame 2k = `walk/<id>/<dir>/<k>`), so switching tiers mid-stride
  never pops: Smooth step = 2 × Basic step. Only the odd frames are new cells. On the Smooth tier, interpolate the position every display frame and round to whole pixels.
  `walk/*` and `meta.omega.walk` are unchanged (the Basic tier, which `parseMotion` already validates).
- **Breathe:** `[1400, 1000]` ms. Start each avatar at a random phase so a full room doesn't breathe in unison.
  The blink ticker (set a) wins over the exhale frame for its 120 ms.
- **Wave** is one-shot (`6 × 160 ms`), then return to the pose's base frame. Seated waves still draw between the chair's `back` and `front` layers.
- **Emotes** are one-shot (`80, 160, 200, 200, 200, 400, 80` ms ≈ 1.3 s). They draw on the tag layer, bottom-centred 1 px above the
  name tag (`(floor x, tagTop − 1)`). Without a tag, use `floor y − tagLiftByAvatar[id][pose]`. The icons are outlined, so they hold on
  floor, rug, velvet and the dark walls.
- Contract: accepted in `docs/adr/0010-motion-atlas.md` ([OME-57](/OME/issues/OME-57)).

## Expressions atlas (`avatars/expressions.json`, set p, OME-1104)

Two reactions for every avatar, pose and facing, built like the wave (`src/motion.ts`, the set (a) templates through `composeMotion`):
same 32×64 cells, anchor = floor point `(16, 61)` (`0.5, 61/64`), shading, plum outline and mirroring. `motion.png` is full (1024×512),
so this is a **second lazy sheet with `motion.json`'s schema**: `frames`, Pixi `animations`, `meta.omega.{tile, cell, floorPoint, gestures, anims}`.
Load it with `motion.json` (or the first time someone reacts). One row per avatar (Juno, Pip, Mo, Kiki); cheer then yawn, each poses × dirs × frames; a 5th row holds reach (1024×320, not rounded up to 512: the web keeps one tinted copy per look).

| Key | Frames | Notes |
|---|---|---|
| `cheer/<id>/<pose>/<dir>/<0-1>` | 2 per pose × dir | Fists up in a V. `0` elbows bent, fists by the ears, eyes closed in a smile, a small grin; `1` arms high and a wide-open grin, and standing avatars hop onto tiptoe (body up 1 px, heels up, toes on y 60). Kiki keeps her popcorn and pumps her free arm. |
| `yawn/<id>/<pose>/<dir>/<0-1>` | 2 per pose × dir | `0` the yawn: a big stretch, elbows out and hands behind the head, eyes shut, mouth a tall O. `1` the doze: arms down, head nods 2 px onto the collar, eyes shut, and a small cream "z z" floats up beside the head (never mirrored, so it never reads backwards). |
| `reach/<id>/idle/<dir>/<0-1>` | 2 per dir, standing only (OME-1697) | Petting something small on the floor beside the feet (the room cat). Squat: knees forward, body down 4 px, head 1 px more. The template-left arm (never Kiki's popcorn hand) goes down and out; `0` hand on the floor out beside the shoes, `1` stroked 4 px back in. In the 5th sheet row, avatar i in columns 8i–8i+7. |

- **Faces only show facing the camera (se/sw).** From behind (ne/nw) the arms and the head carry the reaction: the V, the elbows-out stretch,
  the nod and the "z". The far arm passes behind the head and hair, so a raised arm never covers a bun or a hat.
- **`meta.omega.anims`**: `cheer/<id>/<pose>/<dir>` is one-shot, `6 × 180 ms` (three pumps); `yawn/<id>/<pose>/<dir>` is one-shot, `[900, 1800]` ms
  (yawn, then doze); `reach/<id>/idle/<dir>` is one-shot, `5 × 160 ms` = 800 ms (stroke, back, stroke, back, stroke). Afterwards return to the pose's base frame. Seated reactions still draw between the chair's `back` and `front` layers.
- `meta.omega.gestures = [{id: "cheer", label: "Cheer"}, {id: "yawn", label: "Yawn"}]`, alongside motion.json's `wave`.
- Reach isn't in `gestures` (it's not a picker emote); the web wires it as a `GestureKind` with idle cycles only.
- Previews: `preview/reach-strip@4x.png` (per avatar: base pose, frame 0, frame 1, in se sw ne nw).
- Keys start with `cheer`, `yawn` or `reach`, so they never collide with avatar ids, motion keys or room keys in Pixi's cache.
- Previews: `preview/expressions-strip@4x.png` (per avatar a cheer row and a yawn row: base pose, frame 0, frame 1, for idle and sit in se sw ne nw, on floor marks)
  and `preview/expressions-scene@1x.png` / `@2x` (the room floor at 1×: every avatar standing and seated in an armchair, each facing a different way;
  frame 0 left, frame 1 right, cheers on top, yawns/dozes below).
- Engineering hookup (emote picker, server message) is a follow-up issue after the design judge passes.

## Watching poses (`avatars/watching.json`, OME-1640, lazy)

What a seated viewer does while the film plays, seen from behind (theatre rows face the screen). Built like the expressions
(`watchMotion` in `src/motion.ts` through `composeMotion`): same 32×64 cells, anchor = floor point `(16, 61)`, `nw` is the mirror of `ne`.
One row per avatar (Juno, Pip, Mo, Kiki); per dir `ne` then `nw`: base 0, laugh 0–1, gasp 0–1.

| Key | Frames | Notes |
|---|---|---|
| `watch/base/<id>/<ne\|nw>/0` | 1 | Settled in: sunk 1 px into the seat, the near elbow out on the armrest (Kiki keeps her popcorn). Use it in place of `<id>/sit/<dir>/0` while a video plays; outside playback keep `sit`. No blink frame (no eyes from behind). |
| `watch/laugh/<id>/<ne\|nw>/<0-1>` | 2 | The shake: `0` bounces up 2 px with the head thrown 1 px aside and the elbows flapping out, `1` drops 1 px. |
| `watch/gasp/<id>/<ne\|nw>/<0-1>` | 2 | `0` a jolt upright with both hands flung to the cheeks (they frame the jaw beside the hair), `1` the lean in: head dips 2 px toward the screen, hands stay up. |

- **Why these reads:** above a theatre row's seat back only the head, hair and shoulders show, so each reaction lives there (the bounce, the hands).
  The head never shifts toward the cell's near edge, because wide hats (the witch hat on Mo's brim) would touch the border.
- **`meta.omega.anims`**: `watch/laugh/<id>/<dir>` is one-shot, `6 × 140 ms` (three shakes); `watch/gasp/<id>/<dir>` is one-shot, `[260, 1400]` ms.
  Afterwards return to `watch/base`. `meta.omega.states = [{base, 1}, {laugh, 2}, {gasp, 2}]`. Seated frames draw between the seat's `back` and `front` layers,
  at the seat's lift (`seatLiftByColour` on the theatre row), exactly like `sit`.
- **Hair colours, shirt tints, hats, bare heads: nothing new to wire.** `watching.png` shares the avatar PLTE, so it's listed in `hairs.json` and
  `tints.json` `sheets`: patch it like the other avatar sheets. Every `watch/*` key also has its hat in every theme sheet and in
  `accessories.png`, and a bare-head frame for Pip and Mo in `bare.png` (`bare/watch/...`), because they're generated from the same frame list.
- Reactions ride the Lead's reaction message (Movie night contract B); this sheet adds no message. Frame swaps only: no per-frame work beyond the texture swap.
- **Bytes:** sheet 4 548 B + json 1 154 B gz; with the hat and bare frames for the new keys the art total grows by 11 459 B (≤ 20 KB allowance).
- Previews: `preview/watching-strip@4x.png` (per avatar: plain `sit` back, base, laugh 0–1, gasp 0–1, for ne and nw, on floor marks),
  `preview/watching-theatre@1x.png` / `@2x` (the theatre set with three raised rows of 4 per side, every row holding all four avatars; panels
  base, laugh 0, laugh 1 / gasp 0, gasp 1, and a mixed house: front row laughing, middle gasping, back plain) and `preview/watching-rows@3x.png`
  (the same six panels cut to the seats).

## Holiday theme: Halloween (`themes/halloween/halloween.json`, OME-1185, lazy)

One lazy sheet per theme (plan: OME-1140). Load it only while the theme is active (Oct 24 – Nov 1, the viewer's local date;
`meta.omega.period`). Same PixiJS v8 format as the room atlas: 256×128 indexed PNG-8, no trim, no rotation, per-frame `anchor`.
Every key starts with `halloween/`, so nothing collides in Pixi's texture cache. Style rules: `STYLE.md` § Holiday themes.

| Key | Size | Place at | Notes |
|---|---|---|---|
| `halloween/window/0`, `/1` | 20×87 | the `wall/l/window0` / `window1` cell's floor point | Moonlit view: a big harvest moon, a bare tree, a crooked house with one lit window on a hill. Only the panes, so the room's window frame, mullion and sill stay. |
| `halloween/pumpkin/big`, `/small` | 16×13, 9×8 | the `wall/l/window0` cell | Jack-o'-lanterns on the sill, carved faces toward the room, lit from inside. |
| `halloween/pumpkin/mid` | 12×10 | the `wall/l/window1` cell | |
| `halloween/web/corner-l`, `/corner-r` | | `(0,0)`, where `wall/corner` goes | Cobweb in the back top corner, one half per wall; a spider hangs off the right half. |
| `halloween/web/l-end`, `/r-end` | | `(0,9)`, `(9,0)`, where `wall/l/end` / `wall/r/end` go | Small webs in the open wall ends' top corners. |
| `halloween/bat/<0-3>` | 16×16 | anywhere on the back walls | Flap cycle: wings up, mid, down, mid. Facing right; mirror (`scale.x = -1`) to fly left. Anchor = centre `(8, 8)`. |
| `halloween/hat/<avatar frame key>` | varies | the avatar's floor point | A witch hat for **every** frame key in `avatars.json`, `motion.json` and `expressions.json` (448 keys). |

- **`meta.omega.decor`** lists the decor in draw order, each `{ key, on }`, where `on` is the wall frame key it belongs to. For every wall cell
  drawn with that frame, place the decal at that cell's `cellCenter(col, row)`. If the room has no such wall (an owner removed the window), skip it.
  Draw decor after the walls and the console and before anything on the floor. It never changes, so it can go into the cached background.
- **`meta.omega.effect`** = `{ frames, ms: 90, max: 6, layer: "behind-avatars", motion: "fly", facing: "right" }`: up to 6 bats crossing the back walls, behind
  every avatar and piece of furniture, looping `frames` at 90 ms. The engine owns the paths. Pixi's `animations["halloween/bat"]` has the same 4 frames.
- **Hats.** Whenever an avatar shows texture `K`, show `halloween/hat/K` at the **same position**, drawn directly over the avatar sprite (as its
  sibling right after it, so a seated avatar's hat still sits under the chair's `front` layer). There's no offset to compute: each hat key's anchor is the
  avatar's floor point, which can lie outside the hat image. Every key exists, including mirrored dirs, `/1` blink and back keys, `breathe/*/1`, `walk8/*`,
  `wave/*`, `cheer/*` and `yawn/*`, so a key lookup never misses. Emote icons have no hat. Overlaying hat on avatar gives exactly the frame with the hat on:
  Pip's beanie and Mo's bucket hat are fully covered (the build fails if any pixel of either would show), and raised arms stay in front of the brim.
- Previews: `preview/halloween-room@1x.png` / `@2x` (the default room dressed, with bats and every sitter hatted), `preview/halloween-hats@4x.png`
  (per avatar: each pose × dir without and with the hat, then a row of hatted walk, wave, cheer, yawn and breathe frames), `preview/halloween-sheet@2x.png`.

## Holiday themes B: Sinterklaas, Christmas, Valentine's, Easter (OME-1187, lazy)

Same format and rules as Halloween above: one lazy 256-wide indexed PNG-8 per theme under `themes/<id>/`, keys prefixed `<id>/`, decor in
`meta.omega.decor`, a hat for every avatar frame key (448 keys each) under `meta.omega.hat.prefix`, anchored at the avatar's floor point. What's new:

- **`meta.omega.period`** is either `{ from: "MM-DD", to: "MM-DD" }` (local date, both ends inclusive) or, for Easter, `{ easter: { from: -7, to: 1 } }`:
  days relative to Easter Sunday (Gregorian computus), so Easter runs from the Sunday before Easter Sunday through Easter Monday.
- **`meta.omega.effect.motion`**: `fly` (crosses the back wall sideways, Halloween's bats), `fall` (drifts down) or `rise` (floats up). If `ms` is
  absent the frames are **variants** (Christmas's three snowflakes): each particle picks one and keeps it, and there's no Pixi animation.
- **`meta.omega.hat.replaces`**: `true` for crown hats (mitre, Santa hat), which hide Pip's beanie and Mo's bucket hat like the witch hat does. `false`
  for band accessories (heart headband, bunny ears), which are worn over the avatar's own headwear. Either way the overlay gives the exact frame.
- **Decor `on: "wall/l"` / `"wall/r"`**: the decal goes on **every** segment of that wall (a garland or bunting that repeats along it), at each
  segment cell's floor point. `wall/r/poster0` / `poster1` work like the window keys.
- **`meta.omega.accent`** (optional) = `{ lamps: "#rrggbb" }`: a tint for the room's lamp and sconce glow while the theme is on (Valentine's only).

| Theme (period) | Decor (`on`) | Effect | Hat |
|---|---|---|---|
| `sinterklaas` (Nov 14 – Dec 6) | `window/0`, `/1` (20×87): a white steamboat with a red chimney and a string of flags in a night harbour. `shoe` (16×11, a yellow clog with a carrot for the horse) and `surprise/small` (8×8) on the `window0` sill, `surprise/big` (12×10) on the `window1` sill. `flags/corner-l`, `-r` (32×23, `wall/corner`): a paper-flag swag in red, gold and cream. **No Zwarte Piet imagery.** | `pepernoot/<0-1>` 8×8, a quarter-turn tumble at 160 ms, `fall`, ≤ 20 | Red mitre with a gold band, seam and cross (replaces) |
| `christmas` (Dec 7 – Dec 31) | `window/0`, `/1`: snow-capped rooftops with lit windows, falling snow, a drift on the ledge. `garland/l`, `/r` (32×23, `wall/l` / `wall/r`): a pine swag with three lights per segment. `stocking/0`, `/1` (`wall/r/poster0`) and `stocking/2` (`wall/r/poster1`), 9×13 each, hung under the poster. | `snow/<0-2>` ≤ 5×5, variants, `fall`, ≤ 40 | Santa hat: fur trim, the tip flops back to a pom (replaces) |
| `valentines` (Feb 10 – Feb 14) | `bunting/l`, `/r` (32×21, `wall/l` / `wall/r`): paper hearts, pink then cream, on a rose string, along both walls. Pink lamp accent. | `heart/<0-1>` 8×7, a beat at 300 ms, `rise`, ≤ 12 | Heart headband: rose band, two pink hearts on gold springs (worn over) |
| `easter` (Easter − 7 → Easter Monday) | `window/0`, `/1`: blossom branches against a spring sky over a green hill. `egg/dots` (8×9), `egg/zigzag` (6×8) on the `window0` sill, `egg/band` (6×7) on `window1`. `eggs/corner-l`, `-r` (32×24, `wall/corner`): a swag of paper eggs. | `petal/<0-1>` 6×6, a tumble at 220 ms, `fall`, ≤ 20 | Bunny ears: the far ear folds at the tip (worn over) |

- Previews per theme: `preview/<id>-room@1x.png` / `@2x`, `preview/<id>-hats@4x.png`, `preview/<id>-sheet@2x.png`.
- `src/themes.test.ts` checks every shipped theme: a hat for every avatar frame key, ≤ 40 KB, effect sprites inside their size limit, decor only on walls.

## Head accessories (`accessories/accessories.json`, OME-1388, lazy)

Eight cosmetics (OME-1388's four, OME-1530's four) in one lazy 256×256 indexed PNG-8, fetched only when someone in the room wears one. Each is a hat in exactly the holiday
theme format above: one overlay for **every** avatar frame key (448 each: idle/blink, `breathe`, `walk`, `walk8`, `sit`, `wave`, `cheer`, `reach`,
`yawn`, all four dirs; dance reuses the walk frames, so it is covered), anchored at the avatar's floor point, drawn as the avatar's next sibling.

`meta.omega.accessories` = `{ <id>: { prefix, count, rects, replaces } }`. Each value has the theme manifest's `meta.omega.hat` shape, so
the theme hat loader works per accessory: the overlay for avatar frame `K` is `<prefix>K`.

| Id (`prefix`) | Look | `replaces` | Rects |
|---|---|---|---|
| `partyhat` (`partyhat/hat/`) | Pink cone with cream stripes and a mustard pom, tipped toward the face | `false` (worn over) | 8 |
| `crown` (`crown/hat/`) | Small gold crown: three points with pearls; a rust gem between two teal ones on the front | `false` | 20 |
| `headphones` (`headphones/hat/`) | Lilac band over the top (parts from dark hair), teal cups; the far cup peeks past the face | `false` | 74 |
| `beanie` (`beanie/hat/`) | Navy knit with a ribbed cuff and a mustard pom (never red and white like the Santa hat); takes off Pip's beanie and Mo's bucket hat like the Santa hat | `true` | 17 |
| `cap` (`cap/hat/`, OME-1530) | Navy ball cap (never olive: on Mo it must not read as his bucket hat), cream front panel, darker brim pointing the way the face does, cream button | `false` | 24 |
| `flower` (`flower/hat/`, OME-1530) | Pink bloom (6×6) with a ginger heart and a 3 px olive leaf above the near ear: in Juno's hair, on Pip's cream beanie, on Mo's olive hat, on Kiki's cream hair band | `false` | 22 |
| `bow` (`bow/hat/`, OME-1530) | Big velvet hair bow with a pink knot, perched on top (1 px lower from behind, so it sits on the hair) | `false` | 14 |
| `halo` (`halo/hat/`, OME-1530) | Warm gold ring (ginger, not the mustard swatch) floating above the hair or headwear: shaded 1 px far rim, 2 px near rim with a cream core; never touches the head | `false` | 8 |

OME-1530's four use no avatar's swatch ramp (mustard, teal, rust, lilac) or hair ramp: the web swaps those slots in the hat overlays
too (`walk/tint-sheets.ts`), so the cap, flower, bow and halo keep their colours under any shirt tint and hair colour (`accessories.test.ts`).

Each value also carries **`bare`** (OME-1409): `true` for `partyhat`, `crown`, `headphones`, `cap` and `bow`, `false` for `beanie`,
`flower` and `halo`. The rule per OME-1530 accessory: the **cap** is fitted to the head (over a beanie or a bucket hat it reads as a stack of
hats), so Pip and Mo go bare. The **bow** sits on the hair, so they go bare (on Pip's pom or Mo's brim it would perch on headwear). The **flower**
is pinned at the side and looks right on Pip's beanie band and Mo's hat band, so nobody goes bare. The **halo** floats clear of everything, so
nobody goes bare. `bare.png` doesn't change: the new `bare` accessories reuse its frames.

### Bare heads under an accessory (`accessories/bare.json`, OME-1409, lazy)

An overlay can't erase pixels, so a hat worn over Pip's beanie or Mo's bucket hat would sit on top of it. For an accessory with `bare: true`,
Pip and Mo take their headwear off: Pip shows a messy ginger mop with two cowlick spikes, and Mo shows a short dark crop (beard and sideburn stay).
Their overlays in `accessories.json` are drawn for those bare heads.

`meta.omega.bare` = `{ prefix: "bare/", avatars: ["pip", "mo"], accessories: ["partyhat", "crown", "headphones", "cap", "bow"] }`. Frame `bare/K` exists
for every avatar frame key `K` of Pip and Mo (112 each: idle/blink, `breathe`, `walk`, `walk8`, `sit`, `wave`, `cheer`, `yawn`, `reach`, all four
dirs; dance reuses walk). Each frame is a full 32×64 cell with the avatar sheets' anchor (`16/32`, `61/64`), so it swaps in for the texture
directly. Keys carry only `frame` + `anchor`. Identical cells share a rect (200 rects for 208 keys).

Web rule: when avatar `A` in `bare.avatars` wears accessory `X` with `accessories[X].bare`, draw texture `bare/K` instead of `K`, then the
overlay `<X prefix>K` as usual. In every other case (Juno, Kiki, the beanie, no accessory) nothing changes.

- Bytes: `bare.png` 15 445 + `bare.json` 1 488 gz = **16 933 B**, lazy (fetched only when Pip or Mo wears a `bare` accessory).
- `src/accessories.ts` (`BARE`) defines the bare looks. `src/accessories.test.ts` checks that every key is present, the cell shape and
  anchor, and PNG-8 under 16 KB. The contact sheet `preview/accessories@4x.png` shows Pip and Mo on their bare frames.

- Bytes: `accessories.png` 4 234 + `accessories.json` 8 460 gz = **12 694 B**, all lazy (OME-1409 refitted Pip's and Mo's overlays to their bare heads: +243 B). Each key carries only `frame` + `anchor` (all the hat loader reads), minified: 201 KB raw to parse.
- OME-1530 (cap, flower, bow, halo) adds **9 286 B** (all lazy): `accessories.png` 4 257 → 5 800 (+1 543, still 256×256: the new hats
  are small and share rects across frames, 68 rects for 1 664 keys), `accessories.json` 8 443 → 16 168 gz (+7 725: 1 664 more keys; 386 KB raw to parse,
  was 199 KB), `bare.json` +18 gz (the two new ids in `meta.omega.bare.accessories`).
- Previews: `preview/accessories@4x.png` (OME-1388's four) and `preview/accessories-b@4x.png` (OME-1530's four, plus a mixed row:
  each cell another avatar in another shirt tint and hair colour) are contact sheets with a row per avatar; per accessory idle SE, idle NW,
  walk SW, sit SE, sit NE. Also `preview/accessories-sheet@2x.png`. Source: `src/accessories.ts`; `src/accessories.test.ts` checks keys, PNG-8 and the size cap.

## Furniture atlas (`furniture/furniture.json`, set g, M4/M5)

Furniture catalogue v1 for customizable rooms. It's a separate, lazy sheet: the default room doesn't need it, so load it only when a room
uses a catalogue piece (or the M5 customization UI opens). Same PixiJS v8 format as the room atlas, and the same anchor rule.
Previews: `preview/furniture-sheet@2x.png` (every frame, seats empty and occupied), `preview/furniture-room@1x.png` / `@2x` (every piece
in the current room, both facings), `preview/furniture-layout@1x.png` / `@2x` (a sample layout), `preview/furniture-atlas@2x.png` (the sheet).
**Catalogue v2 (OME-1103) is a second lazy sheet, `furniture/furniture-v2.png` + `.json`, with exactly the same schema** (frame keys, anchors,
`meta.omega.pieces`). Load it only when a room uses a v2 piece, so rooms with v1 pieces only download nothing new. Keys stay
`furniture/<id>/…` and ids don't collide with v1, so both atlases can sit in Pixi's cache together. Until the hookup issue adds the v2 ids
to `FURNITURE` in `packages/shared`, nothing reads this sheet. Previews: `preview/furniture-v2-atlas@2x.png` (the sheet), `preview/furniture-v2-room@1x.png` / `@2x` (every v2 piece in the room, with a few v1 pieces for scale) and
`preview/furniture-v2-seats@2x.png`, the **seat contact sheet**: one row per v2 seat piece × colour × avatar (an empty row leads each piece),
one column per facing `ne nw se sw`. A 2-seat piece holds the same avatar on both seats, so every avatar is shown on every v2 seat in every facing.

**Catalogue v3 (OME-1348) is packed into the same v2 sheet** (still 512×512), same schema and key rule. Six pieces built from the existing parts
and ramps (the console's square legs, the side table's mug, the cushions' piping, the arc lamp's brass knuckles, the frame's wall depth):

| id | label | layer / mount | facings | colours | footprint |
|---|---|---|---|---|---|
| `coffeetable` | Coffee table | object, floor | `se sw` | `wood` | 1×1 |
| `pouf` | Knitted pouf (seat, no front layer) | object, floor | `ne nw se sw` | `rust`, `lilac` | 1×1, 1 seat |
| `neonsign` | Neon sign | wall | `se sw` | `pink`, `teal` (tube colour) | wall |
| `aquarium` | Aquarium | object, floor | `se sw` | `teal` | 1×1 |
| `arcade` | Arcade cabinet | object, floor | `se sw` | `night` | 1×1 |
| `wallclock` | Sunburst clock | wall | `se sw` | `brass` | wall |

The brief's `stringlights` already ships as v2's `garland`, so the sixth piece is the clock. Like v2, nothing reads these until the Lead adds
the ids to `FURNITURE` in `packages/shared`. Preview: `preview/furniture-v3-room@1x.png` / `@2x` (every v3 piece, both facings, poufs taken and free);
the pouf joins `preview/furniture-v2-seats@2x.png`.

**"In use" loops (OME-1405), same v2 sheet.** Four pieces get a short loop to show while someone uses them. Only the moving part changes
(screen, platter, water, tube); every other pixel is the idle `back` frame, and each loop frame has the idle frame's size and anchor, so swap
the texture in place (same sort point, same layer). Key: `furniture/<id>/<colour>/use/<dir>/<n>` (`meta.omega.useKey`). Pixi's
`animations["furniture/<id>/<colour>/use/<dir>"]` lists the frames in order; the frame time is `meta.omega.pieces[].use = { frames, ms }`.
Back to `…/<dir>/back` when nobody uses it. Preview: `preview/furniture-use@4x.png` (idle + each frame, 1× and 4×; `src/contact-use.sh`).

**Door (OME-1424), same v2 sheet.** `door` ("Panel door"): an object on the floor layer, 1×1, `se sw`, colours `wood` (stained six-panel slab)
and `painted` (teal slab, panels shaded in the teal ramp), both in the bookcase's wood casing with the framed print's lit/shaded trim and a brass
sill. It backs onto its cell's wall like the bookcase, so place it on a wall-side cell (row 0 for `sw`, col 0 for `se`). `walkable: true`: the
door cell is where a walk ends. **Open frame:** `furniture/door/<colour>/open/<dir>` (`meta.omega.openKey`, `meta.omega.pieces[].open: true`);
the slab swings 90° into the room on its left hinges and the doorway shows a dark hall with a lit sill. The closed `back` frame and the open frame
share one rect (their union), so one anchor: swap the texture in place (same sort point, same layer). The open slab stays inside the cell.
`open` is not a layer: `layersByDir` still lists only `back`. Preview: `preview/furniture-door-room@1x.png` / `@2x` (both doors, both facings,
one closed and one open per wall, beside a bookcase). Like v2, nothing reads it until the Lead adds `door` to `FURNITURE` in `packages/shared`. The taller sheet needs no loader change: Pixi reads `meta.size` and every frame rect from the JSON.

**Cat walk (OME-1519), same v2 sheet.** The cat gets off its cushion. All frames are the cat alone (the loaf's role grid, roles and ramp,
eyes open with a mustard glint), drawn facing `sw` and mirrored for `se`, in both colours (`ginger`, `charcoal`):

| key | frames | what | anchor |
|---|---|---|---|
| `furniture/cat/<colour>/walk/<dir>/<0-3>` (`meta.omega.walkKey`) | 4 per dir | Contact (open stride) → passing (legs under, tail tip sways out) → contact (other pair) → passing (sway back). Body drops 1 px on contacts, near paws always on the last row. All four share one rect. | the feet's centre (29×21) |
| `furniture/cat/<colour>/sit/<dir>` (`meta.omega.sitKey`) | 1 per dir | Sitting upright, tail round the front paws: the pause between walks. | the feet's centre (20×22) |
| `furniture/cat/<colour>/bed/<dir>` (`meta.omega.bedKey`) | 1 per dir | The empty cushion it left. Same rect and anchor as `…/<dir>/back`: swap it in place. | as `back` |

Pixi's `animations["furniture/cat/<colour>/walk/<dir>"]` lists the walk in order; the frame time is `meta.omega.pieces[].walk = { frames: 4, ms: 150 }`,
the avatars' Basic walk clock (`avatars/motion.json` `meta.omega.walk.frameMs`), so step it with the same 8×4 px per frame and one tile per cycle.
No Smooth in-betweens: at 1× a 75 ms cat stride reads the same. `layersByDir` still lists only `back`. Only `se` and `sw` exist (like the loaf):
for `ne` moves use `se` and for `nw` moves `sw` (the same screen side). Preview: `preview/cat-walk@4x.png` (1× strip on top; columns loaf, walk 0–3, sit, bed) and
`preview/cat-walk-<colour>-<dir>@4x.apng` at live speed (`bun assets/src/shoot-cat.ts`). Cost: **+1 969 B** (292 857 → 294 826 of 307 200):
`furniture-v2.png` 23 433 → 25 009 (+1 576, still 512×1024), `furniture-v2.json` 2 967 → 3 360 gz (+393).

| id | loop | frames | ms/frame |
|---|---|---|---|
| `turntable` | the record turns: a groove glint and a label dot step a quarter turn per frame | 4 | 120 |
| `neonsign` | hum: the halo swells, then the core dims, then the antennae blink out (both colours) | 3 | 140 |
| `aquarium` | the bubble stream rises one unit per frame | 3 | 220 |
| `arcade` | screen: the invaders step side to side, the shot climbs, a scan band rolls down | 3 | 160 |

**Batch 6 (OME-1437) is a third lazy sheet, `furniture/furniture-v4.png` + `.json` (256×1024), with exactly the v2 schema**: frame keys,
anchors, `meta.omega.pieces`, `animations`, `useKey`. It isn't packed into v2 because `packages/shared/test/layout-contract.test.ts` requires
every piece in `furniture.json` and `furniture-v2.json` to already be a `FURNITURE` kind. A separate sheet lets the art land before the
hookup issue adds the five ids, and rooms without these pieces don't download them. Load it only when a room uses one of them.
**Identical frames share one rect** in this sheet: the hammock's two "centre" loop frames are its idle frame, so the 52 keys use 44 rects.
Nothing changes for a reader: every key has its own entry with the same size and anchor. Built from the existing parts: the bookcase's
wall-backed build, the door's raised panels, the bench's stand wood, the pouf's piping, the neon sign's glow.

| id | label | layer / mount | facings | colours | footprint |
|---|---|---|---|---|---|
| `hammock` | Hammock (seat, no front layer) | object, floor | `ne nw se sw` | `rust` | 2×1, 2 seats |
| `stool` | Stool (seat, no front layer) | object, floor | `ne nw se sw` | `wood` (rush seat, 3 legs), `teal` (buttoned cushion, 4 legs, brass foot ring) | 1×1, 1 seat |
| `barcounter` | Bar counter | object, floor, wall-backable | `se sw` | `wood` (teal tongue-and-groove front) | 2×1 |
| `piano` | Upright piano | object, floor, wall-backable | `se sw` | `wood`, `charcoal` | 2×1 |
| `fireplace` | Fireplace | object, floor, wall-backed | `se sw` | `stone` | 1×1 |

The bar counter, piano and fireplace back onto their cell's wall like the bookcase and the door (their depth sits toward +y), so place them on a
wall-side cell (row 0 for `sw`, col 0 for `se`). The counter and piano also stand free, because their backs never face the camera.
Seats sit at `seatHeight` like every other seat (`preview/furniture-v4-seats@2x.png`: every avatar on both seats of the hammock and on both
stools, in every facing).

| id | loop | frames | ms/frame | intended trigger (the hookup issue wires it in `piecesInUse`) |
|---|---|---|---|---|
| `hammock` | the sling's belly and fringe swing one way, back to centre, the other way, back (frames 1 and 3 are the idle frame) | 4 | 260 | someone sits in it (either seat) |
| `piano` | a chord goes down and the metronome ticks left, then another chord and it ticks right | 2 | 300 | someone stands on a cell at its front (either footprint cell) |
| `fireplace` | the three flame tongues leap and flicker, a spark rises, the mantel candles flicker in turn | 4 | 120 | a video is playing, like `neonsign` |

The hammock's sitter isn't moved by the loop. The swing is at most 1 px at a seat cell, and the ends stay put.
Previews: `preview/furniture-v4-room@1x.png` / `@2x` (every piece, both facings, people seated and free), `preview/furniture-v4-seats@2x.png`,
`preview/furniture-v4-atlas@2x.png`, and `preview/furniture-v4-use@4x.png` (`src/contact-use.sh assets/furniture <out> <gif-dir> furniture-v4`).

**Teleport pad (OME-1546, batch 12), packed into the v4 sheet** (still 256×1024). `pad`: 1×1, `layer: "floor"`, `walkable`, one facing
(`se`, the contract's, OME-1545; it's round), colours `teal` and `lilac`. Built like the kilim runner (a flat floor cast, plum outline), plus a 2 px plate edge: a dark
rim with eight brass studs, a cream ring, and a dish holding the site's "found" sparkle (cream, mustard heart). Only the dish/rim ramp
changes with the colour, so `lilac` is `teal` with that ramp remapped, index for index (`src/pad.test.ts`). **Active frame** =
its one-frame "in use" loop, `furniture/pad/<colour>/use/se/0` (`use: { frames: 1, ms: 1000 }`, same rect and anchor as `back`): the ring
lights in glow, the studs and the heart in bright mustard, the dish brightens and the sparkle grows out to the ring. Show it while someone
stands on the pad's cell, `back` otherwise. Floor layer, so it draws under the avatar like a rug. Contact sheet:
`preview/furniture-pad-contact.png` (idle and active, 1× and 4×, then the v4 room at 2×: mo on a lit teal pad, idle pads, a lit lilac pad).

**Frame key:** `furniture/<id>/<colour>/<dir>/<back|front>`. Every key starts with `furniture/`, so nothing collides with the
room's `armchair`, `plant` or `lamp` in Pixi's texture cache.

**Anchor = the floor point of the piece's anchor cell:** the tile centre `cellCenter(col, row)` of the footprint's lowest col and row.
Place the sprite there, with no per-item offsets. A piece covers `footprintByDir[dir]` cells from that cell toward +col and +row.

| id | Piece | Colours (first = default) | Dirs | Footprint (ne/sw) | Seats | Notes |
|---|---|---|---|---|---|---|
| `sofa` | Club sofa | `velvet`, `navy` | ne nw se sw | 2×1 | 2 | The room's armchair grown to two seats: tufted back, mustard piping, split cushion. |
| `couch` | Lounge couch | `cream`, `olive` | ne nw se sw | 2×1 | 2 | Low and deep: charcoal plinth, slouchy back cushions, bolster arms. |
| `wingback` | Wingback chair | `ginger` | ne nw se sw | 1×1 | 1 | Tan leather, stepped wings, brass studs, channel-stitched back. |
| `beanbag` | Beanbag | `blush`, `navy` | ne nw se sw | 1×1 | 1 | Squashed body + back hump. No `front` layer when it faces the camera (se/sw). |
| `sidetable` | Snack table | `wood` | se sw | 1×1 | — | Round pedestal table with a popcorn bowl and a mug. |
| `arclamp` | Arc lamp | `brass` | se sw | 1×1 | — | Marble foot, brass arc, cream bell shade; the shade hangs inside its own cell. |
| `monstera` | Monstera | `rust`, `teal` (pot) | se sw | 1×1 | — | Split leaves (role grid, mirrored then shaded) in a round pot. |
| `popcorn` | Popcorn cart | `rust` | se sw | 1×1 | — | Striped cart, glass case of popcorn, two-tier awning, spoked wheel. |
| `bookshelf` | Bookcase | `wood` | se sw | 2×1 | — | **Wall-backed:** `sw` stands against the right wall (row 0), `se` against the left wall (col 0). Back half of the cells only. |
| `rug` | Kilim runner | `lilac`, `teal` | ne nw | 3×2 | — | **Floor layer**, walkable. `ne` runs along cols (3×2), `nw` along rows (2×3). |
| `frame` | Framed print | `dusk`, `tide` (artwork) | se sw | wall | — | **Wall layer.** `sw` hangs on the right wall at `(col, 0)`, `se` on the left wall at `(0, row)`. Use a `plain` wall segment (not a window, poster or sconce). |
| **v2** | *(OME-1103)* | | | | | |
| `floorcushion` | Floor cushions | `mustard`, `teal` | ne nw se sw | 1×1 | 1 | Two stacked square cushions (button-tufted top, cream piping, corner tassels) and a striped bolster: `front` layer when facing ne/nw. |
| `bench` | Storage bench | `teal`, `pink` (pad; the throw is mustard / lilac) | ne nw se sw | 2×1 | 2 | Backless: wood frame with woven cane panels, a long seat pad, a pillow between the seats, a fringed throw over the far end (`front` in every facing). |
| `turntable` | Record console | `wood` | se sw | 1×1 | — | Mid-century cabinet on peg legs (grille + drawers), a turntable with a record and brass tonearm, a stack of sleeves. |
| `speaker` | Floor speaker | `wood`, `teal` (cabinet) | se sw | 1×1 | — | Tall cabinet on splayed legs: brass-ringed woofer and tweeter, a port. Pairs either side of the record console. |
| `cat` | Sleepy cat | `ginger`, `charcoal` (coat) | se sw | 1×1 | — | A loafing cat, eyes shut, tail round its paws, on a round lilac cushion. Hand-pixelled role grid (like the monstera's leaves) on a ray-cast cushion. Decor, not walkable. |
| `wallshelf` | Wall shelf | `wood` | se sw | wall | — | **Wall layer.** A floating plank on iron brackets (74–76 px up): trailing pothos, three books, a candle. |
| `garland` | String lights | `warm`, `party` (bulbs) | se sw | wall | — | **Wall layer.** One wall segment of festoon lights, wire 105–112 px up. The wire meets the next segment at the same height and the bulbs keep a 4-unit pitch, so garlands on neighbouring segments join into one string. |

- **Dirs** name the way the piece faces (where a sitter looks). `ne`/`nw` face the TV corner (backrest toward the camera, sitter seen from behind),
  `se`/`sw` face the camera. Same facing rule as the room armchair (`col < row` → `ne`, otherwise `nw`). Pieces that only need two facings
  (tables, lamps, plants, the cart, wall pieces) ship `se`/`sw`, and the rug ships its two orientations `ne`/`nw`.
- **`meta.omega.pieces[]`** is the contract: `{ id, label, kind, mount, layer, colours, dirs, footprint, footprintByDir, sortByDir, seatsByDir?, walkable, layersByDir }`.
  - `footprintByDir[dir] = {cols, rows}`: ne/sw keep `footprint`, nw/se swap it.
  - `layer`: `floor` (rugs: draw with the floor, under everything), `wall` (frames: draw with the walls, part of the static background), or `object` (depth-sorted).
  - `sortByDir[dir] = {x, y}`: the **z-sort floor point**, in px from the anchor. It's the footprint's centre, e.g. `(16, 8)` for a 2×1 piece. Sort objects by
    `(anchor + sort).y`, then `.x`, then `meta.omega.layers` (`back 2`, `avatar 3`, `front 4`). Centre sorting is exact for 1×1, 2×1 and 1×2 pieces next to
    1×1 avatars, which is why no object is longer than 2 tiles (the 3×2 rug is on the floor layer, so it never sorts).
  - `seatsByDir[dir] = [{col, row, dir}]`: seat cells relative to the anchor cell. Draw `<avatar>/sit/<dir>/<n>` at that cell's `cellCenter`.
    The sitting surface is 8 px above it (`meta.omega.seatHeight`), like the room's seats.
  - **Sitters sort with their seat's piece**, not their own cell: draw `back`, then every sitter on that piece, then `front`, all at the piece's sort point.
    (On a 2-seat sofa the far sitter's own cell would sort in front of the sofa's sort point, and the backrest would cover the wrong person.)
  - `layersByDir[dir]`: `["back"]` or `["back", "front"]`. `front` is only what stands between a sitter and the camera (backrest when facing
    ne/nw, the near arm). Non-seats have `back` only. Both layers of one facing share one rect size and anchor.
  - `walkable`: rugs and wall frames don't block a cell; everything else does.
- **Wall frames** hang 76–108 px above the floor point, so they clear the 56 px wainscot and the bookcase (62 px plus its cactus) on neighbouring segments.
- **Footprint check for M4:** the console still covers `col + row <= 2`. Don't place pieces there.
- Contract: proposed here, for the M4 layout contract (Lead Engineer). Nothing in `apps/` reads it yet.

**Theatre set v2 (OME-1639) is a fourth lazy sheet, `furniture/furniture-v5.png` + `.json` (256×1024), v4's schema plus one field.**
Separate for the same reason as v4: the five ids become `FURNITURE` kinds in contract B ([OME-1625](/OME/issues/OME-1625)), and rooms
without theatre pieces don't download it. Identical frames share one rect, as in v4. All static: no loops.

| id | label | layer / mount | facings | colours | footprint |
|---|---|---|---|---|---|
| `theatrerow` | Theatre row (seat, `front` layer: the backrests) | object, floor | `ne nw` | `floor`, `step`, `high`: the riser height | 2×1, 2 seats |
| `curtain` | Stage curtain | wall | `se` (left wall), `sw` (right wall) | `velvet` | 0×0 (a wall segment) |
| `bigscreen` | Big screen (the 2× screen frame) | object, floor, corner | `se` | `charcoal` | 1×1 at (0,0) |
| `aislelight` | Aisle lights | floor, walkable | `ne nw` (the strip's direction) | `warm` | 1×1 |
| `carpet` | Theatre carpet | floor, walkable | `se` | `navy` | 2×2 |

- **Raised rows.** `meta.omega.pieces[].seatLiftByColour` (`theatrerow` only: `{ "floor": 0, "step": 10, "high": 20 }`) is how many px
  higher to draw a sitter than `seatHeight` puts them, because the seat stands on the riser. A reader without the field draws 0. The
  backrests are the `front` layer, so from behind you see the head and shoulders over the seat back (`preview/theatre-seats@2x.png`: every
  avatar on both seats of every height, both facings). Each riser's back edge has a lit brass nosing, so the tiers read from the aisle.
- **Curtains** hang floor to pelmet (z 0–200) and stand 6 units off the wall. One kind covers both sides: put them on segment 2 of each wall
  (`sw` at col 2, `se` at row 2), right where the big screen meets the walls. Segments 5, 6 and 8 have fixtures, as for frames.
- **Big screen** replaces the corner console: a velvet-skirted stage across the corner (front plane u + v = 22, like the console's 24) and a
  camera-facing screen 120 px wide with a 110 × 62 lit picture. Like the console, it's drawn past its 1×1 cell: keep (1,0) and (0,1) free.
  Decorative: the live player stays page chrome (ADR 0012). The contract decides if it stands in for `tv` or is a `tv` variant (OME-1625).
- **Carpet** has no outline and its pattern repeats every 16 units on the world grid, so 2×2 tiles join into one carpet anywhere.
  The risers' tops use the same pattern. Floor pieces may not overlap, so aisle lights go on planks (the theatre preview's aisle).
- **Editor:** thumbnails for all five, and 3 new swatches for the row heights (`swatch/floor`, `swatch/step`, `swatch/high`: a seat
  on the planks, on one riser, on two).

Previews: `preview/theatre-room@1x.png` / `@2x` (the theatre layout: screen, curtains, two tiers, carpet, aisle, a full house),
`preview/theatre-seats@2x.png`, `preview/furniture-v5-atlas@2x.png`.

## Furniture recolours (`furniture/recolours.json`, OME-1462)

Six kinds get **2 extra colours each** by the shirt tints' technique: a runtime PLTE swap of the piece's fabric ramp(s), no new
frames. Keyed by the `FURNITURE` kind in `packages/shared`: `rug` is the room's 7×7 rug (`room/room.png`), `runner` is the kilim
runner (atlas id `rug` in `furniture/furniture.png`).

| kind | shipped | new (variant 2, 3; the rug 1, 2) | swapped ramps (source colour) | sheet |
|---|---|---|---|---|
| `sofa` | `velvet`, `navy` | `teal`, `ginger` | velvet (`velvet`) | furniture.png |
| `rug` | (navy) | `rust` (rust field, mustard border), `teal` (teal field, cream border) | navy, mustard | room.png |
| `beanbag` | `blush`, `navy` | `mustard`, `lilac` | blush (`blush`) | furniture.png |
| `pouf` | `rust`, `lilac` | `teal`, `mustard` | rust (`rust`) | furniture-v2.png |
| `stool` | `wood`, `teal` | `lilac`, `mustard` (padded, like `teal`; ginger sat 19.6 from wood under CVD) | teal (`teal`) | furniture-v4.png |
| `runner` | `lilac`, `teal` | `rust` (teal border), `mustard` (navy border) | lilac, pink (`lilac`) | furniture.png |
| `frame` | `dusk`, `tide` | `meadow` (glow sky, teal and olive hills), `sunset` (ginger sky, cream sun, rust and velvet ridges) | pink, lilac, navy, mustard (`dusk`; trim and mat stay) | furniture.png |
| `garland` | `warm`, `party` | `frost` (teal and ice bulbs), `peach` (blush and brass bulbs) | glow, mustard (`warm`) | furniture-v2.png |

**Why runtime, in bytes.** Every sheet (room, furniture ×3, `ui/edit.png`) carries the full shared PALETTE in its PLTE, so a swap
needs no new colours and no sheet byte changes: the table is **756 B gz** (3 223 B raw). Baking the same 12 colours (measured by
adding them to the catalogue and rebuilding) costs **+11 101 B of PNG** (furniture.png 21 948 → 29 620, furniture-v2.png 23 433 →
24 574, furniture-v4.png 18 733 → 19 167, edit.png 13 689 → 14 857 for the thumbs) **+ 639 B of JSON gz**, about 15× the table,
and would grow room.png too. The cost moves to the client: one sheet copy per (kind, variant) in use. If GPU memory matters, copy
only the source frames' rects (the table names them by key prefix) instead of the whole sheet.

**How to apply** (`kinds[<kind>]`): `slots` are PLTE indexes; for layout variant `variants[i].variant`, take a copy of `sheet`,
write `variants[i].colors[j]` into PLTE entry `slots[j]` (redo the CRC, as `apps/web/src/walk/tint.ts` `retint` does), and draw
the frames whose key starts with `frames` (the source colour's: `furniture/sofa/velvet/…`, the rug's `rug/…`) from that copy.
The tray thumbnail is `thumb` in a copy of `ui/edit.png` with the same swap; the variant chip is the existing `swatch/<id>`.
Colours are written, not indexes, so nothing cascades. The contract still says `variants: 2` (`rug`: 1); the hookup raises it.

- Every target is a shared-palette ramp, so a swapped frame is index-for-index what a direct render in that ramp gives (tested
  for every facing of the 4 seats); swapping a shipped piece into its other shipped colour (velvet → navy sofa, blush → navy
  beanbag, rust → lilac pouf, lilac → teal runner) reproduces the shipped frames exactly. The rug's ramps never touch the planks.
- Every new colour: ΔE ≥ 20 from each sibling with normal, deutan and protan vision, ΔE ≥ 25 from the floor, ≥ 3:1 on the dark
  site bg `#1d1a2b` (where the tray sits). `src/recolours.test.ts` checks all of it and that `slots` hold the source colours in
  every listed sheet.
- Contact sheet: `preview/recolours-sheet@1x.png` / `@2x`: one row per kind (the rug as a 4×4 patch), one cell per variant with
  every facing, shipped colours first and a cream rule before the new ones; the room floor on top, the dark site bg below.

**Wall decor (OME-1500).** `frame` and `garland` take 2 more each, same table, same path: **+401 B** (292 456 → 292 857 of
307 200): `recolours.json` +180 gz, `edit.png` +89 and `edit.json` +51 gz for 4 picture chips (`swatch/meadow`, `sunset`, `frost`,
`peach`, drawn like `dusk`/`warm`), `reference.css` +81 gz for their rules. No furniture sheet changes. A print or a bulb string
has no one colour, so the sibling test compares pixels where two variants differ: mean CVD ΔE ≥ 20 (shipped dusk vs tide: 51.5;
weakest new pair: meadow vs dusk 29.2). The new bulbs are ≥ 3:1 on the dark site bg and, on the wall under every mood, no weaker
than the weakest shipped bulb (party's lilac); a first `ember` string (ginger) missed that under `cool`, and `pink` next to
`frost`'s teal collapses for deutans (CVD ΔE 7), so it is `peach`. Contact sheet: `preview/recolours-wall@1x.png` / `@2x`, the
same rows and cells on the flat wall base under the 4 room moods (top to bottom `none`, `warm` rgb(255 140 50 / .18), `cool`
rgb(60 120 255 / .18), `night` rgb(14 12 46 / .5), as flat overlays: OME-1502 owns the real values), then the dark site bg.
The contract still says `variants: 2` for both; the hookup raises it to 4 (the web picker reads the table already).

**Lamps, plants and shelves (OME-1688).** Every lamp, plant and shelf takes 2 more, same table, same path: **+223 B**, all lazy
(`recolours.json` gz 936 → 1 159; 308 788 → 309 011 of 409 600). No sheet, thumb or chip changes: every new id reuses an existing
`swatch/<id>`. The room's `lamp` and `plant` are `room/room.png` frames like the rug (`source` names their shipped colour; no thumb).

| kind | shipped (variant 0..) | new (variant, id) | swapped ramps → new | sheet |
|---|---|---|---|---|
| `lamp` (room) | 0 cream shade | 1 `teal`, 2 `lilac` | cream (shade) | room.png |
| `plant` (room) | 0 rust pot | 1 `teal`, 2 `mustard` | rust (pot) | room.png |
| `arclamp` | 0 `brass` | 1 `lilac` (lilac arc, cream shade), 2 `teal` (brass arc, teal shade) | mustard, cream | furniture.png |
| `monstera` | 0 `rust`, 1 `teal` | 2 `mustard`, 3 `lilac` | rust (pot) | furniture.png |
| `bookshelf` | 0 `wood` | 1 `cream` (cream case with the wood shade tone, cream spines → wood), 2 `teal` (teal case, cream spines, teal spines and globe → navy) | wood, cream, teal | furniture.png |
| `wallshelf` | 0 `wood` | 1 `cream` (cream plank), 2 `teal` (teal plank, pot band → rust) | wood, teal | furniture-v2.png |

The bookcase swaps its spines out of the case's new ramp so no book vanishes into the case. A pink room-lamp shade was dropped:
it sits ΔE 6 from teal for deutans. Judge polish (OME-1707): the arc lamp went charcoal → lilac (1.7 → 5.2:1 on the dark
site bg), the wall shelf lilac → cream (plank on the wall ≥ 2.8:1 in every mood, was 1.45), and the cream case keeps the wood
shade (a variant's optional `shade` ramp, same table shape) so it reads on the lightest floor (shade 1.22 → 1.83:1). Single-colour kinds pass the ΔE ≥ 20 sibling / ≥ 25 floor / ≥ 3:1 site-bg test on the
named ramp; the arc lamp (brass is no ramp) and the wall shelf (a wall kind) are compared by pixel like the wall decor. The wall
shelf is drawn in `preview/recolours-wall@*`, the other five in `preview/recolours-sheet@*` (rows after the runner). Hookup: the
contract's `variants` become lamp 3, plant 3, arclamp 3, monstera 4, bookshelf 3, wallshelf 3.

## Set (o) extension popup kit + toolbar "found" state (OME-1041, `ui/popup/` + `store/`)

The extension popup in the site's chrome, and a second toolbar icon for "this page has a video". Previews (1× and 2× device px):
`preview/ui-popup-kit-toolbar@1x|2x.png` (both states on six real toolbar colours, zooms, the three directions) and
`preview/ui-popup-kit-states@1x|2x.png` (all nine popup states at 340 px). Source: `preview/popup-kit.html`, shot by
`bun assets/src/shoot-popup-kit.ts`. Generators: `src/store.ts` (icons), `src/popupkit.ts` (kit), wired in `src/build.ts`.

### Toolbar icon states (`store/`)

| State | 16 px | 32 px (2× of 16) | 48 px | 64 px (2× of 32) |
|---|---|---|---|---|
| `idle` | `icon-16.png` (unchanged) | `icon-32.png` (unchanged) | `icon-48.png` (unchanged) | `icon-64.png` **new**, 542 B |
| `found` | `found-16.png` 219 B | `found-32.png` 308 B | `found-48.png` 476 B | `found-64.png` 606 B |

`found` = the same TV with the **tally lamp** lit: a mustard bulb (the Share key's colour) with a cream glint and its own plum ring,
set into the cabinet's top-right corner. Each size is drawn natively, never scaled. Top-right on purpose: browsers draw the badge
bottom-right, so OME-1042's interim badge and the lamp never overlap. Wiring (OME-1042), per tab:

```ts
browser.action.setIcon({ tabId, path: { 16: "icon/found-16.png", 32: "icon/found-32.png", 48: "icon/found-48.png", 64: "icon/found-64.png" } });
// back to idle: the same with icon/16|32|48|64.png. Copy store/found-*.png and store/icon-64.png in wxt.config.ts like the others.
```

Keep the action's `title` in step ("omega share: video found") so the state isn't carried by the picture alone.
Added bytes: 1 609 B for the four found icons + 542 B for idle-64 = **2 151 B** in the extension package.

### Popup kit (`ui/popup/kit.css` + `ui/popup/kit.png`)

The popup can't load the site's `ui.png` (12.9 KB) or `reference.css`, so it gets its own cut:

| File | Bytes | What |
|---|---|---|
| `ui/popup/kit.png` | 749 | 16 sprites copied pixel for pixel from `ui.png` (the dots brightened, OME-1061) (`icon/tv`, `icon/share`, `icon/queue-add`, `icon/warn`, `icon/retry`, `glyph/check`, `glyph/dots/0-2`, `glyph/insync`, `glyph/outsync`, `glyph/radio-on`, `glyph/radio-off`, `qsrc/video`, `qsrc/live`, `qsrc/generic`) + one new 9×6 cream `chevron` for the room field |
| `ui/popup/kit.css` | 3 398 gz | Tokens (`--ui-*`, same values as the site, plus the popup's `--ui-hint` = cream[1] for the host and state line), the reused site rules under their site names (`.ui-panel`, `.ui-button(.secondary)`, `.ui-input`, `.ui-qrow`, `.ui-chip(.solo)`, `.ui-sysline`, `.ui-dots`) and the popup layout (`.pk-*`). Generated; don't edit by hand. |
| 17 × `ui/slices/*.png` | 2 668 | Existing files, listed in `POPUP_KIT_SLICES` (`src/popupkit.ts`): `panel-0`, `button-primary-idle\|hover\|press\|disabled`, `button-secondary-idle\|hover\|press`, `input-idle\|focus\|invalid`, `queue-row-idle\|hover\|next`, `chip-shared`, `chip-solo`, `chat-system` |
| OME-842 vignettes | (already shipped) | `nothing-found`, `cant-read`, `server-away` (+ `@2x`) |

**Total added to the popup: 6 815 B** (kit.png + kit.css gz + slices), all local files in the package, no network, no web font.
The popup opens on the same scan path, so the 300 ms "popup opened → embeds listed" budget isn't touched by the art.

**Copy layout (OME-1043):** `kit.css` + `kit.png` → `popup/`, the 17 slices → `slices/` (kit.css points at `../slices/<name>.png`),
then `<link rel="stylesheet" href="/popup/kit.css">` in the popup's `index.html` and `class="pk"` on `<body>`.

**Markup** (class names engineering should use; the mock-up `preview/popup-kit.html` is the reference for each state):

| Piece | Markup |
|---|---|
| Popup | `<body class="pk"><main class="ui-panel pk-main">` (one wood panel on the plum page, 340 px; `@media (hover: none)` fills the phone sheet with 44 px targets) |
| Head | `<h1 class="pk-head"><span class="pk-sprite pk-icon-tv" aria-hidden="true"></span>Share a video<span class="host">cooking.test</span></h1>` |
| Scanning | `<div class="pk-state" role="status"><span class="pk-sprite pk-glyph-dots-0 ui-dots" aria-hidden="true"></span>Looking for videos…</div>` |
| No video / can't read / server away | `<div class="pk-state"><img src="/popup/<vignette>.png" srcset="… 1x, …@2x.png 2x" alt="">line</div>` |
| Embeds list | `<fieldset class="pk-list"><legend>Videos on this page</legend>` + one row per embed |
| Embed row | `<label class="ui-qrow pk-embed"><input type="radio" name="embed"><span class="pk-sprite pk-glyph-radio-off"></span><span class="pk-sprite pk-qsrc-video\|live\|generic"></span><span class="body"><span class="title">YouTube</span><span class="meta">sunsetBay40</span></span><span class="ui-chip"><span class="pk-sprite pk-glyph-insync"></span>Synced</span></label>`. Generic: title = host, meta "Page embed", `ui-chip solo` + `pk-glyph-outsync` + "Not synced". `qsrc-live` for a Twitch channel. The checked row takes `queue-row-next` and the radio glyph turns on via CSS (`:has(input:checked)`, Chrome 105+ / Firefox 121+). |
| Room picker | `<label class="pk-room">Room<span class="pk-field"><select class="ui-input">…</select><span class="pk-sprite pk-chevron" aria-hidden="true"></span></span></label>` (native list; options get night + cream) |
| Keys | `<div class="pk-keys"><button class="ui-button">` + `pk-icon-share` "Share" `</button><button class="ui-button secondary">` + `pk-icon-queue-add` "Add to queue" `</button></div>`. Disabled while sending. |
| Success | `<p class="ui-sysline" role="status"><span class="pk-sprite pk-glyph-check"></span><span>Shared to <b>Movie night</b>.</span></p>` |
| Error | `<p class="pk-error" role="status"><span class="pk-sprite pk-icon-warn"></span>message</p>` (rust text + the warn icon) |
| Foot | `<footer class="pk-foot"><button class="pk-link" data-emphasis="true\|false">Server settings</button><span class="legal"><a>Privacy</a><a>Terms</a><a>Licences</a></span></footer>` |

Tokens in `kit.css`: `--ui-page` (popup background), `--ui-text`, `--ui-muted` (labels, host, meta), `--ui-accent` (Server settings),
`--ui-error`, `--ui-glow` (room name in the success line), `--ui-field` (option list), `--ui-on-primary`, `--ui-disabled-text`, and `--ui-px: 2px`.

## Sound recipes (`sound/recipes.json`, OME-1642)
WebAudio recipes as data, played by the room's engine (`apps/web/src/audio/`, OME-1638); the format (v1) is `apps/web/src/audio/FORMAT.md`. 14 names: `step.wood|carpet|tile`, `chair.sit|stand`, `door`, `ui.tick|toggle|error`, `pop`, `tone.warm|cool|night` (loop) and `swell`. Each `gain` is the mixed level at master volume 1. Checks: `bun test assets/src/sound.test.ts` (names, fields, ≤ 4 KB, a ≤ -12 dBFS bound, no audio files) and `bun assets/src/sound-meter.ts` (measured peak/RMS per sound, headless). Audition: serve the repo root and open `assets/preview/sound.html`. Look and mix: `STYLE.md`, *Sound palette*.

## Dank Dungeon (OME-1670, lazy): hotel-suite furniture, the preset, the bend-over / thrust emote

A tongue-in-cheek "dungeon" that is really a modern hotel suite after dark. **The room shell costs 0 B:** the honey planks are the wood
floor, the left wall's `window0`/`window1` pair is the big window, and the moody light is the existing `night` mood (OME-1502,
`layout.mood`, a multiplied `rgb(36 48 110 / 0.5)`). Previews: `preview/dungeon-room@1x.png` / `@2x` (the preset, full house, a pair
mid-emote on the runner) and `preview/dungeon-room-night@1x.png` / `@2x` (the same under the night mood, as the room shows it).

### Furniture v6 (`furniture/furniture-v6.png` + `.json`, 256×256, lazy)

A fourth lazy sheet with exactly the v4 schema (frame keys, anchors, `meta.omega.pieces`, `animations`, `useKey`; identical frames share
a rect). Load it only when a layout uses one of these. Like v4, nothing reads it until the hookup (OME-1672) adds the ids to `FURNITURE`.

| id | label | layer / mount | facings | colours | footprint |
|---|---|---|---|---|---|
| `bed` | Queen bed (seat, no front layer, a `cover` per sleeper; OME-1983) | object, floor | `ne nw se sw` | `velvet` (duvet, headboard, two pillows) | 2×2, 2 seats, 2 sleepers |
| `whirlpool` | Whirlpool (seat, front layer) | object, floor | `ne nw se sw` | `teal` | 2×1, 2 seats |
| `mirror` | Wall mirror | wall | `se sw` | `brass` | wall |
| `minibar` | Minibar | object, floor | `se sw` | `wood` | 1×1 |
| `desk` | Writing desk | object, floor, wall-backable | `se sw` | `wood` | 1×1 |
| `washbasin` | Washbasin | object, floor, wall-backed | `se sw` | `cream` | 1×1 |
| `partition` | Interior wall (OME-1959), with a `cut` stub | object, floor | `se sw` (axis) | `solid`, `glass` (= layout variant 0, 1) | 1×1 |

- **Bed:** low platform bed, plum duvet folded back over cream sheets, a mustard throw at the foot, and five pillows against a tufted
  headboard at the **anchor end** (local −x). So facing `ne` at `(0, r)` the headboard is on the left wall, facing `nw` at `(c, 0)` on the right
  wall: it reads wall-backed without being `wallBacked` in the contract. Sitters sit on the duvet (seat 0 among the pillows).
- **Whirlpool:** cream tub on a wood skirt, a towel roll and a rubber duck on the rim. The rim and the water **in front of each sitter**
  (toward the camera from that seat) are the `front` layer, so a sitter is in the water to the waist in every facing
  (`preview/furniture-v6-seats@2x.png`). **In use loop** (`use: { frames: 2, ms: 200 }`, intended trigger: someone sits in it): bubbles rise;
  swap `back` for `furniture/whirlpool/teal/use/<dir>/<n>` in place, `front` stays. The use frames are the back layer only (same rect and
  anchor as `back`), so the bubbles (2 px clusters, never on the rim) rise on the water behind the sitters; the water in `front` stays calm.
  (OME-1685: before that the frames were missing from `furniture-v6.json`; `src/dungeon.test.ts` now checks every animation frame exists.)
- **Mirror:** an oval 16 × 60 px, 70–130 px up, so it clears the 56 px wainscot and stands over a washbasin or desk. Bevelled brass
  frame (outer edge lit top-left, inner edge lit bottom-right), pale glass (the `glow` ramp) darker toward the bottom, two sheen streaks
  and the reflected lamp. OME-1685: it was a tall dark rectangle that read as a door or the night window. Plain wall segments only, like
  the framed print.
- **Minibar:** glass door lit from inside (bottles, cans), an ice bucket on top. **Desk:** brass lamp, notepad and pen. Both stand free
  or against a wall. **Washbasin:** backs onto its cell's wall like the bookcase (row 0 for `sw`, col 0 for `se`).
- Previews: `preview/furniture-v6-room@1x.png` / `@2x` (every piece, both facings, seats taken and free), `preview/furniture-v6-seats@2x.png`,
  `preview/furniture-v6-atlas@2x.png`. Tray thumbnails are in `ui/edit.png` (`thumb/<id>/<colour>`), like every catalogue piece.

### Partition: interior wall, glass, cut-down stubs (OME-1959)

For the two-compartment rework (spike OME-1957, phase A; contract kind `partition` from OME-1958). Source: `partition()` in
`src/furniture.ts`. Previews: `preview/partition-room@1x.png` / `@2x` (what everyone sees), `preview/partition-room-cut@1x.png` / `@2x`
(what a viewer whose avatar is in the bedroom sees), and `-night` versions of both under the room's night mood.

- **Facing picks the axis**, like the curtain: `sw` runs along a row (cells (c, r) side by side), `se` along a col. The wall is one room
  wall thick (4 px) through the middle of its cell, so a row of them reads as part of the shell.
- **`solid` (variant 0):** the room's own wall, painted by `wallPaint("plain")` from `src/room.ts`: wainscot with panel insets,
  lozenge paper, crown. Full `WALL_H` (212 px), so it hides the compartment behind it, like the real walls.
- **`glass` (variant 1):** a wainscot sill at mattress height (24 px) and a papered header from 150 px, each with a black frame. Open in
  between, with **one frosted stripe** at 110–114 px (above a standing avatar's head and the beds behind). It lines up from cell to
  cell, so a run of glass cells shows a single band through the whole window, not one stripe per pane. The pane itself is transparent
  pixels, so whatever stands behind it shows through as it is (no tint needed from the renderer).
- **Seamless runs:** a cell has no plum outline on its trailing end (local x = −8, the side the previous cell in the run is drawn on) and
  none round the stripe (`keepOutline` on the piece def). So a row has no seams; the one cost is a missing outline on the trailing edge
  of the cell right after a doorway gap, which nobody will see at 1×.
- **Cut stubs** (`furniture/partition/<solid|glass>/cut/<se|sw>`, `meta.omega.cutKey`, piece `cut: true`): the same wall sawn off at 16 px
  (`PARTITION_STUB`), so an avatar one row behind shows from the knees up. Solid: plain wainscot with a wood top. Glass: the sill with its
  black cap, so the window still reads. **Unlike a door's open frame, a stub has its own tight rect and anchor** (the same floor point),
  so draw it as its own sprite at the cell instead of swapping the texture into the tall one.
- **Doorway:** a plain gap in the row (OME-1958 dropped the doorframe variant). The wall ends show their wainscot end faces.

**The reworked preset's grid** (for OME-1960; `partitionPlan()` in `src/build.ts`, constants `PARTITION_ROW` / `PARTITION_GLASS` /
`PARTITION_DOOR`). The bedroom is the far compartment, so from the one camera of phase A the beds are what you see through the glass,
as the board described it:

| | cells |
|---|---|
| Partition | row 4, facing `sw`: `solid` at cols 0, 2; `glass` at cols 3–9 (OME-2023 round 2); **doorway gap at (1, 4)** |
| Bedroom (rows 0–3, behind the wall) | `bed (2,2) nw`, `bed (5,2) nw` (queens, 2×2: cols 2–3 and 5–6, rows 2–3, a one-col gap at col 4 so they read as two beds; both show whole through the glass, OME-2023); `desk (7,0) sw`, `minibar (9,0) sw`; `wingback (8,2) nw`; `neonsign (0,2) se`; the TV corner console (0,0) |
| Spa (rows 5–9, in front) | `whirlpool (2,7) ne`; `washbasin (0,6) se` under `mirror (0,6) se`; `wingback (7,7) nw` + `coffeetable (7,6) sw`; `arclamp (1,9) se`; `monstera (9,9) sw` |

Notes for the hookup: a far cell (c, r) shows above partition cell (c − r + 4, 4), so the queens on cols 2–3 and 5–6, rows 2–3 span partition
cols 3–5 and 6–8; the glass runs cols 3–9 so the right bed's far pillow isn't cut by a solid end (OME-2023); move the beds and the glass together. The TV console stays in the bedroom corner and is mostly hidden from the spa side, which is fine
because the video is page chrome (ADR 0012). The spa has no sauna cabin yet (a later piece, OME-1956's list). Cost: +2 722 B
(furniture-v6.png +2 106, its JSON +269 gz, `ui/edit.png` +220 for the tray thumbnail, two swatches `solid` / `glass` +127 gz in
edit.json and reference.css).

### Queen bed (OME-1983)

Board direction (OME-1977): beds are queens, not singles. The `bed` is now **2×2** (contract: OME-1982), in every colour (`velvet`, the only
one) and facing. Same look as the twin, twice as wide: a plum duvet folded back over cream sheets with a seam down the middle, a mustard throw
at the foot, **two big cream pillows** (one per sleeper), a plum and a mustard cushion and a teal bolster against the tufted headboard at the
anchor end (local −x). Previews: `preview/queenbed@2x.png` (each facing: empty, two sleepers, two sitters) and `preview/queenbed-room@1x.png` / `@2x`.

- **Footprint:** the anchor cell is the footprint's min corner, as for every piece (`sortByDir` (0, 16) in all four facings). In local
  coordinates the bed spans x −8..24 (the length) and y 0..16 facing `ne`/`nw` but −16..0 facing `se`/`sw` (`toWorld` flips y there).
- **Seats** (`seatsByDir`, 2): side by side on the bed's **front half** (−y, the half the bed faces), like the twin's: `ne` (0,0) (1,0),
  `nw` (0,0) (0,1), `se` (1,0) (1,1), `sw` (0,1) (1,1) as `{col, row}` from the anchor. Sitters face the piece's way, drawn as on any seat.
- **Sleepers** (two, side by side along the length, heads on the pillows): the `sleep` pose in `avatars/lying.json`
  (`sleep/<avatar>/<dir>/<0|1>`, all four facings; nw is se's frame and ne is sw's, sharing a rect). Each shows the face, eyes shut; the body is
  under the duvet. Where to draw them: `lying.json` `meta.omega.sleepers.bed` (not `pieces`, which the web pins to the contract's `lie`/`curl` kinds; move it there with the wiring, OME-1984): `dirs` is sleeper 0 (on the seats' half), `beside` sleeper 1,
  screen px from the bed's anchor to the frame's floor point (`sleepFloorPoint` (13, 30) in the cell, mirrored for sw/ne; each frame's `anchor` holds it).

  | sleeper | ne | nw | se | sw |
  |---|---|---|---|---|
  | 0 (`dirs`) | (16, 1) | (−16, 1) | (16, 17) | (−16, 17) |
  | 1 (`beside`) | (−16, 17) | (16, 17) | (−16, 1) | (16, 1) |

- **Covers:** `furniture/bed/<colour>/cover/<dir>/<sleeper>` (`meta.omega.coverKey`): the duvet pulled up over that sleeper's half, a soft
  mound from the shoulders to the foot. Same rect and anchor as `…/<dir>/back`, so draw it at the bed's anchor. **Draw order** at the bed's sort
  point: `back`, then per sleeper, the one with the smaller screen y first: its `sleep` frame, then its `cover`. An empty half has no cover.
- The empty bed looks the same whether or not someone sits on it; only sleepers pull a cover up.
- `layersByDir` for the bed is now `["back"]` in every facing. Before, the frame filter matched the id `bed` itself and listed no layers.
- **Bytes** (`bun assets/src/build.ts`): +6 234 B (396 504 → 402 738 of 409 600), all lazy: `furniture-v6.png` +3 109 (12 475 → 15 584,
  the sheet grows to 256×2048), its JSON +148 gz, `lying.png` +2 427 (6 457 → 8 884) and its JSON +553 gz (lying total 10 732 of its 12 KB),
  `ui/edit` −29 (the tray thumb keeps the twin's 43×34 rect, so the sheet doesn't repack and the eager `reference.css` is byte-identical).
  `presets/thumbs/dank-dungeon.png` +26 (it draws the new bed). Every other frame in v6, lying and edit is pixel-identical.
- Not mine to change: the Dank Dungeon preset still places two 2×1 beds (`bed (4,0) nw`, `bed (0,3) ne`) and says "Twin beds". OME-1982
  moves them to the 2×2 footprint.

### The preset (draft for OME-1672)

`presets/` validates every layout against `FURNITURE`, so the preset can't ship there before the hookup. Its layout is `DUNGEON_PRESET` in
`src/build.ts` (rendered in `preview/dungeon-room*`); move it into `src/presets.ts` once the kinds exist:

- id `dungeon`, name **Dank Dungeon**, blurb "Twin beds, a whirlpool for two, lights down.", `mood: "night"`.
- Pieces: `tv (0,0) se`; `bed (4,0) nw`, `bed (0,3) ne`; `wingback (7,2) nw`, `wingback (7,4) nw` with `coffeetable (7,3) sw` (the sitting corner);
  `whirlpool (2,7) ne`; `desk (7,0) sw`, `minibar (9,0) sw`; `washbasin (0,7) se` under `mirror (0,7) se`; `neonsign (0,2) se`; `arclamp (1,5) se`;
  `runner (4,4) nw` variant 1; `monstera (9,9) sw` variant 1.
- 8 seats, all facing the TV corner: both beds (2 each), the tub (2), the two wingbacks. Nothing on wall segments 5, 6, 8; the middle diagonal stays clear.

### Two-compartment rework: concept (OME-1956, not shipped)

Board ask (OME-1664): split the room into a bedroom and a spa with an interior wall, a doorway and a glass panel; walking through the
door swaps your view between "from the south" (bedroom up close) and "from the north" (spa up close). Concept renders, both palettes:
`preview/dungeon2-south@1x.png` / `@2x`, `preview/dungeon2-north@1x.png` / `@2x`, plus `-night` versions (the room's `night` mood).
Source: `src/dungeon2-concept.ts` (`bun assets/src/dungeon2-concept.ts`; writes only those previews).

- **Plan:** interior wall on the row 4/5 line. Bedroom rows 5–9 (two beds headboard-to-glass, nightstand, desk with lamp, a bar
  fridge on its own, a flat TV on the corner console, pink neon, an oval rug in front of the doorway, two wingbacks round a coffee table).
  Spa rows 0–4 (sauna cabin in the corner, round cedar tub, whirlpool, recliner, two washbasins under a big mirror). Glass cols 3–8
  (u 36–128, z 16–150): wide enough that both beds, feet included, show whole from the spa. Black frame, one pale stripe across the
  pane's top-left corner (clear of the beds), leaning the same way in both views. Doorway col 1; the rug sits on its line of sight.
- **North view = the same room turned 180°.** `Kit` takes `turned` (`src/furniture.ts`): the same 3D model spun about its anchor, so
  every piece's far side is re-cast, not redrawn. Walls nearest the camera are not drawn in either view (Habbo-style cut-away); each view
  draws its own two back walls. The far compartment is drawn only through the glass and the doorway, at full colour with its dark
  carpet one tone lighter so the beds stand out; no haze (the frame and the stripe say "glass").
- **Wood panelling:** pale oak (`floor` ramp) in the bedroom, smoked wood (`wood`) in the spa, a warm cove strip under the top, and the
  old dungeon's purple wainscot under a wood rail so the room still belongs to the set. Floors: dark carpet with gold veins, slatted deck.
- **Pieces that must read at 1×:** sauna in pale cedar (lighter than the wall) with a front window onto the bench, the glowing stone
  heater and wisps of steam, and a glazed bronze door with a long handle; TV is a flat screen (dark bezel, navy screen lit low in teal, a
  glint, a power light); the fridge is a cream bar fridge with freezer seam and handles; the mirror is a silver pane in a chunky brass
  frame with the deck and the sauna faintly reflected and two sheen streaks.
- **Night is a lighting pass, not a filter:** everything drops to the dark ramp, then light comes back from sources. Lamps throw a pool
  onto bare floor (lit pixels also rise one tone, so a pool reads on the dark carpet); wall lights (neon, mirror) halo the wall; the cove
  strip glows and washes down the walls; glass and doorway take a warm tint; glow, ember and neon colours light themselves; the TV
  screen stays lit. Pools stop at furniture (a "covered" mask), so no disc paints across a piece. The renderer would do the same with a
  light layer (additive sprites masked to floor and walls); the concept builds its own indexed palette for it.
- All existing ramps, no palette change.

### Furniture v7: the reworked room's asset set (`furniture/furniture-v7.png` + `.json`, 512×1024, lazy, OME-1977)

The shippable pieces for the two-compartment room. They follow the OME-1959 grid: the bedroom is behind the row-4 interior wall,
the spa is in front. The sheet uses the v4 schema. The PNG is 15.5 KB and the JSON is 1.9 KB gzipped, inside ADR 0056's ≈21 KB.
Load the sheet only when a layout uses one of these pieces. Nothing reads it until the hookup adds the kinds to `FURNITURE`; the
atlas shape and turned frames are with the Lead on OME-1978.

v7 also holds **single colours of older kinds** (`V7_COLOURS` in `src/furniture.ts`). The older sheets keep their own frames,
byte-identical. v7's `meta.omega.pieces` lists only the new colours, so look a frame up by key across the loaded sheets.

| id | colour | label | layer / mount | facings | footprint |
|---|---|---|---|---|---|
| `sauna` | `cedar` | Sauna cabin | object, floor, backs onto a wall | `se sw` | 2×2 |
| `soaktub` | `cedar` | Cedar soaking tub (seat, front layer) | object, floor | `se` (round) | 2×2, 2 seats |
| `lounger` | `teak` | Spa lounger (seat) | object, floor | `ne nw se sw` | 2×1, 2 seats |
| `tv` | `flat` | Flat TV on the corner console (variant 1 of `tv`) | object, cell (0,0) | `se` | 1×1 |
| `mirror` | `silver` | Tall mirror (variant 1) | wall | `se sw` | wall |
| `minibar` | `fridge` | Bar fridge (variant 1) | object, floor | `se sw` | 1×1 |
| `carpet` | `oval` | Oval velvet rug (variant 1) | floor | `se` | 2×2 |
| `partition` | `panel`, `panelglass` | Panelled interior wall, solid and glass (variants 2, 3) | object | `se sw` | 1×1, with cut stubs |

The judge's five notes from OME-1956, and where each is fixed:
- **Mirror:** a thin brass frame round a cool blue-grey pane (`glow`, lighter at the top), one soft diagonal sheen and a faint head
  and shoulders reflected in it. There's no beige. It fills one wall segment, so hang two side by side over a pair of basins.
- **Sauna at 1×:** the door faces into the room (local front). It is glazed and lit, with light spilling from under it onto the
  floor, a curl of steam over it and a thermometer beside it. The side has a window onto a **two-tier slatted bench**, drawn dark
  against the glow so it reads as a silhouette, and a **stone-topped heater**: an iron box, grey stones with embers between them,
  and steam pixels rising.
- **Glass stripe:** `panelglass` moves the stripe up to z 133–135, 2 units thin, just under the header. It is clear of the beds,
  the tub and anyone standing behind the pane. The `glass` variant (OME-1959) is unchanged. The warm night tint is a renderer
  question (the pane is transparent pixels); see OME-1978.
- **Bedroom carpet:** `floor/carpet/*` uses a taupe tweed (`charcoal` 0 flecked with `wood` 2) instead of the concept's
  `charcoal` 1. That's one step lighter and warmer. Its gold veins run in short stretches, not a full lattice.
- **Lounger:** the north view's "treadmill" is now a spa lounger: a teak frame on four legs, a thick cream mattress with a raised
  back, a rolled teal towel at the head and a folded one at the foot. The wall's night dither is a 2-row wash under the cove strip.

**Shell skin** (in the same sheet). The rects and anchors are exactly those of the room atlas frames named in brackets, so the
renderer only swaps keys:
- Walls: `wall/l/{oak,smoke,split}` [`wall/l/plain`] and `wall/r/{oak,smoke}` [`wall/r/plain`]. `split` is the left-wall segment
  the interior wall meets: oak behind its midline, smoked in front.
- Corner and ends: `wall/corner/oak` [`wall/corner`], `wall/l/end/smoke` [`wall/l/end`], `wall/r/end/oak` [`wall/r/end`].
- Floors: `floor/{carpet,deck,split}/{0,1}` [`floor/0`]. `split` is carpet behind the partition's midline and deck in front. The
  tiles repeat every 16 units, so any tile joins any other.

The panelling (`panelPaint` in `src/room.ts`) is the concept's, unchanged: a dark skirting, the old dungeon's purple wainscot
under a wood rail, boards with a seam every 16, and a warm cove strip under the crown. Oak (the `floor` ramp) is the bedroom and
smoked wood (`wood`) is the spa.

The grid in the preview (`dungeon2Plan` in `src/build.ts`) is OME-1959's partition row, with `panel` cells, `panelglass` at
cols 5–8 and the doorway at col 1. The other pieces:
- Bedroom: `tv/flat (0,0)`, beds `(2,0)` and `(4,0) nw`, `desk (7,0) sw`, `minibar/fridge (9,0) sw`, `wingback (8,2) nw`,
  `neonsign (0,1) se`, `carpet/oval (0,2)` in front of the doorway.
- Spa: basins under `mirror/silver` at `(0,5)` and `(0,6) se`, `sauna (0,8) se`, `soaktub (3,6) se`, `whirlpool (6,8) ne`,
  `lounger (8,5)` and `(9,5) nw`, `monstera (9,9) sw`.
- Shell: `floor/carpet` on rows 0–3, `floor/split` on row 4 and `floor/deck` on rows 5–9. On the left wall, `oak` on rows 0–3,
  `split` on row 4 and `smoke` on rows 5–9. The right wall is all `oak`.

Previews:
- `preview/dungeon2-room@1x.png` / `@2x`, `-night` (the `night` mood) and `-cut` (a viewer in the bedroom).
- `preview/furniture-v7-room@1x.png` / `@2x`: every piece in each facing, seats taken and free.
- `preview/furniture-v7-seats@2x.png` and `preview/furniture-v7-atlas@2x.png`.
- Tray thumbnails and swatches: `ui/edit.png`, `thumb/<id>/<colour>` and `swatch/<colour>`.

**Night pane masks** (OME-1994): `furniture/partition/<glass|panelglass>/pane/<se|sw>`, in v7 for both glass colours (v6 stays
byte-identical). Each is an opaque amber fill (`mustard` 1) of exactly the pane pixels the glass `<dir>/back` frame leaves
transparent. It has that frame's rect and anchor, so draw it at the same spot over the back frame, at about 20% alpha, in the
`night` mood only. The frosted stripe, sill and header aren't in the mask. The tray chip for `tv` variant 1 is `swatch/flat`: a
charcoal bezel round a dark screen with one glint, on its stand.

### Back views for the 180° view swap (`furniture/furniture-back.png` + `.json`, lazy, OME-1997)

For OME-1961: a viewer in the bedroom sees the room from the north, every cell `(c, r)` at `(9 − c, 9 − r)`. Facings turn
`se → nw`, `sw → ne` (and back). Pieces with all four facings already have their art. The one-sided (CAMERA/FIXED) pieces of the
Dank Dungeon get their far side here, rendered from the same 3D models turned 180°. **Preload this sheet with a layout that has a
partition**, so the swap never waits on a fetch. It's 10.9 KB PNG + 1.2 KB JSON gz; the art total is 409 473 B of 409 600.

**Keys:** the usual `furniture/<id>/<colour>/<nw|ne>/<back|front>`. Every frame is anchored on the **footprint's min corner**,
like every other frame, and its footprint is the source facing's (`footprintByDir[se]` for `nw`). So a piece at `(c, r)` with
footprint `cols × rows` draws at `(9 − c − (cols − 1), 9 − r − (rows − 1))`. Layers and seats carry over: the cedar tub's `nw`
has `back` + `front`; a seat `(col, row)` becomes `(cols − 1 − col, rows − 1 − row)` facing `TURN[dir]`.

| `<id>/<colour>` | turned frames | what you see from behind |
|---|---|---|
| `tv/charcoal` (variant 0, the room's projector console) | `nw` | the console's two hardboard back panels meeting at the near corner, on its plinth on the floor; a cable hatch, vent slots, a blank label, cables dropping to the floor; the projector's back (vent grille, power socket) under its two reels |
| `tv/flat` (variant 1) | `nw` | the same console; the flat TV's matte back with a raised housing, vents, ports and the stand's neck, its cables over the lip and into the hatch |
| `desk/wood`, `minibar/wood`, `washbasin/cream`, `arclamp/brass` | `nw ne` | the models' plain backs (the arc lamp's arm swings the other way) |
| `minibar/fridge` | `nw ne` | a black condenser coil on its back |
| `sauna/cedar` | `nw ne` | the boarded back and side, a louvred vent under the roof trim |
| `soaktub/cedar` | `nw` (+ `front`) | the tub turned round, its bucket and ladle on the far side |
| `partition/panel`, `partition/panelglass` | `nw ne` | the bedroom side, in the bedroom's **oak** (the spa side stays smoked) |

**No back view (draw the source facing's own frame):** pieces that look the same from behind: `carpet/oval`, `monstera`, `plant`,
`coffeetable`, the papered `partition/solid` and `partition/glass` (same paper both sides), `rug`. The same fallback covers any
other one-sided piece someone places in a partitioned room, until it gets a back view. **Wall pieces** (mirror, neon sign, frames)
hang on the left/right walls, which are the near walls from the north and aren't drawn, so they go with them: the silver mirror
has no north look (where it does show, from the south, it is the shipped cool blue-grey pane in a thin brass frame).

**North shell skin** (same sheet; rects and anchors as the room atlas's): from the north the spa walls are at the back.
- `wall/l/split/north` (smoked behind the midline, oak in front), `floor/split/north/{0,1}` (deck behind, carpet in front).
- `wall/corner/smoke`, `wall/l/end/oak`, `wall/r/end/smoke`.
- With the partition on row `p` (north row `9 − p`): the left wall (the old right wall, `col 9`) is `smoke` before the partition
  row, `split/north` on it and `oak` after; the right wall (the old south wall) is all `smoke`; floors `deck`, `split/north`, `carpet`.

Previews: `preview/dungeon2-room-north@1x.png` / `@2x` and `-night` (`dungeon2North` in `src/build.ts`), and
`preview/furniture-back-atlas@2x.png`.

**Anchors (OME-1999):** every frame of the 2×2 `sauna` and `soaktub`, front (`se`/`sw`, v7) and back (`nw`/`ne`), stands on its
contract footprint: the anchor cell's centre, the footprint growing toward +col/+row (`footprintCells`). The soaking tub leans
toward its two seats (the footprint's back row, col 0 facing `se`) so both sitters are in the water; its bucket is on the near corner.
`src/dungeon2.test.ts` pins this on the shipped sheets.

### Emote poses (`avatars/dungeon.png` + `.json`, 256×512, lazy)

Room-only meme emote, slapstick and fully clothed: **`bendover`**, bent 90° at the waist, hands on knees, grinning back at the camera
(Kiki parks her popcorn on the floor); **`thrust`**, a silly hip-thrust dance standing just behind the partner, 3 frames played
`0 1 2 1` at 110 ms (`meta.omega.thrust`, Pixi `animations["thrust/<avatar>/<dir>"]`). Built from each avatar's own idle frame (head,
hair, hat, shirt and shading are theirs), so the four stay as distinct as in set (a).

| Key | Cell | Anchor | Draw |
|---|---|---|---|
| `bendover/<avatar>/<se\|sw>/0` | 48×64 | the bender's floor point (24, 61) for `se`, (23, 61) for `sw` | at the bender's cell centre, its normal depth |
| `thrust/<avatar>/<se\|sw>/<0-2>` | 48×64 | **the partner's** floor point (38, 61) for `se`, (9, 61) for `sw` | at the **partner's** cell centre, just behind the partner (zIndex − 0.5) |

- One sheet row per avatar × dir (`juno se`, `juno sw`, `pip se`, …); per row bend, thrust 0, 1, 2. The web reads rects from the JSON.
- **Facings:** front views only (`se`, `sw`). Turn both avatars to the same front facing for the emote (the nearer of `se`/`sw` to the
  bender's facing). The thruster's own feet are drawn at `meta.omega.thrust.feetOffset` (−13, −6) px from the partner's floor point
  (mirror x for `sw`): about a third of a tile up-left, on the floor plane. Because the frame is anchored on the partner, the thruster's own
  cell (behind, or the nearest free one) doesn't change the picture.
- **Tints and hair colours** apply: `dungeon.png` is listed in `tints.json` and `hairs.json` `sheets` (same PLTE slots).
- Shortcut: no theme hat or accessory overlays exist for these keys, so a hat hides for the few seconds of the emote. Add them if it shows.
- Preview: `preview/dungeon-poses@4x.png` (per avatar and dir: idle, bend, thrust 0–2, then the pair at thrust 0 and 2).

**Bytes** (`bun assets/src/build.ts`): **+17 159 B**, 308 788 → 325 947 (OME-1685 polish: +2 926 B, → 328 873, nearly all the 8 whirlpool use
frames that were missing), under the 400 KB cap of ADR 0056. Lazy: `furniture-v6.png` +
`.json` gz, `avatars/dungeon.png` + `.json` gz, `edit.png` / `edit.json` gz for 6 thumbnails. **Eager: +154 B**, the six `.ui-thumb-*`
rules in `reference.css` (gz), the same per-piece cost every catalogue batch has paid.

## Lying pose (`avatars/lying.json`, OME-1687, lazy)

Someone stretched out on a sofa, or curled up in the cat's bed while the cat is out walking. Built from the set (a) idle frame,
so hair, clothes, shading and outline are the avatar's own (fully clothed): the body turns 90° in the picture plane (lying on its
side, front to the camera, **eyes shut**), the torso and legs shear onto the 2:1 axis the seats run along, and the head stays a
rigid block lying flat on the armrest. Previews: `preview/lying.html` (every facing on each piece, a room at 1×/2×, the strip).

- **Queen bed (OME-1983):** `sleep/<avatar>/<ne|nw|se|sw>/<0|1>`, head up on the pillows, under a duvet; see *Queen bed* above.
- **Keys:** `lie/<avatar>/<se|sw|ne|nw>/<0|1>` (the sofas, the same four facings as `sit`; se/sw show the face, ne/nw the back
  over the backrest, like a sitter from behind) and `curl/<avatar>/<se|sw>/<0|1>` (the cat bed, its two facings; the shins tuck in
  so the body fits the cushion). **Animations:** `lie/<avatar>/<dir>` and `curl/<avatar>/<dir>`: a 2-frame breath, frame 1 lifts the
  flank 1 px, 1 400 ms then 1 000 ms (`meta.omega.anims`), the same clock as the standing breathe.
- **Cell 50×34**, wider than the 32×64 avatar cell because a lying body runs along the floor diagonal. **Floor point (36, 26)**
  (se/nw; sw/ne are mirrored, so (13, 26)): the point on the cushion under the hips. Each frame's `anchor` already holds it.
  Mirrored facings are re-shaded in the sheet: play each facing's own frames, never `scale.x = -1`.
- **Where to draw it** (`meta.omega.pieces`): put the frame's anchor at the piece's anchor (its anchor cell's centre, where its
  `back` frame is drawn) plus this offset in screen px (1×), lift included. Draw it between the piece's `back` and `front`
  layers, sorted at the piece's sort point (`sortByDir`), exactly like a sitter. One lier takes the whole piece (both seats).

  | piece | style | under it | se | sw | ne | nw |
  |---|---|---|---|---|---|---|
  | `sofa` (club sofa) | `lie` | `…/<dir>/back` + `front` | (−4, 4) | (4, 4) | (4, 1) | (−4, 1) |
  | `couch` (lounge couch) | `lie` | `…/<dir>/back` + `front` | (−4, 4) | (4, 4) | (4, 1) | (−4, 1) |
  | `cat` (cat bed) | `curl` | `furniture/cat/<colour>/bed/<dir>` (the empty bed) | (12, −2) | (−12, −2) | n/a | n/a |

- **Headwear:** each avatar's own headwear is drawn into the frames (Pip's beanie and Mo's bucket hat, turned sideways), so
  show the frame as is. There are no lying frames in the theme or accessory hat overlays: hide those overlays while lying. **Tints and hair colours:** `lying.png` uses the same
  PLTE as `avatars.png` (a test guards it), so apply the `tints.json` / `hairs.json` slots to it for that avatar's frames. It is not
  added to those tables' `sheets` lists, so the eager files stay byte-for-byte frozen.
- **Bytes:** `lying.png` 6 457 + `lying.json` 1 308 gz (level 9, as `build.ts` measures) = **7 765 B** of the 12 KB (12 288 B) allowance, all lazy; no other shipped
  file changes. Measured art total (after merging main, OME-1670/1631): **367 992 B of 409 600**.

## Wave 2: wall screens, ambient loops, penthouse + studio (OME-2066, ADR 0058, lazy)

The shipped version of the OME-2062 concepts the board passed (`preview/c2062-README.md`). Source: `src/wave2.ts`. It uses the same
67-colour palette (no new colours), the same Kit / iso ray-caster, the plum outline and the top-left light. Two new lazy sheets, PixiJS
v8 atlases in the v4 schema (`meta.omega.pieces`, `animations`). Everything else under `assets/` is byte-identical.

| file | what | bytes |
|---|---|---|
| `furniture/furniture-v8.png` + `.json` | the new pieces, their loops, their back views, 2 turned shipped pieces, tray thumbnails | 29 303 + 3 215 gz |
| `furniture/furniture-v8-shell.png` + `.json` | penthouse and studio shell skin, split floors, the near-wall stubs | 6 623 + 695 gz |
| **total** | `main` 415 398 → **455 234 B of 460 800** (+39 836, all lazy; eager unchanged at 109 617) | |

**Both v8 sheets are packed tight (OME-2078):** their height is the packed height, not the next power of two (512×736 and 512×233;
Pixi v8 takes non-power-of-two textures, and nothing mipmaps them), and their PNG rows use filter Up, which suits stacked loop frames.
That freed 4 258 B (v8 −1 264, v8-shell −2 994 with the x-ray patches gone). Other sheets keep their power-of-two size and filter None.

**Load:** `furniture-v8` when a layout uses one of its kinds or colours. `furniture-v8-shell` with `shell: "penthouse"` or `"studio"`
(together with v7 and furniture-back, like the dungeon).

### Pieces (`furniture/<id>/<colour>/<dir>/back`)

| id / colour | variant | label | layer | facings | footprint | loop (`use`) |
|---|---|---|---|---|---|---|
| `wallscreen/panel` | 0 (new kind) | Wall screen: a 56 × 36 px panel on a bracket, soundbar | wall | se sw | wall, **span 2** | none |
| `projector/cloth` | 0 (new kind) | Pull-down screen: a lit cloth, black border, pull tab, case | wall | se sw | wall, **span 3** | none |
| `tripod/charcoal` | 0 (new kind) | Projector on a tripod | object | ne nw se sw | 1×1 | none |
| `window/sky`, `window/rain` | 0, 1 (new kind) | Window: dusk clouds drift and a star blinks / rain streaks and drops | wall | se sw | wall | 4 × 260 ms |
| `longclock/wood` | 0 (new kind) | Long-case clock: the pendulum swings | object (backs onto a wall) | se sw | 1×1 | 4 × 250 ms |
| `lavalamp/lilac` | 0 (new kind) | Lava lamp: two blobs rise and sink | object | se | 1×1 | 4 × 320 ms |
| `sidetable/mug` | **1** | Snack table, the mug steaming | object | se sw | 1×1 | 4 × 180 ms |
| `barcounter/espresso` | **1** | Espresso bar: two cups steaming | object | se sw | 2×1 | 4 × 160 ms |
| `barcounter/kitchen` | **2** | Kitchenette: the pot steaming | object (backs onto a wall) | se sw | 2×1 | 4 × 160 ms |
| `speaker/jukebox` | **2** | Jukebox: light tubes chase round the arch | object | se sw | 1×1 | 4 × 150 ms |

- **Colours of older kinds** follow v7's pattern. v8's `meta.omega.pieces` lists only its own colours, and the variant is fixed
  (`V8_COLOURS` in `src/wave2.ts`): `sidetable/mug` 1, `barcounter/espresso` 1, `barcounter/kitchen` 2, `speaker/jukebox` 2. The
  web needs a `V8_COLOURS` table beside `V7_COLOURS`.
- **Ambient loops** use the shipped `use` schema: `furniture/<id>/<colour>/use/<dir>/<n>`, n = 0..3, frame time in
  `pieces[].use.ms`. Frame 0 equals `back` and shares its rect. Each loop's frames share one rect (the union of the frames), so they
  share one anchor and a loop is a texture swap. The new flag **`pieces[].ambient: true`** means "run the loop always (gated, ADR 0058
  §2)", not only while the piece is in use. ADR 0058 proposes `…/<dir>/loop/<n>`. I kept `use/` so that the shipped loops the
  revamps reuse cost 0 bytes: **fireplace** (4 × 120), **neonsign** (3 × 140) and **aquarium** (3 × 220). The web marks those
  three as ambient by kind.
- **Wall span** (`pieces[].wallSpan`, ADR 0058 §1): the frame's anchor is the anchor segment, as for `frame`. The art hangs centred on
  the covered segments, 8 × (span − 1) units toward +row (se, left wall) or +col (sw, right wall). Draw it at the anchor cell like
  any wall piece, with no extra offset.
- **Projector beam** (lounge): not a sprite. It is a sparse dither of `glow` 0 (every 4th pixel, `(x + 2y) % 4 == 0`) over the hull from the
  tripod's lens to the cloth's four corners, outside the cloth. Draw it once as a cached `Graphics` between the floor/wall layers and
  the object layer, so seats, the tripod and avatars cover it and it starts at the lens. The reference is `beam()` in
  `src/wave2.ts`.
- **Tray thumbnails** `thumb/<id>/<colour>` are in v8 itself, not in `ui/edit.png`, so the eager `reference.css` doesn't grow.
  Same fit rules as set (h): ≤ 44×40, anchored on the visual centre.

### Back views (swapped view)

These follow the furniture-back rules: keys `furniture/<id>/<colour>/<nw|ne>/back`, anchored on the turned footprint's min corner.
- `wallscreen/panel`, `projector/cloth` (wall): the panel's matte back with the VESA plate and vents, and the cloth's blank back under its
  case. A wall piece at segment `s` with span `n` turns to segment `9 − s − (n − 1)` on the **near** wall: col 9 for se → nw,
  row 9 for sw → ne. Draw it there as a ghost: every other pixel, or ~50% alpha, with nothing behind it (OME-2078 dropped the x-ray
  wall patch: it hid the sitters in front of it). This is the swapped-view rule (`preview/w2-screen-*-north`).
- `barcounter/kitchen`, `speaker/jukebox`: turned objects.
- Turned shipped pieces for the swap rooms, in v8 because furniture-back is at its 12 KB allowance: `aquarium/teal`, `bookshelf/wood`.
  Round pieces (`sidetable` in both colours, `coffeetable`) have no back view: draw the source facing.

### Shell skin (`furniture-v8-shell`, the room atlas's rects and anchors, as v7's skin)

- Penthouse terrace: `wall/l/sky/{0,1}`, `wall/r/sky/{0,1}` (alternate by segment: `i % 2`), `wall/l/sky/split` (sky behind the
  partition's midline, smoked panel in front), `wall/l/sky/split/north`, `wall/corner/sky`, `wall/l/end/sky`, `wall/r/end/sky`. The
  lounge uses v7's `wall/l/smoke`, `wall/l/end/smoke`. North: v7/back's `wall/r/smoke`, `wall/corner/smoke`, `wall/r/end/smoke`.
- Floors: `floor/pent/{0,1}` (deck behind, planks in front), `floor/pent/north/{0,1}`, `floor/nook/{0,1}` (carpet | planks),
  `floor/nook/north/{0,1}`. The rest are v7's `floor/deck/*`, `floor/carpet/*` and the room's planks.
- The studio keeps the room's papered walls, and its glass stripe is v6's papered `partition/glass` (variant 1). The penthouse uses
  v7's `panelglass` (3) with a `panel` (2) end.
- Near-wall stubs: `wall/stub/u` (one segment of the +u edge, drawn at `(9, i)`) and `wall/stub/v` (at `(i, 9)`). This is the partition's 16 px cut
  stub run along both near edges in a swapped view.

### Proposed layouts (`preview/w2-layouts/<id>.json`, contract-shaped)

The five revamps (`classic`, `living`, `lounge`, `cafe`, `bar`) are the shipped preset minus the corner console, plus the screen and
ambient pieces. Seats are unchanged, so each keeps its 8. The lounge's pull-down screen covers segments 2–4 (5 is a window
segment), and its print moves to segment 7. Two new presets: `penthouse` (`shell: "penthouse"`) and `studio` (`shell: "studio"`),
both on OME-1959's grid (partition on row 4, doorway at col 1).

**Open contract points for the Lead** (these are proposals, nothing is wired):
1. New kinds `wallscreen`, `projector` (screens, ADR 0058), `tripod`, `window`, `longclock`, `lavalamp`, and variant counts
   `sidetable` 2, `barcounter` 3, `speaker` 3.
2. **Fixture segments in a skinned shell.** In both swap rooms the front room has only left-wall segments 5–9, and 5, 6 and 8 are
   `WALL_FIXTURE_SEGMENTS`. A span-2 screen can't hang there. The skin draws no window, poster or sconce, so I propose fixtures only
   for the default shell. The proposals hang the screen at (0, 7) (penthouse) and (0, 8) (studio) on that basis.
3. One screen per room stays. From the far side of the partition the screen shows as its ghosted back on the near wall. The concept's
   "a screen per side" would need either a second screen or the web repeating the screen's front on the far wall. That decision
   is the web's (ADR 0058 §1), and no new art is needed for either option.

Previews: `w2-<preset>@1x/@2x.png` + `@1x.apng` (every loop on its own clock), `w2-penthouse-{south,north}`,
`w2-studio-{south,north}`, `w2-screen-{wallscreen,projector}-{south,north}`, `w2-ambient-strip@4x.png`, and
`furniture-v8-atlas@2x.png` / `furniture-v8-shell-atlas@2x.png`.

**Budget levers, if the next set needs room:** move the tray thumbnails to a runtime-scaled `se` frame (−2.3 KB); make the espresso
and jukebox one facing (about −2.8 KB, but needs per-variant facings); a single skyline (−0.6 KB); or loops as small overlay sprites
in place of whole-piece frames (an engineering change: the espresso, kitchenette and jukebox loops repeat the whole piece for a few
moving pixels).

## Budget

**One basis, used everywhere in this README:** bytes on the wire. PNGs count as stored, and text files (JSON, CSS) count gzipped at level 9.
The total covers every file under `assets/` that ships, eager and lazy. `bun assets/src/build.ts` prints exactly these numbers (its last two lines
are the lazy/eager split and the total). Previews and `src/` don't ship and aren't counted.

| File | Bytes |
|---|---|
| `avatars/avatars.png` | 4 426 |
| `avatars/avatars.json` | 24 075 raw / 1 492 gz |
| `avatars/motion.png` (sets d + l, lazy) | 18 335 |
| `avatars/motion.json` (sets d + l, lazy) | 117 095 raw / 5 032 gz |
| `avatars/expressions.png` (set p, lazy) | 10 863 |
| `avatars/expressions.json` (set p, lazy) | 67 102 raw / 2 789 gz |
| `room/room.png` | 8 335 |
| `room/room.json` | 13 823 raw / 1 192 gz |
| `ui/ui.png` (sets c + e + M1b TV frame + M2 live + f + h + i + j + k + l) | 12 951 |
| `ui/ui.json` (sets c + e + M1b TV frame + M2 live + f + h + i + j + k + l) | 91 380 raw / 4 905 gz |
| `ui/edit.png` (set h, lazy, owners only) | 10 792 |
| `ui/edit.json` (set h, lazy) | 24 030 raw / 1 653 gz |
| `ui/slices/*.png` (100 files, palettes trimmed to the colours used) | 15 862 |
| `ui/popup/*.png` (set f) | 409 |
| `ui/scenes/*.png` (sets i + j + k + OME-841, lazy) | 3 556 |
| `ui/reference.css` (if ported as-is) | 102 130 raw / 20 369 gz |
| `furniture/furniture.png` (set g, lazy, M4/M5) | 21 930 |
| `furniture/furniture.json` (set g, lazy) | 37 570 raw / 2 418 gz |
| `furniture/furniture-v2.png` (catalogue v2 + v3 + use loops + door, lazy) | 23 415 |
| `furniture/furniture-v2.json` (catalogue v2 + v3 + use loops + door, lazy) | 2 958 gz |
| `furniture/furniture-v4.png` + `.json` (batch 6, OME-1437; + pad, OME-1546; lazy) | 19 477 + 1 915 gz |
| `furniture/furniture-v5.png` + `.json` (theatre set v2, OME-1639, lazy) | 8 810 + 1 335 gz |
| `furniture/recolours.json` (OME-1462 + OME-1500 + OME-1688, recolour table, lazy) | 7 713 raw / 1 159 gz |
| `themes/halloween/halloween.png` (OME-1185, lazy) | 3 513 |
| `themes/halloween/halloween.json` (OME-1185, lazy) | 152 659 raw / 3 740 gz |
| `themes/sinterklaas/sinterklaas.png` + `.json` (OME-1187, lazy) | 2 799 + 3 597 gz |
| `themes/christmas/christmas.png` + `.json` (OME-1187, lazy) | 2 280 + 3 309 gz |
| `themes/valentines/valentines.png` + `.json` (OME-1187, lazy) | 1 117 + 3 224 gz |
| `themes/easter/easter.png` + `.json` (OME-1187, lazy) | 2 890 + 3 532 gz |
| `accessories/accessories.png` + `.json` (OME-1388 + OME-1530, lazy) | 5 800 + 16 168 gz |
| `accessories/bare.png` + `.json` (OME-1409, lazy) | 15 445 + 1 488 gz |
| **total shipped art** | **131 058 B (≈ 128.0 KB) of 300 KB** (1 KB = 1 024 B, as in the budget: 307 200 B). Eager 69 528 B; lazy (sets d + l's walk, g, h's edit kit, i's, j's and k's scenes, not-found) 61 530 B |

**Cap: 460 800 B (450 KB) since the ADR 0056 amendment of 2026-10-29** (OME-2001: 415 711 B with the queen bed; 409 600 B / 400 KB from ADR 0056 until then; 300 KB / 307 200 B before; older rows below say "of 307 200"). **Measured total now: 455 234 B** after OME-2078 (wave 2 polish, −4 258); 459 492 B after OME-2066 (wave 2, +44 094 lazy on 415 398); 376 550 B after OME-1959 (partition, +2 722 lazy; main was 373 828, the rows since OME-1688 not all logged here); 352 244 B after OME-1688 (lamp, plant and shelf colourways, +223 lazy); 352 021 B after OME-1685's Dank Dungeon polish (+2 926) merged with main's later art; 337 639 B after OME-1670 (Dank Dungeon, +17 010); 320 629 B after OME-1639's theatre set (+11 841 on top of 308 788 after OME-1641 and its OME-1657 polish); was 304 093 B (≈ 297.0 KB) of 300 KB, eager 104 314, lazy 199 779 (OME-1530: +9 286 lazy; 3 107 B left) (`bun assets/src/build.ts`). Rows not named below are
older hand-copied figures; the build's printout is the source of truth.

The Halloween theme (OME-1185) adds **7 231 B (≈ 7.1 KB)**, all lazy and fetched only during the theme (cap: 40 KB per theme): `halloween.png` 3 513 +
`halloween.json` 3 718 gz. No existing file changes. Measured total with it: 195 623 B of 307 200.

Themes B (OME-1187) add **22 748 B (≈ 22.2 KB)**, all lazy, one theme fetched at a time (cap: 40 KB each): Sinterklaas 6 396, Christmas 5 589,
Valentine's 4 341, Easter 6 422. `halloween.json` grows 22 B gz (the new `motion` and `replaces` meta fields). Measured total: 218 393 B of 307 200.

Catalogue v2 (OME-1103) adds **14 412 B (≈ 14.1 KB)** against `main` as the build measures it (159 946 → 174 358): lazy +14 104
(`furniture-v2.png` 10 261 + `furniture-v2.json` 1 657 gz, `edit.png` +1 867 for 12 thumbnails and 5 swatches, `edit.json` +319 gz), eager +308
(`reference.css` gz: the new `.ui-thumb-*` / `.ui-swatch-*` rules). The v1 sheet is byte-identical. A separate sheet costs about 1.3 KB more than
packing v2 into `furniture.png` (measured: 13 152 B that way), but it keeps v1-only rooms 10 KB lighter. `edit.png` stays 256×1024 (frames still end at y 708).

Catalogue v3 (OME-1348) adds **7 493 B (≈ 7.3 KB)** against `main` (218 779 → 226 272 of 307 200): lazy +7 293 (`furniture-v2.png` +5 375,
`furniture-v2.json` +611 gz, `edit.png` +1 127 for 8 thumbnails, `edit.json` +180 gz), eager +200 (`reference.css` gz, the new `.ui-thumb-*` rules).

The cat walk (OME-1519) adds **1 969 B**: 292 857 → 294 826 of 307 200 (see "Cat walk").

Lamp, plant and shelf colourways (OME-1688) add **223 B**, all lazy (`recolours.json` gz 936 → 1 159): 308 788 → 309 011 of 409 600 (see "Furniture recolours").

Wall decor recolours (OME-1500) add **401 B**: 292 456 → 292 857 of 307 200 (see "Furniture recolours").

Furniture recolours (OME-1462) add **756 B** (the gz table): 291 642 → 292 398 of 307 200. No sheet changes; baking them would cost
+11 740 B (see "Furniture recolours").

Head accessories (OME-1388) add **12 451 B (≈ 12.2 KB)**, all lazy: `accessories.png` 3 970 + `accessories.json` 8 481 gz. No existing file
changes. Measured total: 238 750 B of 307 200.

The "in use" loops (OME-1405) add **5 620 B (≈ 5.5 KB)** to the art total (eager + lazy; every added byte is in the lazy v2 sheet, still 512×512): 32 frames, `furniture-v2.png`
15 613 → 20 737 (+5 124), `furniture-v2.json` +513 gz (frames, `animations`, `use`). The clock notes (shorter, bolder hands with a cream gap
before softer ticks; mid-tone short rays) cost nothing measurable; `edit.png` +1 for the clock thumbnail. Measured total: 244 370 B of 307 200.

Batch 6 (OME-1437) adds **22 384 B (≈ 21.9 KB)** against `main` (265 085 → 287 469 of 307 200, `bun assets/src/build.ts`). Lazy: `furniture-v4.png`
18 733 + `furniture-v4.json` 1 772 gz, `edit.png` +1 460 and `edit.json` +229 gz (8 thumbnails). Eager: `reference.css` +208 gz (the new
`.ui-thumb-*` rules). The v1 and v2 sheets are byte-identical. To fit the budget the hammock ships in one colour (a teal one cost 6.5 KB with its
loop) and the piano loop has 2 frames.

The teleport pad (OME-1546) adds **1 130 B** (304 093 → 305 223 of 307 200), all lazy but `reference.css`: `furniture-v4.png` 18 733 →
19 477 (+744, 4 frames), `edit.png` +180 (2 thumbnails), `furniture-v4.json` / `edit.json` / `reference.css` +206 gz together.

The theatre set v2 (OME-1639) adds **11 955 B (≈ 11.7 KB)** of its +30 KB allowance (305 109 → 317 064, `bun assets/src/build.ts`): lazy
`furniture-v5.png` 8 810 + `furniture-v5.json` 1 335 gz, `edit.png` +1 260 and `edit.json` +230 gz (5 thumbnails, 3 swatches); eager
`reference.css` +320 gz. The other sheets are byte-identical. It fits the 400 KB cap (ADR 0056): 320 629 of 409 600 measured on top of OME-1641. (`gzip -9` on
the command line shows the JSON at 1 353 B: it stores the file name in its header. The budget counts zlib level 9 without one, as
`bun assets/src/build.ts` does.)

Bare heads (OME-1409) add **17 154 B (≈ 16.8 KB)** as `bun assets/src/build.ts` measures it (255 904 of 307 200 on its own; 261 418 measured on top of OME-1405), all lazy:
`bare.png` 15 445 + `bare.json` 1 488 gz, and `accessories.png` +264 / `.json` −19 gz for the refitted Pip and Mo overlays.

Set (p) (OME-1104) adds **13 652 B (≈ 13.3 KB)** against `main` as `bun assets/src/build.ts` measures it (159 946 → 173 598 of 307 200; 174 358 → 188 010 on top of catalogue v2), all lazy:
`expressions.png` 10 863 + `expressions.json` 2 789 gz. No existing file changes (the avatar and motion sheets are byte-identical).

OME-841 adds **795 B** against `main` as `bun assets/src/build.ts` measures it (130 263 → 131 058): the lazy `scenes/not-found.png` 731 and one
`reference.css` rule +64 gz. The row above said 130 224 before this change; the build on `main` already measured 130 263 (eager 69 464, i.e.
+39 B of `reference.css` gz since that row was written), so the totals here are the measured ones.

Set (l) (OME-644) adds **10 433 B (≈ 10.2 KB)** against `main` (119 791 → 130 224): eager +5 455 (`ui.png` +1 107, `ui.json` +794 gz, 7 new slices +952,
`reference.css` +2 602 gz), lazy +4 978 (the smooth walk's 64 in-between cells: `motion.png` +3 734, `motion.json` +1 244 gz).

Set (k) (OME-541) adds **5 524 B (≈ 5.4 KB)** against `main` (114 267 → 119 791). The layouts: `ui.png` +474, `ui.json` +235 gz, 4 new slices +596,
`reference.css` +1 452 gz, and the two lazy scenes 701 (`chat-away.png` 310, `room-away.png` 391). Items 5 and 6 (quality, report): +1 301, all eager
(`ui.png` +149 for 4 sprites, `ui.json` gz and `reference.css` gz for the rest; no new slices). Round 1 fixes (touch hit areas, scroll rail): +620 `reference.css` gz.
Quality per OME-545 (no key where unsupported, the Twitch echo state): +143 `reference.css` gz. Round 2 fixes (brighter rail): +2. Eager +4 823, lazy +701.

Set (j) (OME-422) adds **6 323 B (≈ 6.2 KB)** against `main` (107 942 → 114 265): `ui.png` +1 448, `ui.json` +402 gz, 11 new slices +1 571,
`reference.css` +2 109 gz, and the lazy `scenes/removed.png` 793 (per file: § Set (j) bytes). Eager +5 530, lazy +793. The extension icons
(`store/icon-*.png`, 1 501 B) ship in the extension, not the site, and are reported apart; the promo tile and screenshots are store listing only.

Set (i) (OME-416 + OME-427 polish) adds **8 471 B (≈ 8.3 KB)** against `main` (99 471 → 107 942): `ui.png` +2 213, `ui.json` +541 gz, 16 new slices +2 577
(a browser only fetches a slice once a rule uses it), `reference.css` +1 809 gz, and the two lazy scenes 1 331 (per file: § Set (i) bytes). Eager +7 140, lazy +1 331.
`apps/web/src/style.css` imports `reference.css`, so its gz growth reaches the site's CSS; the perf budget gates initial JS, which is untouched.

Set (h) polish (OME-296): the stronger grid, six iso footprint glyphs (up from four), and the build now counts `reference.css` and the popup
PNGs, so its total matches this table. The submission's 99.3 KB and the build's earlier 88.8 KB were the same art counted two ways: the gap was
`reference.css` (gz) plus the popup PNGs.

Set (h) (OME-276) adds **≈ 16.1 KB** against `main`. The lazy edit kit (`ui/edit.png` + gz `edit.json`) is 10 223 B and only loads for an owner in
edit mode. Everything else adds ≈ 6.3 KB: `ui.png` +1 076, `ui.json` +356 gz, 13 new slices +2 243 (a browser only fetches a slice once a rule uses it), and
`reference.css` +2.4 KB gz. The eager sheet stays 256×256.

Set (g) (OME-261) adds **24 348 B (≈ 23.8 KB, 8 % of the 300 KB art budget)** as one extra request, made only by rooms that use the catalogue.
`docs/perf-budgets.md` has no per-atlas line (the art budget is the 300 KB above); the JS budget is untouched because the atlas is fetched, not bundled.
The sheet is 1024×512 (72 frames, 11 pieces). Its colour variants are baked, so each one costs real bytes: about 1–3 KB per variant.

Set (f) (OME-193) adds ≈ 4.1 KB against `main`: `ui.png` +1 030, `ui.json` +331 gz, 6 slices +955, `reference.css` +1 273 gz, popup PNGs +471. The sheet stays 256×256.

"gz" is zlib **level 9** with no file name (what `build.ts` prints; `gzip -9nc <file> | wc -c` agrees within 4 B).
Plain `gzip -c` (level 6 plus the file name in the header) reads about 20–45 B more per file, e.g. for `ui.json` and `reference.css`.

## Set (n): room presets and portrait phone references

`presets/presets.json` indexes six named starting rooms. Its `layout` and `thumb` paths resolve relative to `assets/presets/`. Layout files are strict layout-v1 JSON, with eight seat cells, one TV and existing furniture kinds. Thumbnails are 212×176 indexed PNGs on a 20×10 tile grid, sharing the room palette; six together are 20,478 bytes (cap 40,960). They are standalone create-flow previews. PixiJS still renders the selected layout through the existing room/furniture PNG sheets and JSON atlases; no atlas change is needed.

Source: `src/presets.ts`; regeneration: `bun assets/src/build.ts`; validation: `bun test assets/src/presets.test.ts`. `preview/presets@1x.png` shows all six at native scale with sitters; `preview/presets-thumbs@3x.png` shows the thumbnails enlarged without interpolation.

Portrait UI reference: `preview/m10.html`, captured by `bun assets/src/shoot-m10.ts`. The 360×740 and 390×844 state boards cover watching, typing, chat, queue, link entry, emotes and host actions. These review PNGs do not ship. See `docs/design/m10-presets-phone.md` for interaction/focus rules, budget and self-check.

The door (OME-1424) adds **3 319 B (≈ 3.2 KB)** (261 457 → 264 776 of 307 200): lazy `furniture-v2.png` 20 631 → 23 415 (+2 784, 8 frames),
`furniture-v2.json` +203 gz, `edit.png` +283 / `edit.json` +44 gz for 2 thumbnails; eager `reference.css` +46 gz. **Size change:** the v2 sheet
no longer fits 512×512 (the shelf packer runs ~70 px past the bottom with the doors' 8 tall frames), so it doubles to 512×1024, half empty,
which leaves room for the rest of batch 5. GPU cost when loaded: 1 MB → 2 MB RGBA. A separate door sheet would need a new loader in the web app.

## OME-1799: the empty-TV curtain (responsive proposal)

With nothing playing, the TV was a black slab at every size. Four lazy repeat tiles in `ui/scenes/` draw the theatre's velvet
curtain closed across the picture box, whatever its size: `curtain-pelmet.png` 16×13 (repeat-x, top: wood rail, a swag, its
fringe, a tassel at each join), `curtain-drape.png` 8×8 (repeat both: the folds), `curtain-hem.png` 12×7 (repeat-x, bottom:
fringe and stage boards), `curtain-seam.png` 3×6 (repeat-y, centred: one art pixel of dim glow between the drapes). Layer them top to
bottom pelmet, hem, seam, drape, each sized at the page chrome's `--ui-px` (2 px; 4 px under the 2× chrome zoom), so they keep the
shelf's and the keys' pixel size on any TV width. Every pixel is opaque; the TV bezel is the outline. 551 B in total, all lazy;
eager unchanged. Source: `src/responsive.ts`. The proposal, CSS and mockups are on [OME-1799](/OME/issues/OME-1799).
