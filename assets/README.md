# omega-share assets

Original art, CC BY-SA 4.0 (`LICENSE`). Style rules: `STYLE.md`.

```
assets/
  avatars/avatars.png   # shipped: 256×256 indexed PNG-8 sprite sheet
  avatars/avatars.json  # shipped: PixiJS v8 spritesheet atlas
  preview/              # not shipped: sheet at 4×, scene at 1× and 2×
  src/                  # generator (Bun, no deps) + mood boards
```

Rebuild everything (deterministic): `bun assets/src/build.ts`. Sprites are role-letter templates in
`src/avatars.ts`, and palette ramps are in `src/palette.ts`. Shading and outline are applied by `src/sprite.ts`.
The build fails if any sprite touches its cell border.

## Atlas format (PixiJS v8 native spritesheet JSON, TexturePacker "hash" style)

```ts
const sheet = await Assets.load("…/avatars/avatars.json"); // Spritesheet
sheet.textureSource.scaleMode = "nearest";
const s = new Sprite(sheet.textures["kiki/sit/sw/0"]); // anchor comes from the atlas
s.position.set(seatTileCenter.x, seatTileCenter.y);
```

- **Layout:** one row per avatar (`juno`, `pip`, `mo`, `kiki`, top to bottom). Within a row the 8 cells are
  `idle/se/0, idle/se/1, idle/sw/0, idle/sw/1, sit/se/0, sit/se/1, sit/sw/0, sit/sw/1`.
  Cells are 32×64 with no trimming and no rotation.
- **Frame key:** `<avatarId>/<pose>/<dir>/<n>`, where pose is `idle|sit`, dir is `se|sw`, and n is `0` (open eyes) or `1` (blink).
- **`animations`:** `<avatarId>/<pose>/<dir>` → `[…/0, …/1]`. This is **not** a loop. Show `1` for about 120 ms every
  3–6 s, with random jitter per avatar (`meta.omega.blink`).
- **Per-frame `anchor` = floor point** `(0.5, 0.953125)`, i.e. pixel (16, 61). For `idle` it's the feet.
  For `sit` it's the floor under the hips, so you place the sprite at the **seat tile centre**. Seats
  are drawn with their surface 8 px above that point (`meta.omega.seatHeight`).
- **`meta.omega`:** `tile {64×32}`, `cell`, `floorPoint`, `seatHeight`, `poses`, `dirs`, `blink`, and
  `avatars[] {id, label, blurb, colors {main, dark}}` (use `colors.main` for nickname tags and the picker).
- Status: accepted, see `docs/adr/0004-sprite-atlas-format.md`. `meta.format` is informational (PixiJS v8 ignores it); the PNG is indexed PNG-8.

## Budget

| File | Bytes |
|---|---|
| `avatars/avatars.png` | 2 862 |
| `avatars/avatars.json` | 12 752 raw / ~1 200 gz |
