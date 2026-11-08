# ADR 0065: Chat bubbles stay in the DOM; only text-free scene UI is painted

**Status:** accepted (2026-11-08) · [OME-2307](/OME/issues/OME-2307)

**Context:** Doorstep desk 3 (OME-2307) moves scene-bound UI into the PixiJS room canvas so camera and avatar movement is one transform. Name tags (3b, PR #960) moved first. Bubbles (3c, PR #965) followed: each bubble was a pooled sprite over its own 2D canvas, drawn at the next whole stage scale. The perf A/B passed. QA ([OME-2400](/OME/issues/OME-2400)) rejected it on legibility. The room canvas has one backing px per stage px (ADR 0063), so painted 12 px body text is limited to a 960×600 bitmap that CSS then resamples. On a Pixel 7 (DPR 2.625) three lines of body text came out blurred, and at the 1024×768 stage scale of 0.85 nearest sampling dropped pixels from glyphs. DOM text on `main` is sharp in both cases. Tags got through because they are one or two bold words.

The fixes that would make painted text sharp break other decisions:
- A canvas at `devicePixelRatio × stage scale` brings back the ~2 ms per walking frame on phones that ADR 0063 removed.
- A second canvas for UI only is the new renderer the issue rules out, and it would pay its own commit on every walking frame.
- Painted frame and tail with DOM text over them costs the DOM writes and the canvas renders together, more than either does alone.

## Decision

Chat bubbles (frame, tail, text, typing dots, thought cloud) stay DOM, as on `main` (`apps/web/src/bubbles/floats.ts`). PR #965 is closed unmerged. Scene UI without body text is still painted into the canvas: name tags (merged), reaction glyphs (3d) and the seat cursor (3e). These are pixel art, and pixel art looks the same at stage resolution.

Rule for later moves: text longer than a short bold label stays DOM while the room canvas renders at stage resolution.

## Consequences

- Bubble legibility matches `main` at every sign-off size and DPR.
- Bubble steps still cost no canvas render (OME-1206), and walking still writes bubble positions to the DOM, as today.
- Camera and avatar movement is one transform for tags, reactions and the cursor, but not for bubbles. That covers less than OME-2307's original scope.
- Reverting this means painting text at device resolution, which first needs ADR 0063 revisited with the phone walk rows measured.
