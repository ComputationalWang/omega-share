# ADR 0004 — Sprite atlas format

**Status:** accepted (2026-09-29) · [OME-10](/OME/issues/OME-10) · details in `assets/STYLE.md` + `assets/README.md` ([OME-2](/OME/issues/OME-2))

**Decisions:**
- One atlas per set (`avatars`, `room`, `ui`): `assets/<set>/<set>.png` (indexed PNG-8, **binary** tRNS alpha only) + `assets/<set>/<set>.json` in the **PixiJS v8 native spritesheet JSON** (TexturePacker "hash"). There is no custom loader. No rotation, no trimming, `meta.scale: "1"`, and **no @2x sheets**.
- Frame keys are `<id>/<pose>/<dir>/<n>` (e.g. `juno/sit/sw/0`). Pixi's `Assets` caches frame textures **globally by key**, so ids must be unique across all sets. The asset build enforces this.
- Every frame carries `anchor` at the **floor point** (`meta.omega.floorPoint / cell`). The web places a sprite at its tile-centre screen position and z-sorts by `(floorY, floorX, layer)`. If furniture has to draw in front of a seated avatar (armrests, table fronts), it ships a separate front-layer frame. There are no per-sprite z hacks.
- `meta.omega` is the renderer contract: `tile`, `cell`, `floorPoint`, `seatHeight`, `poses`, `dirs`, `blink`, `avatars[]`. The web parses it with a strict Valibot schema at load.
- **`meta.omega.avatars[i]` is wire avatar `i`** (`AvatarSchema` in `packages/shared`). The order is append-only, and the length must equal `AVATAR_COUNT`. If you reorder it, every stored and in-flight avatar choice changes.
- Blink is driven by one shared ticker that swaps textures, and it only runs on avatars that are visible. It does not use `AnimatedSprite`, and it does not use per-avatar timers. `animations` is informational.
- The web never assumes sheet dimensions or cell positions; it reads `frame` rects. Sheets may grow (power of two) as sets grow.
- Scaling uses nearest-neighbour at integer world scales only, with `roundPixels: true`. The renderer, not the art, handles HiDPI.

**Why:** a single texture per set keeps PixiJS batching in one draw call per layer. The native format keeps the bundle free of loaders. A fixed floor-point anchor lets avatars, seats and furniture compose without per-item offsets. Tying the atlas order to the wire index is the one place art and protocol meet, so it has to be written down.
