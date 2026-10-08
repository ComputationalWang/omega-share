# ADR 0029 — The room draws on Pixi's 2D canvas renderer; clients walk avatars locally

**Status:** accepted (2026-10-08) · Lead · [OME-408](/OME/issues/OME-408) · amends [ADR 0001](0001-stack.md) ("PixiJS (WebGL)") · uses [ADR 0010](0010-motion-atlas.md)

**Context:** M5 adds walking. While anyone walks, the room re-renders every frame, where before it rendered only on change (OME-185). We measured 8 avatars walking with the fake YouTube player in the perf harness (headless Chromium, `--trace off`). On WebGL, each frame cost about 7.5 ms of observer main thread, and `GLES2::ReadPixels` under `LayerTreeHost::DoUpdateLayers` took about 6 ms of that. With software compositing (headless, and any browser whose GPU is blocklisted), a WebGL canvas is read back from the GPU process on every commit. Our JS was about 0.2 ms a frame. Hiding the canvas brought work down to 0.4 ms. Hiding the DOM name tags changed nothing.

| 8 walking + video (YouTube fake) | work p95 | frame p95 | missed vsyncs |
|---|---|---|---|
| WebGL, only the observer animates | 8.06–8.47 ms | 16.67 ms | 0 % |
| WebGL, all 8 clients animate (one browser) | 32–34 ms | 33.3 ms | 83–89 % |
| 2D canvas, only the observer animates | 1.55–2.43 ms | 16.67 ms | 0 % |
| 2D canvas, all 8 clients animate (one browser) | 3.35–4.03 ms | 16.67 ms | 0 % |

**Decision:**
- `room-view.ts` creates the Pixi `Application` with `preference: "canvas"`. Our scene is a pixel-art floor plus about 30 sprites with nearest-neighbour sources, so it doesn't need GPU batching. An e2e guard (`e2e/walk.e2e.ts`) fails if the room canvas isn't 2D.
- Walking stays client-side, with no contract change. The server is seat-authoritative. Each client walks an avatar from the door (front corner cell `(9,9)`) or its previous spot to its new seat or standing spot. It uses BFS over the layout grid, where solid pieces block and the path's ends may be solid. Paths are found once per spot change, never per frame. The walk is time-based at ADR 0010's 150 ms a frame and 4 frames a tile. Avatars move in whole `stepPx` steps (8 × 4 px a frame), and every walk starts on a shared 150 ms step clock, so all walkers step together. My own snapshot places everyone without a walk, a new layout snaps, and `prefers-reduced-motion` jumps straight to the spot and holds the still pose.
- No per-frame loop. While anyone walks, the room redraws once per step (≤ 6.7 times a second, however many walk): a timer to the next tick of the step clock, then one rAF. At rest, breathing redraws on a shared 400 ms clock (≤ 2.5 times a second, however full the room). A hidden tab renders nothing. `destroy()` drops any pending timer or frame.
- The set (a) and set (d) sheets load in their own chunk (`walk/motion-atlas.ts`) once the room has people in it. Until then, and if the sheets fail to load, avatars are the placeholder shapes, and they still walk.

**Consequences:** Pixi's canvas renderer chunk (~28 KB gz) loads with the room instead of the WebGL one. That's lazy, so initial JS is unchanged. Filters, meshes and custom shaders aren't available. If the room ever needs them, measure on software compositing first, and draw them on a separate WebGL layer that renders on change only. Don't move the whole room back to WebGL.
