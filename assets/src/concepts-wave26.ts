// Rooms wave 26 concept round (OME-2434): two swap rooms that use the generic partition line (ADR 0058 §3) in ways the shipped
// three don't. Previews only, `CONCEPTS=26 bun assets/src/build.ts` (nothing shipped is rewritten):
//   Stage Door  : the first *column* partition (se), open velvet wings; a club stage in front, the green room behind.
//   Reef Tunnel : the partition *is* the attraction, a run of fish tanks with an arched tunnel at the doorway; a reef bar in front,
//                 "the deep" behind, its seats facing the tanks.
// Same 67-colour palette, Kit ray-caster, plum outline and top-left light as every shipped piece. Output: preview/c-wave26-*.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Kit, PIECES, buildFurniture, pieceFrames, pieceImage, type Canvas, type FurnDir, type PieceDef, type PieceMeta } from "./furniture";
import { addOutline, box, renderSolids } from "./iso";
import { PALETTE, colorIndex, type RampName, type Tone } from "./palette";
import { encodeIndexedApng, encodeIndexedPng } from "./png";
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
/** Renders a partition cell on `cv` at scale `s`, outline trimmed, then `post` paints over it (the water's tint). */
function partitionImage(build: (k: Kit) => void, post?: (img: Uint8Array, cv: Canvas, dir: FurnDir) => void) {
  return (dir: FurnDir, _colour: string, s = 1, cv: Canvas = CV): Uint8Array => {
    const k = new Kit(dir);
    build(k);
    const r = renderSolids(k.parts.map((p) => p.solid), cv.w, cv.h, cv.ax, cv.ay, "none", s);
    const lined = r.img.slice();
    addOutline(lined, cv.w, cv.h);
    lined.forEach((v, i) => { if (v !== r.img[i] && (s !== 1 || trailingEnd(dir, (i % cv.w) - cv.ax, Math.floor(i / cv.w) - cv.ay))) r.img[i] = v; });
    if (s === 1) post?.(r.img, cv, dir);
    return r.img;
  };
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
/** The wings: open between a black stage plinth (a brass edge) and the pelmet, so a run of them is one proscenium opening
 *  onto the other room, framed by the solid velvet legs either side. */
function velvetWings(k: Kit): void {
  k.box(-8, 8, -T, T, 0, 7, "charcoal", { paint: (p, f) => (f === "top" ? ["charcoal", 0] : p.z > 4.5 ? ["mustard", 2] : ["charcoal", 2]) });
  pelmet(k);
}

/** Tank: a charcoal cabinet with a teal strip light, a glass tank of water (the pane is see-through, tinted by a sparse navy
 *  dither in `tankTint`), sand, a kelp strand swaying, a rock, fish swimming +x, bubbles, and a lid with a light under it. No
 *  header: the deep shows over the lid, so the tanks read as a long aquarium divider, not a wall with a slot in it.
 *  Every fish is drawn at x, x − 16 and x + 16 and clipped to the cell, so a run of cells shows one unbroken stream. */
const TK = { base: 24, sand: 30, surf: 118, head: 124 } as const;
const ARCH = { half: 6.2, spring: 44, top: 66 } as const;
const FISH: readonly { x: number; z: number; ramp: RampName; len: number; speed: number }[] = [
  { x: -3, z: 92, ramp: "mustard", len: 3.2, speed: 4 },
  { x: 5, z: 58, ramp: "rust", len: 2.6, speed: 4 },
];
function fish(k: Kit, n: number, hole?: (x: number, z: number) => boolean): void {
  for (const f of FISH) {
    const x0 = ((((f.x + n * f.speed + 8) % 16) + 16) % 16) - 8;
    for (const x of [x0 - 16, x0, x0 + 16]) {
      if (x + f.len < -8 || x - f.len > 8 || hole?.(x, f.z)) continue;
      const clip = [-8, 8, -1, 1, f.z - 2, f.z + 2] as const;
      k.ell({ x, y: 0, z: f.z }, { x: f.len, y: 0.8, z: 1.4 }, clip, f.ramp, {
        paint: (p) => (f.ramp === "rust" && Math.abs(p.x - x) < 0.5 ? ["cream", 0] : p.z > f.z + 0.4 ? [f.ramp, 0] : null),
      });
      // The tail, a notch behind the body.
      const a0 = Math.max(-8, x - f.len - 1.2), a1 = Math.min(8, x - f.len + 0.2);
      if (a1 > a0) k.box(a0, a1, -0.6, 0.6, f.z - 1.2, f.z + 1.2, f.ramp, { tones: { top: 1, sw: 2, se: 2 } });
    }
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
  // Kelp: two strands, a step of sway per frame.
  for (const [kx, tall, ramp] of [[5.2, 40, "olive"]] as const) {
    for (let z = sand; z < sand + tall; z += 3) {
      const sway = 0.9 * Math.sin(z * 0.12 + n * (Math.PI / 2));
      if (hole?.(kx + sway, z)) continue;
      k.box(kx + sway - 0.6, kx + sway + 0.6, -0.5, 0.5, z, z + 3, ramp, { tones: { top: 0, sw: 1, se: 2 } });
    }
  }
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
/** Tunnel: the tank with an arched opening walked through, an acrylic ring (glow) and charcoal ribs at both faces. */
function tunnel(k: Kit, n: number): void {
  tankShell(k, n, inArch);
  const { half, spring, top } = ARCH;
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI, x = -Math.cos(a) * half, z = spring + Math.sin(a) * (top - spring);
    for (const y of [-T - 0.2, T - 0.8]) k.box(x - 0.8, x + 0.8, y, y + 1, z - 0.8, z + 0.8, i % 4 === 0 ? "charcoal" : "glow", { tones: { top: 0, sw: 1, se: 1 } });
  }
  for (const s of [-1, 1]) {
    for (const y of [-T - 0.2, T - 0.8]) k.box(s * half - 0.8, s * half + 0.8, y, y + 1, 0, spring, "glow", { tones: { top: 0, sw: 1, se: 1 } });
  }
}
/** The water: a sparse navy dither over the pane wherever the sprite is still clear, so whatever is behind shows through it. */
function tankTint(img: Uint8Array, cv: Canvas, dir: FurnDir, hole?: (x: number, z: number) => boolean): void {
  for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) {
    const i = y * cv.w + x;
    if (img[i] || (x + 2 * y) % 8 !== 0) continue;
    const lx = dir === "sw" ? (x - cv.ax) / 2 : (cv.ax - x) / 2;
    const z = lx - (y - cv.ay);
    if (Math.abs(lx) < 8 && z > TK.base && z < TK.surf && !hole?.(lx, z)) img[i] = c(z > TK.surf - 22 ? "teal" : "navy", z > TK.surf - 22 ? 1 : 0);
  }
}

// ------------------------------------------------------------------ objects

/** Stage riser (3×2): plank boards, a black skirt, a brass nosing and six footlights along the front that chase (4 frames). */
function stage(k: Kit, n: number): void {
  const H = 10;
  k.box(-8, 40, -8, 24, 0, H - 1, "charcoal", { paint: (p, f) => (f === "top" ? ["charcoal", 0] : p.z < 2 ? ["charcoal", 2] : ["charcoal", 1]) });
  k.box(-8.5, 40.5, -8.5, 24, H - 1, H, "floor", {
    paint: (p, f) => (f !== "top" ? ["mustard", 1] : Math.abs((((p.x + 8) % 6) + 6) % 6) < 0.5 ? ["floor", 2] : hash(Math.floor((p.x + 8) / 6), Math.floor(p.y)) % 7 === 0 ? ["floor", 0] : ["floor", 1]),
  });
  for (let i = 0; i < 6; i++) {
    const x = -4 + i * 8.4, on = (i + ph(n)) % 3 !== 0;
    k.box(x - 1.4, x + 1.4, -10, -8.5, 3, 6.5, on ? "mustard" : "charcoal", { tones: on ? { top: 0, sw: 0, se: 0 } : { top: 0, sw: 1, se: 2 } });
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

/** The stage through `image`, so its loop frames sit on the footprint like its still (useFrames' kitImage doesn't recentre a
 *  two-deep piece; shortcut: fold this into useFrames when the set ships). */
function stageImage(dir: FurnDir, _colour: string, s = 1, cv: Canvas = CV, n = 0): Uint8Array {
  const k = new Kit(dir);
  stage(k, n);
  const fp = dir === "se" || dir === "nw" ? { c: 2, r: 3 } : { c: 3, r: 2 };
  const mid = k.world(16, 8);
  const du = 8 * (fp.c - 1) - mid.u, dv = 8 * (fp.r - 1) - mid.v;
  return renderSolids(k.parts.map((p) => p.solid), cv.w, cv.h, cv.ax + s * 2 * (du - dv), cv.ay + s * (du + dv), "all", s).img;
}

const SE_SW: readonly FurnDir[] = ["se", "sw"];
/** New in this round. `partition` colours ride the shipped partition kind; `stage`, `vanity`, `rack` are new kinds. */
const DEFS: readonly PieceDef[] = [
  { id: "partition", label: "Interior wall", kind: "wall", colours: ["velvet"], dirs: SE_SW, cols: 1, rows: 1, image: partitionImage(velvetWall) },
  { id: "partition", label: "Interior wall", kind: "wall", colours: ["wings"], dirs: SE_SW, cols: 1, rows: 1, image: partitionImage(velvetWings) },
  { id: "partition", label: "Interior wall", kind: "wall", colours: ["tank"], dirs: SE_SW, cols: 1, rows: 1, use: { frames: 4, ms: 300 },
    image: (d, col, s, cv, n = 0) => partitionImage((k) => { tankShell(k, ph(n)); }, (img, cvv, dd) => { tankTint(img, cvv, dd); })(d, col, s, cv) },
  { id: "partition", label: "Interior wall", kind: "wall", colours: ["tunnel"], dirs: SE_SW, cols: 1, rows: 1, use: { frames: 4, ms: 300 },
    image: (d, col, s, cv, n = 0) => partitionImage((k) => { tunnel(k, ph(n)); }, (img, cvv, dd) => { tankTint(img, cvv, dd, inArch); })(d, col, s, cv) },
  { id: "stage", label: "Stage riser", kind: "fun", colours: ["boards"], dirs: SE_SW, cols: 3, rows: 2, use: { frames: 4, ms: 300 }, build: (k, _c, n) => { stage(k, n); }, image: stageImage },
  { id: "vanity", label: "Dressing table", kind: "fun", colours: ["bulbs"], dirs: SE_SW, cols: 1, rows: 1, use: { frames: 4, ms: 300 }, build: (k, _c, n) => { vanity(k, n); } },
  { id: "rack", label: "Costume rail", kind: "fun", colours: ["costumes"], dirs: SE_SW, cols: 2, rows: 1, build: (k) => { rack(k); } },
];
/** One-sided new pieces that need their 180° turn for the swapped view. */
const TURNED: readonly string[] = ["stage", "vanity"];

// ------------------------------------------------------------------ shell skins

const WALL_T = 4;
/** Club brick: running bond in rust, charcoal mortar, a black dado to 40 px (the black box), a charcoal crown. */
function brickPaint(s: number, z: number, lit: boolean): Paint {
  if (z < 4) return ["charcoal", 2];
  if (z >= WALL_H - 4) return ["charcoal", lit ? 0 : 1];
  if (z < 40) return z > 37 ? ["mustard", lit ? 1 : 2] : ["charcoal", lit ? 1 : 2];
  const row = Math.floor((z - 40) / 6), off = row % 2 === 0 ? 0 : 6;
  if ((z - 40) % 6 < 1 || (((s + off) % 12) + 12) % 12 < 1) return ["charcoal", 2];
  const b = hash(Math.floor((s + off) / 12) + 50, row);
  return ["rust", b % 5 === 0 ? 2 : b % 3 === 0 ? (lit ? 0 : 1) : lit ? 1 : 2];
}
/** The deep: navy water-light, caustic glints that drift with the wall, a rock skirting, a brass porthole every second segment. */
function deepPaint(s: number, z: number, lit: boolean, hole: boolean): Paint {
  if (z < 4) return ["charcoal", 2];
  if (z >= WALL_H - 4) return ["navy", lit ? 1 : 2];
  const rock = 18 + 3 * Math.sin(s * 0.45) + 1.5 * Math.sin(s * 1.3);
  if (z < rock) return hash(Math.floor(s / 3), Math.floor(z / 4)) % 3 === 0 ? ["charcoal", lit ? 0 : 1] : ["charcoal", 1];
  if (hole) {
    const r = Math.hypot((((s % 32) + 32) % 32) - 16, (z - 112) * 0.5);
    if (r < 7.5 && r >= 6) return ["mustard", lit ? 0 : 1];
    if (r < 6) {
      const fx = ((((s % 32) + 32) % 32) - 16), fz = z - 112;
      if (Math.hypot((fx + 1) * 0.6, fz * 1.4) < 1.5) return ["mustard", 0]; // a fish going past outside
      return ["teal", fz > 4 ? 0 : 2];
    }
  }
  const glint = Math.sin(s * 0.55 + z * 0.08) + Math.sin(s * 0.21 - z * 0.13 + 1.3);
  if (z > 120 && glint > 1.55 && (Math.floor(s * 2) + Math.floor(z)) % 2 === 0) return ["teal", 1];
  return ["navy", z > 150 ? 2 : glint > 1.2 ? 1 : 2];
}
type Skin = "brick" | "deep" | "paper" | "smoke";
const skinPaint = (skin: Skin, s: number, z: number, lit: boolean): Paint =>
  skin === "brick" ? brickPaint(s, z, lit) : skin === "deep" ? deepPaint(s, z, lit, true) : skin === "smoke" ? panelPaint("smoke", s, z, lit) : wallPaint("plain", s, z, lit);
const topOf = (skin: Skin): Paint => (skin === "brick" ? ["charcoal", 1] : skin === "deep" ? ["navy", 1] : skin === "smoke" ? ["wood", 0] : ["wall", 0]);
const leftWall = (key: string, i: number, skin: (v: number) => Skin): RoomFrame =>
  solidsFrame(key, [box(-8 - WALL_T, -8, -8, 8, 0, WALL_H, "wall", { skip: ["sw", "other"], paint: (p, f) => (f === "top" ? topOf(skin(p.v)) : f === "se" ? skinPaint(skin(p.v), p.v + 16 * i, p.z, false) : null) })], "top");
const rightWall = (key: string, i: number, skin: (u: number) => Skin): RoomFrame =>
  solidsFrame(key, [box(-8, 8, -8 - WALL_T, -8, 0, WALL_H, "wall", { skip: ["se", "other"], paint: (p, f) => (f === "top" ? topOf(skin(p.u)) : f === "sw" ? skinPaint(skin(p.u), p.u + 16 * i, p.z, true) : null) })], "top");
const corner = (key: string, skin: Skin): RoomFrame => solidsFrame(key, [box(-8 - WALL_T, -8, -8 - WALL_T, -8, 0, WALL_H, skin === "brick" ? "charcoal" : "navy", { tones: { top: 0, sw: 1, se: 2 } })], "top");
const lEnd = (key: string, skin: Skin): RoomFrame => solidsFrame(key, [box(-8 - WALL_T, -8, 7, 8, 0, WALL_H, skin === "brick" ? "charcoal" : "navy", { skip: ["se", "other"], tones: { top: 0, sw: 1, se: 2 } })], "all", (x) => x < -32);
const rEnd = (key: string, skin: Skin): RoomFrame => solidsFrame(key, [box(7, 8, -8 - WALL_T, -8, 0, WALL_H, skin === "brick" ? "charcoal" : "navy", { skip: ["sw", "other"], tones: { top: 0, sw: 1, se: 2 } })], "all", (x) => x >= 32);

/** Sand for the deep: pale ripples and a shell or two. */
const sandTile = (n: number) => (u: number, v: number): Paint => {
  const h = hash(Math.floor((u + 8) * 2) + n * 17, Math.floor((v + 8) * 2));
  if (h % 61 === 0) return ["pink", 0]; // a shell
  const ripple = (((u * 0.5 + v + 2 * Math.sin(u * 0.4 + n)) % 6) + 6) % 6;
  if (ripple < 0.7) return ["floor", 1];
  return h % 5 === 0 ? ["cream", 2] : h % 7 === 0 ? ["floor", 2] : ["floor", 0];
};
const SKY = 2;
function buildSkins(): RoomFrame[] {
  const out: RoomFrame[] = [];
  for (let i = 0; i < SKY; i++) {
    out.push(rightWall(`wall/r/brick/${String(i)}`, i, () => "brick"), leftWall(`wall/l/brick/${String(i)}`, i, () => "brick"));
    out.push(rightWall(`wall/r/deep/${String(i)}`, i, () => "deep"), leftWall(`wall/l/deep/${String(i)}`, i, () => "deep"));
  }
  // Stage Door's split segment: the column partition runs through the middle of right-wall segment 4 (u = 0).
  out.push(rightWall("wall/r/brick/split", 0, (u) => (u < 0 ? "paper" : "brick")), rightWall("wall/r/brick/split/north", 1, (u) => (u < 0 ? "brick" : "paper")));
  out.push(corner("wall/corner/brick", "brick"), lEnd("wall/l/end/brick", "brick"), rEnd("wall/r/end/brick", "brick"));
  // Reef Tunnel's split segment: the row partition through left-wall segment 4 (v = 0), like the penthouse.
  out.push(leftWall("wall/l/deep/split", 1, (v) => (v < 0 ? "deep" : "smoke")), leftWall("wall/l/deep/split/north", 0, (v) => (v < 0 ? "smoke" : "deep")));
  out.push(corner("wall/corner/deep", "deep"), rEnd("wall/r/end/deep", "deep"), lEnd("wall/l/end/deep", "deep"));
  for (const n of [0, 1]) {
    const sand = sandTile(n), carpet = carpetTile(n), plank = planks(n);
    out.push(floorTile(`floor/sand/${String(n)}`, sand));
    out.push(floorTile(`floor/reef/${String(n)}`, (u, v) => (v < 0 ? sand(u, v) : plank(u, v))), floorTile(`floor/reef/north/${String(n)}`, (u, v) => (v < 0 ? plank(u, v) : sand(u, v))));
    out.push(floorTile(`floor/green/${String(n)}`, (u, v) => (u < 0 ? carpet(u, v) : plank(u, v))), floorTile(`floor/green/north/${String(n)}`, (u, v) => (u < 0 ? plank(u, v) : carpet(u, v))));
  }
  return out;
}

// ------------------------------------------------------------------ the two rooms

interface Room {
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
const plankKey = (c0: number, r: number): string => `floor/${String((c0 * 3 + r) % 2)}`;
const alt = (k: string) => (c0: number, r: number): string => `${k}/${String((c0 * 3 + r) % 2)}`;

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
    P("vanity", "bulbs", "se", 0, 8), P("vanity", "bulbs", "se", 0, 9), P("rack", "costumes", "sw", 1, 6),
    P("couch", "olive", "se", 1, 3, ["mo", ""]), P("wingback", "ginger", "se", 2, 1, ["kiki"]), P("pouf", "lilac", "se", 3, 2, [""]),
    P("minibar", "fridge", "sw", 1, 0), P("neonsign", "pink", "sw", 2, 0), P("lavalamp", "lilac", "se", 3, 0), P("monstera", "teal", "se", 1, 9),
  ],
  south: {
    floor: (c0, r) => (c0 < 4 ? alt("floor/carpet")(c0, r) : c0 === 4 ? alt("floor/green")(c0, r) : plankKey(c0, r)),
    l: () => "wall/l/plain",
    r: (i) => (i < 4 ? "wall/r/plain" : i === 4 ? "wall/r/brick/split" : `wall/r/brick/${String(i % SKY)}`),
    corner: "wall/corner", lEnd: "wall/l/end", rEnd: "wall/r/end/brick",
  },
  north: {
    // Turned: the stage is cols 0–4 now (behind), the green room cols 6–9 (in front), the partition at col 5.
    floor: (c0, r) => (c0 < 5 ? plankKey(c0, r) : c0 === 5 ? alt("floor/green/north")(c0, r) : alt("floor/carpet")(c0, r)),
    l: (i) => `wall/l/brick/${String(i % SKY)}`,
    r: (i) => (i < 5 ? `wall/r/brick/${String(i % SKY)}` : i === 5 ? "wall/r/brick/split/north" : "wall/r/plain"),
    corner: "wall/corner/brick", lEnd: "wall/l/end/brick", rEnd: "wall/r/end",
  },
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
  south: {
    floor: (c0, r) => (r < 4 ? alt("floor/sand")(c0, r) : r === 4 ? alt("floor/reef")(c0, r) : plankKey(c0, r)),
    l: (i) => (i < 4 ? `wall/l/deep/${String(i % SKY)}` : i === 4 ? "wall/l/deep/split" : "wall/l/smoke"),
    r: (i) => `wall/r/deep/${String(i % SKY)}`,
    corner: "wall/corner/deep", lEnd: "wall/l/end/smoke", rEnd: "wall/r/end/deep",
  },
  north: {
    floor: (c0, r) => (r < 5 ? plankKey(c0, r) : r === 5 ? alt("floor/reef/north")(c0, r) : alt("floor/sand")(c0, r)),
    l: (i) => (i < 5 ? "wall/l/smoke" : i === 5 ? "wall/l/deep/split/north" : `wall/l/deep/${String(i % SKY)}`),
    r: () => "wall/r/smoke",
    corner: "wall/corner/smoke", lEnd: "wall/l/end/deep", rEnd: "wall/r/end/smoke",
  },
  standing: [],
};
const ROOMS: readonly Room[] = [STAGE_DOOR, REEF];

// ------------------------------------------------------------------ previews

const NEW_IDS = new Set(["stage", "vanity", "rack"]);
/** Loops that run on the shared ambient clock: the new ones (PieceDef `use`, frame 0 = the still) and reused shipped/v8 loops. */
const LOOPS: Readonly<Record<string, { frames: number; ms: number }>> = {
  "partition/tank": { frames: 4, ms: 300 }, "partition/tunnel": { frames: 4, ms: 300 }, "stage/boards": { frames: 4, ms: 300 }, "vanity/bulbs": { frames: 4, ms: 300 },
  "neonsign/pink": { frames: 3, ms: 140 }, "neonsign/teal": { frames: 3, ms: 140 }, "lavalamp/lilac": { frames: 4, ms: 320 }, "lavalamp/bubbles": { frames: 4, ms: 320 },
};
/** The bubble column is the lava lamp under a runtime PLTE swap (recolours.json), no new frames: pink blobs → cream bubbles,
 *  navy glass → teal water. */
const BUBBLES: ReadonlyMap<number, number> = new Map([
  [c("pink", 0), c("glow", 0)], [c("pink", 1), c("cream", 0)], [c("pink", 2), c("glow", 1)],
  [c("navy", 0), c("teal", 0)], [c("navy", 1), c("teal", 1)], [c("navy", 2), c("teal", 2)],
]);

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

/** Preset thumb mock at the shipped scale (THUMB_SCALE, 212×176): the room's own skin and pieces re-cast small, painter's order
 *  by sort point. The shipped thumbs draw the plain shell; this one shows the skin, which the set would add to presetThumb. */
function thumb(d: Wave2Deps, pieces: readonly PieceMeta[], room: Room, defs: readonly PieceDef[]): Uint8Array {
  const S = THUMB_SCALE, W = THUMB.w, H = THUMB.h, OX = 106, OY = 77;
  const full = d.compose(pieces, d.all, { placements: room.placements.filter((p) => p.id === "projector" || p.id === "curtain" || p.id === "neonsign" || p.id === "wallscreen"), standing: [], rug: false, tv: false, shell: room.south });
  // The shell (and wall pieces) by box-sampling the full composite: 64 px tiles → 20 px, the same grid the thumbs use.
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
    const def = defs.find((x) => x.id === p.id && x.colours.includes(p.colour)) ?? PIECES.find((x) => x.id === p.id);
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

export function buildConcepts26(d: Wave2Deps): void {
  const built = buildFurniture(DEFS);
  const frames: RoomFrame[] = [...built.frames, ...buildSkins()];
  for (const id of TURNED) {
    const def = DEFS.find((x) => x.id === id);
    if (!def) throw new Error(`no def ${id}`);
    for (const dir of def.dirs) frames.push(...pieceFrames(def, def.colours[0] ?? "", dir, true));
  }
  // The bubble column's frames: the lava lamp's, palette-swapped (what the runtime PLTE swap does; 0 sheet bytes).
  for (const [k, f] of [...d.all]) if (k.startsWith("furniture/lavalamp/lilac/")) d.all.set(k.replace("/lilac/", "/bubbles/"), { ...f, img: f.img.map((v) => BUBBLES.get(v) ?? v) });
  for (const f of frames) d.all.set(f.key, { img: f.img, w: f.w, h: f.h, ax: f.ax, ay: f.ay });
  const pieces = [...d.pieces, ...built.pieces.filter((m) => NEW_IDS.has(m.id))];

  const bytes: Record<string, number> = {};
  for (const room of ROOMS) {
    const plan: RoomPlan = { placements: room.placements, standing: room.standing, rug: false, tv: false, shell: room.south };
    const after = beamFor(d, pieces, plan);
    const south = d.compose(pieces, d.all, plan);
    after?.(south.img, south.W, south.H);
    write(`c-wave26-${room.id}-south`, south);
    animate(`c-wave26-${room.id}-south`, d, pieces, plan, after);
    const nv = d.northView(pieces, d.all, plan, room.north);
    const north = d.compose(nv.pieces, d.all, nv.plan);
    write(`c-wave26-${room.id}-north`, north);
    animate(`c-wave26-${room.id}-north`, d, nv.pieces, nv.plan);
    const th = thumb(d, pieces, room, DEFS);
    writeFileSync(join(ROOT, "preview", `c-wave26-${room.id}-thumb@1x.png`), encodeIndexedPng(THUMB.w, THUMB.h, th, PALETTE));
    writeFileSync(join(ROOT, "preview", `c-wave26-${room.id}-thumb@3x.png`), encodeIndexedPng(THUMB.w * 3, THUMB.h * 3, upscale(th, THUMB.w, THUMB.h, 3), PALETTE));
    bytes[`thumb ${room.id}`] = encodeIndexedPng(THUMB.w, THUMB.h, th, PALETTE).length;
  }

  // Byte estimate: each new piece's frames (both facings, loops, turned views) on one tight strip PNG, plus its atlas entries
  // gzipped. Single PNGs, so a packed sheet comes out a little smaller.
  const groups = new Map<string, RoomFrame[]>();
  for (const f of frames) {
    const parts = f.key.split("/");
    const g = parts[0] === "furniture" ? `${parts[1] ?? ""}/${parts[2] ?? ""}` : f.key.includes("brick") || f.key.includes("green") ? "shell/stage-door" : "shell/reef";
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  for (const [g, fs] of groups) {
    const W = Math.max(...fs.map((f) => f.w)), H = fs.reduce((a, f) => a + f.h, 0);
    const img = new Uint8Array(W * H);
    let y0 = 0;
    for (const f of fs) { for (let y = 0; y < f.h; y++) img.set(f.img.subarray(y * f.w, (y + 1) * f.w), (y0 + y) * W); y0 += f.h; }
    const atlas = Object.fromEntries(fs.map((f) => [f.key, { frame: { x: 0, y: 0, w: f.w, h: f.h }, anchor: { x: f.ax / f.w, y: f.ay / f.h } }]));
    bytes[g] = encodeIndexedPng(W, H, img, PALETTE).length + gzipSync(JSON.stringify(atlas)).length;
  }
  writeFileSync(join(ROOT, "preview", "c-wave26-budget.json"), JSON.stringify(bytes, null, 1) + "\n");
  console.log(bytes);

  // Loop strip at 4×: every new loop frame (both facings), one row per piece colour and facing.
  const rows = DEFS.filter((x) => x.use).flatMap((x) => x.dirs.map((dir) => ({ id: x.id, colour: x.colours[0] ?? "", dir })));
  const colW = 200, rowH = 240, SW = colW * 4, SH = rowH * rows.length;
  const strip = new Uint8Array(SW * SH).fill(c("night", 2));
  rows.forEach(({ id, colour, dir }, row) => {
    for (let n = 0; n < 4; n++) {
      const f = d.all.get(`furniture/${id}/${colour}/use/${dir}/${String(n)}`);
      if (!f) continue;
      const ox = n * colW + Math.round(colW / 2 - f.w / 2), oy = row * rowH + Math.round((rowH - f.h) / 2);
      for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
        const v = f.img[y * f.w + x] ?? 0, px = ox + x, py = oy + y;
        if (v && px >= n * colW && px < (n + 1) * colW && py >= row * rowH && py < (row + 1) * rowH) strip[py * SW + px] = v;
      }
    }
  });
  writeFileSync(join(ROOT, "preview", "c-wave26-loops@2x.png"), encodeIndexedPng(SW * 2, SH * 2, upscale(strip, SW, SH, 2), PALETTE));
}
