# ADR 0010 — Motion atlas (walk, breathe, wave, emotes)

**Status:** proposed (2026-09-30) · [OME-56](/OME/issues/OME-56) · extends [ADR 0004](0004-sprite-atlas-format.md) and [ADR 0008](0008-room-atlas-and-back-facing-avatars.md)

**Decision:**
- Avatar motion ships as a **second sheet**, `assets/avatars/motion.{png,json}` (1024×512 indexed PNG-8, same PixiJS v8 JSON as ADR 0004). `avatars.png` doesn't change. The web loads it after the room is up, so first paint and TTI don't pay for it.
- Frame keys are namespaced by animation: `walk/<id>/<dir>/<n>`, `breathe/<id>/<pose>/<dir>/1`, `wave/<id>/<pose>/<dir>/<n>`, `emote/<emoteId>/<n>`. `walk`, `breathe`, `wave` and `emote` join the reserved prefixes of ADR 0008. The asset build enforces cross-set uniqueness.
- Avatar cells keep the set (a) cell (32×64) and anchor (floor point `(16, 61)`). Emote cells are 16×16, anchored bottom-centre.
- Timing lives in the atlas: `meta.omega.anims[name] = { frames: key[], ms: number[], loop: boolean }`. Pixi's native `animations` map repeats the frame lists where every frame is in this sheet (all but `breathe/*`, whose first frame is the set (a) `/0` frame).
- Walking speed is part of the contract: `meta.omega.walk = { frameMs: 150, tilesPerCycle: 1, stepPx: {x: 8, y: 4} }`.

**Why:** one extra ~18 KB request that's off the critical path, instead of growing the sheet every room loads. Durations in the atlas let art change the timing without code changes. Cross-sheet keys work because Pixi caches textures globally by key.

**Open for the Lead Engineer:** a Valibot schema for `meta.omega.anims` / `walk` when M5 starts, and whether emotes are server-relayed events (a wire-contract change, `packages/shared`).
