// OME-2235 (judge round 5): a seated avatar's head and torso stay ≥ 80 % visible in front of every armchair and sofa `front`
// layer. Measured on the shipped atlases: each sitter is composited at its seat, and its head+torso pixels (everything above
// the seat surface) count as hidden where the piece's `front` frame is opaque.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const ROOT = join(import.meta.dir, "..");
interface Rect { x: number; y: number; w: number; h: number }
interface Frame { frame: Rect; anchor: { x: number; y: number } }
interface Seat { col: number; row: number; dir: string }
interface Piece { id: string; colours: string[]; seatsByDir?: Record<string, Seat[]>; layersByDir: Record<string, string[]> }
interface Atlas { frames: Record<string, Frame>; meta: { image: string; omega: { pieces?: Piece[] } } }
interface Sheet { atlas: Atlas; w: number; px: Uint8Array }

/** Indexed PNG → palette indices (0 = transparent). Handles the filters `png.ts` writes: none (0) and up (2). */
function sheet(file: string): Sheet {
  const atlas = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Atlas;
  const png = readFileSync(join(ROOT, file.replace(/[^/]+$/, atlas.meta.image)));
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  let idat = Buffer.alloc(0);
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    if (png.toString("latin1", o + 4, o + 8) === "IDAT") idat = Buffer.concat([idat, png.subarray(o + 8, o + 8 + len)]);
    o += 12 + len;
  }
  const raw = inflateSync(idat), px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w + 1)] ?? 0;
    if (f !== 0 && f !== 2) throw new Error(`${file}: PNG filter ${String(f)}`);
    for (let x = 0; x < w; x++) px[y * w + x] = ((raw[y * (w + 1) + 1 + x] ?? 0) + (f === 2 && y > 0 ? (px[(y - 1) * w + x] ?? 0) : 0)) & 255;
  }
  return { atlas, w, px };
}

/** Opaque pixels of a frame, as screen points relative to its anchor. */
function ink(s: Sheet, key: string): { x: number; y: number }[] {
  const f = s.atlas.frames[key];
  if (!f) throw new Error(`no frame ${key}`);
  const ax = Math.round(f.anchor.x * f.frame.w), ay = Math.round(f.anchor.y * f.frame.h), out: { x: number; y: number }[] = [];
  for (let y = 0; y < f.frame.h; y++) for (let x = 0; x < f.frame.w; x++) {
    if ((s.px[(f.frame.y + y) * s.w + f.frame.x + x] ?? 0) !== 0) out.push({ x: x - ax, y: y - ay });
  }
  return out;
}

const SEAT_HEIGHT = 8;
const AVATARS = ["juno", "pip", "mo", "kiki"];
const avatars = sheet("avatars/avatars.json"), watching = sheet("avatars/watching.json");
/** Every seated look of one avatar in one facing: the plain sit frames, and the from-behind watching poses for ne/nw. */
const sitters = (who: string, dir: string): Point[][] => [
  ...Object.keys(avatars.atlas.frames).filter((k) => k.startsWith(`${who}/sit/${dir}/`)).map((k) => ink(avatars, k)),
  ...Object.keys(watching.atlas.frames).filter((k) => k.startsWith("watch/") && k.endsWith(`/${who}/${dir}/0`)).map((k) => ink(watching, k)),
];
type Point = { x: number; y: number };

/** Lowest share of the upper body left showing over every avatar, pose and seat of one `front` frame: rows above the seat
 *  surface, down from `top` (−Infinity: head and torso; −22: the torso band from the shoulders down). */
function minVisible(front: Point[], seats: readonly Seat[], top = -Infinity): number {
  const cover = new Set(front.map((p) => `${String(p.x)},${String(p.y)}`));
  let worst = 1;
  for (const seat of seats) for (const who of AVATARS) for (const body of sitters(who, seat.dir)) {
    const ox = (seat.col - seat.row) * 32, oy = (seat.col + seat.row) * 16;
    const upper = body.filter((p) => p.y >= top && p.y < -SEAT_HEIGHT);
    const hidden = upper.filter((p) => cover.has(`${String(p.x + ox)},${String(p.y + oy)}`)).length;
    worst = Math.min(worst, 1 - hidden / upper.length);
  }
  return worst;
}

/** Every armchair facing and every sofa colour and facing that has a `front` layer: [name, front ink, seats]. */
const fronts: [string, Point[], readonly Seat[]][] = [];
const room = sheet("room/room.json");
for (const d of ["ne", "nw", "se", "sw"]) fronts.push([`armchair/${d}`, ink(room, `armchair/${d}/front`), [{ col: 0, row: 0, dir: d }]]);
const furniture = sheet("furniture/furniture.json");
for (const id of ["sofa", "couch", "wingback"]) {
  const p = furniture.atlas.meta.omega.pieces?.find((q) => q.id === id);
  if (!p) throw new Error(`no ${id}`);
  for (const c of p.colours) for (const [d, seats] of Object.entries(p.seatsByDir ?? {})) {
    if (p.layersByDir[d]?.includes("front") === true) fronts.push([`${id}/${c}/${d}`, ink(furniture, `furniture/${id}/${c}/${d}/front`), seats]);
  }
}
const low = (top: number): string[] =>
  fronts.map(([k, f, seats]) => [k, minVisible(f, seats, top)] as const).filter(([, v]) => v < 0.8).map(([k, v]) => `${k} ${(v * 100).toFixed(1)} %`);

test("a seated avatar's head and torso stay ≥ 80 % visible in every armchair and sofa", () => {
  expect(low(-Infinity)).toEqual([]);
});

// The judge's complaint is the torso, which a big head of hair outweighs in the share above: so the torso band on its own too.
test("the torso band alone (14 rows above the seat) stays ≥ 80 % visible in every armchair and sofa", () => {
  expect(low(-SEAT_HEIGHT - 14)).toEqual([]);
});

test("the measurement sees every armchair facing and every sofa colour and facing", () => {
  expect(fronts.length).toBe(4 + 4 * (2 + 2 + 1));
});

if (process.env.SEAT_REPORT) for (const [k, f, seats] of fronts) console.log(k, (minVisible(f, seats) * 100).toFixed(1), (minVisible(f, seats, -SEAT_HEIGHT - 14) * 100).toFixed(1));
