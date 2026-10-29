// OME-1687: the "lying" pose for the sofas and the cat bed. Built from the set (a) frames (composeMotion), so hair, clothes and
// shading are the avatar's own: the standing body is turned 90° in the picture plane (lying on its side, front to the camera,
// eyes shut) and sheared onto the 2:1 axis the sofa's seats run along. On the cat bed the knees come up (curled, like the cat).
// OME-1983: `sleep` is the queen bed's: turned the other way, so the head lies up the axis on the pillows at the headboard.
import { composeMotion, type AvatarDef, type Dir } from "./avatars";
import { blank, mirror, type Grid } from "./sprite";

/** Wider than the 32×64 avatar cell: a lying body runs along the floor diagonal. */
export const LIE_CELL = { w: 50, h: 34 } as const;
/** The floor point: the surface point under the hips. Draw the frame there (see `LIE_ANCHORS` for each piece). */
export const LIE_FLOOR = { x: 36, y: 26 } as const;
/** `sleep` runs the other way (head up the axis), so its hips sit left of centre; se/nw as drawn, sw/ne mirrored. */
export const SLEEP_FLOOR = { x: 13, y: 30 } as const;
export const floorOf = (style: LieStyle): { x: number; y: number } => (style === "sleep" ? SLEEP_FLOOR : LIE_FLOOR);
/** Same facing set as `sit`. se/sw show the face (eyes shut), ne/nw the back. */
export const LIE_DIRS: readonly Dir[] = ["se", "sw", "ne", "nw"];
export type LieStyle = "lie" | "curl" | "sleep";
export const LIE_STYLES: readonly LieStyle[] = ["lie", "curl", "sleep"];
/** Breathing loop: settled, then the flank rises 1 px. */
export const BREATH_FRAMES = 2;
export const BREATH_MS: readonly number[] = [1400, 1000];

// Set (a) rows (= turned columns): the head block ends above the torso row; the hips sit on the torso's last row.
const NECK: Record<LieStyle, number> = { lie: 40, curl: 40, sleep: 40 };
/** Curl drops TUCK shin rows from SHIN down. */
const SHIN = 54, TUCK = 5;
const HIP: Record<LieStyle, number> = { lie: 50, curl: 50, sleep: 50 };

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

/** A half turn: with `turn` it turns the cell a quarter clockwise, head right. */
const half = (g: Grid): Grid => [...g].reverse().map((r) => [...r].reverse());

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
function shearInto(g: Grid, hipX: number, hipY: number, neck: number, headRight = false): Grid {
  const out = blank(LIE_CELL.w, LIE_CELL.h);
  const floor = headRight ? SLEEP_FLOOR : LIE_FLOOR;
  g.forEach((row, y) => {
    row.forEach((ch, x) => {
      if (ch === ".") return;
      const dy = -Math.floor(((headRight ? Math.min(x, neck) : Math.max(x, neck)) - hipX) / 2);
      const nx = x - hipX + floor.x, ny = y - hipY + floor.y + dy;
      // A sleeper's toes run past the cell's foot; the duvet covers them anyway, so they stop a row short of the outline.
      const dst = headRight && ny > LIE_CELL.h - 3 ? undefined : out[ny];
      if (dst && nx >= 0 && nx < LIE_CELL.w) dst[nx] = ch;
    });
  });
  return out;
}

/** The lying frame for `dir` (the piece's facing: se/nw seats run "/", sw/ne run "\"); `n` = breath frame. A sleeper in
 *  bed shows the face in every facing (the bed runs toward the camera), so `sleep` ne/nw are sw/se. */
export function lieGrid(a: AvatarDef, dir: Dir, style: LieStyle, n: number): Grid {
  const sleep = style === "sleep";
  const back = !sleep && (dir === "ne" || dir === "nw");
  const g = composeMotion(a, "idle", back ? "nw" : "se", { blink: true });
  const t = sleep ? half(turn(g)) : turn(style === "curl" ? tuck(g) : g);
  // After the turn, source row y is column y (column w − 1 − y after the half turn) and the body's lowest pixel is the row it rests on.
  const w = t[0]?.length ?? 0;
  const neck = sleep ? w - 1 - NECK[style] : NECK[style], hip = sleep ? w - 1 - HIP[style] : HIP[style];
  const bottom = t.reduce((b, row, y) => (row.some((c) => c !== ".") ? y : b), 0);
  if (n === 1) breathe(t, Math.min(neck, hip), Math.max(neck, hip));
  const s = shearInto(t, hip, bottom, neck, sleep);
  // se and nw seats run "/" as drawn; sw and ne run "\".
  return dir === "sw" || dir === "ne" ? mirror(s) : s;
}

/** Where the lying frame's floor point (LIE_FLOOR) goes, in screen px from the piece's anchor (its anchor cell's centre, the
 *  point the piece's `back` frame is drawn at), per piece facing. The lift onto the cushion is included. Draw the lier between
 *  the piece's `back` and `front` layers, sorted at the piece's sort point, like a sitter. */
export interface LieAnchor {
  style: LieStyle;
  frame: "back" | "bed";
  dirs: Partial<Record<Dir, { x: number; y: number }>>;
  /** A second sleeper side by side (the queen bed): its floor point. `dirs` is sleeper 0, on the seats' half. */
  beside?: Partial<Record<Dir, { x: number; y: number }>>;
}
export const LIE_ANCHORS: Readonly<Record<string, LieAnchor>> = {
  sofa: { style: "lie", frame: "back", dirs: { se: { x: -4, y: 4 }, sw: { x: 4, y: 4 }, ne: { x: 4, y: 1 }, nw: { x: -4, y: 1 } } },
  couch: { style: "lie", frame: "back", dirs: { se: { x: -4, y: 4 }, sw: { x: 4, y: 4 }, ne: { x: 4, y: 1 }, nw: { x: -4, y: 1 } } },
  // The cat's empty-bed frame (`furniture/cat/<colour>/bed/<dir>`): the cat is out walking, so someone took its cushion.
  cat: { style: "curl", frame: "bed", dirs: { se: { x: 12, y: -2 }, sw: { x: -12, y: -2 } } },
  // Queen bed (OME-1983): hips at local x 8 on the mattress (z 7), one sleeper per half; heads on the pillows at the headboard.
  bed: {
    style: "sleep",
    frame: "back",
    dirs: { ne: { x: 16, y: 1 }, nw: { x: -16, y: 1 }, se: { x: 16, y: 17 }, sw: { x: -16, y: 17 } },
    beside: { ne: { x: -16, y: 17 }, nw: { x: 16, y: 17 }, se: { x: -16, y: 1 }, sw: { x: 16, y: 1 } },
  },
};
