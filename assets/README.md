# omega-share assets

Original art, CC BY-SA 4.0 (`LICENSE`). Style rules: `STYLE.md`.

```
assets/
  avatars/avatars.png   # shipped: 512×256 indexed PNG-8 sprite sheet (set a)
  avatars/avatars.json  # shipped: PixiJS v8 spritesheet atlas
  avatars/motion.png    # set d (M5, lazy-load): 1024×512 indexed PNG-8, walk / breathe / wave / emote icons
  avatars/motion.json   # set d: PixiJS v8 atlas + meta.omega.anims (frames, per-frame ms, loop)
  room/room.png         # shipped: 512×1024 indexed PNG-8 (set b: floor, rug, walls, seats, TV + media shelf, props)
  room/room.json        # shipped: PixiJS v8 spritesheet atlas + meta.omega room contract
  ui/ui.png             # shipped: 256×256 indexed PNG-8 (set c: 9-slices, cursor, icons, dots, portraits, wordmark;
                        #   set e: playback keys, seek/volume, chips, system line, catching-up hourglass; M1b: tvframe/*)
  ui/ui.json            # shipped: PixiJS v8 spritesheet atlas (9-slices carry `borders`)
  ui/slices/*.png       # shipped: each 9-slice / cursor / bubble tail as its own PNG, for CSS border-image
  ui/reference.css      # design spec for the DOM chrome (generated); apps/web ports what it needs
  preview/              # not shipped: sheets, avatar scene, room@1x/@2x, ui.html + ui-*.png screenshots (ui-playback*.png = set e, ui-tv.png = M1b TV),
                        #   walk-/breathe-/emote-strip@4x.png, motion-scene@1x.png (frame strip) + .apng (animated)
  src/                  # generator (Bun, no deps) + mood boards
```

Rebuild everything (deterministic): `bun assets/src/build.ts`. It prints the byte budget.
Re-shoot the UI previews after a build: `bun assets/src/shoot-ui.ts` (uses the repo's Playwright + Chromium).
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

## Room atlas (`room/room.json`, same format)

**Every frame's anchor is the floor point of the cell it belongs to:** the tile centre, `cellCenter(col,row)`
in `apps/web/src/layout.ts`. Place the sprite there, with no per-item offsets.

| Key | Size | Place at | Notes |
|---|---|---|---|
| `floor/0`, `floor/1` | 64×32 | every floor cell | Honey planks. Tiles partition pixels half-open, so they tessellate with no gaps or overlaps. |
| `rug/<c\|ne\|se\|sw\|nw\|n\|e\|s\|w>` | 64×32 | rug cells | 9-slice. Parts name the screen side of the rug rim; edge tiles include the floor planks outside the rug. |
| `wall/l/<plain\|window0\|window1\|sconce>` | 39×253 | `(0,row)` | Stands on the cell's top-left edge. `window0` at row r needs `window1` at r+1. |
| `wall/r/<plain\|poster0\|poster1\|sconce>` | 39×253 | `(col,0)` | Stands on the cell's top-right edge. `poster0` at col c needs `poster1` at c+1. |
| `wall/corner` | | `(0,0)` | Top cap of the back corner. |
| `wall/l/end`, `wall/r/end` | | `(0,9)`, `(9,0)` | Open wall ends at the front. |
| `armchair/<ne\|nw>/back`, `…/front` | 52×36 | seat cell | Faces the TV (sitter seen from behind). Draw `back`, then the seated avatar, then `front`. Seat surface is 8 px above the anchor (`seatHeight`). |
| `armchair/<se\|sw>/back`, `…/front` | 52×44 | seat cell | Faces the camera (sitter's face visible, use `sit/se` / `sit/sw`). Same three-layer draw; `front` is just the near armrest. For seats that face into the room rather than the TV. |
| `tv/0` | 458×303 | `(0,0)` | M1b: 384×216 wall-hung TV across the corner, on a media shelf with speaker cabinets, a flat transport slot and brass gussets, plus a 1 px cool glow line. The screen is painted "off". `meta.omega.tv.screen` is the iframe rect and `meta.omega.tv.controls` the transport slot (see *M1b TV* below). |
| `plant/0`, `lamp/0` | | any free cell | Floor props. |

- **Walls** tile as flat 32 px columns, and only their top edge is outlined, so segments butt with no seams. Draw floor → walls → `tv/0`
  as one static background (it never changes, so it can be cached into a single texture).
- **Z order** for everything else: sort by `(floorY, floorX, layer)` with `meta.omega.layers`
  (`back 2`, `avatar 3`, `front 4`).
- **`meta.omega.tv`** (relative to the `tv/0` anchor at `cellCenter(0,0)`): `screen {x:-192, y:-247, w:384, h:216}`,
  `controls {x:-192, y:-15, w:384, h:44}`, `stageOrigin {x:480, y:248}`. See *M1b TV* below.
- **The TV and shelf hang in front of the back corner cells.** Don't seat or stand anyone at `col+row <= 4` (an avatar there would
  draw over the shelf, since the TV is part of the static background).
- **`meta.omega.layout`** is a suggested default room for the 10×10 floor: `floor[row][col]` keys, `walls.l[row]`,
  `walls.r[col]`, `props[]`. Since M1b the window and poster sit on the last two wall segments (8–9), clear of the TV, and the
  sconces aren't placed (the shelf would cut their halo); their frames stay in the atlas. Seats are **not** in it; they stay in `layout.ts`. `preview/room@1x.png` renders exactly this layout
  with the `layout.ts` seats at the suggested `stageOrigin`, plus two preview-only camera-facing chairs (`armchair/sw` at (1,8), `armchair/se` at (8,1)) so the `se`/`sw` sprites are checked in context.
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

## M1b TV (OME-92): bigger player + transport slot

YouTube's rules need a ≥ 200×200 px player with nothing over it (`docs/research/m1b-youtube-sync.md` §3.4), so the M1b TV is
**384×216** (16:9). It stays ≥ 356×200 at any stage scale ≥ 0.93. Directly under it, the media shelf has a flat **transport slot**
where the set (e) shared transport goes, outside the player rect. Previews: `preview/room@1x.png` / `@2x.png` and
`preview/ui-tv.png` (the transport docked in the room, plus the DOM frame at 384×216 and on a 360 px viewport).

**In the stage** (the room art at 1×): place `tv/0` at `cellCenter(0,0)` as before, then

| Rect | Relative to the `tv/0` anchor | On the stage, with `stageOrigin` (480, 248) |
|---|---|---|
| `tv.screen`: the iframe | `{x:-192, y:-247, w:384, h:216}` | `{x:288, y:17, w:384, h:216}` |
| `tv.controls`: the transport slot | `{x:-192, y:-15, w:384, h:44}` | `{x:288, y:249, w:384, h:44}` |

- **Why `stageOrigin` moved** from `ORIGIN_Y = 220` to `248`: the bezel top then lands at y 7, and the slot clears the back-row name tags
  (sit tags are 19 px tall at 1×) by 2 px. The floor's front corner ends at y 568 of the 600 px stage. Walls are now 232 px tall, so the
  corner cap peaks at y 8, just behind the TV's top edge.
- **Slot contents:** one row of `.ui-transport` straight on the slot, no `.ui-panel` (the shelf is the panel): `chip/shared` · play/pause key ·
  readout · seek · readout. Wrap it in `.ui-tv-slot` at the `controls` rect. The key is 28 px tall, so it clears the 44 px slot by 8 px each side.
  Personal volume stays in page chrome (it's "only you", never on the shared TV).
- The 8 px bezel bottom, 4 px ledge and 4 px rail separate the slot from the player, so the controls never touch the iframe rect.
- **Back-row chat bubbles** would overlap the slot. Nudge them sideways or clamp them below the slot (y ≥ 295). Bubbles must never cover the screen rect.
- Coupling: `apps/web/test/room-atlas.test.ts` checks that `anchor + tv.screen` equals `layout.ts` `TV`, so this atlas has to land with
  the layout change (OME-84): `TV = {x:288, y:17, w:384, h:216}`, `ORIGIN_Y = 248`.

**Outside the stage** (the player out of the CSS-scaled stage, e.g. narrow windows): the same bezel and shelf are 9-slices in `ui/`.

| Key | Size | Slice (t r b l) | Use |
|---|---|---|---|
| `tvframe/bezel` | 26×24 | 12 12 10 12 | The `tv/0` bezel with a plum ring round the hole. No `fill`: the iframe is the content box. |
| `tvframe/shelf` | 78×58 | 28 38 29 38 | Ledge + front face + speakers. **Fixed height 58**: only the slot's flat middle stretches (sideways). |

- Markup and rules are at the end of `ui/reference.css` (`.ui-tv`, `.ui-tv-bezel`, `.ui-tv-shelf`, `.ui-tv.compact`). Use `--ui-px: 1px`.
- The shelf is 50 px wider than the bezel (its speakers), and its slot is exactly the player's width. The transport is positioned over the slot.
- **`.compact`** (below ~380 CSS px): the bezel keeps only its top and bottom bars and the shelf only its slot, so a 356×200 player
  fits a 360 px viewport. The border-image width *is* the border width, so a zero side border paints nothing, and nothing ever draws over the iframe.

## Motion atlas (`avatars/motion.json`, set d)

Same format as the avatar atlas (PixiJS v8, 32×64 cells, no trim, no rotation, anchor = floor point `(16, 61)`).
It's a second sheet so the room's first paint doesn't pay for it: load it after the room is up (walking is M5).
Frame keys start with `walk`, `breathe`, `wave` or `emote`, so they never collide with avatar ids or room keys in Pixi's cache.

| Key | Frames | Notes |
|---|---|---|
| `walk/<id>/<dir>/<0-3>` | 4 per dir | Contact (kick-up) → passing → contact (open V) → passing. The body rises 1 px on passing frames, the supporting sole is always on y 60, and both arms swing against the legs (Kiki's popcorn arm stays put). |
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
- **Breathe:** `[1400, 1000]` ms. Start each avatar at a random phase so a full room doesn't breathe in unison.
  The blink ticker (set a) wins over the exhale frame for its 120 ms.
- **Wave** is one-shot (`6 × 160 ms`), then return to the pose's base frame. Seated waves still draw between the chair's `back` and `front` layers.
- **Emotes** are one-shot (`80, 160, 200, 200, 200, 400, 80` ms ≈ 1.3 s). They draw on the tag layer, bottom-centred 1 px above the
  name tag (`(floor x, tagTop − 1)`). Without a tag, use `floor y − tagLiftByAvatar[id][pose]`. The icons are outlined, so they hold on
  floor, rug, velvet and the dark walls.
- Contract: accepted in `docs/adr/0010-motion-atlas.md` ([OME-57](/OME/issues/OME-57)).

## Budget

| File | Bytes |
|---|---|
| `avatars/avatars.png` | 4 426 |
| `avatars/avatars.json` | 24 075 raw / 1 492 gz |
| `avatars/motion.png` (set d, lazy) | 14 601 |
| `avatars/motion.json` (set d, lazy) | 87 408 raw / 3 788 gz |
| `room/room.png` | 10 594 |
| `room/room.json` | 13 991 raw / 1 229 gz |
| `ui/ui.png` (sets c + e + M1b TV) | 5 159 |
| `ui/ui.json` (sets c + e + M1b TV) | 29 966 raw / 1 920 gz |
| `ui/slices/*.png` (39 files, palettes trimmed to the colours used) | 6 393 |
| `ui/reference.css` (if ported as-is) | 22 923 raw / 4 676 gz |
| **total shipped art** | **≈ 54.3 KB of 300 KB** (54 278 B; 35 889 B without the lazy set d) |

"gz" is zlib **level 9** with no file name (what `build.ts` prints; `gzip -9nc <file> | wc -c` agrees within 4 B).
Plain `gzip -c` (level 6 plus the file name in the header) reads about 20–45 B more per file, e.g. for `ui.json` and `reference.css`.
