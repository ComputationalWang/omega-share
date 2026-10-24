# Responsive polish, round 2 (OME-1847)

Design notes for the four cosmetic findings of audit round 2 (OME-1840, `main` @ `2355bdb2`; contact sheets on OME-1840).
The art and copy parts ship on this branch. The code parts are handed to the Lead as a restyle issue.

## 1. Curtain caption on big TVs: scale it with the TV

The "Nothing on yet…" plate (`.tv-empty`, `apps/web/src/room.css`) uses the chrome's text size, while the TV grows to
1100+ px in the 1920/2560 room view and to the whole screen in full screen. Size the plate by the TV, not the page:

```css
.tv-curtain { container-type: size; }
.tv-empty {
  font-size: clamp(var(--text-sm), 2.2cqw, 40px);
  padding: 0.3em 0.9em;
  border-width: max(var(--ui-px), 0.12em);
  max-width: min(80%, 30em);
}
```

- 2.2 % of the TV's width: about 14 px on a 640 px TV (as now), 24 px at 1100 px, and 40 px (the cap) from a 1820 px TV,
  so full screen at 1440+ reads like a title card, not a tooltip.
- The TV is outside the chrome's `zoom` (`.stage-wrap` is excluded), so `cqw` is real px and the 1.5×/2× chrome steps
  don't double it.
- The curtain tiles keep their art pixel (`--ui-px` 2 px, 4 px at chrome 2). A bigger drape weave isn't needed: at full
  screen the fabric reads fine, and only the caption was lost.

## 2. Editor tray "Armchair" tile: art, shipped here

Cause: the tray draws `ui-thumb-<atlas id>-<first colour>`, and only catalogue pieces had `thumb/*` frames. The five
room atlas pieces had none: **Armchair** and **TV console** (no colours, so their tile falls back to the name), and
**Lamp**, **Plant** and **Big rug**, which ask for `ui-thumb-lamp-cream`, `ui-thumb-plant-rust` and `ui-thumb-rug-navy`.
Those classes didn't exist, so the tile stayed empty.

This branch adds all five to the lazy `ui/edit.png`, re-cast from the same solids as the preset thumbnails (same light,
tones and plum outline, ≤ ½ scale, fitted to the 44×40 box like the catalogue's). The big rug shows a 3×3 corner of
itself (rim and lozenge field), since the whole 7×7 rug would be mush at that size:

| frame | size | class |
|---|---|---|
| `thumb/armchair/velvet` | 27×23 | `.ui-thumb-armchair-velvet` |
| `thumb/tv/charcoal` | 42×17 | `.ui-thumb-tv-charcoal` |
| `thumb/lamp/cream` | 18×38 | `.ui-thumb-lamp-cream` |
| `thumb/plant/rust` | 22×21 | `.ui-thumb-plant-rust` |
| `thumb/rug/navy` | 44×23 | `.ui-thumb-rug-navy` |

Lamp, plant and rug now light up with no code change. Armchair and TV need one line in `editor.ts`: when `coloursOf(kind)`
is empty, use the tray-only name (`armchair` → `velvet`, `tv` → `charcoal`) instead of the text. Keep the name as the
`title` / `aria-label`, as now. Cost: `edit.png` +710 B (lazy, owners only); no eager bytes.

## 3. Directory preset blurbs: shorter copy, and the 4-column grid shows the picked one

At 1280+ the create card's 4-column grid leaves about 80 px per card, so any blurb wraps a word per line.

- **Copy (shipped here):** every blurb is now ≤ 44 characters, one idea, no tagline ("Two rows of armchairs on the big
  rug.", "Bar stools, hammocks, a piano, a fire.", …). That helps the phone strip (140 px cards, 2–3 lines) too.
- **Layout (Lead):** in the 4-column grid (`@container (min-width: 360px)`), hide `.preset-blurb` in the cards and show
  the picked preset's blurb once, under the grid, in a `.preset-note` line (`--text-sm`, `--muted`; `aria-live="polite"`;
  link it to the radios with `aria-describedby` so screen readers still hear each blurb). Update it on `change`. The
  phone strip and the 2-column grid keep blurbs on the cards.

## 4. Landing, directory and legal at 2560: 2× at the room's 2× step

Yes. At the room page's 2× step (`chromeZoom`: ≥ 2560 × 1200) the plain pages get `zoom: 2` on their page column. The
1120 px cap becomes 2240 px on screen, which leaves 160 px either side at 2560. Same size in both places, so going
from the directory into a room no longer jumps the type.

- **Only 2×, no 1.5× step at 1920.** The landing hero and the preset thumbnails are pixel art. 1.5× smears them
  (STYLE.md: whole-number scales only), and at 1920 the 1× column already reads fine (the audit flagged 2560 only).
- One media query, `@media (min-width: 2560px) and (min-height: 1200px)`, on the plain pages' main column, never on
  the room page (it has its own `data-chrome`).
