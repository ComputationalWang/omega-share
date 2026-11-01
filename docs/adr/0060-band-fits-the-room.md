# ADR 0060: The band fits the room, below 1× where it must; the phone's Fit fits the walls

**Status:** accepted (2026-11-01) · Lead · [OME-2148](/OME/issues/OME-2148) (design judge round 2 on OME-2122, QA evidence [OME-2146](/OME/issues/OME-2146#document-review) findings 1 and 3). Amends ADR 0059 and OME-1811's whole-number rule for the audience band.

**Context:** ADR 0059 gave the 1280×800 band half the room (266 px) at 1× and pointed it at the audience. From the back wall's tallest art (stage y 113) to the lowest name tag, every preset needs 377 to 442 stage px, so no preset fits at 1×. The empty standing spots by the door pulled the band down to y 538, which put the cinema's back-row heads under the TV, and in the Dank Dungeon and the Studio my own name tag went under the band's foot. On the phone, Fit fitted the 960×600 stage. The walls are 660 px of that width, so the room filled about 60 % of a 412 px phone.

## Decision

1. **The band fits the room** (`bandFit`, `apps/web/src/layout.ts`). It uses the largest whole scale up to `roomScale` that holds `BAND_WALL_TOP` (y 113) down to the lowest name tag foot, counting every seat, every standing spot and me. If none does, it uses the fraction that does, never under 0.5. At 1280×800 that is 0.60 to 0.70. The band's box is no wider than the room at that scale, centred, and its backdrop still bleeds to the column's edges (OME-1843). A change in my spot refits only when it changes the scale.
2. **Names and bubbles stay readable below 1×:** the band gets the phone's counter-scale (`labelScale`, ≥ 0.85 of their 1× size on screen, `.is-fit`).
3. **The phone's Fit fits the walls** (`ROOM_WALLS`, 660×532 stage px), not the stage. A window that holds them shows them centred (`panTo`).

## Consequences

- At 1× windows the band's pixel art is drawn below 1× (nearest-neighbour, like the phone's zoomed-out window). Whole-number scales stay wherever the band holds the span: 1280×1200 and 2× windows are unchanged.
- The TV keeps ADR 0059's size. The hero bound (43 %) is untouched.
- Rows of the room below the lowest name tag (the floor's front corner) can sit under the band's foot, and a wheel drag still reaches them.
- Reversing: drop `bandFit` from `room-layout.ts`. The band is then ADR 0059's again.
