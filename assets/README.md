# omega-share assets

Original art, CC BY-SA 4.0 (`LICENSE`). Style rules: `STYLE.md`.

```
assets/
  avatars/avatars.png   # shipped: 512×256 indexed PNG-8 sprite sheet (set a)
  avatars/avatars.json  # shipped: PixiJS v8 spritesheet atlas
  avatars/motion.png    # set d (M5, lazy-load): 1024×512 indexed PNG-8, walk / breathe / wave / emote icons
  avatars/motion.json   # set d: PixiJS v8 atlas + meta.omega.anims (frames, per-frame ms, loop)
  room/room.png         # shipped: 512×512 indexed PNG-8 (set b: floor, rug, walls, seats, corner console + projector, props)
  room/room.json        # shipped: PixiJS v8 spritesheet atlas + meta.omega room contract
  ui/ui.png             # shipped: 256×256 indexed PNG-8 (set c: 9-slices, cursor, icons, dots, portraits, wordmark;
                        #   set e: playback keys, seek/volume, chips, system line, catching-up hourglass; M1b: tvframe/* TV frame)
  ui/ui.json            # shipped: PixiJS v8 spritesheet atlas (9-slices carry `borders`)
  ui/slices/*.png       # shipped: each 9-slice / cursor / bubble tail as its own PNG, for CSS border-image
  ui/popup/*.png        # set f: the extension popup's key icon as standalone files, drawn at 16 px (1×) and 32 px (2×)
  ui/reference.css      # design spec for the DOM chrome (generated); apps/web ports what it needs
  preview/              # not shipped: sheets, avatar scene, room@1x/@2x, ui.html + ui-*.png screenshots (ui-playback*.png = set e, ui-tv.png = M1b TV frame),
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
- **Scale:** these pieces follow `--ui-px` like set (e). The shelf is `.ui-room` (1×). Text is 11 px at 2× and 9 px at 1×, except the plate name (10 px at 1×); the note is 12 px / 11 px.

## Set (f) safety states (OME-193, `ui/`)

M3's limits, drawn as "wait a moment" and never as an alarm: **no rust and no warn icon anywhere in this set** (rust means on air or
a real error). They use the same files as sets (c)/(e) (`ui/ui.png` / `ui.json`, `ui/slices/`, the end of `ui/reference.css`) plus
two standalone popup PNGs. Previews: `preview/ui-safety.png` (in context: shelf, system lines, popup 1×/2×, notices, room list) and
`preview/ui-safety-states.png` (every piece at 2× and 1×). **Each motif has one job:** snail = too fast · timer ring = how long to wait ·
mustard bar = only you see this · plug = the network dropped · shut door with a hanger = the room is full.

| Key | Size | Slice | Use |
|---|---|---|---|
| `button/shared/cool` | 16×20 | 5 | A rate-limited shared key resting: still wood (it's still everyone's key), a ramp step darker, charcoal lip. Not `disabled` (charcoal all over). |
| `wait/<0..7>` | 16×16 | — | Timer ring. `0` is full; each frame spends one more eighth, clockwise from 12 o'clock (cream arc, plum groove, 2×2 hub). One-shot over the server's retry-after: frame = `floor(elapsed / total × 8)`. Anchor = centre. |
| `glyph/snail` | 12×8 | — | "Take it slow": the slow-down chip and rate-limit system lines. |
| `chat/system-self` | 14×12 | 4 (left 5) | System line only you see: set (e)'s strip with a **mustard** bar instead of the glow bar. |
| `glyph/retry` | 8×8 | — | Round mustard arrow, for "your share didn't go through". |
| `icon/retry`, `icon/retry-2x` | 16×16, 32×32 | — | Round arrow round a clock face: "try again later". The 32 px one is drawn, not upscaled. Also shipped as `ui/popup/retry-16.png` / `retry-32.png`. |
| `icon/unplugged` | 16×16 | — | Normal disconnect: a mustard plug pulled out of its cream socket (prongs line up with the holes). |
| `glyph/dots/<0..2>` | 12×8 | — | "Reconnecting" loader: one dot lifted in turn, `meta.omega.dotsFrameMs` (240 ms), loop. |
| `icon/resting` | 16×16 | — | Closed by the server (flood/policy): the snail tucked in its shell with a small "z". Still, never animated. |
| `dot/paused` | 8×8 | — | Top-bar lamp for "paused by the room": a pale lamp with two plum pause bars (a shape, so it isn't colour alone next to the plain `dot/*` discs). |
| `card/room/<idle\|hover\|full>` | 16×16 | 6 | Room-list card: dusk glass in a wood rim (hover = cream lit edge). `full` = shade rim, charcoal glass. |
| `door/<open\|full>` | 16×24 | — | Card thumbnail, anchor bottom centre `(8,24)`. `open`: lamplight in the doorway and on the floor. `full`: door shut, a cream hanger on the knob with three little heads. |
| `pill/full` | 12×12 | 4 | Calm "Full" pill: charcoal, cream rim, cream text (≥ 5:1). |

- **1 · Slow down** (`.ui-button.shared.is-cooling`): swap the key's icon for `<span class="ui-sprite ui-wait" style="--cool: 3s">`,
  and the CSS drains the ring once over `--cool`. Use `aria-disabled="true"`, not `disabled`, so the key keeps focus. Relabel it
  ("Pause for everyone: available again in 3 seconds"), and drop `.is-cooling` when the ring is empty. Next to it, put a `.ui-chip.self`
  with `glyph/snail` + "Slow down". It's in the "only you" rim because only you are slowed. Optionally, show a self line: `glyph/snail` · "**Easy!** You can skip again in `<time>3 s</time>`".
- **2 · Share retry.** Room: `.ui-sysline.self` · `glyph/retry` · "**Your share** didn't go through. Try again in `<time>12 s</time>`". Recount the
  `<time>` each second and drop the line when it reaches 0. Popup (plain HTML): `<img src="retry-16.png" srcset="retry-16.png 1x, retry-32.png 2x" width="16" height="16" alt="">`
  before the status text. The icon has a plum outline, so it holds on the popup's white as well as on dark chrome.
- **3 · Connection.** They differ in lamp, icon, motion and action:
  - **Normal drop:** `dot/connecting` + "Reconnecting" + `.ui-dots`, and a `panel/0` notice with `icon/unplugged` ("Connection dropped.
    Reconnecting by itself…"). There's **no button**: it retries by itself.
  - **Closed by the server:** `dot/paused` + "Paused by the room", and a `panel/0` notice with `icon/resting` ("The room paused your
    connection: lots of messages at once.") plus a primary **Rejoin** key. The key is disabled ("Rejoin in 20 s") until the delay is over. Nothing moves.
- **4 · Room full** (ADR 0006, the 26th member): `.ui-card.is-full` with `door/full`, the count "25 / 25" and a `.ui-pill-full`. Render the card as a
  `div` with `aria-disabled="true"`, not a link. Open rooms are `a.ui-card` with `door/open` (hover/focus = the cream edge).
- **Motion:** `prefers-reduced-motion` stops the dots and shows `wait/0` (the countdown text still carries the time).
- **Scale:** follows `--ui-px` like the other sets (2× page chrome, 1× in `.ui-room`, e.g. on the TV shelf). No new colours: still the 67.

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
| `room/room.png` | 8 335 |
| `room/room.json` | 13 823 raw / 1 192 gz |
| `ui/ui.png` (sets c + e + M1b TV frame + M2 live + f) | 6 492 |
| `ui/ui.json` (sets c + e + M1b TV frame + M2 live + f) | 43 732 raw / 2 436 gz |
| `ui/slices/*.png` (49 files, palettes trimmed to the colours used) | 7 923 |
| `ui/popup/*.png` (set f) | 471 |
| `ui/reference.css` (if ported as-is) | 36 406 raw / 7 282 gz |
| **total shipped art** | **≈ 58.4 KB of 300 KB** (58 438 B; 40 049 B without the lazy set d) |

Set (f) (OME-193) adds ≈ 4.1 KB against `main`: `ui.png` +1 030, `ui.json` +331 gz, 6 slices +955, `reference.css` +1 273 gz, popup PNGs +471. The sheet stays 256×256.

"gz" is zlib **level 9** with no file name (what `build.ts` prints; `gzip -9nc <file> | wc -c` agrees within 4 B).
Plain `gzip -c` (level 6 plus the file name in the header) reads about 20–45 B more per file, e.g. for `ui.json` and `reference.css`.
