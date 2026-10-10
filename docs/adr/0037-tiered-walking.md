# ADR 0037 — Tiered walking (Smooth and Basic)

**Status:** accepted (2026-10-10) · Lead · [OME-731](/OME/issues/OME-731) · research [R-M8a](../research/m8-smooth-walk.md) §1–§3 · amends [ADR 0029](0029-room-canvas-renderer-and-walking.md) and [ADR 0010](0010-motion-atlas.md)

**Context:** M5 walks avatars in whole 8 × 4 px steps, one room render per 150 ms step (ADR 0029). That is cheap but reads as choppy. Set (l) adds a smooth 8-frame walk (`walk8/<id>/<dir>`, 8 × 75 ms) whose even frames are the 4-frame walk's own keys. R-M8a measured both: a Smooth frame costs the same work as a Basic step render (a full 2D canvas redraw), but Smooth renders about 9× as often while anyone walks. That is battery and headroom on slow phones, not jank on the budget profiles. So the walk comes in two tiers, chosen per device.

**Decision:**
- **Two tiers, same walk.** Paths, waypoint times and the shared 150 ms start clock (`walks.ts` `stepClock`) are the same on both, so start and arrival times match to the ms and everything that keys off "arrived" (rest phase, seat badges, bubble settle) behaves the same.
  - **Basic:** walk time held to the 150 ms step, whole `stepPx` moves, the even frames of the 8-frame cycle at 150 ms (frames 0, 2, 4, 6 = `walk/<id>/<dir>/0..3`). One timer per step, then one rAF, as in ADR 0029.
  - **Smooth:** walk time on the clock, position rounded to whole stage px, frame `floor(t / 75) % 8`. While anyone walks, each frame asks for the next rAF. At rest it goes back to the 400 ms breathe clock. A hidden tab, `pause()` and `dispose()` still stop everything.
  - The tier is read on every sample (`WalksOptions.smooth`, `AnimatorOptions.smooth`), so a mid-walk drop takes effect on the next frame. Swapping mid-stride never pops: Smooth is at most one step ahead of Basic, on Basic's frame or the in-between after it.
- **Choosing the tier** (`apps/web/src/walk/tier.ts`, pure, at room start):
  1. `localStorage["omega.motion"]` = `"smooth"` or `"basic"` forces a tier for the session (e2e, perf, later a user setting). It is parsed; anything else is ignored.
  2. `prefers-reduced-motion` means no walk at all, on either tier (unchanged from ADR 0029). Save-Data, `hardwareConcurrency` < 4 or a reported `deviceMemory` < 4 → Basic for the session.
  3. Otherwise start in Basic and probe. After each render, post on one `MessageChannel`; the handler's time since the frame started is the post-render work, which includes paint and raster (the rAF frame time alone read 16.7 ms even where work was twice the budget). Samples go into preallocated `Float64Array`s, nothing allocates per frame. While probing, one extra empty rAF next to each render gives the rAF interval.
  4. **Upgrade** to Smooth when, over the first 30 renders, the post-render p95 is ≤ 8 ms and the median rAF interval is ≤ 20 ms (a 30 Hz battery-saver rAF stays Basic). Otherwise Basic for the session.
  5. **Drop** to Basic for the session when the post-render p95 over the last 120 Smooth walking renders is > 10 ms, or > 5 % of the walking rAF intervals in a 5 s window are late (> 1.5 × the window's median, so it holds at any refresh rate). Only frames where Smooth drew a walk count; intervals over 1 s (a tab coming back, full screen) are ignored. No flipping back up until reload.
- The room canvas carries `data-motion="smooth" | "basic"` (written when it changes), so e2e and perf can check which tier they measured.
- DOM followers (tags, bubbles, emote badges) get whole px and are only moved when the pixel changes.

**Amends ADR 0029:** "No per-frame loop" now reads: no per-frame loop in Basic; in Smooth the room renders every frame while anyone walks, and only then.

**Amends ADR 0010:** the walking contract is now two entries in `meta.omega`. `walk = { frameMs: 150, tilesPerCycle: 1, stepPx: {x: 8, y: 4} }` is Basic's (`stepPx` applies to Basic only). `walk8 = { frameMs: 75, frames: 8, tilesPerCycle: 1, stepPx: {x: 4, y: 2} }` is Smooth's cycle; Smooth itself moves in whole px, not in `stepPx`. `motion.ts` parses both and refuses a sheet whose `walk8/<id>/<dir>` isn't 8 frames at 75 ms or whose even frames aren't the `walk/<id>/<dir>` keys.

**Consequences:** no `packages/shared` and no wire change: walking stays client-local and the server stays seat-authoritative. The atlas grows by the 64 in-betweens (same 1024×512 sheet, lazy chunk, initial JS unchanged). Smooth costs about 9× the room CPU while people walk on capable devices; the probe keeps it off where a frame doesn't fit the 8 ms budget. The perf budgets add 25-walker rows per forced tier, desktop and Pixel 7 (`docs/perf-budgets.md`), and the polish walk rows run once per tier.
