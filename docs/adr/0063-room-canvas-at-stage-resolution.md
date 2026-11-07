# ADR 0063: The room canvas renders one backing px per stage px

**Status:** accepted (2026-11-06) · [OME-2330](/OME/issues/OME-2330)

**Context:** Since OME-6 the room's 2D canvas (ADR 0029) rendered at `min(2, devicePixelRatio)`, so a HiDPI screen got a 1920×1200 backing store for the 960×600 stage. Nobody recorded why. `walk25.conga.workP95.phone` sat on its 8 ms budget (7.6 / 7.8 / 8.1 ms in three flocked runs on main `4ab30759`). A timeline trace of the Pixel 7 Smooth window showed `Commit` taking 3.5 ms of every walking frame, more than half the frame's work. About 0.9 ms of that is `Canvas2DResourceProvider::ProduceCanvasResource`, and most of the rest is the main thread replaying the canvas's draw calls into the bitmap. The compositor thread stays idle meanwhile. Both scale with backing pixels: at resolution 1 the same window's `Commit` was 1.4 ms. On the phone the stage sits at zoom 1 in a 390–412 px window, so more than half of the 1920×1200 bitmap was never on screen anyway.

## Decision

The room canvas renders at `resolution: 1` on every screen (`apps/web/src/room-view.ts`). Nothing about the art changes. Sprites sit on whole stage px (Smooth rounds poses, ADR 0037), textures use nearest scaling, and `.scene` is `image-rendering: pixelated`, so a HiDPI screen shows what a DPR 1 screen already does, including at 2× wheel or pinch zoom. `e2e/phone-layout.e2e.ts` holds a DPR 2 phone's canvas to 960×600.

## Consequences

- Every walking frame on a HiDPI device commits a quarter of the pixels. The phone walk rows lose about 2 ms of traced work, and the conga row clears its budget (OME-2330 measurements).
- Vector edges drawn into the canvas (the floor diamonds baked into the shell, seat markers, the hover and editor cursor) step in whole stage px instead of half px on HiDPI screens. That is the same as on DPR 1 screens and fits the pixel-art look.
- `/snap` scales the canvas ×2 itself, so a HiDPI photo is now 1968 px wide, the same size as a DPR 1 one.
- Reverting to a DPR-based resolution brings back the ~2 ms per walking frame on phones. Measure the phone walk rows before doing it.
