# OME-2062 concept round: screens without the TV table, livelier old rooms, two swap rooms

Concepts only, nothing shipped changes. Rebuild: `CONCEPTS=2062 bun assets/src/build.ts` (add `CONCEPTS_CACHE=/tmp/x.json`
to reuse the ~2 min sprite ray-cast between runs). Source: `assets/src/concepts-2062.ts`. Same 67-colour palette (no new
colours), the same Kit/iso ray-caster, plum outline and top-left light as every shipped piece. Original art, CC BY-SA 4.0.

## 1 · A screen without the TV table

| file | what |
|---|---|
| `c2062-screen-wall-south@1x/@2x` | **(a) Wall panel.** A 56 × 36 px flat panel on a bracket, soundbar under it, hung on the left wall like `frame` (`wallscreen`, wall layer, se/sw). The console is gone and the corner is free. |
| `c2062-screen-wall-north@1x/@2x` | The same room swapped 180°. The panel's wall is now the near wall, so it shows its **back** (matte housing, VESA plate, vents) at its real height on an x-rayed patch of that wall, over the near wall's 16 px stub (the partition's cut-stub idea from OME-1959, run along both near edges). |
| `c2062-screen-projector-south@1x/@2x` | **(b) Projector on a tripod + pull-down screen.** A charcoal case on the wall, a black-bordered cloth lit with the picture, a pull tab. The beam is a sparse dither of the glow highlight from the lens to the cloth's corners (draw it as one cached `Graphics` or a baked overlay, not per frame). |
| `c2062-screen-projector-north@1x/@2x` | Swapped: the cloth's back is ghosted on the near wall and the projector turns with the room (the lens now points away). |

Recommendation: **(a) as the default "screen"** (one sprite, no extra layer), **(b) as the theatre/lounge option**.
A ceiling-hung projector variant exists (`projector/ceiling`, in the budget table), but I'd drop it. With no ceiling drawn, anything
hung high projects up the screen onto the back of the room and reads as a floor lamp by the wall, even with a floor shadow. The ceiling
fan failed the same test (it's in the ambient strip as the rejected option).

Swapped-view rule for every wall piece: the near walls draw as the stub, and a piece on them shows as its back, x-rayed. In a
partitioned room, give **each side its own screen** on its own back wall (penthouse: lounge panel ↔ rooftop cinema; studio: living-room
panel ↔ nook panel).

## 2 · Older rooms, revamped (all without the console)

Every room has a still (`c2062-revamp-<room>@1x/@2x.png`) and an animated crop (`…@1x.apng`, 10 × 100 ms, every loop on its own clock).
Loop frames at 4×: `c2062-ambient-strip@4x.png`. Bytes are measured: every frame of both facings on one strip PNG, plus the atlas
entries gzipped (`c2062-budget.json`).

| room | revamp idea | ambient touches | frames × facings | bytes (png + gz json) |
|---|---|---|---|---|
| Classic | Wall panel on the left wall, the rug stays, a dusk window and a long-case clock on the right wall | dusk window: clouds drift, a star blinks | 4 × 2 | 1 810 + 215 |
| | | long-case clock: the pendulum swings | 4 × 2 | 1 340 + 229 |
| Living room | The hearth takes the TV corner, with the panel above it ("screen over the fireplace") | fireplace flicker (**shipped loop**, `fireplace` use 4 × 120 ms) | — | 0 |
| | | steaming mugs on the snack tables (`teatable`) | 4 × 2 | 859 + 198 |
| Lounge | Movie corner: tripod projector behind the beanbags, a pull-down screen, lava lamps | lava lamps: two blobs rise and sink | 4 × 1 | 606 + 175 |
| | | neon buzz (**shipped loop**, `neonsign` use 3 × 140 ms) | — | 0 |
| Café | An espresso bar takes the bookcase's place on the right wall, rainy windows both sides, a small panel in the corner | rain on the windows: streaks and sliding drops | 4 × 2 | 2 104 + 215 |
| | | espresso machine: two cups steaming | 4 × 2 | 2 836 + 214 |
| Bar | A jukebox by the left window, the panel over the counter | jukebox: light tubes chase round the arch | 4 × 2 (+ back views) | 2 728 + 276 |
| | | neon buzz + fireplace (**shipped loops**) | — | 0 |

Screens: `wallscreen` 1 656 + 247 (incl. its back view), `projector/stand` 1 351 + 225, `rollscreen` 1 792 + 250.

## 3 · Two new partitioned swap rooms (Dank Dungeon tech: interior wall + glass, the view swaps at the door)

| file | what |
|---|---|
| `c2062-penthouse-south@1x/@2x` (+ `.apng`) | **Penthouse.** In front, the lounge: smoked panelling, a sofa and couch facing the wall panel, an aquarium, a bar fridge under a neon sign. Behind the glass, the **rooftop terrace**: a deck, an open-air "wall" (glass balustrade, brass rail, a skyline with lit windows, a dusk sky with stars, a steel pergola beam), loungers, string lights. |
| `c2062-penthouse-north@1x/@2x` | From the terrace: a **rooftop cinema** (tripod projector, pull-down screen on the terrace's own east wall, loungers facing it). The lounge is seen through the glass, and its panel shows ghosted on the near wall. |
| `c2062-studio-south@1x/@2x` (+ `.apng`) | **Studio flat.** In front, the kitchen and living room: a kitchenette with a pot steaming, a fridge, a breakfast table with stools, a couch facing the wall panel. Behind a papered wall with a glass stripe, the **sleeping nook**: a carpet, the queen bed, a rainy window, a steaming mug, the cat curled up. |
| `c2062-studio-north@1x/@2x` | From the nook: its own panel on the back wall, the living room through the glass, the kitchenette seen from behind. |

New bytes for the swap rooms: `kitchenette` 3 951 + 298 (incl. back views); sky walls (3 skyline variants per side + 2 split
segments) 8 988; split floors (deck|planks, carpet|planks, each also turned) 4 147; turned views of 4 shipped pieces (aquarium, coffee
table, bookcase, snack table) ≈ 2 330; near-wall stubs 1 707. These are single PNGs, so a packed sheet comes out smaller.

## Budget (ADR 0056 as amended 2026-10-29: 460 800 B)

`main` measures **415 398 B** today (`bun assets/src/build.ts`), so it's already over the issue's 400 KB (409 600 B). Under the
amended cap, the headroom is **45 402 B**.

The recommended set (wall panel + tripod projector + roll screen, the 7 new loops, both swap rooms with stubs): about **40.7 KB**
unpacked, all lazy (each room loads only its own sheet), so first paint and eager bytes don't move. It fits, but tightly. Cheapest cuts
if needed: one skyline variant instead of three (−6 KB), and the espresso and jukebox as single facings (−2.8 KB). Runtime palette
swaps stay the rule for any colourways.

## Self-check (design-judging rubric)

| # | criterion | self-score | note |
|---|---|---|---|
| 1 | Readability at 1× | 4 | Screens, windows, clock, lava lamps and steam read at 1×. The ghosted near-wall screen needs the @2x to be obvious. |
| 2 | Distinctness | 4 | No avatar changes. All four avatars appear in every swap-room view (where the layout allows). |
| 3 | Inspired, not copied | 5 | All pieces drawn from scratch in code, nothing traced, no third-party names. |
| 4 | Style consistency | 4 | One palette, one outline, one light. The sky wall is the boldest departure (no paper or panelling), on purpose. |
| 5 | Isometric correctness | 4 | Everything is ray-cast on the 2:1 grid. Back views turn about the anchor like furniture-back. The beam is an overlay, not a sprite. |
| 6 | Technical fitness | 3 | Concept round: previews only, no sheets or atlas yet. Frame keys follow `furniture/<id>/<colour>/use/<dir>/<n>`. |
| 7 | Budget | 4 | Measured per piece. About 40.7 KB of 45.4 KB headroom. |
| 8 | Charm | 4 | The rooftop cinema, the rain on the café windows and the steaming mugs make the rooms feel lived in. |
