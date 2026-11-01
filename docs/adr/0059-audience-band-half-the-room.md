# ADR 0059: The audience band holds half the room and looks up to the back wall

**Status:** accepted (2026-11-01) · Lead · [OME-2117](/OME/issues/OME-2117) (design judge REVISE on [OME-2116](/OME/issues/OME-2116), QA evidence [OME-2107](/OME/issues/OME-2107#document-review) finding 1)

**Context:** With a video loaded, the wide page makes the TV the hero and the room a band under the shelf (OME-1803, design OME-1799 §2), at least 240 px and 28 % of the column, at 1× or 2× (OME-1811). At 1280×800 that band was 240 px of the 532 px room (`ROOM_VIEW`), and it was centred on the audience. Wave 2 puts its art on the back walls (wall screens, projector, neon, fireplace, partition glass), so it was above the band in almost every preset. In a swap room the band ignored where I stood: from Dank Dungeon's north side, the band's foot cut my own avatar.

## Decision

1. **The band's floor is half the room:** `BAND_MIN_H = ROOM_VIEW.h / 2` (266 px at 1×; 2× needs 532). `BAND_SHARE` (28 %) is unchanged.
2. **The band looks as high as keeps the audience whole.** When every seat's and standing spot's name tag fits, the front row's tag foot sits one pixel above the band's foot, and the back wall gets the rest. Where the tags don't fit, OME-1864/OME-1945 still apply (seats whole first). The band never rises past the back seats' tops while they fit: where the seats and the front row's tags don't both fit (the Dank Dungeon and the Penthouse from the south at 1280×800, Twitch at 1280×720), the seats stay whole and clickable and the front tags give way.
3. **Standing, I'm always whole in the band**, head (`AVATAR_TOP`) to name tag, on any floor cell from either side, except that the back seats' tops win over my name tag where both don't fit: on 1–3 front cells of the Dank Dungeon, the Penthouse and the Studio at 1280×800 my tag loses up to 26 px, my avatar head to feet stays whole (and Twitch's 1280×720 seats stay clickable for a viewer who joins standing). The band re-homes when my spot changes, as the phone window already does (OME-1930), until the viewer drags or zooms it.

## Consequences

- The hero TV loses 26 px of height at the floor. At 1280×800 it is 702×395 (55 % of the window). At 1920×1080 (chrome 1.5×) it is 842 px, **43.9 %** of the window. That is under OME-1803's 45 %, so the hero test's bound is now 43 %. Keeping 45 % at 1920 would cap the band at about 254 px, under half the room, and keep the same crop there.
- At 1× the band still can't show the whole back wall above the audience: the audience alone is about 240 px tall. The band shows every row above it, which is the lower part of the back walls (most of the side-wall art and, from the north, the partition glass). The rest is a drag away.
- Twitch's larger minimum (534×300) still wins over the floor: its band can be under half the room in short windows (unchanged, OME-1864).
