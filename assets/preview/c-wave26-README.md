# OME-2434 concept round: two swap rooms with table-free screens (rooms wave 26)

Concepts only, previews only. Source: `assets/src/concepts-wave26.ts`. To render: `CONCEPTS=26 bun assets/src/build.ts` writes `preview/c-wave26-*` and
stops after the furniture set. Nothing shipped is rewritten. No `apps/web`, contract or preset JSON changes.

The three shipped swap rooms (Dank Dungeon, Penthouse, Studio) all use the same pattern: a **row** partition, a main room with the screen
in front, and a quieter room behind glass. This round does two different things:

- **Stage Door** is the first **column** partition (ADR 0058 §3, `partitionLine` axis `col`, pieces facing `se`). The rooms sit side by
  side, not front and back, and the partition is a stage's **wings**, not a wall with a window.
- **Reef Tunnel** keeps the row, but the **partition is the attraction**: a run of fish tanks with an arched acrylic **tunnel** as the
  doorway. Both sides look at the same water. The back room's seats face the tanks, not the screen.

## Files

| file | what |
|---|---|
| `c-wave26-stage-door-south@1x/@2x.png` (+ `@1x.apng`) | Stage Door as everyone outside the green room sees it: the club stage in front, the green room through the wings |
| `c-wave26-stage-door-north@1x/@2x.png` (+ `.apng`) | Swapped, from the green room: dressing tables, rail and couch in front, the stage behind the wings |
| `c-wave26-reef-south@1x/@2x.png` (+ `.apng`) | Reef Tunnel from the bar: the tank wall with the deep behind it |
| `c-wave26-reef-north@1x/@2x.png` (+ `.apng`) | Swapped, from the deep: sand, hammock and beanbags facing the tanks, the bar behind |
| `c-wave26-<room>-thumb@1x.png` / `@3x` | preset thumb mock at the shipped size (212×176, `THUMB_SCALE`), with the room's own wall skin |
| `c-wave26-loops@2x.png` | every new loop frame, both facings (tank, tunnel, stage footlights, vanity bulbs) |
| `c-wave26-budget.json` | measured bytes per new piece / shell / thumb |

The `.apng` files run on the shared ambient clock: 8 ticks of 150 ms (`AMBIENT_TICK_MS` = the walkers' step, ADR 0058 amendment OME-2068;
the brief's "8 fps" is 6.7 fps in the shipped code). Each loop samples its own frame time on the tick.

## 1 · Stage Door (`stage-door`, "A club stage in front, the green room behind the wings.")

**Partition:** column 4, facing `se`. `velvet` (solid drape, gold fringe, scalloped pelmet) at rows 0–1 and 8–9. `wings` (a black stage
plinth with a brass edge and the pelmet, open between them) at rows 2–6, which makes one proscenium opening. **The stage door (doorway gap) is (4, 7).**
**Screen:** `projector` (pull-down cloth, span 3) on the **right wall** at (6, 0) `sw`, over the stage riser and framed by the shipped `curtain`
pair at (5, 0) and (9, 0). A `tripod` at (7, 8) facing `ne` throws the shipped dithered beam across the house onto the cloth.
**Why walk through:** the stage side is the cinema. The green room is backstage: bulb mirrors, a costume rail, the comfy couch, the
fridge. From there you watch the house through the wings, like the band before the set. The ad-hoc "after-party" room.

| side | furniture (col, row, facing) | seats |
|---|---|---|
| Stage (cols 5–9, front) | **`stage/boards` (6, 0) sw (new)**, `projector` (6, 0) sw, `curtain` ×2, `tripod` (7, 8) ne, `beanbag` blush (6, 4) ne + navy (8, 4) ne, `sidetable` (7, 5), `stool` teal (6, 6) + (8, 6) ne, `arclamp` (9, 6), `monstera` (5, 9) | 4 |
| Green room (cols 0–3, behind) | **`vanity/bulbs` (0, 8) + (0, 9) se (new)**, **`rack/costumes` (1, 6) sw (new)**, `couch` olive (1, 3) se, `wingback` (2, 1) se, `pouf` lilac (3, 2) se, `minibar` fridge (1, 0) sw, `neonsign` pink (2, 0) sw, `lavalamp` (3, 0) se, `monstera` teal (1, 9) | 4 |

**8 seats.** Shell: the stage's right-wall segments are **club brick** (running bond, a black dado to 40 px, a brass rail), and the green
room keeps the room's papered walls. The floor is planks on the stage side and v7's lilac carpet in the green room, with a split tile
under the partition column. In the swapped view, the brick wraps the two far walls and the green room's paper takes the near end.

## 2 · Reef Tunnel (`reef`, "A reef bar, and a tunnel through the tanks to the deep.")

**Partition:** row 4, facing `sw`. v7's `panel` (smoked) at cols 0 and 9 frames the run. **`tank`** at cols 1–2 and 4–8, **`tunnel`** at
(3, 4), which is the doorway. The tanks are see-through: a cabinet with a teal strip light, sand, a rock, one kelp strand swaying, bubbles,
and two fish swimming +x. Every fish is drawn at x and x ± 16 and clipped to the cell, so a run of tanks shows **one continuous
stream** across the whole wall, not nine fish in lockstep. The water is a sparse navy/teal dither (1 px in 8, the projector beam's
technique), so the room behind shows through. There is no header: the deep reads over the lid, like a long aquarium divider.
**Screen:** `wallscreen` (span 2) on the left wall at (0, 7) `se`, facing the couch.
**Why walk through:** the bar has the screen. The deep is the chill-out room: walk *through the tank* to get there, then sit on sand
in front of the water, with the fish between you and the bar. Its seats face the tanks (`sw`), so from the bar you see their faces
through the water.

| side | furniture | seats |
|---|---|---|
| Reef bar (rows 5–9, front) | `barcounter` wood (0, 5) se, `stool` teal (1, 5) + (1, 6) nw, `wallscreen` (0, 7) se, `couch` cream (4, 7) nw, `coffeetable` (2, 8), `neonsign` teal (0, 9) se, **`lavalamp/bubbles` (8, 6) (recolour)**, `monstera` teal (9, 8) | 4 |
| The deep (rows 0–3, behind) | `hammock` (5, 1) sw, `beanbag` navy (2, 2) + (8, 2) sw, **`lavalamp/bubbles` ×2** (0, 0), (9, 0), `monstera` teal (0, 2) | 4 |

**8 seats.** Shell: the deep's walls are new, **deep-water** navy with drifting caustic glints, a low rock skirting and a brass porthole
every second segment with a fish passing outside. The bar keeps v7's smoked panelling. The deep's floor is new **sand** (ripples, the odd
pink shell). Split tiles go under the partition row, the penthouse's pattern.

## Ambient life (all on the shared clock; texture swaps, no extra renders beyond the tick)

| loop | frames × ms | new or reused |
|---|---|---|
| `partition/tank`: fish stream, kelp sway, bubbles | 4 × 300, se + sw | **new** |
| `partition/tunnel`: the same water around the arch | 4 × 300, se + sw | **new** |
| `stage/boards`: footlights chase | 4 × 300, se + sw | **new** |
| `vanity/bulbs`: bulbs twinkle | 4 × 300, se + sw | **new** |
| `neonsign` pink / teal: buzz | 3 × 140 | **reused** (shipped, 0 B) |
| `lavalamp/lilac` in Stage Door | 4 × 320 | **reused** (v8, 0 B) |
| `lavalamp/bubbles`: the bubble column | 4 × 320 | **reused frames**: the lava lamp under a runtime PLTE swap (`recolours.json`: pink → glow/cream, navy → teal), 0 sheet bytes, ~100 B of JSON |
| projector beam | static | **reused** (`beam()` in `wave2.ts`, a cached Graphics) |
| `hammock` swing | 4 × 260 | reused, in-use only (shipped) |

Main-thread note: Reef has 9 partition cells that loop, so 9 sprites swap textures on the same tick as one atlas frame set. That's
the same render (≤ 1 per tick), but 9 texture assignments per tick. Stage Door has 3 new looping sprites. Both stay inside the idle row's
"renders ≤ 8/s" by construction.

## Bytes (measured: each group's frames on one PNG + its atlas entries gzipped; `c-wave26-budget.json`)

| group | bytes |
|---|---|
| `partition/velvet` (se + sw, symmetric, no back view) | 1 217 |
| `partition/wings` | 1 198 |
| `partition/tank` (+ 4-frame loop × 2 facings) | 4 013 |
| `partition/tunnel` (+ loop) | 3 501 |
| `stage/boards` (+ loop, + turned ne/nw) | 5 069 |
| `vanity/bulbs` (+ loop, + turned) | 2 946 |
| `rack/costumes` (symmetric, no back view) | 1 518 |
| Stage Door shell (brick l/r ×2, split ×2, corner, ends, green split floors) | 6 201 |
| Reef shell (deep l/r ×2, split ×2, corner, ends, sand + split floors) | 5 286 |
| thumbs (full palette here; shipped thumbs are `compactPalette`d, so smaller) | 4 592 + 4 185 |
| **total** | **≈ 39.7 KB** (≈ 30.9 KB of sheets + 8.8 KB thumbs) |

Headroom: OME-2433 (PR #988) takes the art total to **405 384 B of 460 800**, so **55 416 B** free. Both rooms fit with about 15.7 KB to
spare, all lazy (each room's sheet loads with its shell). **Against the old 400 KB line (409 600 B) they don't fit** (4 216 B free), so
this assumes the amended ADR 0056 cap.
**Thumbs:** `PRESET_THUMBS_MAX` is 40 960 B for all thumbs and the shipped ten use 37 363. Two more (~8 KB before palette compaction)
go over it, so the set needs that cap raised (or both thumbs squeezed). Flagged for the CEO and Lead.
Cheapest cuts if needed: wings + velvet as one colour (−1.2 KB), the tank's kelp static (loop only the fish, −~1.5 KB), and the vanity
without its turned view (−~0.8 KB; it backs onto the near wall in the swap, so its back is what shows).

## Contract and engineering notes (for after PASS; not in this issue)

- New kinds: `stage` (object, 3×2, se/sw, not walkable, ambient loop), `vanity` (object, wall-backed, se/sw, ambient loop), `rack` (object, 2×1).
  New `partition` colours: `velvet`, `wings`, `tank`, `tunnel`. New shell values `stage-door`, `reef`. New lavalamp recolour `bubbles`.
- **The tunnel cell must be walkable**: it's the doorway. Today a partition cell blocks walking and the doorway is a gap. Option A:
  `partition/tunnel` is walkable by colour (contract + both languages + corpus). Option B (no contract change): leave the gap and drop the
  arch, at the cost of the room's signature. I recommend A. Drawn in two layers (rear ribs behind a walker, front ribs over) when it ships.
- **Column partition**: the web's split already reads `partitionLine` on either axis (ADR 0058 §3). This room is the first preset to
  exercise `axis: "col"`, so it needs an e2e row for the swap on a col line.
- A partition loop is new for the web: the animator's ambient set must include partition cells (kind `partition`, colour `tank|tunnel`).
- Stage riser: kept non-walkable. Standing on it would need a lift per cell, which is a later question.
- **Swap rule, unchanged:** in the swapped view the screen is on a near wall and isn't drawn (OME-2173). The video is page chrome, so
  the green room and the deep still watch. That's why both rooms give the back room its own reason to exist instead of a second screen.

## Self-check (`design-judging` rubric)

| # | criterion | self-score | note |
|---|---|---|---|
| 1 | Readability at 1× | 4 | Stage, cloth, wings, bulb mirrors, tanks, fish and portholes read at 1×. The rail shows best in the swapped view (it's behind a velvet leg from the south). |
| 2 | Distinctness | 4 | No avatar changes. All four avatars are seated in each room, two per side, and visible in both views. |
| 3 | Inspired, not copied | 5 | Drawn from scratch in code on the shared Kit, no third-party art or names. |
| 4 | Style consistency | 4 | One palette (no new colours), the plum outline, top-left light. The brick and deep-water skins are new surfaces, made from existing ramps. |
| 5 | Isometric correctness | 4 | Ray-cast on the 2:1 grid. Turned views use the furniture-back rule. The column partition runs along v like the curtain. Fish wrap seamlessly across cells. |
| 6 | Technical fitness | 3 | Concept: previews only. Keys follow `furniture/<id>/<colour>/{<dir>/back,use/<dir>/<n>}`. The stage's loop needed its own image fn (a `useFrames` gap for 2-deep pieces; fix when it ships). |
| 7 | Budget | 4 | Measured per piece: ~39.7 KB of 55.4 KB headroom. The thumb cap needs a raise (flagged). |
| 8 | Charm | 5 | Watching the house from the wings, and a fish stream with a tunnel you walk through to sit on sand. |
