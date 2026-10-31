// OME-2062 concept round (not shipped): screens without the TV table, ambient loops for the five older presets, and two new
// partitioned "swap" rooms. Run `CONCEPTS=2062 bun assets/src/build.ts`: it builds the shared sprite set, then this file renders
// preview/c2062-*.png (+ .apng for the loops) and preview/c2062-budget.json, and the build stops. No sheet, atlas or preset changes.
// Same palette (no new colours), same Kit / iso ray-caster, same plum outline and top-left light as every shipped piece.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { Kit, PIECES, TURN, pieceFrames, type FurnDir, type PieceMeta } from "./furniture";
import { addOutline, box, renderSolids } from "./iso";
import { PALETTE, colorIndex, type RampName, type Tone } from "./palette";
import { encodeIndexedApng, encodeIndexedPng } from "./png";
import { PRESETS } from "./presets";
import { WALL_H, carpetTile, defaultLayout, deckTile, floorTile, panelPaint, planks, solidsFrame, type RoomFrame } from "./room";
import { upscale } from "./sprite";
import type { FurnSprites, Placement, RoomPlan } from "./build";

type Paint = readonly [RampName, Tone];
type Shell = NonNullable<RoomPlan["shell"]>;
type Compose = (pieces: readonly PieceMeta[], all: FurnSprites, plan: RoomPlan) => { img: Uint8Array; W: number; H: number };
type NorthView = (pieces: readonly PieceMeta[], all: FurnSprites, south: RoomPlan, shell: Shell) => { pieces: PieceMeta[]; plan: RoomPlan };
export interface ConceptDeps {
  pieces: PieceMeta[];
  all: FurnSprites;
  compose: Compose;
  northView: NorthView;
  presetPlan: (layout: (typeof PRESETS)[number]["layout"]) => RoomPlan;
}

const ROOT = join(import.meta.dir, "..");
const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const hash = (a: number, b: number): number => {
  let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};
const ALL: readonly FurnDir[] = ["ne", "nw", "se", "sw"];
const CV = { w: 480, h: 400, ax: 220, ay: 300 } as const;
const swaps = (d: FurnDir): boolean => d === "nw" || d === "se";

// ------------------------------------------------------------------ concept pieces

interface Spot { x: number; y: number; z: number }
interface CDef {
  id: string;
  label: string;
  layer: "object" | "wall";
  colours: readonly string[];
  dirs: readonly FurnDir[];
  cols: number;
  rows: number;
  /** Ambient loop length (1 = static) and frame time. */
  frames: number;
  ms: number;
  walkable?: boolean;
  /** Also render it turned 180°, as `<id>back` (an object-layer piece: a near-wall ghost in the swapped view). */
  back?: boolean;
  build: (k: Kit, colour: string, n: number) => void;
  /** Steam wisps rising from these local points (drawn after the outline, so they stay soft). */
  steam?: readonly Spot[];
  /** Hung from the ceiling: a soft dithered shadow on the floor under it (radius in units), so it reads as up high, not standing. */
  shadow?: (colour: string) => number;
  /** Pixels drawn before the outline pass (the fan's blades). */
  under?: (img: Uint8Array, at: (x: number, y: number, z: number) => { x: number; y: number }, k: Kit, n: number) => void;
}

/** One wisp pair, 12 px tall, its gaps travelling up one step a frame. */
function steam(img: Uint8Array, w: number, sx: number, sy: number, n: number): void {
  const put = (x: number, y: number, v: number): void => { if (x >= 0 && y >= 0 && x < w && y * w + x < img.length) img[y * w + x] = v; };
  for (let h = 1; h < 13; h++) {
    if ((h + n) % 4 === 3) continue;
    put(Math.round(sx + 1.3 * Math.sin(h * 0.55 - n * 1.6)), Math.round(sy - h), h < 8 ? c("cream", 0) : c("glow", 1));
  }
  for (let h = 3; h < 10; h++) {
    if ((h + n + 2) % 4 === 3) continue;
    put(Math.round(sx + 2 + 1.1 * Math.sin(h * 0.6 - n * 1.6 + 2)), Math.round(sy - h), h < 7 ? c("cream", 0) : c("glow", 1));
  }
}

interface Rendered { key: string; img: Uint8Array; w: number; h: number; ax: number; ay: number }

/** Frames of one concept piece: `furniture/<id>/<colour>/<dir>/back` and its loop `…/use/<dir>/<n>`, one rect per (colour, dir). */
function conceptFrames(def: CDef, idOut: string, colour: string, dir: FurnDir, turned: boolean): Rendered[] {
  const imgs: Uint8Array[] = [];
  for (let n = 0; n < def.frames; n++) {
    const k = new Kit(dir, turned);
    def.build(k, colour, n);
    // As pieceFrames: a turned or two-deep piece is moved so its centre sits on the footprint's centre.
    const fp = swaps(dir) ? { c: def.rows, r: def.cols } : { c: def.cols, r: def.rows };
    const mid = k.world(8 * (def.cols - 1), 8 * (def.rows - 1));
    const centre = turned || def.rows > 1;
    const du = centre ? 8 * (fp.c - 1) - mid.u : 0, dv = centre ? 8 * (fp.r - 1) - mid.v : 0;
    const AX = CV.ax + 2 * (du - dv), AY = CV.ay + du + dv;
    const at = (x: number, y: number, z: number): { x: number; y: number } => { const p = k.world(x, y); return { x: AX + 2 * (p.u - p.v), y: AY + p.u + p.v - z }; };
    const img = renderSolids(k.parts.map((p) => p.solid), CV.w, CV.h, AX, AY, "none").img;
    def.under?.(img, at, k, n);
    addOutline(img, CV.w, CV.h);
    for (const s of def.steam ?? []) { const p = at(s.x, s.y, s.z); steam(img, CV.w, p.x, p.y, n); }
    const R = def.shadow?.(colour) ?? 0;
    if (R > 0) {
      for (let py = 0; py < CV.h; py++) for (let px = 0; px < CV.w; px++) {
        const a = (px + 0.5 - AX) / 2, b = py + 0.5 - AY, u = (a + b) / 2, v = (b - a) / 2;
        if (Math.hypot(u, v) < R && (px + 2 * py) % 4 === 0 && !img[py * CV.w + px]) img[py * CV.w + px] = c("charcoal", 2);
      }
    }
    imgs.push(img);
  }
  let x0: number = CV.w, y0: number = CV.h, x1 = -1, y1 = -1;
  for (const img of imgs) img.forEach((v, i) => { if (!v) return; const x = i % CV.w, y = Math.floor(i / CV.w); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
  if (x1 < 0 || x0 === 0 || y0 === 0 || x1 === CV.w - 1 || y1 === CV.h - 1) throw new Error(`${def.id}/${colour}/${dir}: empty or touches the canvas edge`);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const cut = (img: Uint8Array): Uint8Array => { const o = new Uint8Array(w * h); for (let y = 0; y < h; y++) o.set(img.subarray((y0 + y) * CV.w + x0, (y0 + y) * CV.w + x0 + w), y * w); return o; };
  const d = turned ? TURN[dir] : dir;
  const out: Rendered[] = [{ key: `furniture/${idOut}/${colour}/${d}/back`, img: cut(imgs[0] ?? new Uint8Array()), w, h, ax: CV.ax - x0, ay: CV.ay - y0 }];
  imgs.forEach((img, n) => out.push({ key: `furniture/${idOut}/${colour}/use/${d}/${String(n)}`, img: cut(img), w, h, ax: CV.ax - x0, ay: CV.ay - y0 }));
  return out;
}

function conceptMeta(def: CDef, id: string, dirs: readonly FurnDir[], layer: "object" | "wall"): PieceMeta {
  const footprintByDir: PieceMeta["footprintByDir"] = {}, sortByDir: PieceMeta["sortByDir"] = {}, layersByDir: PieceMeta["layersByDir"] = {};
  for (const d of dirs) {
    const fp = layer === "wall" ? { cols: 0, rows: 0 } : swaps(d) ? { cols: def.rows, rows: def.cols } : { cols: def.cols, rows: def.rows };
    footprintByDir[d] = fp;
    const dc = Math.max(fp.cols - 1, 0) / 2, dr = Math.max(fp.rows - 1, 0) / 2;
    sortByDir[d] = { x: (dc - dr) * 32, y: (dc + dr) * 16 };
    layersByDir[d] = ["back"];
  }
  const m: PieceMeta = {
    id, label: def.label, kind: "fun", mount: layer === "wall" ? "wall" : "floor", layer, colours: [...def.colours], dirs: [...dirs],
    footprint: { cols: def.cols, rows: def.rows }, footprintByDir, sortByDir, walkable: def.walkable === true, layersByDir,
  };
  if (def.frames > 1) m.use = { frames: def.frames, ms: def.ms };
  return m;
}

// --- 1a: wall-mounted flat panel. 56 × 36 px on the wall, a 2-unit-deep slab on a bracket, a soundbar under it.
const WS = { X: 14, Z0: 80, Z1: 116 } as const;
function wallScreen(k: Kit): void {
  const { X, Z0, Z1 } = WS;
  k.box(-X, X, 5.6, 7.4, Z0, Z1, "charcoal", {
    paint: (p, f) => {
      if (f === "top") return ["charcoal", 0];
      // The back (seen only from the swapped side): matte housing, a raised VESA plate, vent slots.
      if (f === "back") return Math.abs(p.x) < 5 && Math.abs(p.z - (Z0 + Z1) / 2) < 7 ? ["charcoal", 2] : Math.abs(p.x) > 7 && Math.abs(p.x) < 11 && Math.floor(p.z) % 3 === 0 ? ["charcoal", 2] : ["charcoal", 1];
      if (f !== "front") return ["charcoal", 2];
      if (Math.abs(p.x) > X - 1 || p.z < Z0 + 1.6 || p.z > Z1 - 1.2) return Math.abs(p.x - X + 3) < 0.6 && p.z < Z0 + 1.2 ? ["mustard", 0] : ["charcoal", 2];
      // The picture: a dusk scene (it's decorative; the real player is page chrome, ADR 0012), a soft glint top-left.
      const g = p.x + (p.z - Z0) * 0.9;
      if (g > 18 && g < 21 && p.z > Z1 - 14) return ["glow", 2];
      const hill = Z0 + 8 + 3 * Math.sin(p.x * 0.35 + 1) + (p.x > 2 ? 3 : 0);
      if (p.z < hill) return ["teal", p.z < Z0 + 5 ? 2 : 1];
      const sun = Math.hypot((p.x + 5) * 0.8, p.z - (Z0 + 17));
      if (sun < 3.4) return ["mustard", 0];
      if (p.z < Z0 + 16) return ["pink", 0];
      return ["navy", p.z > Z1 - 9 ? 2 : 1];
    },
  });
  // Bracket arm (the gap behind the slab), then the soundbar with its grille dots.
  k.box(-3, 3, 7.4, 8, Z0 + 10, Z1 - 10, "charcoal", { tones: { top: 1, sw: 2, se: 2 } });
  k.box(-10, 10, 6.2, 8, Z0 - 7, Z0 - 3, "charcoal", { paint: (p, f) => (f === "front" ? (Math.floor(p.x * 1.5) % 2 === 0 ? ["charcoal", 2] : ["charcoal", 1]) : f === "top" ? ["charcoal", 0] : null) });
}

// --- 1b: projector (a stand or a ceiling rod) and a pull-down screen.
const PJ = { lensY: -4.6 } as const;
function projector(k: Kit, colour: string): void {
  const Zb = colour === "ceiling" ? 150 : 38;
  if (colour === "ceiling") {
    k.box(-0.8, 0.8, -0.8, 0.8, Zb + 6, WALL_H, "charcoal", { tones: { top: 0, sw: 1, se: 2 } });
    k.box(-3, 3, -3, 3, Zb + 5, Zb + 7, "charcoal", { tones: { top: 0, sw: 1, se: 2 } });
  } else {
    // Tripod: three splayed legs (as stepped posts), a column and a tray.
    for (const [lx, ly] of [[-5, 3], [5, 3], [0, -5]] as const) {
      for (let s = 0; s < 4; s++) { const t = s / 4; k.box(lx * (1 - t) - 0.6, lx * (1 - t) + 0.6, ly * (1 - t) - 0.6, ly * (1 - t) + 0.6, s * 7, s * 7 + 7, "charcoal", { tones: { top: 0, sw: 1, se: 2 } }); }
    }
    k.box(-0.8, 0.8, -0.8, 0.8, 28, Zb - 2, "charcoal", { tones: { top: 0, sw: 1, se: 2 } });
    k.box(-4, 4, -3.5, 4, Zb - 2, Zb, "wood", { tones: { top: 0, sw: 1, se: 2 } });
  }
  // Body: cream shell, charcoal vents on the sides, a teal status light; the lens barrel out front.
  k.box(-4.5, 4.5, -3.5, 4, Zb, Zb + 5, "cream", {
    paint: (p, f) => (f === "top" ? (Math.abs(p.x - 2.5) < 1 && Math.abs(p.y) < 1 ? ["teal", 0] : ["cream", 0]) : (f === "left" || f === "right") && Math.floor(p.y * 1.4) % 2 === 0 && p.z > Zb + 1.5 && p.z < Zb + 4 ? ["charcoal", 1] : null),
  });
  k.ell({ x: -1.5, y: 0, z: Zb + 2.5 }, { x: 1.7, y: Infinity, z: 1.7 }, [-99, 99, PJ.lensY, -3.5, Zb, Zb + 5], "charcoal", {
    paint: (p, f) => (f === "front" ? (Math.hypot(p.x + 1.5, p.z - Zb - 2.5) < 0.9 ? ["glow", 0] : ["navy", 1]) : null),
  });
}

const RS = { X: 15, Z0: 70, Z1: 150 } as const;
function rollScreen(k: Kit): void {
  const { X, Z0, Z1 } = RS;
  // The cloth, lit by the projector: a black masking border, the picture washed out to the glow ramp, a pull tab and its ring.
  k.box(-X + 1, X - 1, 6.8, 7.4, Z0, Z1, "cream", {
    paint: (p, f) => {
      if (f === "back") return ["cream", 2];
      if (f !== "front") return ["cream", 1];
      if (Math.abs(p.x) > X - 2.6 || p.z < Z0 + 2 || p.z > Z1 - 8) return ["charcoal", 2];
      const hill = Z0 + 16 + 6 * Math.sin(p.x * 0.3) + (p.x > 3 ? 6 : 0);
      if (p.z < hill) return ["teal", 0];
      if (Math.hypot((p.x - 5) * 0.8, p.z - (Z0 + 46)) < 6) return ["cream", 0];
      return ["glow", p.z > Z1 - 22 ? 1 : 0];
    },
  });
  k.box(-1.2, 1.2, 6.4, 7.4, Z0 - 4, Z0, "charcoal", { tones: { top: 0, sw: 1, se: 1 } });
  // The case: a charcoal tube on two end caps.
  k.ell({ x: 0, y: 6, z: Z1 + 2.5 }, { x: Infinity, y: 2, z: 2.5 }, [-X - 0.5, X + 0.5, 3, 8, Z1, Z1 + 5], "charcoal");
  for (const s of [-1, 1]) k.box(s * (X + 0.5) - 0.8, s * (X + 0.5) + 0.8, 4, 8, Z1 - 0.5, Z1 + 5.5, "charcoal", { tones: { top: 0, sw: 1, se: 2 } });
}

// --- 2: ambient pieces.
/** Window on a wall, with a sill and a little pot. `sky`: dusk clouds drift past (4 frames). `rain`: streaks and drops slide down. */
function wallWindow(k: Kit, colour: string, n: number): void {
  const X = 6, Z0 = 78, Z1 = 128;
  k.box(-X, X, 6.4, 8, Z0, Z1, "wood", {
    paint: (p, f) => {
      if (f !== "front") return f === "top" ? ["wood", 0] : ["wood", 2];
      const x = p.x, z = p.z;
      if (x < -X + 1 || z >= Z1 - 1.5) return ["wood", 0];
      if (x >= X - 1 || z < Z0 + 1.5) return ["wood", 2];
      if (Math.abs(x) < 0.5 || Math.abs(z - (Z0 + Z1) / 2) < 0.7) return ["wood", 1]; // mullions
      const t = z - Z0;
      if (colour === "rain") {
        const streak = (((x * 1.6 + z + n * 5) % 9) + 9) % 9 < 0.9;
        const drop = [[-3.2, 0], [2.4, 1], [4.1, 2]].some(([dx, ph]) => Math.abs(x - (dx ?? 0)) < 0.55 && Math.abs(t - (40 - ((n * 6 + (ph ?? 0) * 13) % 36))) < 0.9);
        if (drop) return ["glow", 0];
        if (streak) return ["glow", 2];
        // A wet street lamp far off, then the night.
        if (Math.hypot((x + 3) * 1.3, t - 12) < 2) return ["mustard", 1];
        return ["navy", t < 14 ? 1 : 2];
      }
      // Sky: dusk bands, a cloud bank drifting right 2 units a frame (wrapping), the first star.
      const cx = ((x + 6 - n * 3) % 12 + 12) % 12 - 6;
      const cloud = Math.hypot(cx * 0.8, t - 30) < 3.2 || Math.hypot((cx - 2.5) * 0.8, t - 31.5) < 2.4 || Math.hypot((((x + 6 - n * 2 + 7) % 12 + 12) % 12 - 6) * 0.9, t - 18) < 1.8;
      if (cloud) return ["cream", t > 30 ? 0 : 1];
      if (t > 40 && Math.abs(x - 3.5) < 0.6 && Math.abs(t - 43) < 0.6 && n % 2 === 0) return ["cream", 0];
      return t < 12 ? ["pink", 0] : t < 22 ? ["pink", 1] : t < 34 ? ["lilac", 1] : ["navy", 1];
    },
  });
  k.box(-X - 1, X + 1, 4.5, 8, Z0 - 3, Z0, "wood", { tones: { top: 0, sw: 1, se: 2 } });
  k.ell({ x: 3, y: 6, z: 0 }, { x: 1.4, y: 1.4, z: Infinity }, [-99, 99, -99, 99, Z0, Z0 + 3], "rust");
  k.ell({ x: 3, y: 6, z: Z0 + 5 }, { x: 1.8, y: 1.8, z: 2.2 }, [-99, 99, -99, 99, Z0 + 3, Z0 + 8], "olive");
}

/** Ceiling fan: a rod down from the ceiling line, a brass hub, a cream light bowl, four wood blades turning 30° a frame (3 frames
 *  cover the 90° symmetry). The blades are painted per pixel on their plane, so they can turn; the rest is solids. */
const FAN_Z = 172;
function ceilingFan(k: Kit): void {
  k.box(-0.7, 0.7, -0.7, 0.7, FAN_Z + 2, WALL_H, "charcoal", { tones: { top: 0, sw: 1, se: 2 } });
  k.ell({ x: 0, y: 0, z: FAN_Z + 1 }, { x: 2.6, y: 2.6, z: 2 }, [-99, 99, -99, 99, FAN_Z - 1, FAN_Z + 3], "mustard");
  k.ell({ x: 0, y: 0, z: FAN_Z - 1 }, { x: 2.2, y: 2.2, z: 3 }, [-99, 99, -99, 99, FAN_Z - 4, FAN_Z - 1], "cream");
}
function fanBlades(img: Uint8Array, _at: unknown, _k: Kit, n: number): void {
  const th = (n * Math.PI) / 6;
  for (let py = 0; py < CV.h; py++) {
    for (let px = 0; px < CV.w; px++) {
      const a = (px + 0.5 - CV.ax) / 2, b = py + 0.5 - CV.ay + FAN_Z; // u − v, u + v on the blade plane
      const u = (a + b) / 2, v = (b - a) / 2;
      const r = Math.hypot(u, v);
      if (r < 2.4 || r > 13) continue;
      const ang = Math.atan2(v, u) - th;
      const off = ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2) - Math.PI / 4; // −45°..45° from the blade between
      const across = Math.abs(Math.PI / 4 - Math.abs(off)) * r;
      if (across > 1.9 - r * 0.03) continue;
      img[py * CV.w + px] = (Math.PI / 4 - Math.abs(off)) * Math.sign(off) > 0 ? c("wood", 0) : c("wood", 1);
    }
  }
}

/** Lava lamp: a brass foot, a tapered glass of lilac, two pink blobs rising and sinking (4 frames), a brass cap. */
function lavaLamp(k: Kit, n: number): void {
  k.ell({ x: 0, y: 0, z: 0 }, { x: 3.4, y: 3.4, z: Infinity }, [-99, 99, -99, 99, 0, 3], "mustard");
  k.ell({ x: 0, y: 0, z: 0 }, { x: 2.4, y: 2.4, z: Infinity }, [-99, 99, -99, 99, 3, 9], "mustard", { tones: { top: 0, sw: 1, se: 2 } });
  const b1 = 12 + ([0, 3, 6, 3][n % 4] ?? 0), b2 = 23 - ([0, 3, 6, 3][(n + 2) % 4] ?? 0);
  k.ell({ x: 0, y: 0, z: 0 }, { x: 2.8, y: 2.8, z: Infinity }, [-99, 99, -99, 99, 9, 27], "navy", {
    paint: (p, f) => {
      if (f === "top") return ["mustard", 0];
      if (Math.hypot(p.x * 0.8, p.z - b1) < 2.6 || Math.hypot((p.x - 0.5) * 0.9, p.z - b2) < 2.1 || p.z < 10.5) return ["pink", Math.abs(p.x) > 1.8 ? 1 : 0];
      return null;
    },
  });
  k.ell({ x: 0, y: 0, z: 0 }, { x: 1.6, y: 1.6, z: Infinity }, [-99, 99, -99, 99, 27, 30], "mustard", { tones: { top: 0, sw: 1, se: 2 } });
}

/** Café espresso bar: the bar counter, a rust espresso machine with a brass group head, two cups steaming (4 frames). */
function espressoBar(k: Kit): void {
  PIECES.find((p) => p.id === "barcounter")?.build?.(k, "wood", 0);
  const H = 30;
  k.box(6, 21, 0, 7, H, H + 18, "rust", {
    paint: (p, f) => {
      if (f === "top") return p.x < 12 ? (Math.floor(p.x) % 2 === 0 ? ["cream", 0] : ["cream", 1]) : ["rust", 0]; // cups warming on top
      if (f !== "front") return null;
      if (p.z > H + 15) return ["mustard", p.z > H + 16.5 ? 0 : 1];
      if (Math.hypot(p.x - 13.5, p.z - H - 11.5) < 2) return Math.hypot(p.x - 13.5, p.z - H - 11.5) < 1.2 ? ["cream", 0] : ["mustard", 1]; // gauge
      if (p.z < H + 3) return ["charcoal", p.z < H + 1.5 ? 2 : 1]; // drip tray
      return null;
    },
  });
  // Two group heads with portafilters, cups under them.
  for (const x of [9.5, 17.5]) {
    k.box(x - 1.5, x + 1.5, -1.5, 0, H + 7, H + 9, "mustard", { tones: { top: 0, sw: 1, se: 2 } });
    k.box(x - 0.5, x + 0.5, -4, -1.5, H + 7, H + 8, "charcoal", { tones: { top: 0, sw: 1, se: 2 } });
    k.ell({ x, y: -0.8, z: 0 }, { x: 1.2, y: 1.2, z: Infinity }, [-99, 99, -99, 99, H + 3, H + 5.5], "cream");
  }
}

/** Jukebox: a wood case with an arched top, light tubes chasing round the arch (4 frames), a record window and a chrome grille. */
function jukebox(k: Kit, n: number): void {
  const BANDS: readonly RampName[] = ["pink", "mustard", "teal", "lilac"];
  const H = 30;
  const front: (p: { x: number; z: number }) => Paint | null = (p) => {
    const r = Math.hypot(p.x, (p.z - H) * 1.05);
    if (p.z > H - 2 && r > 4.6 && r < 6.2) return [BANDS[(Math.floor((Math.atan2(p.z - H, p.x) / Math.PI) * 6) + n) % 4] ?? "pink", 0];
    if (p.z < H && Math.abs(p.x) > 4.6) return [BANDS[(Math.floor(p.z / 4) + n) % 4] ?? "pink", Math.abs(p.x) > 5.4 ? 1 : 0];
    if (p.z > 18 && p.z < H + 2 && Math.abs(p.x) < 3.6) return Math.hypot(p.x, p.z - 24) < 2.4 ? ["charcoal", 2] : ["glow", 1]; // record window
    if (p.z > 5 && p.z < 15 && Math.abs(p.x) < 3.6) return Math.floor(p.z) % 2 === 0 ? ["charcoal", 0] : ["charcoal", 2]; // grille
    return null;
  };
  k.box(-6, 6, -3, 5, 0, H, "wood", { paint: (p, f) => (f === "front" ? front(p) : f === "top" ? ["wood", 0] : null) });
  k.ell({ x: 0, y: 0, z: H }, { x: 6, y: Infinity, z: 6.3 }, [-6, 6, -3, 5, H, H + 7], "wood", { paint: (p, f) => (f === "front" ? front(p) : null) });
}

/** Studio kitchenette (2×1, backs onto a wall): cream cabinets with wood handles under a wood worktop, a sink, a two-ring hob
 *  with a teal pot steaming (4 frames), a rail of utensils on the wall behind. */
function kitchenette(k: Kit): void {
  const W0 = -7.5, W1 = 23.5, H = 26;
  k.box(W0, W1, -4, 7.5, 0, 2, "charcoal");
  k.box(W0, W1, -4, 7.5, 2, H, "cream", {
    paint: (p, f) => {
      if (f !== "front") return null;
      if (Math.abs(p.x - 8) < 0.5 || p.z > H - 2) return ["cream", 2];
      if (Math.abs(p.z - H + 5) < 0.6 && (Math.abs(p.x - 0) < 2 || Math.abs(p.x - 16) < 2)) return ["wood", 1];
      return null;
    },
  });
  k.box(W0 - 0.5, W1 + 0.5, -4.5, 8, H, H + 2, "wood", {
    paint: (p, f) => (f === "top" ? (Math.abs(p.x) < 4 && Math.abs(p.y - 1.5) < 3 ? ["charcoal", 1] : Math.hypot(p.x - 14, p.y - 2) < 2.4 || Math.hypot(p.x - 19, p.y - 2) < 2.4 ? ["charcoal", 2] : ["wood", 0]) : null),
  });
  k.ell({ x: 14, y: 2, z: 0 }, { x: 2.2, y: 2.2, z: Infinity }, [-99, 99, -99, 99, H + 2, H + 6], "teal");
  k.box(0.4, 0.9, 4, 5, H + 2, H + 8, "mustard", { tones: { top: 0, sw: 1, se: 2 } }); // tap
  k.box(-6, 22, 7, 8, H + 18, H + 19, "charcoal", { tones: { top: 0, sw: 1, se: 2 } });
  for (const [x, ramp] of [[2, "wood"], [6, "mustard"], [10, "charcoal"]] as const) k.box(x, x + 1, 6.5, 7, H + 10, H + 18, ramp, { tones: { top: 0, sw: 1, se: 2 } });
}

/** Turned frames made here for shipped pieces (the back-view cost of the swap rooms). */
const turnedShipped = new Set<string>();
/** Long-case clock (backs onto a wall): a wood case with a crown, a cream dial with two hands, a glass door over a brass pendulum
 *  swinging (4 frames: left, middle, right, middle). */
function longClock(k: Kit, n: number): void {
  const H = 66, swing = [-1.6, 0, 1.6, 0][n % 4] ?? 0;
  k.box(-5, 5, -1, 7, 0, 3, "wood", { tones: { top: 0, sw: 1, se: 2 } });
  k.box(-4, 4, 0, 7, 3, H, "wood", {
    paint: (p, f) => {
      if (f === "top") return ["wood", 0];
      if (f !== "front") return null;
      const x = p.x, z = p.z;
      const dial = Math.hypot(x, (z - 54) * 1.05);
      if (dial < 3.4) {
        if ((Math.abs(x) < 0.35 && z > 54 && z < 57.5) || (Math.abs(z - 54) < 0.4 && x > 0 && x < 2.2)) return ["charcoal", 2];
        return dial > 2.9 ? ["mustard", 1] : ["cream", 0];
      }
      if (z > 10 && z < 46 && Math.abs(x) < 2.8) {
        if (Math.abs(x) > 2.2 || z < 10.8 || z > 45.2) return ["mustard", 1]; // door frame
        const t = (46 - z) / 30, px = swing * Math.min(t, 1);
        if (z > 16 && Math.abs(x - px) < 0.4) return ["mustard", 2]; // rod
        if (Math.hypot(x - swing, (z - 18) * 1.1) < 1.5) return ["mustard", 0]; // bob
        return ["navy", 2];
      }
      return null;
    },
  });
  k.box(-5, 5, -1, 7, H, H + 3, "wood", { tones: { top: 0, sw: 1, se: 2 } });
  k.ell({ x: 0, y: 3, z: H + 3 }, { x: 3, y: Infinity, z: 3 }, [-4, 4, 0, 7, H + 3, H + 6], "wood");
}

const SIDETABLE = PIECES.find((p) => p.id === "sidetable");
const CONCEPTS: readonly CDef[] = [
  { id: "wallscreen", label: "Wall screen", layer: "wall", colours: ["panel"], dirs: ["se", "sw"], cols: 0, rows: 0, frames: 1, ms: 0, walkable: true, back: true, build: (k) => { wallScreen(k); } },
  { id: "projector", label: "Projector", layer: "object", colours: ["stand", "ceiling"], dirs: ALL, cols: 1, rows: 1, frames: 1, ms: 0, build: (k, col) => { projector(k, col); }, shadow: (col) => (col === "ceiling" ? 5 : 0) },
  { id: "rollscreen", label: "Pull-down screen", layer: "wall", colours: ["cloth"], dirs: ["se", "sw"], cols: 0, rows: 0, frames: 1, ms: 0, walkable: true, back: true, build: (k) => { rollScreen(k); } },
  { id: "window", label: "Window", layer: "wall", colours: ["sky", "rain"], dirs: ["se", "sw"], cols: 0, rows: 0, frames: 4, ms: 260, walkable: true, build: (k, col, n) => { wallWindow(k, col, n); } },
  { id: "ceilingfan", label: "Ceiling fan", layer: "object", colours: ["wood"], dirs: ["se"], cols: 1, rows: 1, frames: 3, ms: 90, walkable: true, build: (k) => { ceilingFan(k); }, under: fanBlades, shadow: () => 10 },
  { id: "longclock", label: "Long-case clock", layer: "object", colours: ["wood"], dirs: ["se", "sw"], cols: 1, rows: 1, frames: 4, ms: 250, build: (k, _c, n) => { longClock(k, n); } },
  { id: "teatable", label: "Snack table, steaming mug", layer: "object", colours: ["wood"], dirs: ["se", "sw"], cols: 1, rows: 1, frames: 4, ms: 180, build: (k) => { SIDETABLE?.build?.(k, "wood", 0); }, steam: [{ x: 2.6, y: -1.8, z: 19 }] },
  { id: "lavalamp", label: "Lava lamp", layer: "object", colours: ["lilac"], dirs: ["se"], cols: 1, rows: 1, frames: 4, ms: 320, build: (k, _c, n) => { lavaLamp(k, n); } },
  { id: "espresso", label: "Espresso bar", layer: "object", colours: ["rust"], dirs: ["se", "sw"], cols: 2, rows: 1, frames: 4, ms: 160, build: (k) => { espressoBar(k); }, steam: [{ x: 9.5, y: -0.8, z: 37 }, { x: 17.5, y: -0.8, z: 50 }] },
  { id: "jukebox", label: "Jukebox", layer: "object", colours: ["wood"], dirs: ["se", "sw"], cols: 1, rows: 1, frames: 4, ms: 150, back: true, build: (k, _c, n) => { jukebox(k, n); } },
  { id: "kitchenette", label: "Kitchenette", layer: "object", colours: ["cream"], dirs: ["se", "sw"], cols: 2, rows: 1, frames: 4, ms: 170, back: true, build: (k) => { kitchenette(k); }, steam: [{ x: 14, y: 2, z: 33 }] },
];
/** Shipped pieces whose existing "in use" loop becomes an ambient loop in these concepts (0 new bytes). */
const REUSED_LOOPS: Readonly<Record<string, { frames: number; ms: number }>> = { fireplace: { frames: 4, ms: 120 }, neonsign: { frames: 3, ms: 140 }, aquarium: { frames: 3, ms: 220 } };

// ------------------------------------------------------------------ shells (sky terrace, split floors)

const WALL_T = 4;
const SKY_N = 3;
const sky = (side: "l" | "r", i: number): string => `wall/${side}/sky/${String(i % SKY_N)}`;
/** Penthouse terrace "wall": open air. A glass balustrade with a brass rail, a skyline with lit windows, a dusk sky with stars,
 *  under a slim steel pergola beam. `s` runs along the whole wall, so the skyline never repeats from cell to cell. */
function skyPaint(s: number, z: number, lit: boolean): Paint {
  if (z < 4) return ["charcoal", 2];
  if (z >= WALL_H - 5) return ["charcoal", lit ? 0 : 1];
  if (z >= 28 && z < 31) return ["mustard", lit ? 0 : 1];
  if (z < 28) return (((s % 16) + 16) % 16) < 1 ? ["charcoal", 1] : ["glow", lit ? 1 : 2];
  const lot = Math.floor(s / 5);
  const top = 31 + 14 + (hash(lot, 7) % 46) * (hash(lot, 3) % 3 === 0 ? 0.4 : 1);
  if (z < top) {
    const win = Math.floor(s * 1.2) % 2 === 0 && Math.floor(z) % 5 < 2 && hash(Math.floor(s * 1.2), Math.floor(z / 5)) % 3 === 0;
    if (win) return ["mustard", hash(Math.floor(s), Math.floor(z)) % 2 === 0 ? 0 : 1];
    return ["charcoal", (((s % 5) + 5) % 5) < 1 ? 1 : 2];
  }
  if (z > 120 && hash(Math.floor(s * 2), Math.floor(z)) % 61 === 0) return ["cream", 0];
  const d = (Math.floor(s * 2) + Math.floor(z)) % 2 === 0;
  if (z < 70) return ["pink", z > 66 && d ? 1 : 0];
  if (z < 104) return ["pink", z > 100 && d ? 2 : 1];
  if (z < 140) return ["lilac", z > 136 && d ? 2 : 1];
  if (z < 176) return ["lilac", 2];
  return ["navy", 1];
}
type Skin = "sky" | "smoke";
const skinPaint = (skin: Skin, s: number, z: number, lit: boolean): Paint => (skin === "sky" ? skyPaint(s, z, lit) : panelPaint("smoke", s, z, lit));
const topOf = (skin: Skin): Paint => (skin === "sky" ? ["charcoal", 1] : ["wood", 0]);
const leftWall = (key: string, i: number, skin: (v: number) => Skin): RoomFrame =>
  solidsFrame(key, [box(-8 - WALL_T, -8, -8, 8, 0, WALL_H, "wall", { skip: ["sw", "other"], paint: (p, f) => (f === "top" ? topOf(skin(p.v)) : f === "se" ? skinPaint(skin(p.v), p.v + 16 * i, p.z, false) : null) })], "top");
const rightWall = (key: string, i: number, skin: Skin): RoomFrame =>
  solidsFrame(key, [box(-8, 8, -8 - WALL_T, -8, 0, WALL_H, "wall", { skip: ["se", "other"], paint: (p, f) => (f === "top" ? topOf(skin) : f === "sw" ? skinPaint(skin, p.u + 16 * i + 300, p.z, true) : null) })], "top");
const skyBits = (): RoomFrame[] => [
  solidsFrame("wall/corner/sky", [box(-8 - WALL_T, -8, -8 - WALL_T, -8, 0, WALL_H, "charcoal", { tones: { top: 0, sw: 1, se: 2 } })], "top"),
  solidsFrame("wall/l/end/sky", [box(-8 - WALL_T, -8, 7, 8, 0, WALL_H, "charcoal", { skip: ["se", "other"], tones: { top: 0, sw: 1, se: 2 } })], "all", (x) => x < -32),
  solidsFrame("wall/r/end/sky", [box(7, 8, -8 - WALL_T, -8, 0, WALL_H, "charcoal", { skip: ["sw", "other"], tones: { top: 0, sw: 1, se: 2 } })], "all", (x) => x >= 32),
];
const split = (name: string, back: (n: number) => (u: number, v: number) => Paint, front: (n: number) => (u: number, v: number) => Paint): RoomFrame[] =>
  [0, 1].map((n) => { const b = back(n), f = front(n); return floorTile(`floor/${name}/${String(n)}`, (u, v) => (v < 0 ? b(u, v) : f(u, v))); });

function shellFrames(): RoomFrame[] {
  const out: RoomFrame[] = [...skyBits()];
  // Three skyline variants per wall side (shortcut: a 3-cell period; a long wall shows the repeat only if you look for it).
  for (let i = 0; i < SKY_N; i++) out.push(leftWall(`wall/l/sky/${String(i)}`, i, () => "sky"), rightWall(`wall/r/sky/${String(i)}`, i, "sky"));
  out.push(leftWall("wall/l/sky/split", 1, (v) => (v < 0 ? "sky" : "smoke")), leftWall("wall/l/sky/splitn", 2, (v) => (v < 0 ? "smoke" : "sky")));
  // The near walls' cut-away line in a swapped view: the partition's 16 px stub (OME-1959) run along both near edges.
  const stubPaint = (p: { z: number }, f: string): Paint => (f === "top" ? ["wood", 0] : p.z < 3 ? ["charcoal", 2] : ["wood", f === "sw" ? 1 : 2]);
  out.push(solidsFrame("stub/u", [box(8, 8 + WALL_T, -8, 8, 0, 16, "wood", { paint: stubPaint })], "top"));
  out.push(solidsFrame("stub/v", [box(-8, 8, 8, 8 + WALL_T, 0, 16, "wood", { paint: stubPaint })], "top"));
  // The wall patch behind a ghosted screen: three cells of the near wall, x-rayed (paper over the wainscot).
  out.push(solidsFrame("stub/patch/u", [box(8, 8 + WALL_T, -24, 24, 16, 136, "wall", { paint: (p, f) => (f === "top" ? ["wall", 0] : p.z < 36 ? ["wood", 2] : p.z < 38 ? ["wood", 0] : ["wall", 2]) })], "all"));
  out.push(...split("pent", deckTile, planks), ...split("pent/north", planks, deckTile), ...split("nook", carpetTile, planks), ...split("nook/north", planks, carpetTile));
  return out;
}

// ------------------------------------------------------------------ plans

const ROW = 4, DOOR = 1;
const part = (colour: (c: number) => string): Placement[] => Array.from({ length: 10 }, (_, i) => i).filter((i) => i !== DOOR).map((i) => ({ id: "partition", colour: colour(i), dir: "sw" as const, col: i, row: ROW }));
const plank = (c0: number, r: number): string => `floor/${String((c0 * 3 + r) % 2)}`;

/** 1: the Classic room with no console. `kind` = which screen. South: as everyone sees it today. */
function screenPlan(d: ConceptDeps, kind: "wall" | "projector"): RoomPlan {
  const classic = PRESETS.find((p) => p.id === "classic");
  if (!classic) throw new Error("no classic preset");
  const plan = d.presetPlan(classic.layout);
  plan.tv = false;
  if (kind === "wall") plan.placements.push({ id: "wallscreen", colour: "panel", dir: "se", col: 0, row: 3 });
  else plan.placements.push({ id: "rollscreen", colour: "cloth", dir: "se", col: 0, row: 3 }, { id: "projector", colour: "stand", dir: "nw", col: 4, row: 4 });
  return plan;
}
/** The same room swapped 180° (classic has no partition; this is how a north-facing view would draw it): the screen's wall is the
 *  near wall now, so the screen shows as its back, ghosted (x-ray) where the cut-away wall would be. */
function screenNorth(d: ConceptDeps, pieces: readonly PieceMeta[], kind: "wall" | "projector"): { pieces: PieceMeta[]; plan: RoomPlan } {
  const south = screenPlan(d, kind);
  const walls = (side: "l" | "r") => (i: number) => `wall/${side}/${["plain", "plain", "plain", "plain", "plain", side === "l" ? "window0" : "poster0", side === "l" ? "window1" : "poster1", "plain", "sconce", "plain"][i] ?? "plain"}`;
  // The big rug turned with the room: cell (c, r) shows (9 − c, 9 − r) with its edge parts swapped.
  const RUG_TURN: Readonly<Record<string, string>> = { n: "s", s: "n", e: "w", w: "e", ne: "sw", sw: "ne", nw: "se", se: "nw", c: "c" };
  const floor = defaultLayout().floor;
  const nv = d.northView(pieces, d.all, south, { floor: (c0, r) => { const k = floor[9 - r]?.[9 - c0] ?? plank(c0, r); return k.startsWith("rug/") ? `rug/${RUG_TURN[k.slice(4)] ?? "c"}` : k; }, l: walls("l"), r: walls("r"), corner: "wall/corner", lEnd: "wall/l/end", rEnd: "wall/r/end" });
  // presetPlan's armchairs are cell sprites ("standing"): turn them by hand (ne ↔ sw, nw ↔ se), sitters included.
  nv.plan.standing = south.standing.map(([key, c0, r]): [string, number, number] => [key.replace(/\/(ne|nw|se|sw)\//, (_m, dd: FurnDir) => `/${TURN[dd]}/`), 9 - c0, 9 - r]);
  return nv;
}

/** 2: one revamp per older preset, every ambient loop in it. */
function revampPlan(d: ConceptDeps, id: string): RoomPlan {
  const pr = PRESETS.find((p) => p.id === id);
  if (!pr) throw new Error(`no preset ${id}`);
  const plan = d.presetPlan(pr.layout);
  plan.tv = false;
  const add = (...ps: Placement[]): void => { plan.placements.push(...ps); };
  const drop = (pid: string, col: number, row: number): void => { plan.placements = plan.placements.filter((p) => !(p.id === pid && p.col === col && p.row === row)); };
  if (id === "classic") {
    add({ id: "wallscreen", colour: "panel", dir: "se", col: 0, row: 2 }, { id: "window", colour: "sky", dir: "sw", col: 3, row: 0 }, { id: "longclock", colour: "wood", dir: "sw", col: 7, row: 0 });
  } else if (id === "living") {
    add({ id: "fireplace", colour: "stone", dir: "sw", col: 0, row: 0 }, { id: "wallscreen", colour: "panel", dir: "sw", col: 0, row: 0 });
    drop("sidetable", 4, 6); drop("sidetable", 6, 4);
    add({ id: "teatable", colour: "wood", dir: "se", col: 4, row: 6 }, { id: "teatable", colour: "wood", dir: "sw", col: 6, row: 4 });
  } else if (id === "lounge") {
    drop("frame", 0, 2); drop("arclamp", 1, 8); drop("arclamp", 8, 1);
    add({ id: "rollscreen", colour: "cloth", dir: "se", col: 0, row: 3 }, { id: "projector", colour: "stand", dir: "nw", col: 6, row: 6 }, { id: "frame", colour: "dusk", dir: "se", col: 0, row: 7 });
    add({ id: "lavalamp", colour: "lilac", dir: "se", col: 1, row: 6 }, { id: "lavalamp", colour: "lilac", dir: "se", col: 6, row: 1 });
  } else if (id === "cafe") {
    drop("bookshelf", 2, 0);
    add({ id: "espresso", colour: "rust", dir: "sw", col: 2, row: 0 }, { id: "window", colour: "rain", dir: "sw", col: 7, row: 0 }, { id: "window", colour: "rain", dir: "se", col: 0, row: 7 }, { id: "wallscreen", colour: "panel", dir: "se", col: 0, row: 1 });
  } else if (id === "bar") {
    add({ id: "jukebox", colour: "wood", dir: "se", col: 0, row: 5 }, { id: "wallscreen", colour: "panel", dir: "sw", col: 3, row: 0 });
  }
  return plan;
}

/** 3a: Penthouse. Rooftop terrace behind glass (rows 0–3: deck, sky walls, loungers, a rooftop cinema), lounge in front (rows 5–9:
 *  smoked panelling, a wall screen over the aquarium, the sofa and couch facing it). */
function penthouseSouth(): RoomPlan {
  return {
    placements: [
      { id: "lounger", colour: "teak", dir: "se", col: 6, row: 0, sitters: ["kiki", ""] },
      { id: "lounger", colour: "teak", dir: "se", col: 6, row: 2 },
      { id: "projector", colour: "stand", dir: "se", col: 3, row: 2 },
      { id: "monstera", colour: "rust", dir: "se", col: 0, row: 0 },
      { id: "monstera", colour: "teal", dir: "sw", col: 9, row: 3 },
      { id: "garland", colour: "warm", dir: "sw", col: 3, row: 0 }, { id: "garland", colour: "warm", dir: "sw", col: 7, row: 0 },
      { id: "garland", colour: "warm", dir: "se", col: 0, row: 2 },
      ...part((i) => (i === 0 ? "panel" : "panelglass")),
      { id: "aquarium", colour: "teal", dir: "se", col: 0, row: 5 },
      { id: "wallscreen", colour: "panel", dir: "se", col: 0, row: 7 },
      { id: "minibar", colour: "fridge", dir: "se", col: 0, row: 9 },
      { id: "neonsign", colour: "pink", dir: "se", col: 0, row: 9 },
      { id: "sofa", colour: "velvet", dir: "nw", col: 4, row: 6, sitters: ["juno", "mo"] },
      { id: "couch", colour: "cream", dir: "nw", col: 6, row: 6 },
      { id: "coffeetable", colour: "wood", dir: "sw", col: 2, row: 7 },
      { id: "arclamp", colour: "brass", dir: "se", col: 8, row: 8 },
      { id: "monstera", colour: "teal", dir: "sw", col: 9, row: 9 },
    ],
    standing: [["pip/idle/se/0", 2, 9]],
    rug: false,
    tv: false,
    shell: {
      floor: (c0, r) => (r < ROW ? `floor/deck/${String((c0 * 3 + r) % 2)}` : r === ROW ? `floor/pent/${String((c0 * 3 + r) % 2)}` : plank(c0, r)),
      l: (i) => (i < ROW ? sky("l", i) : i === ROW ? "wall/l/sky/split" : "wall/l/smoke"),
      r: (i) => sky("r", i),
      corner: "wall/corner/sky",
      lEnd: "wall/l/end/smoke",
      rEnd: "wall/r/end/sky",
    },
  };
}
const N = 9 - ROW;
const penthouseNorthShell: Shell = {
  floor: (c0, r) => (r < N ? plank(c0, r) : r === N ? `floor/pent/north/${String((c0 * 3 + r) % 2)}` : `floor/deck/${String((c0 * 3 + r) % 2)}`),
  l: (i) => (i < N ? "wall/l/smoke" : i === N ? "wall/l/sky/splitn" : sky("l", i)),
  r: () => "wall/r/smoke",
  corner: "wall/corner/smoke",
  lEnd: "wall/l/end/sky",
  rEnd: "wall/r/end/smoke",
};

/** 3b: Studio flat. A sleeping nook behind a papered wall with a glass stripe (rows 0–3: carpet, the bed, a rainy window, a steaming
 *  mug, the cat), the kitchen-living room in front (rows 5–9: kitchenette, fridge, breakfast table, couch facing a wall screen). */
function studioSouth(): RoomPlan {
  return {
    placements: [
      { id: "bed", colour: "velvet", dir: "nw", col: 4, row: 1, sitters: ["", "kiki"] },
      { id: "teatable", colour: "wood", dir: "sw", col: 6, row: 1 },
      { id: "bookshelf", colour: "wood", dir: "se", col: 0, row: 1 },
      { id: "window", colour: "rain", dir: "sw", col: 7, row: 0 },
      { id: "cat", colour: "ginger", dir: "se", col: 2, row: 2 },
      { id: "arclamp", colour: "brass", dir: "sw", col: 8, row: 1 },
      ...part((i) => (i >= 3 && i <= 7 ? "glass" : "solid")),
      { id: "kitchenette", colour: "cream", dir: "se", col: 0, row: 5 },
      { id: "minibar", colour: "fridge", dir: "se", col: 0, row: 7 },
      { id: "sidetable", colour: "wood", dir: "se", col: 3, row: 6 },
      { id: "stool", colour: "teal", dir: "ne", col: 3, row: 7, sitters: ["mo"] },
      { id: "stool", colour: "wood", dir: "nw", col: 4, row: 6 },
      { id: "couch", colour: "olive", dir: "nw", col: 5, row: 7, sitters: ["juno", "pip"] },
      { id: "wallscreen", colour: "panel", dir: "se", col: 0, row: 8 },
      { id: "beanbag", colour: "navy", dir: "nw", col: 7, row: 8 },
      { id: "monstera", colour: "rust", dir: "se", col: 9, row: 9 },
    ],
    standing: [],
    rug: false,
    tv: false,
    shell: {
      floor: (c0, r) => (r < ROW ? `floor/carpet/${String((c0 * 3 + r) % 2)}` : r === ROW ? `floor/nook/${String((c0 * 3 + r) % 2)}` : plank(c0, r)),
      l: (i) => `wall/l/${i === 1 ? "window0" : i === 2 ? "window1" : "plain"}`,
      r: (i) => `wall/r/${i === 9 ? "sconce" : "plain"}`,
      corner: "wall/corner",
      lEnd: "wall/l/end",
      rEnd: "wall/r/end",
    },
  };
}
const studioNorthShell: Shell = {
  floor: (c0, r) => (r < N ? plank(c0, r) : r === N ? `floor/nook/north/${String((c0 * 3 + r) % 2)}` : `floor/carpet/${String((c0 * 3 + r) % 2)}`),
  l: (i) => `wall/l/${i === 7 ? "sconce" : "plain"}`,
  r: (i) => `wall/r/${i === 2 ? "poster1" : "plain"}`,
  corner: "wall/corner",
  lEnd: "wall/l/end",
  rEnd: "wall/r/end",
};

// ------------------------------------------------------------------ render helpers

const cellCentre = (c0: number, r: number): { u: number; v: number } => ({ u: 16 * c0, v: 16 * r });
const screenXY = (u: number, v: number, z: number): { x: number; y: number } => ({ x: 480 + 2 * (u - v), y: 236 + u + v - z });

/** The projector's light: a sparse dither of the glow highlight from the lens to the screen's four corners (not over the screen). */
function beam(img: Uint8Array, W: number, H: number, pj: Placement, screen: { col: number; row: number; dir: FurnDir; near: boolean }): void {
  const Zb = pj.colour === "ceiling" ? 150 : 38;
  const k = new Kit(pj.dir);
  const lw = k.world(-1.5, PJ.lensY - 0.5), cc = cellCentre(pj.col, pj.row);
  const lens = screenXY(cc.u + lw.u, cc.v + lw.v, Zb + 2.5);
  // The cloth's plane: the far left wall (se), far right wall (sw), or — swapped — the near right / near left edge.
  const s = cellCentre(screen.col, screen.row);
  const corner = (x: number, z: number): { x: number; y: number } => {
    if (screen.dir === "se") return screenXY(s.u - 7, s.v + x, z);
    if (screen.dir === "sw") return screenXY(s.u + x, s.v - 7, z);
    if (screen.dir === "nw") return screenXY(s.u + 7, s.v + x, z);
    return screenXY(s.u + x, s.v + 7, z);
  };
  const X = RS.X - 2.6, quad = [corner(-X, RS.Z0 + 2), corner(X, RS.Z0 + 2), corner(X, RS.Z1 - 8), corner(-X, RS.Z1 - 8)];
  const inside = (pts: readonly { x: number; y: number }[], x: number, y: number): boolean => {
    let sign = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (!a || !b) return false;
      const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (cr !== 0) { if (sign === 0) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false; }
    }
    return true;
  };
  // Convex hull of lens + quad (gift wrap; 5 points).
  const pts = [lens, ...quad];
  const hull: { x: number; y: number }[] = [];
  let p = pts.reduce((a, b) => (b.x < a.x ? b : a));
  for (let guard = 0; guard < 8; guard++) {
    hull.push(p);
    let q = pts[0] === p ? (pts[1] ?? p) : (pts[0] ?? p);
    for (const r of pts) { const cr = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x); if (cr < 0) q = r; }
    p = q;
    if (p === hull[0]) break;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if ((x + 2 * y) % 4 !== 0 || !inside(hull, x + 0.5, y + 0.5) || inside(quad, x + 0.5, y + 0.5)) continue;
    img[y * W + x] = c("glow", 0);
  }
}

const cellAt = (c0: number, r: number): { x: number; y: number } => ({ x: 480 + (c0 - r) * 32, y: 220 + (c0 + r + 1) * 16 });
function blit(img: Uint8Array, W: number, H: number, all: FurnSprites, key: string, c0: number, r: number, ghost = false): void {
  const f = all.get(key);
  if (!f) throw new Error(`missing ${key}`);
  const a = cellAt(c0, r), ox = a.x - f.ax, oy = a.y - f.ay;
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    const v = f.img[y * f.w + x] ?? 0, px = ox + x, py = oy + y;
    if (v && px >= 0 && py >= 0 && px < W && py < H && (!ghost || (px + py) % 2 === 0)) img[py * W + px] = v;
  }
}
/** Swapped view: the near walls as their low stub, and what hangs on them as an x-ray ghost of its back at its real height. */
function nearWalls(img: Uint8Array, W: number, H: number, all: FurnSprites, ghosts: readonly { key: string; col: number; row: number }[]): void {
  for (let i = 0; i < 10; i++) { blit(img, W, H, all, "stub/v", i, 9); blit(img, W, H, all, "stub/u", 9, i); }
  for (const g of ghosts) { blit(img, W, H, all, "stub/patch/u", g.col, g.row, true); blit(img, W, H, all, g.key, g.col, g.row); }
}

function write(name: string, r: { img: Uint8Array; W: number; H: number }): void {
  writeFileSync(join(ROOT, "preview", `${name}@1x.png`), encodeIndexedPng(r.W, r.H, r.img, PALETTE));
  writeFileSync(join(ROOT, "preview", `${name}@2x.png`), encodeIndexedPng(r.W * 2, r.H * 2, upscale(r.img, r.W, r.H, 2), PALETTE));
}

/** The room animated: every ambient loop on its own clock, 10 ticks of 100 ms, cropped to the room (the near corner to the walls' top). */
const CROP = { x: 140, y: 0, w: 680, h: 552 } as const;
function animate(name: string, d: ConceptDeps, pieces: readonly PieceMeta[], plan: RoomPlan, after?: (img: Uint8Array, W: number, H: number) => void): void {
  const loops = new Map<string, { frames: number; ms: number }>(Object.entries(REUSED_LOOPS));
  for (const def of CONCEPTS) if (def.frames > 1) loops.set(def.id, { frames: def.frames, ms: def.ms });
  const frames: Uint8Array[] = [];
  for (let t = 0; t < 10; t++) {
    const placements = plan.placements.map((p): Placement => { const l = loops.get(p.id); return l ? { ...p, use: Math.floor((t * 100) / l.ms) % l.frames } : p; });
    const r = d.compose(pieces, d.all, { ...plan, placements });
    after?.(r.img, r.W, r.H);
    const out = new Uint8Array(CROP.w * CROP.h);
    for (let y = 0; y < CROP.h; y++) out.set(r.img.subarray((CROP.y + y) * r.W + CROP.x, (CROP.y + y) * r.W + CROP.x + CROP.w), y * CROP.w);
    frames.push(out);
  }
  // Each later frame keeps only the pixels that changed since the one before (the rest blend through).
  const deltas = frames.map((f, i) => { const prev = frames[i - 1]; return prev ? f.map((v, j) => (v === prev[j] ? 0 : v)) : f; });
  writeFileSync(join(ROOT, "preview", `${name}@1x.apng`), encodeIndexedApng(CROP.w, CROP.h, deltas, frames.map(() => 100), PALETTE, true));
}

/** Byte estimate per concept piece: every frame of every facing of one colour on one strip PNG (as a sheet would pack them), plus
 *  its atlas entries gzipped (frames + one `meta.omega.pieces` row). */
function budget(frames: readonly Rendered[]): Record<string, { frames: number; png: number; json: number }> {
  const out: Record<string, { frames: number; png: number; json: number }> = {};
  for (const def of CONCEPTS) {
    for (const colour of def.colours) {
      const mine = frames.filter((f) => { const k = f.key.split("/"); return (k[1] === def.id || k[1] === `${def.id}back`) && k[2] === colour && (def.frames > 1 ? !f.key.endsWith("/back") : !f.key.includes("/use/")); });
      const w = mine.reduce((a, f) => a + f.w + 1, 0), h = Math.max(...mine.map((f) => f.h));
      const sheet = new Uint8Array(w * h);
      let x = 0;
      for (const f of mine) { for (let y = 0; y < f.h; y++) sheet.set(f.img.subarray(y * f.w, (y + 1) * f.w), y * w + x); x += f.w + 1; }
      const json = JSON.stringify(Object.fromEntries(mine.map((f, i) => [f.key, { frame: { x: i * 40, y: 0, w: f.w, h: f.h }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h }, sourceSize: { w: f.w, h: f.h }, anchor: { x: f.ax / f.w, y: f.ay / f.h } }])));
      out[`${def.id}/${colour}`] = { frames: mine.length, png: encodeIndexedPng(w, h, sheet, PALETTE).length, json: gzipSync(json, { level: 9 }).length };
    }
  }
  return out;
}

// ------------------------------------------------------------------ entry

/** The shipped sprite set takes ~2 min to ray-cast; iterating on concepts reuses it from $CONCEPTS_CACHE when set (delete to refresh). */
export function cachedSprites(make: () => { pieces: PieceMeta[]; frames: readonly RoomFrame[] }): { pieces: PieceMeta[]; all: FurnSprites } {
  const path = process.env["CONCEPTS_CACHE"];
  interface Row { key: string; w: number; h: number; ax: number; ay: number; img: string }
  let data: { pieces: PieceMeta[]; frames: Row[] } | null = null;
  if (path && existsSync(path)) data = JSON.parse(readFileSync(path, "utf8")) as { pieces: PieceMeta[]; frames: Row[] };
  if (!data) {
    const made = make();
    data = { pieces: made.pieces, frames: made.frames.map((f) => ({ key: f.key, w: f.w, h: f.h, ax: f.ax, ay: f.ay, img: Buffer.from(f.img).toString("base64") })) };
    if (path) writeFileSync(path, JSON.stringify(data));
  }
  const all: FurnSprites = new Map();
  for (const f of data.frames) all.set(f.key, { w: f.w, h: f.h, ax: f.ax, ay: f.ay, img: new Uint8Array(Buffer.from(f.img, "base64")) });
  return { pieces: data.pieces, all };
}

export function buildConcepts(d0: ConceptDeps): void {
  const all: FurnSprites = new Map(d0.all);
  const rendered: Rendered[] = [];
  const pieces: PieceMeta[] = [...d0.pieces];
  for (const def of CONCEPTS) {
    for (const colour of def.colours) for (const dir of def.dirs) rendered.push(...conceptFrames(def, def.id, colour, dir, false));
    pieces.push(conceptMeta(def, def.id, def.dirs, def.layer));
    if (def.back) {
      // Free-standing pieces keep their id turned, so northView turns them; a wall piece's back is its own object (the near-wall ghost).
      const id = def.layer === "object" ? def.id : `${def.id}back`;
      for (const colour of def.colours) for (const dir of def.dirs) rendered.push(...conceptFrames(def, id, colour, dir, true));
      if (def.layer === "wall") pieces.push(conceptMeta(def, id, def.dirs.map((x) => TURN[x]), "object"));
    }
  }
  for (const f of [...rendered, ...shellFrames()]) all.set(f.key, f);
  // Shipped one-sided pieces in the swap rooms get their turned view too (as furniture-back would ship them), so nothing shows its
  // front to the wrong side.
  for (const p of [...penthouseSouth().placements, ...studioSouth().placements]) {
    const def = PIECES.find((x) => x.id === p.id);
    if (!def?.build || def.mount === "wall" || p.id === "partition" || def.dirs.includes(TURN[p.dir]) || all.has(`furniture/${p.id}/${p.colour}/${TURN[p.dir]}/back`)) continue;
    for (const f of pieceFrames(def, p.colour, p.dir, true)) { all.set(f.key, f); turnedShipped.add(f.key); }
  }
  const d: ConceptDeps = { ...d0, all, pieces };

  // 1: screens.
  for (const kind of ["wall", "projector"] as const) {
    const s = screenPlan(d, kind);
    const south = d.compose(pieces, all, s);
    const pj = s.placements.find((p) => p.id === "projector");
    if (pj) beam(south.img, south.W, south.H, pj, { col: 0, row: 3, dir: "se", near: false });
    write(`c2062-screen-${kind}-south`, south);
    const n = screenNorth(d, pieces, kind);
    const north = d.compose(n.pieces, all, n.plan);
    const pn = n.plan.placements.find((p) => p.id === "projector");
    nearWalls(north.img, north.W, north.H, all, [{ key: kind === "wall" ? "furniture/wallscreenback/panel/nw/back" : "furniture/rollscreenback/cloth/nw/back", col: 9, row: 6 }]);
    if (pn) beam(north.img, north.W, north.H, pn, { col: 9, row: 6, dir: "nw", near: true });
    write(`c2062-screen-${kind}-north`, north);
  }

  // 2: revamps (still + animated).
  for (const id of ["classic", "living", "lounge", "cafe", "bar"]) {
    const plan = revampPlan(d, id);
    const pj = plan.placements.find((p) => p.id === "projector");
    const after = pj ? (img: Uint8Array, W: number, H: number): void => { beam(img, W, H, pj, { col: 0, row: 3, dir: "se", near: false }); } : undefined;
    const r = d.compose(pieces, all, plan);
    after?.(r.img, r.W, r.H);
    write(`c2062-revamp-${id}`, r);
    animate(`c2062-revamp-${id}`, d, pieces, plan, after);
  }

  // 3: swap rooms, one preview per view (+ the loops animated).
  const ps = penthouseSouth();
  const terraceBeam = (pjc: Placement) => (img: Uint8Array, W: number, H: number): void => { beam(img, W, H, pjc, { col: 0, row: 7, dir: "se", near: false }); };
  const pSouth = d.compose(pieces, all, ps);
  write("c2062-penthouse-south", pSouth);
  animate("c2062-penthouse-south", d, pieces, ps);
  const pnv = d.northView(pieces, all, { ...ps, placements: ps.placements.filter((p) => !p.ghost) }, penthouseNorthShell);
  // The terrace's own screen hangs on its east wall, at the back in this view (the rooftop cinema); the lounge's screen is ghosted.
  pnv.plan.placements.push({ id: "rollscreen", colour: "cloth", dir: "se", col: 0, row: 7 });
  pnv.plan.placements.push({ id: "frame", colour: "tide", dir: "sw", col: 3, row: 0 }, { id: "frame", colour: "dusk", dir: "sw", col: 5, row: 0 });
  const pnPj = pnv.plan.placements.find((p) => p.id === "projector");
  const pNorth = d.compose(pnv.pieces, all, pnv.plan);
  nearWalls(pNorth.img, pNorth.W, pNorth.H, all, [{ key: "furniture/wallscreenback/panel/nw/back", col: 9, row: 2 }]);
  if (pnPj) terraceBeam(pnPj)(pNorth.img, pNorth.W, pNorth.H);
  write("c2062-penthouse-north", pNorth);

  const ss = studioSouth();
  write("c2062-studio-south", d.compose(pieces, all, ss));
  animate("c2062-studio-south", d, pieces, ss);
  const snv = d.northView(pieces, all, ss, studioNorthShell);
  // The nook's own screen on its back wall in this view (a screen per view), the living room's ghosted on the near wall.
  snv.plan.placements.push({ id: "wallscreen", colour: "panel", dir: "sw", col: 5, row: 0 });
  snv.plan.placements.push({ id: "window", colour: "sky", dir: "sw", col: 2, row: 0 });
  const sNorth = d.compose(snv.pieces, all, snv.plan);
  nearWalls(sNorth.img, sNorth.W, sNorth.H, all, [{ key: "furniture/wallscreenback/panel/nw/back", col: 9, row: 1 }]);
  write("c2062-studio-north", sNorth);

  // Ambient strip at 4× (every loop frame, both facings) and the byte table.
  const loopKeys = rendered.filter((f) => f.key.includes("/use/") && !f.key.split("/")[1]?.endsWith("back"));
  const ids = [...new Set(loopKeys.map((f) => f.key.split("/").slice(1, 3).join("/") + "/" + (f.key.split("/")[4] ?? "")))].filter((k) => (CONCEPTS.find((x) => x.id === k.split("/")[0])?.frames ?? 1) > 1);
  const rowH = 96, colW = 96, maxN = 4;
  const SW = colW * maxN, SH = rowH * ids.length;
  const strip = new Uint8Array(SW * SH).fill(c("night", 2));
  ids.forEach((k0, row) => {
    const [id, colour, dir] = k0.split("/");
    for (let n = 0; n < maxN; n++) {
      const f = all.get(`furniture/${id ?? ""}/${colour ?? ""}/use/${dir ?? ""}/${String(n)}`);
      if (!f) continue;
      const ox = n * colW + Math.round(colW / 2 - f.ax), oy = row * rowH + Math.round((rowH - f.h) / 2);
      for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
        const v = f.img[y * f.w + x] ?? 0, px = ox + x, py = oy + y;
        if (v && px >= n * colW && px < (n + 1) * colW && py >= row * rowH && py < (row + 1) * rowH) strip[py * SW + px] = v;
      }
    }
  });
  writeFileSync(join(ROOT, "preview", "c2062-ambient-strip@4x.png"), encodeIndexedPng(SW * 4, SH * 4, upscale(strip, SW, SH, 4), PALETTE));
  const table = budget(rendered);
  const shell = shellFrames();
  const shellPng = (pre: string): number => shell.filter((f) => f.key.startsWith(pre)).reduce((a, f) => a + encodeIndexedPng(f.w, f.h, f.img, PALETTE).length, 0);
  const shellBytes = { skyWalls: shellPng("wall/"), splitFloors: shellPng("floor/"), nearStubs: shellPng("stub/") };
  console.log(`c2062 shell (single PNGs, unpacked): ${JSON.stringify(shellBytes)}`);
  const turnedKeys = [...turnedShipped];
  const turnedPng = turnedKeys.reduce((a, k) => { const f = all.get(k); return a + (f ? encodeIndexedPng(f.w, f.h, f.img, PALETTE).length : 0); }, 0);
  console.log(`c2062 turned shipped pieces: ${turnedKeys.join(", ")} ≈ ${String(turnedPng)} B (single PNGs; packed is less)`);
  writeFileSync(join(ROOT, "preview", "c2062-budget.json"), JSON.stringify({ pieces: table, shellUnpacked: shellBytes, turnedShipped: { keys: turnedKeys, pngBytesUnpacked: turnedPng }, reusedLoops: REUSED_LOOPS }, null, 1) + "\n");
  for (const [k, v] of Object.entries(table)) console.log(`c2062 ${k}: ${String(v.frames)} frames, ${String(v.png)} B png + ${String(v.json)} B gz json`);
  console.log(`c2062: strip rows ${ids.join(", ")}`);
}
