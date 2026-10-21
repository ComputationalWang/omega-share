// OME-1687: the "lying" pose for the sofas and the cat bed. Built from the set (a) frames (composeMotion), so hair, clothes and
// shading are the avatar's own: the standing body is turned 90° in the picture plane (lying on its side, front to the camera,
// eyes shut) and sheared onto the 2:1 axis the sofa's seats run along. On the cat bed the knees come up (curled, like the cat).
import { composeMotion, type AvatarDef, type Dir } from "./avatars";
import { blank, mirror, type Grid } from "./sprite";

/** Wider than the 32×64 avatar cell: a lying body runs along the floor diagonal. */
export const LIE_CELL = { w: 50, h: 34 } as const;
/** The floor point: the surface point under the hips. Draw the frame there (see `LIE_ANCHORS` for each piece). */
export const LIE_FLOOR = { x: 36, y: 26 } as const;
/** Same facing set as `sit`. se/sw show the face (eyes shut), ne/nw the back. */
export const LIE_DIRS: readonly Dir[] = ["se", "sw", "ne", "nw"];
export type LieStyle = "lie" | "curl";
export const LIE_STYLES: readonly LieStyle[] = ["lie", "curl"];
/** Breathing loop: settled, then the flank rises 1 px. */
export const BREATH_FRAMES = 2;
export const BREATH_MS: readonly number[] = [1400, 1000];

// Set (a) rows (= turned columns): the head block ends above the torso row; the hips sit on the torso's last row.
const NECK: Record<LieStyle, number> = { lie: 40, curl: 40 };
/** Curl drops TUCK shin rows from SHIN down. */
const SHIN = 54, TUCK = 5;
const HIP: Record<LieStyle, number> = { lie: 50, curl: 50 };

/** Turn the cell a quarter anticlockwise: the top (head) goes left, the template's facing side (right) goes up. */
function turn(g: Grid): Grid {
  const h = g.length, w = g[0]?.length ?? 0;
  const out = blank(h, w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ch = g[y]?.[x] ?? ".";
    const row = out[w - 1 - x];
    if (row) row[y] = ch;
  }
  return out;
}

/** Curl: knees drawn up toward the camera, so the shins vanish behind the thighs and the shoes tuck in under the knees. */
function tuck(g: Grid): Grid {
  const empty = (): string[] => Array<string>(g[0]?.length ?? 0).fill(".");
  return [...g.slice(0, SHIN), ...g.slice(SHIN + TUCK, 61), ...Array.from({ length: g.length - 61 + TUCK }, empty)];
}

/** Breath frame 1: every column over the torso gains one pixel on its upper edge (the flank lifts). */
function breathe(g: Grid, x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) {
    const y = g.findIndex((row) => (row[x] ?? ".") !== ".");
    const above = g[y - 1], top = g[y]?.[x];
    if (y > 0 && above && top !== undefined) above[x] = top;
  }
}

/** Shear onto the "/" floor axis: one row up for every 2 px right, about the hips, then place the hips on LIE_FLOOR. The head
 *  (columns left of the neck) stays a rigid block resting flat, as on an armrest, so the face isn't stair-stepped. */
function shearInto(g: Grid, hipX: number, hipY: number, neck: number): Grid {
  const out = blank(LIE_CELL.w, LIE_CELL.h);
  g.forEach((row, y) => {
    row.forEach((ch, x) => {
      if (ch === ".") return;
      const dy = -Math.floor((Math.max(x, neck) - hipX) / 2);
      const nx = x - hipX + LIE_FLOOR.x, ny = y - hipY + LIE_FLOOR.y + dy;
      const dst = out[ny];
      if (dst && nx >= 0 && nx < LIE_CELL.w) dst[nx] = ch;
    });
  });
  return out;
}

/** The lying frame for `dir` (the piece's facing: se/nw seats run "/", sw/ne run "\"); `n` = breath frame. */
export function lieGrid(a: AvatarDef, dir: Dir, style: LieStyle, n: number): Grid {
  const back = dir === "ne" || dir === "nw";
  const g = composeMotion(a, "idle", back ? "nw" : "se", { blink: true });
  const t = turn(style === "curl" ? tuck(g) : g);
  // After the turn, source row y is column y and the body's lowest pixel (source x) is the row it rests on.
  const bottom = t.reduce((b, row, y) => (row.some((c) => c !== ".") ? y : b), 0);
  if (n === 1) breathe(t, NECK[style], HIP[style]);
  const s = shearInto(t, HIP[style], bottom, NECK[style]);
  // se and nw seats run "/" as drawn; sw and ne run "\".
  return dir === "sw" || dir === "ne" ? mirror(s) : s;
}

/** Where the lying frame's floor point (LIE_FLOOR) goes, in screen px from the piece's anchor (its anchor cell's centre, the
 *  point the piece's `back` frame is drawn at), per piece facing. The lift onto the cushion is included. Draw the lier between
 *  the piece's `back` and `front` layers, sorted at the piece's sort point, like a sitter. */
export interface LieAnchor { style: LieStyle; frame: "back" | "bed"; dirs: Partial<Record<Dir, { x: number; y: number }>> }
export const LIE_ANCHORS: Readonly<Record<string, LieAnchor>> = {
  sofa: { style: "lie", frame: "back", dirs: { se: { x: -4, y: 4 }, sw: { x: 4, y: 4 }, ne: { x: 4, y: 1 }, nw: { x: -4, y: 1 } } },
  couch: { style: "lie", frame: "back", dirs: { se: { x: -4, y: 4 }, sw: { x: 4, y: 4 }, ne: { x: 4, y: 1 }, nw: { x: -4, y: 1 } } },
  // The cat's empty-bed frame (`furniture/cat/<colour>/bed/<dir>`): the cat is out walking, so someone took its cushion.
  cat: { style: "curl", frame: "bed", dirs: { se: { x: 12, y: -2 }, sw: { x: -12, y: -2 } } },
};
