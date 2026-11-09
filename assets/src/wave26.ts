// Rooms wave 26 asset set (OME-2440, from the OME-2434 concepts, judge PASS 32/40): two swap rooms on the generic partition line
// (ADR 0058 §3), with the judge's polish notes folded in.
//   Stage Door  : the first *column* partition (se), open velvet wings; a club stage in front, the green room behind.
//   Reef Tunnel : the partition *is* the attraction, a run of fish tanks with an arched, walk-through tunnel at the doorway; a reef
//                 bar in front, "the deep" behind, its seats facing the tanks.
// Same 67-colour palette, Kit ray-caster, plum outline and top-left light as every shipped piece. Ships two lazy sheets:
//   furniture/furniture-v9.{png,json}       stage/boards, vanity/bulbs, rack/costumes, partition velvet|wings|tank|tunnel, their
//                                           loops, the tunnel's front ribs and the turned (swap) views of the stage and the vanity
//   furniture/furniture-v9-shell.{png,json} club brick and deep-water walls, the split segments, sand and the split floors
// plus presets/thumbs/stage-door.png, reef.png, shipped ahead of their presets (OME-2441). The lava lamp's `bubbles` is a PLTE swap in v9's meta.
// Previews: preview/w26-*.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Kit, PIECES, buildFurniture, pieceFrames, pieceImage, type Canvas, type FurnDir, type PieceDef, type PieceMeta } from "./furniture";
import { addOutline, box, renderSolids } from "./iso";
import { PALETTE, colorIndex, type RampName, type Tone } from "./palette";
import { encodeIndexedApng, encodeIndexedPng } from "./png";
import { AMBIENT_RECOLOURS, recolourRemap } from "./recolours";
import { THUMB, THUMB_SCALE } from "./presets";
import { WALL_H, carpetTile, floorTile, panelPaint, planks, solidsFrame, wallPaint, type RoomFrame } from "./room";
import { upscale } from "./sprite";
import type { Placement, RoomPlan } from "./build";
import { beamFor, type Wave2Deps } from "./wave2";

type Paint = readonly [RampName, Tone];
type Shell = NonNullable<RoomPlan["shell"]>;
const ROOT = join(import.meta.dir, "..");
const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const hash = (a: number, b: number): number => {
  let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};
const CV: Canvas = { w: 480, h: 400, ax: 220, ay: 300 };
/** Every wave-26 loop: 4 frames of 300 ms, two ticks of the shared 150 ms ambient clock (AMBIENT_TICK_MS, ADR 0058 / OME-2068). */
export const LOOP = { frames: 4, ms: 300 } as const;
/** Loop phase for a PieceDef `use` frame: build gets n = 1..frames for the loop, 0 for the still, and loop frame 0 is the still. */
const ph = (n: number): number => Math.max(0, n - 1);

// ------------------------------------------------------------------ partitions (seamless runs like OME-1959's)

const T = 2;
/** No plum outline on a cell's trailing end (local x = −8), so a run joins like one wall (partitionOutline's first rule). */
function trailingEnd(dir: FurnDir, x: number, y: number): boolean {
  const s = dir === "sw" ? -8 - x / 2 : x / 2 - 8;
  const z = -8 + s - y;
  return !(s >= -2.5 && z >= -3 && z <= WALL_H + 2);
}

/** Velvet: a full-height stage drape, folds every 4 units (16 divides evenly, so a run has no seam), a gold fringe at the hem,
 *  a scalloped pelmet. The same both sides, so it needs no back view. */
const folds = (x: number, z: number): Paint => {
  if (z < 5 && z > 1.5) return ["mustard", Math.floor(x * 2) % 2 === 0 ? 0 : 1];
  const f = (((x + 8) % 4) + 4) % 4;
  return ["velvet", f < 1 ? 0 : f < 2.6 ? 1 : 2];
};
const PELMET = 168;
function pelmet(k: Kit): void {
  const scallop = (x: number): number => PELMET + 6 * Math.abs(Math.sin(((x + 8) * Math.PI) / 8));
  k.box(-8, 8, -T - 1, T + 1, PELMET, WALL_H, "velvet", {
    paint: (p, f) => {
      if (f === "top") return ["charcoal", 1];
      if (p.z < scallop(p.x)) return null;
      if (p.z < scallop(p.x) + 2.5) return ["mustard", Math.floor(p.x * 2) % 2 === 0 ? 0 : 1]; // gold fringe
      if (p.z > WALL_H - 5) return ["mustard", 2]; // the batten
      return ["velvet", Math.abs(p.x % 8) < 1 ? 2 : 1];
    },
  });
}
function velvetWall(k: Kit): void {
  k.box(-8, 8, -T, T, 0, WALL_H, "velvet", { paint: (p, f) => (f === "top" ? ["charcoal", 1] : folds(p.x, p.z)) });
  pelmet(k);
}
/** The wings: open between a black stage plinth (a brass edge) and the pelmet, so a run of them is a row of openings onto the other
 *  room. A narrow black masking leg (darker than the velvet drape, so wings and velvet read as two partitions), tied back with a
 *  gold cord, at each cell's leading end (+x, toward the stage door) carries the pelmet
 *  down to the plinth, so the run's last cell by the door doesn't leave the pelmet hanging in the air (judge's note). */
function velvetWings(k: Kit): void {
  k.box(-8, 8, -T, T, 0, 7, "charcoal", { paint: (p, f) => (f === "top" ? ["charcoal", 0] : p.z > 4.5 ? ["mustard", 2] : ["charcoal", 2]) });
  // The leg pinches in at the tie-back (z 70–73) and flares a little to the hem, like the shipped curtain.
  for (let z = 7; z < PELMET; z += 2) {
    const w = z < 70 ? 2.6 - (0.9 * (z - 7)) / 63 : z < 73 ? 1.6 : 1.7 + (0.9 * (z - 73)) / (PELMET - 73);
    const tie = z >= 70 && z < 73;
    k.box(8 - w, 8, -T + 0.6, T - 0.6, z, z + 2, tie ? "mustard" : "charcoal", { tones: tie ? { top: 0, sw: 1, se: 1 } : { top: 0, sw: 0, se: 1 } });
  }
  pelmet(k);
}

/** Tank: a charcoal cabinet with a teal strip light, a glass tank of water (the pane is see-through, tinted by a sparse dither in
 *  `tankTint`), sand, kelp swaying, a rock, fish swimming +x, bubbles, and a lid with a light under it. No header: the deep shows
 *  over the lid, so the tanks read as a long aquarium divider, not a wall with a slot in it.
 *  Every fish is drawn at x, x − 16 and x + 16 and clipped to the cell, so a run of cells shows one unbroken stream. */
const TK = { base: 24, sand: 30, surf: 118, head: 124 } as const;
const ARCH = { half: 6.2, spring: 52, top: 78 } as const;
/** Two-tone fish (judge's note): a lit back, a cream belly, a forked tail and an eye. 4 frames × 4 units = one cell, a clean loop. */
const FISH: readonly { x: number; z: number; body: RampName; tail: RampName; len: number; speed: number }[] = [
  { x: -3, z: 92, body: "mustard", tail: "mustard", len: 3.4, speed: 4 },
  { x: 5, z: 58, body: "rust", tail: "rust", len: 3, speed: 4 },
];
function fish(k: Kit, n: number, hole?: (x: number, z: number) => boolean): void {
  for (const f of FISH) {
    const x0 = ((((f.x + n * f.speed + 8) % 16) + 16) % 16) - 8;
    for (const x of [x0 - 16, x0, x0 + 16]) {
      if (x + f.len < -8 || x - f.len - 2 > 8 || hole?.(x, f.z)) continue;
      const clip = [-8, 8, -1, 1, f.z - 2, f.z + 2] as const;
      k.ell({ x, y: 0, z: f.z }, { x: f.len, y: 0.8, z: 1.6 }, clip, f.body, {
        paint: (p) => {
          if (Math.abs(p.x - (x + f.len - 1)) < 0.5 && p.z > f.z && p.z < f.z + 1) return ["charcoal", 2]; // the eye
          if (f.body === "rust" && Math.abs(p.x - x) < 0.5) return ["cream", 0]; // a clownfish band
          return p.z > f.z - 0.2 ? [f.body, 0] : ["cream", 1];
        },
      });
      // The tail: a fork, two fins splaying up and down behind the body.
      for (const [z0, z1] of [[f.z + 0.2, f.z + 1.8], [f.z - 1.8, f.z - 0.2]] as const) {
        const a0 = Math.max(-8, x - f.len - 1.6), a1 = Math.min(8, x - f.len + 0.4);
        if (a1 > a0) k.box(a0, a1, -0.5, 0.5, z0, z1, f.tail, { tones: { top: 2, sw: 2, se: 2 } });
      }
    }
  }
}
/** Kelp (judge's note: not cactus-like): a ribbon, no stem and no side arms. It snakes in a gentle S that grows toward the tip, swells
 *  and narrows along its length, and bands light / mid every few units like a blade's ribs; the sway runs one step a frame. */
function kelp(k: Kit, n: number, kx: number, tall: number, ramp: RampName, hole?: (x: number, z: number) => boolean): void {
  for (let z = TK.sand; z < TK.sand + tall; z += 1) {
    const t = (z - TK.sand) / tall;
    const x = kx + (0.4 + t) * 1.1 * Math.sin(z * 0.16 + n * (Math.PI / 2));
    const w = 0.45 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (0.6 + 0.4 * Math.sin(z * 0.5));
    if (hole?.(x, z)) continue;
    const tone: Tone = Math.floor(z / 3) % 2 === 0 ? 0 : 1;
    k.box(x - w, x + w, -0.2, 0.2, z, z + 1, ramp, { tones: { top: tone, sw: tone, se: 2 } });
  }
}
function tankShell(k: Kit, n: number, hole?: (x: number, z: number) => boolean): void {
  const { base, sand, surf, head } = TK;
  const cab: Parameters<Kit["box"]>[7] = { paint: (p, f) => (f === "top" ? ["charcoal", 0] : p.z > base - 4 && p.z < base - 2 ? ["teal", 0] : p.z < 3 ? ["charcoal", 2] : ["charcoal", 1]) };
  // The tunnel leaves the cabinet open under its arch: people walk through there.
  const gap = hole ? ARCH.half + 1 : 0;
  if (gap) { k.box(-8, -gap, -T, T, 0, base, "charcoal", cab); k.box(gap, 8, -T, T, 0, base, "charcoal", cab); } else k.box(-8, 8, -T, T, 0, base, "charcoal", cab);
  const sandTop = (x: number): number => sand + 1.2 * Math.sin(x * 0.9);
  for (let x = -8; x < 8; x += 1) {
    if (hole?.(x + 0.5, base + 1)) continue;
    k.box(x, x + 1, -T + 0.4, T - 0.4, base, sandTop(x + 0.5), "floor", { paint: (p, f) => (f === "top" ? ["floor", 0] : hash(Math.floor(p.x * 2), Math.floor(p.z)) % 5 === 0 ? ["cream", 1] : ["floor", 1]) });
  }
  kelp(k, n, 3.6, 48, "olive", hole); // clear of the cell's end, which a run's end pillar overlaps (judge's note)
  kelp(k, n + 1, 1.6, 24, "olive", hole);
  if (!hole) k.ell({ x: -2, y: 0, z: sand }, { x: 3, y: 1.5, z: 4 }, [-8, 8, -1.6, 1.6, sand - 1, sand + 4], "charcoal", { tones: { top: 0, sw: 1, se: 2 } });
  // Bubbles up the left of the cell.
  for (let b = 0; b < 4; b++) {
    const z = sand + 6 + ((b * 26 + n * 13) % (surf - sand - 10));
    if (!hole?.(-6, z)) k.box(-6.4 + (b % 2) * 0.8, -5.6 + (b % 2) * 0.8, -0.5, 0.5, z, z + 1.2, "glow", { tones: { top: 0, sw: 0, se: 1 } });
  }
  fish(k, n, hole);
  k.box(-8, 8, -T + 0.3, T - 0.3, surf, surf + 1, "glow", { tones: { top: 0, sw: 0, se: 1 } }); // the water's surface
  k.box(-8, 8, -T - 0.5, T + 0.5, surf + 1, head, "charcoal", { paint: (p, f) => (f === "top" ? ["charcoal", 0] : p.z < surf + 2.5 ? ["teal", 0] : ["charcoal", 1]) });
}
const inArch = (x: number, z: number): boolean => {
  const { half, spring, top } = ARCH;
  if (Math.abs(x) > half + 1) return false;
  if (z <= spring) return true;
  return Math.hypot(x / (half + 1), (z - spring) / (top - spring + 1)) <= 1;
};
/** Tunnel: the tank with an arched opening walked through, an acrylic ring (glow) and charcoal ribs at both faces. The near face's
 *  ribs and posts are `front` parts: they ship as the cell's `front` layer, drawn over a walker in the arch; the far face's stay in
 *  `back`, behind them. */
function tunnel(k: Kit, n: number): void {
  tankShell(k, n, inArch);
  const { half, spring, top } = ARCH;
  // Local −y is the camera side facing se/sw.
  const faces = [{ y: -T - 0.2, front: true }, { y: T - 0.8, front: false }] as const;
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI, x = -Math.cos(a) * half, z = spring + Math.sin(a) * (top - spring);
    for (const { y, front } of faces) k.box(x - 0.8, x + 0.8, y, y + 1, z - 0.8, z + 0.8, i % 4 === 0 ? "charcoal" : "glow", { tones: { top: 0, sw: 1, se: 1 }, front });
  }
  for (const s of [-1, 1]) {
    for (const { y, front } of faces) k.box(s * half - 0.8, s * half + 0.8, y, y + 1, 0, spring, "glow", { tones: { top: 0, sw: 1, se: 1 }, front });
  }
}
/** The water: a sparse dither over the pane wherever the sprite is still clear, so whatever is behind shows through it. One pixel
 *  in 16 on a staggered grid (judge's note: the concept's 1-in-8 diagonal read as a mesh at 1×), denser teal near the surface. */
function tankTint(img: Uint8Array, cv: Canvas, dir: FurnDir, hole?: (x: number, z: number) => boolean): void {
  for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) {
    const i = y * cv.w + x;
    if (img[i]) continue;
    const gx = x - cv.ax, gy = y - cv.ay;
    const lx = dir === "sw" ? gx / 2 : -gx / 2;
    const z = lx - gy;
    if (Math.abs(lx) >= 8 || z <= TK.base || z >= TK.surf || hole?.(lx, z)) continue;
    const top = z > TK.surf - 14;
    const on = top ? (gx & 1) === 0 && (gy & 3) === ((gx >> 1) & 1) * 2 : (gx & 3) === 0 && (gy & 3) === ((gx >> 2) & 1) * 2;
    if (on) img[i] = top ? c("teal", 1) : c("navy", 0);
  }
}

interface Part {
  colour: "velvet" | "wings" | "tank" | "tunnel";
  build: (k: Kit, n: number) => void;
  tint?: (img: Uint8Array, cv: Canvas, dir: FurnDir) => void;
  /** Ships a `front` layer (the parts built with `front: true`). */
  front?: true;
}
/** The new partition colours. Every one ships LOOP's frames (velvet's and wings' are the still repeated: deduped to one rect, so
 *  0 PNG bytes), so the v9 `partition` row's `use` holds for all its colours. */
export const PARTS: readonly Part[] = [
  { colour: "velvet", build: (k) => { velvetWall(k); } },
  { colour: "wings", build: (k) => { velvetWings(k); } },
  { colour: "tank", build: (k, n) => { tankShell(k, n); }, tint: (img, cv, d) => { tankTint(img, cv, d); } },
  { colour: "tunnel", build: (k, n) => { tunnel(k, n); }, tint: (img, cv, d) => { tankTint(img, cv, d, inArch); }, front: true },
];
const SE_SW: readonly FurnDir[] = ["se", "sw"];

/** One partition cell, loop frame `n`, on `cv` at scale `s`: the back parts, the front parts or both; the trailing end's outline
 *  trimmed so a run joins, then the water's tint (1× only, back layer). */
function partImage(p: Part, dir: FurnDir, n: number, layer: "back" | "front" | "all", s = 1, cv: Canvas = CV): Uint8Array {
  const k = new Kit(dir);
  p.build(k, n);
  const parts = k.parts.filter((q) => layer === "all" || q.front === (layer === "front"));
  const r = renderSolids(parts.map((q) => q.solid), cv.w, cv.h, cv.ax, cv.ay, "none", s);
  const lined = r.img.slice();
  addOutline(lined, cv.w, cv.h);
  lined.forEach((v, i) => { if (v !== r.img[i] && (s !== 1 || trailingEnd(dir, (i % cv.w) - cv.ax, Math.floor(i / cv.w) - cv.ay))) r.img[i] = v; });
  if (s === 1 && layer !== "front") p.tint?.(r.img, cv, dir);
  return r.img;
}

/** Frames cut to one rect (the union), so they share one anchor. Throws if any is empty or touches the canvas edge. */
function cutUnion(list: readonly { key: string; img: Uint8Array }[], cv: Canvas = CV): RoomFrame[] {
  let x0 = cv.w, y0 = cv.h, x1 = -1, y1 = -1;
  for (const { img } of list) img.forEach((v, i) => { if (!v) return; const x = i % cv.w, y = Math.floor(i / cv.w); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
  if (x1 < 0 || x0 === 0 || y0 === 0 || x1 === cv.w - 1 || y1 === cv.h - 1) throw new Error(`${list[0]?.key ?? "?"}: empty or touches the canvas edge`);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  return list.map(({ key, img }) => {
    if (!img.some((v) => v)) throw new Error(`${key} is empty`);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) out.set(img.subarray((y0 + y) * cv.w + x0, (y0 + y) * cv.w + x0 + w), y * w);
    return { key, img: out, w, h, ax: cv.ax - x0, ay: cv.ay - y0 };
  });
}

function partFrames(p: Part, dir: FurnDir): RoomFrame[] {
  const base = `furniture/partition/${p.colour}`;
  const loop = Array.from({ length: LOOP.frames }, (_, n) => ({ key: `${base}/use/${dir}/${String(n)}`, img: partImage(p, dir, n, "back") }));
  const still = { key: `${base}/${dir}/back`, img: loop[0]?.img ?? new Uint8Array(0) };
  return cutUnion([still, ...(p.front ? [{ key: `${base}/${dir}/front`, img: partImage(p, dir, 0, "front") }] : []), ...loop]);
}

// ------------------------------------------------------------------ objects

/** Stage riser (3×2): plank boards, a black skirt, a brass nosing and six footlights along the front that chase (4 frames). A
 *  second row along the back, lit steady, so the riser still reads as a stage, not a trapdoor, from the swapped view (judge's note). */
function stage(k: Kit, n: number): void {
  const H = 10;
  k.box(-8, 40, -8, 24, 0, H - 1, "charcoal", { paint: (p, f) => (f === "top" ? ["charcoal", 0] : p.z < 2 ? ["charcoal", 2] : ["charcoal", 1]) });
  k.box(-8.5, 40.5, -8.5, 24.5, H - 1, H, "floor", {
    paint: (p, f) => (f !== "top" ? ["mustard", 1] : Math.abs((((p.x + 8) % 6) + 6) % 6) < 0.5 ? ["floor", 2] : hash(Math.floor((p.x + 8) / 6), Math.floor(p.y)) % 7 === 0 ? ["floor", 0] : ["floor", 1]),
  });
  const lit = { top: 0, sw: 0, se: 0 } as const, off = { top: 0, sw: 1, se: 2 } as const;
  for (let i = 0; i < 6; i++) {
    const x = -4 + i * 8.4, on = (i + ph(n)) % 3 !== 0;
    k.box(x - 1.4, x + 1.4, -10, -8.5, 3, 6.5, on ? "mustard" : "charcoal", { tones: on ? lit : off });
    k.box(x - 1.4, x + 1.4, 24.5, 26, 3, 6.5, "mustard", { tones: lit });
  }
}

/** Dressing-room vanity (wall-backed): a wood table, a mirror ringed with bulbs that twinkle, powder and a lipstick. */
function vanity(k: Kit, n: number): void {
  k.box(-7, 7, 0, 8, 0, 22, "wood", { paint: (p, f) => (f === "top" ? ["wood", 0] : f === "front" && (Math.abs(p.x) < 0.4 || Math.abs(p.z - 12) < 0.4) ? ["wood", 2] : f === "front" && Math.abs(p.z - 17) < 0.6 && Math.abs(Math.abs(p.x) - 3.5) < 1 ? ["mustard", 0] : null) });
  k.box(-7.5, 7.5, -0.5, 8, 22, 24, "cream", { tones: { top: 0, sw: 1, se: 2 } });
  k.box(-6, 6, 6.6, 8, 28, 70, "charcoal", {
    paint: (p, f) => {
      if (f !== "front") return ["charcoal", 1];
      if (Math.abs(p.x) > 5 || p.z < 29.5 || p.z > 68.5) return ["charcoal", 2];
      return (p.x + p.z * 0.6) % 14 > 11 ? ["glow", 0] : ["glow", 1];
    },
  });
  const bulbs: [number, number][] = [];
  for (let z = 32; z <= 64; z += 8) bulbs.push([-6.4, z], [6.4, z]);
  for (let x = -4; x <= 4; x += 4) bulbs.push([x, 71.5]);
  bulbs.forEach(([x, z], i) => {
    const dim = (hash(i, 3) + ph(n)) % 5 === 0;
    k.ell({ x, y: 6.2, z }, { x: 1.3, y: 1.3, z: 1.3 }, [-99, 99, -99, 99, z - 1.3, z + 1.3], dim ? "cream" : "mustard", { tones: dim ? { top: 1, sw: 2, se: 2 } : { top: 0, sw: 0, se: 0 } });
  });
  k.ell({ x: -3, y: 3, z: 24 }, { x: 1.6, y: 1.6, z: Infinity }, [-99, 99, -99, 99, 24, 26], "pink");
  k.box(2, 3, 2.5, 3.5, 24, 28, "velvet", { tones: { top: 0, sw: 1, se: 2 } });
}

/** Costume rail (2×1, both sides alike, so no back view): two chrome posts on castors, a top bar, six garments on hangers. */
function rack(k: Kit): void {
  for (const x of [-6, 22]) {
    k.box(x - 2.5, x + 2.5, -1, 1, 1, 2.2, "charcoal");
    k.box(x - 0.6, x + 0.6, -0.6, 0.6, 2, 56, "glow", { tones: { top: 0, sw: 1, se: 2 } });
  }
  k.box(-6, 22, -0.6, 0.6, 54, 55.5, "glow", { tones: { top: 0, sw: 1, se: 2 } });
  const G: readonly [RampName, number][] = [["velvet", 26], ["mustard", 30], ["teal", 22], ["lilac", 28], ["cream", 24], ["pink", 30]];
  G.forEach(([ramp, len], i) => {
    const x = -3 + i * 4.3;
    k.box(x - 1.9, x + 1.9, -1.6, 1.6, 52 - len, 51, ramp, { paint: (p, f) => (f === "top" ? [ramp, 0] : ramp === "mustard" && (Math.floor(p.z) + Math.floor(p.x * 2)) % 3 === 0 ? ["mustard", 0] : null) });
    k.box(x - 1.5, x + 1.5, -0.4, 0.4, 51, 52.5, "charcoal", { tones: { top: 0, sw: 1, se: 1 } });
  });
}

/** The new kinds. The stage is two deep: its loop frames go through useFrames like any piece's, now that kitImage centres a
 *  two-deep model on its footprint as pieceFrames does (the concept's one-off image fn is gone). */
export const DEFS: readonly PieceDef[] = [
  { id: "stage", label: "Stage riser", kind: "fun", colours: ["boards"], dirs: SE_SW, cols: 3, rows: 2, use: LOOP, build: (k, _c, n) => { stage(k, n); } },
  { id: "vanity", label: "Dressing table", kind: "fun", colours: ["bulbs"], dirs: SE_SW, cols: 1, rows: 1, use: LOOP, build: (k, _c, n) => { vanity(k, n); } },
  { id: "rack", label: "Costume rail", kind: "fun", colours: ["costumes"], dirs: SE_SW, cols: 2, rows: 1, build: (k) => { rack(k); } },
];
/** One-sided new pieces that ship their 180° turn for the swapped view. */
const TURNED: readonly string[] = ["stage", "vanity"];
/** Previews and thumbs draw a partition colour through this PieceDef (the thumb re-casts at THUMB_SCALE, no tint). */
const partDef = (p: Part): PieceDef => ({ id: "partition", label: "Interior wall", kind: "wall", colours: [p.colour], dirs: SE_SW, cols: 1, rows: 1, image: (d, _c, s = 1, cv = CV) => partImage(p, d, 0, "all", s, cv) });

/** The v9 sheet's `meta.omega.pieces`: the three new kinds, and a `partition` row listing only the v9 colours (v7's pattern). */
function metas(built: readonly PieceMeta[]): PieceMeta[] {
  const out = built.map((m): PieceMeta => (m.use ? { ...m, ambient: true } : m));
  const per = <V,>(v: () => V): Partial<Record<FurnDir, V>> => Object.fromEntries(SE_SW.map((d) => [d, v()]));
  out.push({
    id: "partition", label: "Interior wall", kind: "wall", mount: "floor", layer: "object", colours: PARTS.map((p) => p.colour), dirs: [...SE_SW],
    footprint: { cols: 1, rows: 1 }, footprintByDir: per(() => ({ cols: 1, rows: 1 })), sortByDir: per(() => ({ x: 0, y: 0 })), walkable: false,
    layersByDir: per((): ("back" | "front")[] => ["back"]), use: { ...LOOP }, ambient: true, frontColours: PARTS.filter((p) => p.front).map((p) => p.colour),
  });
  return out;
}

/** furniture-v9 frames and metas, and the furniture-v9-shell frames. */
export function buildWave26Sheets(): { frames: RoomFrame[]; pieces: PieceMeta[]; shell: RoomFrame[] } {
  const built = buildFurniture(DEFS);
  const frames: RoomFrame[] = [...built.frames];
  for (const id of TURNED) {
    const def = DEFS.find((x) => x.id === id);
    if (!def) throw new Error(`no def ${id}`);
    for (const dir of def.dirs) frames.push(...pieceFrames(def, def.colours[0] ?? "", dir, true));
  }
  for (const p of PARTS) for (const dir of SE_SW) frames.push(...partFrames(p, dir));
  return { frames, pieces: metas(built.pieces), shell: buildSkins() };
}

// ------------------------------------------------------------------ shell skins

const WALL_T = 4;
/** Club brick: running bond in rust, charcoal mortar, a black dado to 40 px (the black box), a charcoal crown. */
function brickPaint(s: number, z: number, lit: boolean): Paint {
  if (z < 4) return ["charcoal", 2];
  if (z >= WALL_H - 4) return ["charcoal", lit ? 0 : 1];
  if (z < 40) return z > 37 ? ["mustard", lit ? 1 : 2] : ["charcoal", lit ? 1 : 2];
  // 16-wide bricks: the web draws one frame for every segment of a side, so the bond has to tile at 16.
  const row = Math.floor((z - 40) / 6), off = row % 2 === 0 ? 0 : 8;
  if ((z - 40) % 6 < 1 || (((s + off) % 16) + 16) % 16 < 1) return ["charcoal", 2];
  const b = hash(Math.floor((s + off) / 16) + 50, row);
  return ["rust", b % 5 === 0 ? 2 : b % 3 === 0 ? (lit ? 0 : 1) : lit ? 1 : 2];
}
/** The deep: navy water-light, wavy water-light, a rock skirting, a small brass porthole per segment. Every term repeats at 16
 *  (s in [-8, 8)), since the web draws one frame for every segment of a side. */
function deepPaint(s: number, z: number, lit: boolean, port = true): Paint {
  if (z < 4) return ["charcoal", 2];
  if (z >= WALL_H - 4) return ["navy", lit ? 1 : 2];
  const rock = 18 + 3 * Math.sin(s * TAU16) + 1.5 * Math.sin(s * 3 * TAU16);
  if (z < rock) return hash(Math.floor(s / 4), Math.floor(z / 4)) % 3 === 0 ? ["charcoal", lit ? 0 : 1] : ["charcoal", 1];
  const r = port ? Math.hypot(s, (z - 112) * 0.5) : Infinity;
  if (r < 5 && r >= 4) return ["mustard", lit ? 0 : 1];
  if (r < 4) return ["teal", z - 112 > 3 ? 0 : 2];
  // Water-light as wavy horizontal bands (a dot pattern would read as wallpaper once the frame repeats).
  const band = Math.sin(z * 0.2 + 1.6 * Math.sin(s * TAU16));
  if (z > 120 && band > 0.97 && (Math.floor(s) + Math.floor(z)) % 2 === 0) return ["teal", 1];
  return ["navy", z > 40 && z < 150 && band > 0.8 ? 1 : 2];
}
const TAU16 = (2 * Math.PI) / 16;
/** `deepbare`: the deep with no porthole, for the split segment, where the line's end pillar would cut the porthole in half. */
type Skin = "brick" | "deep" | "deepbare" | "paper" | "smoke";
const skinPaint = (skin: Skin, s: number, z: number, lit: boolean): Paint =>
  skin === "brick" ? brickPaint(s, z, lit) : skin === "deep" || skin === "deepbare" ? deepPaint(s, z, lit, skin === "deep") : skin === "smoke" ? panelPaint("smoke", s, z, lit) : wallPaint("plain", s, z, lit);
const topOf = (skin: Skin): Paint => (skin === "brick" ? ["charcoal", 1] : skin === "deep" || skin === "deepbare" ? ["navy", 1] : skin === "smoke" ? ["wood", 0] : ["wall", 0]);
const leftWall = (key: string, skin: (v: number) => Skin): RoomFrame =>
  solidsFrame(key, [box(-8 - WALL_T, -8, -8, 8, 0, WALL_H, "wall", { skip: ["sw", "other"], paint: (p, f) => (f === "top" ? topOf(skin(p.v)) : f === "se" ? skinPaint(skin(p.v), p.v, p.z, false) : null) })], "top");
const rightWall = (key: string, skin: (u: number) => Skin): RoomFrame =>
  solidsFrame(key, [box(-8, 8, -8 - WALL_T, -8, 0, WALL_H, "wall", { skip: ["se", "other"], paint: (p, f) => (f === "top" ? topOf(skin(p.u)) : f === "sw" ? skinPaint(skin(p.u), p.u, p.z, true) : null) })], "top");
const capOf = (skin: Skin): RampName => (skin === "brick" ? "charcoal" : skin === "deep" ? "navy" : skin === "smoke" ? "wood" : "wall");
const edgeOpts = (skin: Skin, skip: ("sw" | "se" | "other")[] = []) =>
  ({ skip, tones: { top: 0, sw: 1, se: 2 } as const, paint: (p: { z: number }, f: string): Paint | null => (f !== "top" && skin !== "paper" && p.z < 4 ? ["charcoal", 2] : null) });
const corner = (key: string, skin: Skin): RoomFrame => solidsFrame(key, [box(-8 - WALL_T, -8, -8 - WALL_T, -8, 0, WALL_H, capOf(skin), edgeOpts(skin))], "top");
const lEnd = (key: string, skin: Skin): RoomFrame => solidsFrame(key, [box(-8 - WALL_T, -8, 7, 8, 0, WALL_H, capOf(skin), edgeOpts(skin, ["se", "other"]))], "all", (x) => x < -32);
const rEnd = (key: string, skin: Skin): RoomFrame => solidsFrame(key, [box(7, 8, -8 - WALL_T, -8, 0, WALL_H, capOf(skin), edgeOpts(skin, ["sw", "other"]))], "all", (x) => x >= 32);

/** Sand for the deep: pale ripples and a shell or two. */
const sandTile = (n: number) => (u: number, v: number): Paint => {
  const h = hash(Math.floor((u + 8) * 2) + n * 17, Math.floor((v + 8) * 2));
  if (h % 61 === 0) return ["pink", 0]; // a shell
  const ripple = (((u * 0.5 + v + 2 * Math.sin(u * 0.4 + n)) % 6) + 6) % 6;
  if (ripple < 0.7) return ["floor", 1];
  return h % 5 === 0 ? ["cream", 2] : h % 7 === 0 ? ["floor", 2] : ["floor", 0];
};
type Tile = (u: number, v: number) => Paint;
/** One shell skin by value (the web's SKINS, ADR 0058): `floor/<shell>/<back|split|split/north|front>/<0|1>`,
 *  `wall/<l|r>/<shell>/<back|front|split|split/north>`, `wall/corner|l/end|r/end/<shell>/<back|front>`. Back is the side of the
 *  line with the smaller index. `axis` is the line's: col splits the right wall and the floor on u, row the left wall on v. */
function skinFrames(shell: string, axis: "col" | "row", back: Skin, front: Skin, floor: (n: number) => [Tile, Tile]): RoomFrame[] {
  const bare = (k: Skin): Skin => (k === "deep" ? "deepbare" : k);
  const half = (b: Skin, f: Skin) => (x: number): Skin => (x < 0 ? bare(b) : bare(f));
  const wall = axis === "col" ? rightWall : leftWall;
  const out: RoomFrame[] = [
    leftWall(`wall/l/${shell}/back`, () => back), leftWall(`wall/l/${shell}/front`, () => front),
    rightWall(`wall/r/${shell}/back`, () => back), rightWall(`wall/r/${shell}/front`, () => front),
    wall(`wall/${axis === "col" ? "r" : "l"}/${shell}/split`, half(back, front)), wall(`wall/${axis === "col" ? "r" : "l"}/${shell}/split/north`, half(front, back)),
  ];
  for (const [side, skin] of [["back", back], ["front", front]] as const)
    out.push(corner(`wall/corner/${shell}/${side}`, skin), lEnd(`wall/l/end/${shell}/${side}`, skin), rEnd(`wall/r/end/${shell}/${side}`, skin));
  for (const n of [0, 1]) {
    const [b, f] = floor(n), split = (u: number, v: number) => ((axis === "col" ? u : v) < 0);
    out.push(floorTile(`floor/${shell}/back/${String(n)}`, b), floorTile(`floor/${shell}/front/${String(n)}`, f));
    out.push(floorTile(`floor/${shell}/split/${String(n)}`, (u, v) => (split(u, v) ? b(u, v) : f(u, v))), floorTile(`floor/${shell}/split/north/${String(n)}`, (u, v) => (split(u, v) ? f(u, v) : b(u, v))));
  }
  return out;
}
function buildSkins(): RoomFrame[] {
  // Stage Door: the green room (carpet, paper) behind the col-4 line, the club (planks, brick) in front.
  // Reef: the deep (sand, deep water) behind the row-4 line, the bar (planks, smoked panel) in front.
  return [
    ...skinFrames("stage-door", "col", "paper", "brick", (n) => [carpetTile(n), planks(n)]),
    ...skinFrames("reef", "row", "deep", "smoke", (n) => [sandTile(n), planks(n)]),
  ];
}
/** A preview shell drawn from the skin's frames as the web picks them: side 0 back, 1 the line, 2 front (south view). */
function skinShell(shell: string, axis: "col" | "row", at: number, north: boolean): Shell {
  const L = 9;
  const side = (col: number, row: number): string => {
    const [c, r] = north ? [L - col, L - row] : [col, row];
    const i = axis === "col" ? c : r;
    return i < at ? "back" : i > at ? "front" : north ? "split/north" : "split";
  };
  // The corner and ends have no split frame: on the line they wear the front's.
  const edge = (col: number, row: number): string => (side(col, row) === "back" ? "back" : "front");
  return {
    floor: (c0, r) => `floor/${shell}/${side(c0, r)}/${String((c0 + r) % 2)}`,
    l: (i) => `wall/l/${shell}/${side(0, i)}`,
    r: (i) => `wall/r/${shell}/${side(i, 0)}`,
    corner: `wall/corner/${shell}/${edge(0, 0)}`, lEnd: `wall/l/end/${shell}/${edge(0, L)}`, rEnd: `wall/r/end/${shell}/${edge(L, 0)}`,
  };
}

// ------------------------------------------------------------------ the two rooms

export interface Room {
  id: string;
  name: string;
  blurb: string;
  placements: Placement[];
  south: Shell;
  north: Shell;
  /** Who stands where (south coordinates). */
  standing: [string, number, number][];
}
const P = (id: string, colour: string, dir: FurnDir, col: number, row: number, sitters?: string[]): Placement => (sitters ? { id, colour, dir, col, row, sitters } : { id, colour, dir, col, row });

/** Stage Door. Partition on **column 4** facing se (ADR 0058 §3's col axis, unused so far): velvet at rows 0–1 and 8–9, open wings
 *  at rows 2–6, the stage door (the gap) at (4, 7). The stage (cols 5–9) is the front room; the green room (cols 0–3) is behind. */
const STAGE_DOOR: Room = {
  id: "stage-door",
  name: "Stage Door",
  blurb: "A club stage in front, the green room behind the wings.",
  placements: [
    ...[0, 1, 2, 3, 4, 5, 6, 8, 9].map((r) => P("partition", r <= 1 || r >= 8 ? "velvet" : "wings", "se", 4, r)),
    // Stage side: the riser under the pull-down screen, drapes either side, the projector on its tripod at the back of the house.
    P("stage", "boards", "sw", 6, 0), P("curtain", "velvet", "sw", 5, 0), P("curtain", "velvet", "sw", 9, 0), P("projector", "cloth", "sw", 6, 0),
    P("tripod", "charcoal", "ne", 7, 8),
    P("beanbag", "blush", "ne", 6, 4, ["juno"]), P("beanbag", "navy", "ne", 8, 4, [""]),
    P("sidetable", "wood", "sw", 7, 5), P("stool", "teal", "ne", 6, 6, [""]), P("stool", "teal", "ne", 8, 6, ["pip"]),
    P("arclamp", "brass", "sw", 9, 6), P("monstera", "rust", "sw", 5, 9),
    // Green room: two bulb mirrors on the left wall, the rail, a couch and a wingback facing the wings, the fridge, the lava lamp.
    // No seat behind a velvet leg (rows 0–1, 8–9; judge's note): the wingback moved from (2, 1) to (2, 5), in view through the wings.
    P("vanity", "bulbs", "se", 0, 8), P("vanity", "bulbs", "se", 0, 9), P("rack", "costumes", "sw", 1, 6),
    P("couch", "olive", "se", 1, 3, ["mo", ""]), P("wingback", "ginger", "se", 2, 5, ["kiki"]), P("pouf", "lilac", "se", 3, 2, [""]),
    P("minibar", "fridge", "sw", 1, 0), P("neonsign", "pink", "sw", 2, 0), P("lavalamp", "lilac", "se", 3, 0), P("monstera", "teal", "se", 1, 9),
  ],
  south: skinShell("stage-door", "col", 4, false),
  // Turned: the stage is cols 0–4 now (behind), the green room cols 6–9 (in front), the partition at col 5.
  north: skinShell("stage-door", "col", 4, true),
  standing: [],
};

/** Reef Tunnel. Partition on row 4 facing sw: smoked panel at cols 0 and 9, tanks at 1–2 and 4–8, the tunnel (the doorway) at
 *  (3, 4). The reef bar (rows 5–9) is the front room; the deep (rows 0–3) is behind, its seats facing the tanks. */
const REEF: Room = {
  id: "reef",
  name: "Reef Tunnel",
  blurb: "A reef bar, and a tunnel through the tanks to the deep.",
  placements: [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((col) => P("partition", col === 3 ? "tunnel" : col === 0 || col === 9 ? "panel" : "tank", "sw", col, 4)),
    // The bar: counter and stools on the left wall, the wall screen, the couch facing it, a bubble column, the teal neon.
    P("barcounter", "wood", "se", 0, 5), P("stool", "teal", "nw", 1, 5, ["mo"]), P("stool", "teal", "nw", 1, 6, [""]),
    P("wallscreen", "panel", "se", 0, 7), P("couch", "cream", "nw", 4, 7, ["kiki", ""]), P("coffeetable", "wood", "sw", 2, 8),
    P("neonsign", "teal", "se", 0, 9), P("lavalamp", "bubbles", "se", 8, 6), P("monstera", "teal", "sw", 9, 8),
    // The deep: a hammock and beanbags facing the tanks (sw), bubble columns either end, a monstera standing in for kelp.
    P("hammock", "rust", "sw", 5, 1, ["", "juno"]), P("beanbag", "navy", "sw", 2, 2, ["pip"]), P("beanbag", "navy", "sw", 8, 2, [""]),
    P("lavalamp", "bubbles", "se", 0, 0), P("lavalamp", "bubbles", "se", 9, 0), P("monstera", "teal", "se", 0, 2),
  ],
  south: skinShell("reef", "row", 4, false),
  north: skinShell("reef", "row", 4, true),
  // The tunnel's near ribs, its `front` layer (the composer draws `back` only; the web draws `front` over avatars).
  standing: [["furniture/partition/tunnel/sw/front", 3, 4]],
};
export const ROOMS: readonly Room[] = [STAGE_DOOR, REEF];

// ------------------------------------------------------------------ previews and thumbs

const NEW_IDS = new Set(["stage", "vanity", "rack"]);
/** Loops on the shared ambient clock: the new ones and the reused shipped/v8 ones. */
const LOOPS: Readonly<Record<string, { frames: number; ms: number }>> = {
  "partition/tank": LOOP, "partition/tunnel": LOOP, "stage/boards": LOOP, "vanity/bulbs": LOOP,
  "neonsign/pink": { frames: 3, ms: 140 }, "neonsign/teal": { frames: 3, ms: 140 }, "lavalamp/lilac": { frames: 4, ms: 320 }, "lavalamp/bubbles": { frames: 4, ms: 320 },
};
/** The bubble column: the lava lamp under recolours.json's `bubbles` PLTE swap, as the runtime does it (previews and thumbs only). */
const lamp = AMBIENT_RECOLOURS["lavalamp"];
if (!lamp) throw new Error("no lavalamp recolour");
const BUBBLES: ReadonlyMap<number, number> = recolourRemap(lamp, 0);

function write(name: string, r: { img: Uint8Array; W: number; H: number }): void {
  writeFileSync(join(ROOT, "preview", `${name}@1x.png`), encodeIndexedPng(r.W, r.H, r.img, PALETTE));
  writeFileSync(join(ROOT, "preview", `${name}@2x.png`), encodeIndexedPng(r.W * 2, r.H * 2, upscale(r.img, r.W, r.H, 2), PALETTE));
}
const CROP = { x: 140, y: 0, w: 680, h: 552 } as const;
/** The room on the shared ambient clock (150 ms, AMBIENT_TICK_MS), 8 ticks, every loop sampling its own frame time. */
function animate(name: string, d: Wave2Deps, pieces: readonly PieceMeta[], plan: RoomPlan, after?: (img: Uint8Array, W: number, H: number) => void): void {
  const out: Uint8Array[] = [];
  for (let t = 0; t < 8; t++) {
    const placements = plan.placements.map((p): Placement => { const l = LOOPS[`${p.id}/${p.colour}`]; return l && d.all.has(`furniture/${p.id}/${p.colour}/use/${p.dir}/0`) ? { ...p, use: Math.floor((t * 150) / l.ms) % l.frames } : p; });
    const r = d.compose(pieces, d.all, { ...plan, placements });
    after?.(r.img, r.W, r.H);
    const f = new Uint8Array(CROP.w * CROP.h);
    for (let y = 0; y < CROP.h; y++) f.set(r.img.subarray((CROP.y + y) * r.W + CROP.x, (CROP.y + y) * r.W + CROP.x + CROP.w), y * CROP.w);
    out.push(f);
  }
  const deltas = out.map((f, i) => { const prev = out[i - 1]; return prev ? f.map((v, j) => (v === prev[j] ? 0 : v)) : f; });
  writeFileSync(join(ROOT, "preview", `${name}@1x.apng`), encodeIndexedApng(CROP.w, CROP.h, deltas, out.map(() => 150), PALETTE, true));
}

/** The preset thumb at the shipped size (THUMB_SCALE, 212×176), with the room's own skin: the shell (and wall pieces) box-sampled
 *  from the full composite, the objects re-cast small in painter's order. presetThumb draws the plain shell, so a wave-26 preset
 *  ships this one instead (build.ts `buildPresets`). */
function thumb(d: Wave2Deps, pieces: readonly PieceMeta[], room: Room): Uint8Array {
  const S = THUMB_SCALE, W = THUMB.w, H = THUMB.h, OX = 106, OY = 77;
  const full = d.compose(pieces, d.all, { placements: room.placements.filter((p) => p.id === "projector" || p.id === "curtain" || p.id === "neonsign" || p.id === "wallscreen"), standing: [], rug: false, tv: false, shell: room.south });
  const img = new Uint8Array(W * H);
  const fx = (x: number): number => 480 + (x - OX) / S, fy = (y: number): number => 236 + (y - OY) / S;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const counts = new Map<number, number>();
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
      const X = Math.floor(fx(x + sx / 3)), Y = Math.floor(fy(y + sy / 3));
      const v = X >= 0 && Y >= 0 && X < full.W && Y < full.H ? full.img[Y * full.W + X] ?? 0 : 0;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    let best = 0, n = -1;
    for (const [v, k] of counts) if (k > n || (k === n && v !== c("night", 2))) { best = v; n = k; }
    img[y * W + x] = best === c("night", 2) ? 0 : best;
  }
  const cv: Canvas = { w: 160, h: 160, ax: 80, ay: 120 };
  const objs = room.placements.filter((p) => pieces.find((m) => m.id === p.id)?.layer === "object");
  const sortY = (p: Placement): number => { const fp = pieces.find((m) => m.id === p.id)?.footprintByDir[p.dir] ?? { cols: 1, rows: 1 }; return p.col + p.row + (fp.cols - 1) / 2 + (fp.rows - 1) / 2; };
  objs.sort((a, b) => sortY(a) - sortY(b) || a.col - a.row - (b.col - b.row));
  for (const p of objs) {
    const part = p.id === "partition" ? PARTS.find((x) => x.colour === p.colour) : undefined;
    const def = part ? partDef(part) : DEFS.find((x) => x.id === p.id) ?? PIECES.find((x) => x.id === p.id);
    if (!def) continue;
    const colour = p.colour === "bubbles" ? "lilac" : p.colour;
    let src = pieceImage(def, colour, p.dir, S, cv);
    if (p.colour === "bubbles") src = src.map((v) => BUBBLES.get(v) ?? v);
    const fp = pieces.find((m) => m.id === p.id)?.footprintByDir[p.dir] ?? { cols: 1, rows: 1 };
    // pieceImage leaves a two-deep model where it was built; pieceFrames moves it onto its footprint (OME-1999). Do the same here.
    let du = 0, dv = 0;
    if (def.rows > 1) { const mid = new Kit(p.dir).world(8 * (def.cols - 1), 8 * (def.rows - 1)); du = 8 * (fp.cols - 1) - mid.u; dv = 8 * (fp.rows - 1) - mid.v; }
    const x0 = Math.round(OX + (p.col - p.row) * 10 + 2 * (du - dv) * S) - cv.ax, y0 = Math.round(OY + (p.col + p.row) * 5 + (du + dv) * S) - cv.ay;
    for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) {
      const v = src[y * cv.w + x] ?? 0, px = x0 + x, py = y0 + y;
      if (v && px > 0 && py > 0 && px < W - 1 && py < H - 1) img[py * W + px] = v;
    }
  }
  addOutline(img, W, H);
  return img;
}

/** Previews (preview/w26-*: both views of both rooms at 1× and 2×, an APNG of each on the ambient clock, the loop strip, a walker
 *  in the tunnel) and the two preset thumbs, returned by room id for build.ts to palette-compact and write. */
export function buildWave26Previews(d: Wave2Deps, set: { frames: readonly RoomFrame[]; pieces: readonly PieceMeta[]; shell: readonly RoomFrame[] }): Record<string, Uint8Array> {
  // The bubble column's frames: the lava lamp's, palette-swapped (what the runtime PLTE swap does).
  for (const [k, f] of [...d.all]) if (k.startsWith("furniture/lavalamp/lilac/")) d.all.set(k.replace("/lilac/", "/bubbles/"), { ...f, img: f.img.map((v) => BUBBLES.get(v) ?? v) });
  for (const f of [...set.frames, ...set.shell]) d.all.set(f.key, { img: f.img, w: f.w, h: f.h, ax: f.ax, ay: f.ay });
  const pieces = [...d.pieces, ...set.pieces.filter((m) => NEW_IDS.has(m.id))];

  const thumbs: Record<string, Uint8Array> = {};
  for (const room of ROOMS) {
    const plan: RoomPlan = { placements: room.placements, standing: room.standing, rug: false, tv: false, shell: room.south };
    const after = beamFor(d, pieces, plan, 8); // a sparser beam than wave 2's (judge's note: 1 in 4 read as noise at 1×)
    const south = d.compose(pieces, d.all, plan);
    after?.(south.img, south.W, south.H);
    write(`w26-${room.id}-south`, south);
    animate(`w26-${room.id}-south`, d, pieces, plan, after);
    const nv = d.northView(pieces, d.all, plan, room.north);
    write(`w26-${room.id}-north`, d.compose(nv.pieces, d.all, nv.plan));
    animate(`w26-${room.id}-north`, d, nv.pieces, nv.plan);
    const th = thumb(d, pieces, room);
    writeFileSync(join(ROOT, "preview", `w26-${room.id}-thumb@3x.png`), encodeIndexedPng(THUMB.w * 3, THUMB.h * 3, upscale(th, THUMB.w, THUMB.h, 3), PALETTE));
    thumbs[room.id] = th;
  }

  // The tunnel's two layers: Juno walking through the arch, between the back (rear ribs, water) and the front (near ribs).
  const walk: RoomPlan = { placements: REEF.placements.filter((p) => p.row === 4), standing: [["juno/idle/nw/0", 3, 4], ["furniture/partition/tunnel/sw/front", 3, 4]], rug: false, tv: false, shell: REEF.south };
  write("w26-tunnel-walk", d.compose(pieces, d.all, walk));

  // Loop strip at 2×: every new loop frame (both facings), one row per piece colour and facing.
  const rows = [...DEFS.filter((x) => x.use).map((x) => `${x.id}/${x.colours[0] ?? ""}`), "partition/tank", "partition/tunnel"].flatMap((k) => SE_SW.map((dir) => ({ k, dir })));
  const colW = 200, rowH = 240, SW = colW * LOOP.frames, SH = rowH * rows.length;
  const strip = new Uint8Array(SW * SH).fill(c("night", 2));
  rows.forEach(({ k, dir }, row) => {
    for (let n = 0; n < LOOP.frames; n++) {
      const f = d.all.get(`furniture/${k}/use/${dir}/${String(n)}`);
      if (!f) throw new Error(`no loop frame ${k}/${dir}/${String(n)}`);
      const ox = n * colW + Math.round(colW / 2 - f.w / 2), oy = row * rowH + Math.round((rowH - f.h) / 2);
      for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
        const v = f.img[y * f.w + x] ?? 0, px = ox + x, py = oy + y;
        if (v && px >= n * colW && px < (n + 1) * colW && py >= row * rowH && py < (row + 1) * rowH) strip[py * SW + px] = v;
      }
    }
  });
  writeFileSync(join(ROOT, "preview", "w26-loops@2x.png"), encodeIndexedPng(SW * 2, SH * 2, upscale(strip, SW, SH, 2), PALETTE));
  return thumbs;
}
