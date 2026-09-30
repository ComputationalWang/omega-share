# ADR 0012 — The TV lives outside the scaled stage

**Status:** accepted (2026-09-30) · [OME-84](/OME/issues/OME-84) · research: `docs/research/m1b-youtube-sync.md` §3.4

**Decision:**
- The YouTube player (`.tv`) and the control bar below it are laid out **unscaled**, above the 960×600 stage, by `roomLayout(containerWidth)` in `apps/web/src/layout.ts`. The stage scales down to fit under them and is clipped to its own box.
- The player rect is 16:9: **356×200 CSS px minimum**, 560×315 maximum, centred. If the container is narrower than 356 px, the TV keeps 356 and the page scrolls sideways. It never shrinks. The bezel is an `outline` outside the rect.
- The control bar is `CONTROL_BAR_H` = 44 px tall (set (e) chrome at 1×), 8 px below the player and as wide as it. OME-89 fills it.
- Bubbles and tags stay in the stage, capped at the boxes `bubbleRect`/`tagRect` report. `layout.test.ts` checks that no bubble, tag or control-bar rect meets the player, for widths 360–1920 and every seat and standing spot.

**Why:** YouTube's Required Minimum Functionality needs a player of at least 200×200 px with nothing of ours covering it. At a 360 px viewport the stage scales to 0.375, so an in-stage TV would need to be about 950 logical px wide. A separate unscaled box is the only way to meet the minimum at every width. It also makes "no overlays" true by construction: the room's layers can't reach the TV.

**Consequences:** the room art no longer contains the live screen. The atlas `tv/0` frame is decoration, and its `tv.screen` only has to stay 16:9. [OME-92](/OME/issues/OME-92) redraws the TV frame around the new player. Putting the TV back inside the stage would need a new ADR that still meets the size and overlay rules.
