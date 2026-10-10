# omega-share assets

Original art, CC BY-SA 4.0 (`LICENSE`). Style rules: `STYLE.md`.

```
assets/
  avatars/avatars.png   # shipped: 512×256 indexed PNG-8 sprite sheet (set a)
  avatars/avatars.json  # shipped: PixiJS v8 spritesheet atlas
  avatars/motion.png    # set d (M5, lazy-load): 1024×512 indexed PNG-8, walk / breathe / wave / emote icons; set l: walk8 in-betweens
  avatars/motion.json   # set d: PixiJS v8 atlas + meta.omega.anims (frames, per-frame ms, loop)
  room/room.png         # shipped: 512×512 indexed PNG-8 (set b: floor, rug, walls, seats, corner console + projector, props)
  room/room.json        # shipped: PixiJS v8 spritesheet atlas + meta.omega room contract
  ui/ui.png             # shipped: 256×512 indexed PNG-8 (256×256 until set i) (set c: 9-slices, cursor, icons, dots, portraits, wordmark;
                        #   set e: playback keys, seek/volume, chips, system line, catching-up hourglass; M1b: tvframe/* TV frame)
  ui/ui.json            # shipped: PixiJS v8 spritesheet atlas (9-slices carry `borders`)
  ui/slices/*.png       # shipped: each 9-slice / cursor / bubble tail as its own PNG, for CSS border-image
  ui/popup/*.png        # set f: the extension popup's key icon as standalone files, drawn at 16 px (1×) and 32 px (2×)
  ui/scenes/*.png       # sets i + j (lazy): the "room closed", "invite required" and "you were removed" vignettes, standalone 72×64 PNGs;
                        #   set k (lazy): the "chat / room is in its own window" vignettes, 56×40
  ui/edit.png           # set h (lazy, owners only): 256×1024 indexed PNG-8, edit grid, placement markers, handles, tray thumbnails, swatches
  ui/edit.json          # set h: PixiJS v8 atlas for ui/edit.png
  furniture/furniture.png  # set g (M4/M5, lazy-load): 1024×512 indexed PNG-8, furniture catalogue v1
  furniture/furniture.json # set g: PixiJS v8 atlas + meta.omega.pieces (footprint, z-sort point, seats, layers per facing)
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
  | `ui/popup/cant-read(@2x).png` | 48×40 | 335 + 419 | The page's lines behind a brass padlock: the browser keeps this tab to itself | "Can't read this tab. Open a regular web page and try again." |
  | `ui/popup/server-away(@2x).png` | 48×40 | 342 + 430 | The wood TV (the product mark), screen dark, its cord's plug pulled out of the wall socket | Server unreachable |
  | **total** | | **2 367 B** of the 3 KB cap (the build throws over it) | | |

  They ship in the extension, not the site; the build counts them with `ui/popup/*.png` in the art total (130 263 → 132 630 B of 307 200).
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
| `thumb/<id>/<colour>` *(edit.png)* | ≤ 44×40 | — | Tray thumbnail for every catalogue piece and colour (17). The catalogue model re-cast at ≤ ½ scale (same light, tones, outline), not a shrunk sprite. Seats face `se`, the runner `ne`. Centre it in the cubby. |
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
  138 570 px², more than a 256×512 sheet holds (131 072), so the next size down can't fit them. The frames end at y 708. The rows below
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
| `emote-pick/<heart\|laugh\|question\|exclaim\|clap\|wave>` | 16×16 | — | Picker icons: the motion atlas's settled emote frame (same roles, so the same pixels), centred, except two thin ones drawn a size up so they hold their own at 1× next to the 11 px heart and laugh: `exclaim` (6×12, a heavier bar and a 4 px dot) and `clap` (12×10, the same V palms, taller). Each sits in a 24 art px `emotes/slot` cell, at page 2× and room 1× alike. `wave` is new: an open blush palm with two cream motion ticks, in the sticker style. In the room (1×) they double as a static fallback for the floating sticker. Keys 1–6 (`aria-keyshortcuts`, said in the title; no digits on the cells). |
| `scrim/0` | 2×4 | — (tile) | `.ui-scrim`: 1-bit plum dither, 50 %, to dim the stage behind the 4004 card mid-session. No alpha. |
| `door/<closed\|locked>` | 16×24 | — | Room-list thumbnails beside `door/open\|full\|private`: closed = dark wood, plum sill, moon hanger. locked = shut, empty keyhole, lamplight under the door. |
| `icon/<closed\|emote>` | 16×16 | — | Close room / room closed (a door hanger with a hole, a slit and a crescent moon) · the emote key (a cream line face, so it can't be mistaken for the filled laugh sticker). |
| `glyph/<moon\|open>` | 8×8 | — | "Closes in N days if nobody visits" · "anyone can come in" (beside the switch). In `.ui-mine` the moon gets 3 art px of margin before the words (its crescent sits on its right edge). |
| `scene/<closed\|invite>` *(ui/scenes/\*.png)* | 72×64 | — | `.ui-scene.ui-scene-<closed\|invite>`, page chrome 2× (144×128 CSS px). Not in the sheet. closed = lights out: night in the fanlight, the sconce off, no light under the door, the moon hanger on the knob. invite = someone's home: warm fanlight, lit sconce, lamplight under the door, an empty keyhole, a dashed ghost ticket on the wall. |

- **Create room:** `.ui-panel` form: `icon/create` heading, the name `.ui-input` with a hint and an `n / max` count, the switch row, then the primary key.
  Too many new rooms: the key becomes set (f)'s `.is-waiting` with `.ui-wait` and "New room in 9 min", and the line under it says the existing rooms still work.
  The name error is set (c)'s `input/invalid` + `icon/warn` + words.
- **Your rooms:** a heading with `glyph/host` and a secondary "New room" key, then `.ui-mine` rows: door thumb, title (+ `.ui-pill-private`), a meta line,
  then "Enter" + (private) a square `icon/copy` key + a square `icon/closed` key. A room near the GC sweep says so with `glyph/moon`. Close is two steps:
  the row turns `.is-confirm` with "Keep it" and the danger key. Empty list: `icon/create` + one line.
- **Room closed (4004):** `.ui-panel` with `scene/closed`, a heading, one line and "Find a room" (primary) / "Make your own". Mid-session, lay
  `.ui-scrim` over the stage and centre the same card (1× inside `.ui-room`).
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

Each icon is drawn natively per size by `src/store.ts` (so each keeps the plum outline and whole pixels); `bun assets/src/build.ts` writes them and
prints their bytes (1 498 B for all four; the 128 px icon is 96×96 of art in 16 px of margin) apart from the art budget. The promo tile and screenshots are composed in `preview/store.html` from the
real reference CSS and preview renders, and `bun assets/src/shoot-ui.ts` shoots them at their exact sizes. Screenshot 2's popup is
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
| `wheel/disc` | 77×77 | — | `.ui-wheel[role=menu]` (page chrome, `--ui-px`): night tray, mustard rim, six spoke grooves, a sunk ring round the hub. |
| `wheel/slot/<idle\|hover\|selected\|press\|cool>` | 21×21 | — | `.ui-wheel-slot[role=menuitem]`, each holding set (i)'s `.ui-emote-pick-<id>`. idle = sunken well · hover = cream lit edge · selected (`aria-current`, `:focus-visible`, `.is-selected`) = mustard rim · press = mustard rim, deeper well, sticker 1 px down · cool (`aria-disabled`) = charcoal, sticker dimmed. 42 CSS px at 2×. |
| `wheel/focus` | 27×27 | — | Keyboard focus ring round a slot (`:focus-visible::after`, 3 art px out): 1 px cream between plum, set (c)'s focus language made round. Never on hover. |
| `wheel/hub` | 21×21 | — | `.ui-wheel-hub`: wood bezel, deep well. Shows the selected sticker (`icon/emote` before a pick, set (f)'s `wait/<n>` while cooling). |
| `wheel/tail` | 9×7 | — (slice file) | From the rim down to your head. `.no-tail` when the wheel docks (no avatar in view) or is clamped vertically. |
| `icon/wheel` | 16×16 | — | The touch key by the chat input (`.ui-button.self.icon`, `aria-haspopup="menu"`, `aria-expanded`): six beads round a face, the top one lit. |
| `kbd/0` | 12×12 | 3 4 4 4, fixed height | `kbd.ui-kbd`: a keycap for hints ("Press [Enter] to chat", "[T] emotes", the wheel's label chip). Page chrome (2×) only. |

**Bubbles: geometry, motion, stacking.** All numbers are in `ui.json` `meta.omega.bubbles` (ms and stage px) and baked into the CSS.
- **Box:** 12/15 px words, at most 168 px wide (border box) and 3 lines (`.say` clamps; the full text is in the chat log). Bubbles are decorative:
  the layer is `aria-hidden="true"`, the chat log stays the live region.
- **Anchor:** the tail tip, at `(floor x, floor y − tagLiftByAvatar[id][pose])`, 2 px over that avatar's head. The card's bottom is 4 px above it (`tailBelow`).
  JS sets `left`/`top` to the card's resting border box and `--tail-x` to the speaker's x inside it.
- **Life (default):** 5 s. Opacity 0 → 1 over 120 ms in 3 steps, holds to 3.6 s, then `cubic-bezier(.55, 0, 1, .45)` (ease-in) to 0 at 5 s. It rises 24 px over the whole
  life in `steps(24)`: one whole stage px every ~208 ms, so the art never blurs between pixels. `opacity` + `translate` only: compositor work, no layout or paint per frame.
- **Reduced motion:** no rise, no push slide, no fade-in. Shows at once, holds to 4 s, fades linearly to 0 at 5 s; an early exit is instant.
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

**Emote wheel.** Geometry in `meta.omega.wheel` (art px): slot `k` (0–5, `order`: heart, laugh, question, exclaim, clap, wave = keys 1–6) has its top-left at `slots[k]`,
every 60° clockwise from 12 o'clock on a 24 px radius; the hub at `hubOrigin`. The CSS places them already (`.ui-wheel-slot:nth-child(k)`).
- **Where:** page chrome at `--ui-px: 2px` (never inside the scaled stage, so it's always 154 CSS px and the slots are touch-sized), its tail tip on your bubble anchor
  (`stageToPage`). The label chip (`.ui-chip.self.ui-wheel-label`, the emote name + its key in a `kbd.ui-kbd.is-small`) sits above the wheel, not on your avatar.
  Clamp it inside the stage box; clamped vertically, or with no avatar of yours in view (phone watch-only, panned away), it docks centred above the composer with `.no-tail`.
- **Keyboard:** T (focus not in a text field) opens it with Heart selected and focused (roving tabindex). → / ↓ next clockwise, ← / ↑ back, Home / End, 1–6 send at once,
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

## Furniture atlas (`furniture/furniture.json`, set g, M4/M5)

Furniture catalogue v1 for customizable rooms. It's a separate, lazy sheet: the default room doesn't need it, so load it only when a room
uses a catalogue piece (or the M5 customization UI opens). Same PixiJS v8 format as the room atlas, and the same anchor rule.
Previews: `preview/furniture-sheet@2x.png` (every frame, seats empty and occupied), `preview/furniture-room@1x.png` / `@2x` (every piece
in the current room, both facings), `preview/furniture-layout@1x.png` / `@2x` (a sample layout), `preview/furniture-atlas@2x.png` (the sheet).

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
| `room/room.png` | 8 335 |
| `room/room.json` | 13 823 raw / 1 192 gz |
| `ui/ui.png` (sets c + e + M1b TV frame + M2 live + f + h + i + j + k + l) | 12 951 |
| `ui/ui.json` (sets c + e + M1b TV frame + M2 live + f + h + i + j + k + l) | 91 380 raw / 4 905 gz |
| `ui/edit.png` (set h, lazy, owners only) | 8 925 |
| `ui/edit.json` (set h, lazy) | 18 430 raw / 1 334 gz |
| `ui/slices/*.png` (100 files, palettes trimmed to the colours used) | 15 862 |
| `ui/popup/*.png` (set f) | 409 |
| `ui/scenes/*.png` (sets i + j + k, lazy) | 2 825 |
| `ui/reference.css` (if ported as-is) | 98 398 raw / 19 853 gz |
| `furniture/furniture.png` (set g, lazy, M4/M5) | 21 930 |
| `furniture/furniture.json` (set g, lazy) | 37 570 raw / 2 418 gz |
| **total shipped art** | **130 224 B (≈ 127.2 KB) of 300 KB** (1 KB = 1 024 B, as in the budget: 307 200 B). Eager 69 425 B; lazy (sets d + l's walk, g, h's edit kit, i's, j's and k's scenes) 60 799 B |

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
