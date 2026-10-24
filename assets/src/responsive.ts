// OME-1799 (responsive proposal): the empty TV. With nothing playing, the picture was a black slab with one grey line, the
// biggest dead area at every size. Now the theatre's velvet curtains are drawn closed across the screen, with a sliver of the
// TV glow at the seam ("something will play here").
// Tiles, not one picture: the TV is 356 to 1700 px wide, and one drawing stretched to fill it would land on any odd scale.
// CSS repeats the tiles at the page chrome's art pixel (--ui-px, 2 px; 4 px under the 2× chrome zoom), like the shelf and keys
// around the TV: pelmet (repeat-x) over drape (repeat both) over hem (repeat-x), seam centred (repeat-y). Every pixel opaque.
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import type { UiFrame } from "./ui";

const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);

function tile(key: string, w: number, h: number, paint: (x: number, y: number) => number): UiFrame {
  const img = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img[y * w + x] = paint(x, y);
  return { key: `scene/curtain-${key}`, w, h, img, ax: 0, ay: 0 };
}

/** Fold tone by column: a highlight ridge, base, then the shade valley (light from the top-left, so ridges lead). */
const FOLD: readonly Tone[] = [2, 1, 0, 0, 1, 1, 1, 2];

/** 8×8, repeats both ways: the drape's vertical folds. */
const drape = (): UiFrame => tile("drape", 8, 8, (x) => c("velvet", FOLD[x] ?? 1));

/** 16×13, repeats across the top: wood rail, one velvet swag, its mustard fringe, and a tassel where swags meet. */
function pelmet(): UiFrame {
  const W = 16;
  return tile("pelmet", W, 13, (px, y) => {
    if (y < 3) return c("wood", y as Tone);
    // Drawn half a tile over so the tassel and its outline sit mid-tile: the tile edges fall mid-swag and repeat seamlessly.
    const x = (px + W / 2) % W;
    // Tassel at the join (x 0), with plum either side of its knot so it reads against the velvet.
    if (x === 0 && y < 7) return c("mustard", y === 3 ? 0 : y === 6 ? 2 : 1);
    if ((x === 1 || x === W - 1) && y === 4) return OUTLINE;
    const depth = 4 + Math.round(4 * Math.sin((Math.PI * x) / W));
    if (y < 3 + depth) return c("velvet", y === 3 ? 0 : y === 2 + depth ? 2 : 1);
    if (y === 3 + depth) return c("mustard", x % 2 === 0 ? 0 : 1);
    // Under the swag the drape shows through, fold for fold (16 is two fold periods).
    return c("velvet", FOLD[x % FOLD.length] ?? 1);
  });
}

/** 12×7, repeats across the bottom: drape's shaded foot, a two-row mustard fringe, then the stage boards (one joint per tile). */
function hem(): UiFrame {
  return tile("hem", 12, 7, (x, y) => {
    if (y === 0) return c("velvet", 2);
    if (y === 1) return c("mustard", x % 2 === 0 ? 0 : 1);
    if (y === 2) return x % 2 === 0 ? c("mustard", 2) : c("velvet", 2);
    if (y === 3) return c("wood", 0);
    if (y === 5 && x === 11) return c("wood", 2);
    return c("wood", y === 6 ? 2 : 1);
  });
}

/** 3×6, repeats down the middle: the drapes' shaded leading edges with one art pixel of dim TV glow between them. */
const seam = (): UiFrame => tile("seam", 3, 6, (x) => (x === 1 ? c("glow", 2) : c("velvet", 2)));

export function buildResponsiveScenes(): UiFrame[] {
  return [pelmet(), drape(), hem(), seam()];
}

