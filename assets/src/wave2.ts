// Wave 2 asset set (OME-2066, from the OME-2062 concepts the board passed; ADR 0058): screens without the TV table, ambient loops
// for the five older presets, and the two partitioned swap rooms (penthouse, studio). Same 67-colour palette, the same Kit / iso
// ray-caster, plum outline and top-left light as every shipped piece. Ships two lazy sheets:
//   furniture/furniture-v8.{png,json}       the new pieces, their loops and back views (tray: the se frame scaled by the web)
//   furniture/furniture-v8-shell.{png,json} the swap rooms' shell skin (sky walls, split floors) and the near-wall stubs
// plus 3 turned shipped pieces in furniture-back (BACK_VIEWS). Previews: preview/w2-*, proposed layouts: preview/w2-layouts/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Furniture, RoomLayout } from "@omega/shared";
import { Kit, PIECES, TURN, pieceFrames, type Canvas, type FurnDir, type PieceMeta } from "./furniture";
import { addOutline, box, renderSolids } from "./iso";
import { PALETTE, colorIndex, type RampName, type Tone } from "./palette";
import { encodeIndexedApng, encodeIndexedPng } from "./png";
import { PRESETS } from "./presets";
import { WALL_H, carpetTile, deckTile, floorTile, panelPaint, planks, solidsFrame, type RoomFrame } from "./room";
import { upscale } from "./sprite";
import type { FurnSprites, Placement, RoomPlan } from "./build";

type Paint = readonly [RampName, Tone];
type Shell = NonNullable<RoomPlan["shell"]>;
export interface Wave2Deps {
  pieces: readonly PieceMeta[];
  all: FurnSprites;
  compose: (pieces: readonly PieceMeta[], all: FurnSprites, plan: RoomPlan) => { img: Uint8Array; W: number; H: number };
  northView: (pieces: readonly PieceMeta[], all: FurnSprites, south: RoomPlan, shell: Shell) => { pieces: PieceMeta[]; plan: RoomPlan };
  presetPlan: (layout: RoomLayout) => RoomPlan;
}

const ROOT = join(import.meta.dir, "..");
const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const hash = (a: number, b: number): number => {
  let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};
const ALL: readonly FurnDir[] = ["ne", "nw", "se", "sw"];
const CV: Canvas = { w: 480, h: 400, ax: 220, ay: 300 };
/** se/nw hang on (or back onto) the left wall, whose segments run along +row (v); sw/ne on the right wall, along +col (u). */
const swaps = (d: FurnDir): boolean => d === "nw" || d === "se";

// ------------------------------------------------------------------ pieces

interface Spot { x: number; y: number; z: number }
interface W2 {
  id: string;
  colour: string;
  /** The contract variant: the colour's index in its kind (new kinds count from 0; colours of older kinds go after theirs). */
  variant: number;
  label: string;
  kind: PieceMeta["kind"];
  wall?: true;
  dirs: readonly FurnDir[];
  cols: number;
  rows: number;
  /** Wall segments covered from the anchor toward +row / +col (ADR 0058 `wallSpan`). */
  span?: number;
  /** Ambient loop: frames (frame 0 = the still) and frame time. */
  loop?: { frames: number; ms: number };
  /** Ships its 180° turn (`<nw|ne>/back`) for the swapped view. */
  back?: true;
  build: (k: Kit, n: number) => void;
  /** Steam wisps rising from these local points, drawn after the outline so they stay soft. */
  steam?: readonly Spot[];
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

/** Wall panel: 56 × 36 px on the wall, a 2-unit slab on a bracket, a soundbar under it. Its back (seen only swapped): matte
 *  housing, a raised VESA plate, vent slots. */
const WS = { X: 14, Z0: 80, Z1: 116 } as const;
function wallScreen(k: Kit): void {
  const { X, Z0, Z1 } = WS;
  k.box(-X, X, 5.6, 7.4, Z0, Z1, "charcoal", {
    paint: (p, f) => {
      if (f === "top") return ["charcoal", 0];
      if (f === "back") return Math.abs(p.x) < 5 && Math.abs(p.z - (Z0 + Z1) / 2) < 7 ? ["charcoal", 2] : Math.abs(p.x) > 7 && Math.abs(p.x) < 11 && Math.floor(p.z) % 3 === 0 ? ["charcoal", 2] : ["charcoal", 1];
      if (f !== "front") return ["charcoal", 2];
      if (Math.abs(p.x) > X - 1 || p.z < Z0 + 1.6 || p.z > Z1 - 1.2) return Math.abs(p.x - X + 3) < 0.6 && p.z < Z0 + 1.2 ? ["mustard", 0] : ["charcoal", 2];
      // The picture: a dusk scene (decorative; the real player is page chrome, ADR 0012), a soft glint top-left.
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
  k.box(-3, 3, 7.4, 8, Z0 + 10, Z1 - 10, "charcoal", { tones: { top: 1, sw: 2, se: 2 } });
  k.box(-10, 10, 6.2, 8, Z0 - 7, Z0 - 3, "charcoal", { paint: (p, f) => (f === "front" ? (Math.floor(p.x * 1.5) % 2 === 0 ? ["charcoal", 2] : ["charcoal", 1]) : f === "top" ? ["charcoal", 0] : null) });
}

/** Tripod projector: three splayed legs, a column, a wood tray, a cream body with vents and a teal status light, the lens out front. */
const PJ = { lensY: -4.6, Zb: 38 } as const;
function tripod(k: Kit): void {
  const Zb = PJ.Zb;
  for (const [lx, ly] of [[-5, 3], [5, 3], [0, -5]] as const) {
    for (let s = 0; s < 4; s++) { const t = s / 4; k.box(lx * (1 - t) - 0.6, lx * (1 - t) + 0.6, ly * (1 - t) - 0.6, ly * (1 - t) + 0.6, s * 7, s * 7 + 7, "charcoal", { tones: { top: 0, sw: 1, se: 2 } }); }
  }
  k.box(-0.8, 0.8, -0.8, 0.8, 28, Zb - 2, "charcoal", { tones: { top: 0, sw: 1, se: 2 } });
  k.box(-4, 4, -3.5, 4, Zb - 2, Zb, "wood", { tones: { top: 0, sw: 1, se: 2 } });
  k.box(-4.5, 4.5, -3.5, 4, Zb, Zb + 5, "cream", {
    paint: (p, f) => (f === "top" ? (Math.abs(p.x - 2.5) < 1 && Math.abs(p.y) < 1 ? ["teal", 0] : ["cream", 0]) : (f === "left" || f === "right") && Math.floor(p.y * 1.4) % 2 === 0 && p.z > Zb + 1.5 && p.z < Zb + 4 ? ["charcoal", 1] : null),
  });
  k.ell({ x: -1.5, y: 0, z: Zb + 2.5 }, { x: 1.7, y: Infinity, z: 1.7 }, [-99, 99, PJ.lensY, -3.5, Zb, Zb + 5], "charcoal", {
    paint: (p, f) => (f === "front" ? (Math.hypot(p.x + 1.5, p.z - Zb - 2.5) < 0.9 ? ["glow", 0] : ["navy", 1]) : null),
  });
}

/** Pull-down screen: a black-bordered cloth lit with the picture (washed to the glow ramp), a pull tab, the charcoal case. */
const RS = { X: 15, Z0: 70, Z1: 150 } as const;
function rollScreen(k: Kit): void {
  const { X, Z0, Z1 } = RS;
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
  k.ell({ x: 0, y: 6, z: Z1 + 2.5 }, { x: Infinity, y: 2, z: 2.5 }, [-X - 0.5, X + 0.5, 3, 8, Z1, Z1 + 5], "charcoal");
  for (const s of [-1, 1]) k.box(s * (X + 0.5) - 0.8, s * (X + 0.5) + 0.8, 4, 8, Z1 - 0.5, Z1 + 5.5, "charcoal", { tones: { top: 0, sw: 1, se: 2 } });
}

/** Window with a sill and a little pot. `sky`: dusk clouds drift past, a star blinks. `rain`: streaks and drops slide down. */
function wallWindow(k: Kit, colour: "sky" | "rain", n: number): void {
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
        if (Math.hypot((x + 3) * 1.3, t - 12) < 2) return ["mustard", 1]; // a wet street lamp far off
        return ["navy", t < 14 ? 1 : 2];
      }
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

/** Lava lamp: a brass foot, a tapered glass of navy, two pink blobs rising and sinking, a brass cap. */
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

const BARCOUNTER = PIECES.find((p) => p.id === "barcounter");
const SIDETABLE = PIECES.find((p) => p.id === "sidetable");
/** Espresso bar: the bar counter, a rust machine with a brass head and gauge, two cups steaming. */
function espressoBar(k: Kit): void {
  BARCOUNTER?.build?.(k, "wood", 0);
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
  for (const x of [9.5, 17.5]) {
    k.box(x - 1.5, x + 1.5, -1.5, 0, H + 7, H + 9, "mustard", { tones: { top: 0, sw: 1, se: 2 } });
    k.box(x - 0.5, x + 0.5, -4, -1.5, H + 7, H + 8, "charcoal", { tones: { top: 0, sw: 1, se: 2 } });
    k.ell({ x, y: -0.8, z: 0 }, { x: 1.2, y: 1.2, z: Infinity }, [-99, 99, -99, 99, H + 3, H + 5.5], "cream");
  }
}

/** Jukebox: a wood case with an arched top, light tubes chasing round the arch, a record window and a chrome grille. */
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

/** Kitchenette (2×1, backs onto a wall): cream cabinets, a wood worktop with a sink and a two-ring hob, a teal pot steaming, a
 *  rail of utensils on the wall behind. */
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

/** Long-case clock (backs onto a wall): a wood case with a crown, a cream dial, a glass door over a brass pendulum swinging. */
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

const SE_SW: readonly FurnDir[] = ["se", "sw"];
/** Every wave-2 piece and colour. New kinds: wallscreen, projector, tripod, window, longclock, lavalamp. Colours of older kinds
 *  (variant = index after the kind's shipped colours): sidetable/mug, barcounter/espresso + kitchen, speaker/jukebox. */
export const WAVE2: readonly W2[] = [
  { id: "wallscreen", colour: "panel", variant: 0, label: "Wall screen", kind: "fun", wall: true, dirs: SE_SW, cols: 0, rows: 0, span: 2, back: true, build: (k) => { wallScreen(k); } },
  { id: "projector", colour: "cloth", variant: 0, label: "Pull-down screen", kind: "fun", wall: true, dirs: SE_SW, cols: 0, rows: 0, span: 3, back: true, build: (k) => { rollScreen(k); } },
  { id: "tripod", colour: "charcoal", variant: 0, label: "Projector on a tripod", kind: "fun", dirs: ALL, cols: 1, rows: 1, build: (k) => { tripod(k); } },
  { id: "window", colour: "sky", variant: 0, label: "Window, dusk", kind: "wall", wall: true, dirs: SE_SW, cols: 0, rows: 0, loop: { frames: 4, ms: 260 }, build: (k, n) => { wallWindow(k, "sky", n); } },
  { id: "window", colour: "rain", variant: 1, label: "Window, rain", kind: "wall", wall: true, dirs: SE_SW, cols: 0, rows: 0, loop: { frames: 4, ms: 260 }, build: (k, n) => { wallWindow(k, "rain", n); } },
  { id: "longclock", colour: "wood", variant: 0, label: "Long-case clock", kind: "fun", dirs: SE_SW, cols: 1, rows: 1, loop: { frames: 4, ms: 250 }, build: (k, n) => { longClock(k, n); } },
  { id: "lavalamp", colour: "lilac", variant: 0, label: "Lava lamp", kind: "light", dirs: ["se"], cols: 1, rows: 1, loop: { frames: 4, ms: 320 }, build: (k, n) => { lavaLamp(k, n); } },
  { id: "sidetable", colour: "mug", variant: 1, label: "Snack table, steaming mug", kind: "table", dirs: SE_SW, cols: 1, rows: 1, loop: { frames: 4, ms: 180 }, build: (k) => { SIDETABLE?.build?.(k, "wood", 0); }, steam: [{ x: 2.6, y: -1.8, z: 19 }] },
  { id: "barcounter", colour: "espresso", variant: 1, label: "Espresso bar", kind: "table", dirs: SE_SW, cols: 2, rows: 1, loop: { frames: 4, ms: 160 }, build: (k) => { espressoBar(k); }, steam: [{ x: 9.5, y: -0.8, z: 37 }, { x: 17.5, y: -0.8, z: 50 }] },
  { id: "barcounter", colour: "kitchen", variant: 2, label: "Kitchenette", kind: "table", dirs: SE_SW, cols: 2, rows: 1, loop: { frames: 4, ms: 160 }, back: true, build: (k) => { kitchenette(k); }, steam: [{ x: 14, y: 2, z: 33 }] },
  { id: "speaker", colour: "jukebox", variant: 2, label: "Jukebox", kind: "fun", dirs: SE_SW, cols: 1, rows: 1, loop: { frames: 4, ms: 150 }, back: true, build: (k, n) => { jukebox(k, n); } },
];
/** `<id>/<colour>` → contract variant, for the colours of older kinds (the web's V7_COLOURS pattern). */
export const V8_COLOURS: Readonly<Record<string, number>> = Object.fromEntries(WAVE2.filter((d) => PIECES.some((p) => p.id === d.id)).map((d) => [`${d.id}/${d.colour}`, d.variant]));
/** Shipped pieces whose existing "in use" loop runs as ambience in the revamps (0 new bytes). */
const REUSED_LOOPS: Readonly<Record<string, { frames: number; ms: number }>> = { fireplace: { frames: 4, ms: 120 }, neonsign: { frames: 3, ms: 140 }, aquarium: { frames: 3, ms: 220 } };

/** One frame of `def` on canvas `cv` at scale `s`: loop frame `n`, turned 180° about its anchor for the swapped view. Object pieces
 *  sit on their footprint like pieceFrames does; a wall piece is moved 8 × (span − 1) units along its wall so it hangs centred
 *  on the segments it covers (its anchor stays the anchor segment). */
function render(def: W2, dir: FurnDir, n: number, turned: boolean, s = 1, cv: Canvas = CV): Uint8Array {
  const k = new Kit(dir, turned);
  def.build(k, n);
  let du = 0, dv = 0;
  if (!def.wall && (turned || def.rows > 1)) {
    const fp = swaps(dir) ? { c: def.rows, r: def.cols } : { c: def.cols, r: def.rows };
    const mid = k.world(8 * (def.cols - 1), 8 * (def.rows - 1));
    du = 8 * (fp.c - 1) - mid.u; dv = 8 * (fp.r - 1) - mid.v;
  }
  if (def.span && s === 1) { const d = 8 * (def.span - 1); if (swaps(dir)) dv += d; else du += d; }
  const AX = cv.ax + s * 2 * (du - dv), AY = cv.ay + s * (du + dv);
  const img = renderSolids(k.parts.map((p) => p.solid), cv.w, cv.h, AX, AY, "none", s).img;
  addOutline(img, cv.w, cv.h);
  if (s === 1) {
    for (const sp of def.steam ?? []) {
      const p = k.world(sp.x, sp.y);
      steam(img, cv.w, AX + 2 * (p.u - p.v), AY + p.u + p.v - sp.z, n);
    }
  }
  return img;
}

/** All frames of one piece colour in one facing, cut to one rect (the union of its loop frames), so they share one anchor. */
function frames(def: W2, dir: FurnDir, turned: boolean): RoomFrame[] {
  const count = turned ? 1 : def.loop?.frames ?? 1;
  const imgs = Array.from({ length: count }, (_, n) => render(def, dir, n, turned));
  let x0: number = CV.w, y0: number = CV.h, x1 = -1, y1 = -1;
  for (const img of imgs) img.forEach((v, i) => { if (!v) return; const x = i % CV.w, y = Math.floor(i / CV.w); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
  if (x1 < 0 || x0 === 0 || y0 === 0 || x1 === CV.w - 1 || y1 === CV.h - 1) throw new Error(`${def.id}/${def.colour}/${dir}: empty or touches the canvas edge`);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const cut = (img: Uint8Array | undefined): Uint8Array => { const o = new Uint8Array(w * h); for (let y = 0; y < h; y++) o.set((img ?? new Uint8Array(CV.w * CV.h)).subarray((y0 + y) * CV.w + x0, (y0 + y) * CV.w + x0 + w), y * w); return o; };
  const at = { w, h, ax: CV.ax - x0, ay: CV.ay - y0 };
  const base = `furniture/${def.id}/${def.colour}`;
  const out: RoomFrame[] = [{ key: `${base}/${turned ? TURN[dir] : dir}/back`, img: cut(imgs[0]), ...at }];
  if (def.loop && !turned) imgs.forEach((img, n) => out.push({ key: `${base}/use/${dir}/${String(n)}`, img: cut(img), ...at }));
  return out;
}

/** The v8 sheet's `meta.omega.pieces`: one row per id, listing only its v8 colours (as v7 does for older kinds). */
function metas(): PieceMeta[] {
  const out: PieceMeta[] = [];
  for (const def of WAVE2) {
    const have = out.find((m) => m.id === def.id);
    if (have) { have.colours.push(def.colour); continue; }
    const footprintByDir: PieceMeta["footprintByDir"] = {}, sortByDir: PieceMeta["sortByDir"] = {}, layersByDir: PieceMeta["layersByDir"] = {};
    for (const d of def.dirs) {
      const fp = def.wall ? { cols: 0, rows: 0 } : swaps(d) ? { cols: def.rows, rows: def.cols } : { cols: def.cols, rows: def.rows };
      footprintByDir[d] = fp;
      const dc = Math.max(fp.cols - 1, 0) / 2, dr = Math.max(fp.rows - 1, 0) / 2;
      sortByDir[d] = { x: (dc - dr) * 32, y: (dc + dr) * 16 };
      layersByDir[d] = ["back"];
    }
    const m: PieceMeta = {
      id: def.id, label: def.label, kind: def.kind, mount: def.wall ? "wall" : "floor", layer: def.wall ? "wall" : "object", colours: [def.colour], dirs: [...def.dirs],
      footprint: { cols: def.cols, rows: def.rows }, footprintByDir, sortByDir, walkable: def.wall === true, layersByDir,
    };
    if (def.loop) { m.use = { ...def.loop }; m.ambient = true; }
    if (def.span) m.wallSpan = def.span;
    out.push(m);
  }
  return out;
}

const TURNED_SHIPPED: readonly string[] = ["aquarium/teal", "bookshelf/wood"];

export function buildWave2Pieces(): { frames: RoomFrame[]; pieces: PieceMeta[] } {
  const out: RoomFrame[] = [];
  for (const def of WAVE2) {
    for (const dir of def.dirs) out.push(...frames(def, dir, false));
    if (def.back) for (const dir of def.dirs) out.push(...frames(def, dir, true));
  }
  // One-sided shipped pieces in the swap-room proposals, turned (furniture-back is at its 12 KB allowance; both rooms load v8).
  for (const key of TURNED_SHIPPED) {
    const [id = "", colour = ""] = key.split("/");
    const def = PIECES.find((p) => p.id === id);
    if (!def) throw new Error(`no piece ${id}`);
    for (const dir of SE_SW) out.push(...pieceFrames(def, colour, dir, true));
  }
  return { frames: out, pieces: metas() };
}

// ------------------------------------------------------------------ shell skin (sky terrace, split floors, near-wall stubs)

const WALL_T = 4;
export const SKY_N = 2;
const sky = (side: "l" | "r", i: number): string => `wall/${side}/sky/${String(i % SKY_N)}`;
/** Penthouse terrace "wall", open air: a glass balustrade with a brass rail, a skyline with lit windows, a dusk sky with stars,
 *  under a slim steel pergola beam. `s` runs along the whole wall, so the skyline never repeats within a variant. */
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
const rightWall = (key: string, i: number): RoomFrame =>
  solidsFrame(key, [box(-8, 8, -8 - WALL_T, -8, 0, WALL_H, "wall", { skip: ["se", "other"], paint: (p, f) => (f === "top" ? topOf("sky") : f === "sw" ? skinPaint("sky", p.u + 16 * i + 300, p.z, true) : null) })], "top");
const split = (name: string, back: (n: number) => (u: number, v: number) => Paint, front: (n: number) => (u: number, v: number) => Paint): RoomFrame[] =>
  [0, 1].map((n) => { const b = back(n), f = front(n); return floorTile(`floor/${name}/${String(n)}`, (u, v) => (v < 0 ? b(u, v) : f(u, v))); });

/** The near-wall stub's paint: the partition's 16 px cut stub (OME-1959), wood with a charcoal skirting. */
const stubPaint = (p: { z: number }, f: string): Paint => (f === "top" ? ["wood", 0] : p.z < 3 ? ["charcoal", 2] : ["wood", f === "sw" ? 1 : 2]);

export function buildWave2Shell(): RoomFrame[] {
  const out: RoomFrame[] = [
    solidsFrame("wall/corner/sky", [box(-8 - WALL_T, -8, -8 - WALL_T, -8, 0, WALL_H, "charcoal", { tones: { top: 0, sw: 1, se: 2 } })], "top"),
    solidsFrame("wall/l/end/sky", [box(-8 - WALL_T, -8, 7, 8, 0, WALL_H, "charcoal", { skip: ["se", "other"], tones: { top: 0, sw: 1, se: 2 } })], "all", (x) => x < -32),
    solidsFrame("wall/r/end/sky", [box(7, 8, -8 - WALL_T, -8, 0, WALL_H, "charcoal", { skip: ["sw", "other"], tones: { top: 0, sw: 1, se: 2 } })], "all", (x) => x >= 32),
  ];
  // shortcut: SKY_N skyline variants per side, a SKY_N-cell period; raise SKY_N if a long sky wall shows the repeat.
  for (let i = 0; i < SKY_N; i++) out.push(leftWall(`wall/l/sky/${String(i)}`, i, () => "sky"), rightWall(`wall/r/sky/${String(i)}`, i));
  out.push(leftWall("wall/l/sky/split", 1, (v) => (v < 0 ? "sky" : "smoke")), leftWall("wall/l/sky/split/north", 2, (v) => (v < 0 ? "smoke" : "sky")));
  // Swapped view: the near walls drawn as the stub, one segment each, along the +u edge (col 9) and the +v edge (row 9).
  out.push(solidsFrame("wall/stub/u", [box(8, 8 + WALL_T, -8, 8, 0, 16, "wood", { paint: stubPaint })], "top"));
  out.push(solidsFrame("wall/stub/v", [box(-8, 8, 8, 8 + WALL_T, 0, 16, "wood", { paint: stubPaint })], "top"));
  out.push(...split("pent", deckTile, planks), ...split("pent/north", planks, deckTile), ...split("nook", carpetTile, planks), ...split("nook/north", planks, carpetTile));
  return out;
}

// ------------------------------------------------------------------ proposed layouts (contract-shaped; new kinds need the contract issue)

interface Item { kind: string; col: number; row: number; facing: FurnDir; variant?: number | undefined }
interface Proposal { id: string; name: string; blurb: string; layout: { mood?: RoomLayout["mood"]; shell?: string; furniture: Item[] } }
const it = (kind: string, col: number, row: number, facing: FurnDir, variant = 0): Item => (variant === 0 ? { kind, col, row, facing } : { kind, col, row, facing, variant });
const ROW = 4, DOOR = 1;
/** The interior wall on row ROW, a doorway at col DOOR (OME-1959's grid). */
const partitionRow = (variant: (col: number) => number): Item[] => Array.from({ length: 10 }, (_, col) => col).filter((col) => col !== DOOR).map((col) => it("partition", col, ROW, "sw", variant(col)));

/** A revamp of a shipped preset: its layout without the corner console (and `drop`), plus `add`. */
function revamp(id: string, drop: readonly (readonly [string, number, number])[], add: readonly Item[]): Proposal {
  const pr = PRESETS.find((p) => p.id === id);
  if (!pr) throw new Error(`no preset ${id}`);
  const kept = pr.layout.furniture.filter((f) => f.kind !== "tv" && !drop.some(([k, col, row]) => f.kind === k && f.col === col && f.row === row));
  return { id, name: pr.name, blurb: pr.blurb, layout: { ...(pr.layout.mood ? { mood: pr.layout.mood } : {}), furniture: [...kept.map((f) => ({ ...f })), ...add] } };
}

export const PROPOSALS: readonly Proposal[] = [
  revamp("classic", [], [it("wallscreen", 0, 2, "se"), it("window", 3, 0, "sw"), it("longclock", 7, 0, "sw")]),
  revamp("living", [["sidetable", 4, 6], ["sidetable", 6, 4]], [it("fireplace", 0, 0, "sw"), it("wallscreen", 0, 0, "sw"), it("sidetable", 4, 6, "se", 1), it("sidetable", 6, 4, "sw", 1)]),
  // The pull-down screen covers segments 2–4 (not 3–5: 5 is a window segment); the print moves down to 7.
  revamp("lounge", [["frame", 0, 2], ["arclamp", 1, 8], ["arclamp", 8, 1]], [it("projector", 0, 2, "se"), it("tripod", 6, 6, "nw"), it("frame", 0, 7, "se"), it("lavalamp", 1, 6, "se"), it("lavalamp", 6, 1, "se")]),
  revamp("cafe", [["bookshelf", 2, 0]], [it("barcounter", 2, 0, "sw", 1), it("window", 7, 0, "sw", 1), it("window", 0, 7, "se", 1), it("wallscreen", 0, 1, "se")]),
  revamp("bar", [], [it("speaker", 0, 5, "se", 2), it("wallscreen", 3, 0, "sw")]),
  {
    id: "penthouse",
    name: "Penthouse",
    blurb: "A lounge with a rooftop terrace behind the glass.",
    layout: {
      shell: "penthouse",
      furniture: [
        // Terrace (rows 0–3): loungers, string lights on the open-air rail, plants.
        it("lounger", 6, 0, "se"), it("lounger", 6, 2, "se"),
        it("monstera", 0, 0, "se"), it("monstera", 9, 3, "sw", 1),
        it("garland", 3, 0, "sw"), it("garland", 7, 0, "sw"), it("garland", 0, 2, "se"),
        ...partitionRow((col) => (col === 0 ? 2 : 3)),
        // Lounge (rows 5–9): smoked panelling, the sofa and couch facing the wall screen, the aquarium, a bar fridge under the neon.
        it("aquarium", 0, 5, "se"), it("wallscreen", 0, 7, "se"), it("minibar", 0, 9, "se", 1), it("neonsign", 0, 9, "se"),
        it("sofa", 4, 6, "nw"), it("couch", 6, 6, "nw"), it("coffeetable", 2, 7, "sw"), it("arclamp", 8, 8, "se"), it("monstera", 9, 8, "sw", 1),
      ],
    },
  },
  {
    id: "studio",
    name: "Studio flat",
    blurb: "Kitchen and couch in front, a sleeping nook behind.",
    layout: {
      shell: "studio",
      furniture: [
        // Nook (rows 0–3): the queen bed, a steaming mug, a rainy window, the cat, a bookcase.
        it("bed", 4, 1, "nw"), it("sidetable", 6, 1, "sw", 1), it("bookshelf", 0, 1, "se"), it("window", 7, 0, "sw", 1), it("cat", 2, 2, "se"), it("arclamp", 8, 1, "sw"),
        ...partitionRow((col) => (col >= 3 && col <= 7 ? 1 : 0)),
        // Kitchen-living room (rows 5–9).
        it("barcounter", 0, 5, "se", 2), it("minibar", 0, 7, "se", 1), it("sidetable", 3, 6, "se"), it("stool", 3, 7, "ne", 1), it("stool", 4, 6, "nw"),
        it("couch", 5, 7, "nw", 1), it("wallscreen", 0, 8, "se"), it("beanbag", 7, 8, "nw", 1), it("monstera", 9, 6, "sw"),
      ],
    },
  },
];

// ------------------------------------------------------------------ previews

const W2_IDS = new Set(WAVE2.filter((d) => !PIECES.some((p) => p.id === d.id)).map((d) => d.id));
const w2Of = (f: Item): W2 | undefined => WAVE2.find((d) => d.id === f.kind && d.variant === (f.variant ?? 0));
/** A proposal as a preview plan: shipped kinds through presetPlan (seats, sitters), wave-2 kinds and colours placed directly. */
function planOf(d: Wave2Deps, p: Proposal): RoomPlan {
  const known = p.layout.furniture.filter((f) => !W2_IDS.has(f.kind) && !w2Of(f));
  const plan = d.presetPlan({ furniture: known as Furniture[] });
  plan.tv = false;
  for (const f of p.layout.furniture) {
    const def = w2Of(f);
    if (def) plan.placements.push({ id: def.id, colour: def.colour, dir: f.facing, col: f.col, row: f.row });
  }
  return plan;
}

const plank = (c0: number, r: number): string => `floor/${String((c0 * 3 + r) % 2)}`;
const N = 9 - ROW;
const SHELLS: Readonly<Record<string, { south: Shell; north: Shell }>> = {
  penthouse: {
    south: {
      floor: (c0, r) => (r < ROW ? `floor/deck/${String((c0 * 3 + r) % 2)}` : r === ROW ? `floor/pent/${String((c0 * 3 + r) % 2)}` : plank(c0, r)),
      l: (i) => (i < ROW ? sky("l", i) : i === ROW ? "wall/l/sky/split" : "wall/l/smoke"),
      r: (i) => sky("r", i), corner: "wall/corner/sky", lEnd: "wall/l/end/smoke", rEnd: "wall/r/end/sky",
    },
    north: {
      floor: (c0, r) => (r < N ? plank(c0, r) : r === N ? `floor/pent/north/${String((c0 * 3 + r) % 2)}` : `floor/deck/${String((c0 * 3 + r) % 2)}`),
      l: (i) => (i < N ? "wall/l/smoke" : i === N ? "wall/l/sky/split/north" : sky("l", i)),
      r: () => "wall/r/smoke", corner: "wall/corner/smoke", lEnd: "wall/l/end/sky", rEnd: "wall/r/end/smoke",
    },
  },
  studio: {
    south: {
      floor: (c0, r) => (r < ROW ? `floor/carpet/${String((c0 * 3 + r) % 2)}` : r === ROW ? `floor/nook/${String((c0 * 3 + r) % 2)}` : plank(c0, r)),
      l: (i) => `wall/l/${i === 1 ? "window0" : i === 2 ? "window1" : "plain"}`,
      r: (i) => `wall/r/${i === 9 ? "sconce" : "plain"}`, corner: "wall/corner", lEnd: "wall/l/end", rEnd: "wall/r/end",
    },
    north: {
      floor: (c0, r) => (r < N ? plank(c0, r) : r === N ? `floor/nook/north/${String((c0 * 3 + r) % 2)}` : `floor/carpet/${String((c0 * 3 + r) % 2)}`),
      l: (i) => `wall/l/${i === 7 ? "sconce" : "plain"}`,
      r: (i) => `wall/r/${i === 2 ? "poster1" : "plain"}`, corner: "wall/corner", lEnd: "wall/l/end", rEnd: "wall/r/end",
    },
  },
};

const cellAt = (c0: number, r: number): { x: number; y: number } => ({ x: 480 + (c0 - r) * 32, y: 220 + (c0 + r + 1) * 16 });
const screenXY = (u: number, v: number, z: number): { x: number; y: number } => ({ x: 480 + 2 * (u - v), y: 236 + u + v - z });

/** The projector's light: a sparse dither of the glow highlight from the lens to the cloth's four corners (not over the cloth),
 *  only where `bare` (the room without its standing pieces and avatars) shows, so it starts at the lens and passes behind seats and
 *  sitters. The web draws it once as a cached Graphics under the object layer, never per frame. */
function beam(img: Uint8Array, bare: Uint8Array, W: number, H: number, pj: Placement, screen: { col: number; row: number; dir: FurnDir }): void {
  const k = new Kit(pj.dir);
  const lw = k.world(-1.5, PJ.lensY - 0.5);
  const lens = screenXY(16 * pj.col + lw.u, 16 * pj.row + lw.v, PJ.Zb + 2.5);
  const su = 16 * screen.col, sv = 16 * screen.row, mid = 16; // the cloth's centre: 8 × (span 3 − 1) along its wall
  const corner = (x: number, z: number): { x: number; y: number } =>
    screen.dir === "se" ? screenXY(su - 7, sv + mid + x, z) : screen.dir === "sw" ? screenXY(su + mid + x, sv - 7, z) : screen.dir === "nw" ? screenXY(su + 7, sv + mid + x, z) : screenXY(su + mid + x, sv + 7, z);
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
    if ((x + 2 * y) % 4 !== 0 || img[y * W + x] !== bare[y * W + x] || !inside(hull, x + 0.5, y + 0.5) || inside(quad, x + 0.5, y + 0.5)) continue;
    img[y * W + x] = c("glow", 0);
  }
}
function beamFor(d: Wave2Deps, pieces: readonly PieceMeta[], plan: RoomPlan): ((img: Uint8Array, W: number, H: number) => void) | undefined {
  const pj = plan.placements.find((p) => p.id === "tripod"), sc = plan.placements.find((p) => p.id === "projector");
  if (!pj || !sc) return undefined;
  const flat = (p: Placement): boolean => pieces.find((m) => m.id === p.id)?.layer !== "object"; // rugs and wall pieces take the light
  const bare = d.compose(pieces, d.all, { ...plan, placements: plan.placements.filter(flat), standing: [] }).img;
  return (img, W, H) => { beam(img, bare, W, H, pj, sc); };
}

function blit(img: Uint8Array, W: number, H: number, all: FurnSprites, key: string, c0: number, r: number, ghost = false): void {
  const f = all.get(key);
  if (!f) throw new Error(`missing ${key}`);
  const a = cellAt(c0, r), ox = a.x - f.ax, oy = a.y - f.ay;
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    const v = f.img[y * f.w + x] ?? 0, px = ox + x, py = oy + y;
    if (v && px >= 0 && py >= 0 && px < W && py < H && (!ghost || (px + py) % 2 === 0)) img[py * W + px] = v;
  }
}
/** Swapped view: the near walls as their stub, a screen on them as its back, ghosted at its turned anchor (no wall patch behind
 *  it: a solid patch hid the sitters in front of it, OME-2078). */
function nearWalls(img: Uint8Array, W: number, H: number, all: FurnSprites, screens: readonly Placement[]): void {
  for (let i = 0; i < 10; i++) { blit(img, W, H, all, "wall/stub/v", i, 9); blit(img, W, H, all, "wall/stub/u", 9, i); }
  for (const s of screens) {
    const span = WAVE2.find((d) => d.id === s.id)?.span ?? 1;
    const se = s.dir === "se";
    const col = se ? 9 : 9 - s.col - (span - 1), row = se ? 9 - s.row - (span - 1) : 9;
    blit(img, W, H, all, `furniture/${s.id}/${s.colour}/${TURN[s.dir]}/back`, col, row, true);
  }
}

function write(name: string, r: { img: Uint8Array; W: number; H: number }): void {
  writeFileSync(join(ROOT, "preview", `${name}@1x.png`), encodeIndexedPng(r.W, r.H, r.img, PALETTE));
  writeFileSync(join(ROOT, "preview", `${name}@2x.png`), encodeIndexedPng(r.W * 2, r.H * 2, upscale(r.img, r.W, r.H, 2), PALETTE));
}

/** The room animated: every ambient loop on its own clock, 10 ticks of 100 ms, cropped to the room. */
const CROP = { x: 140, y: 0, w: 680, h: 552 } as const;
function animate(name: string, d: Wave2Deps, pieces: readonly PieceMeta[], plan: RoomPlan, after?: (img: Uint8Array, W: number, H: number) => void): void {
  const loopOf = (p: Placement): { frames: number; ms: number } | undefined => REUSED_LOOPS[p.id] ?? WAVE2.find((x) => x.id === p.id && x.colour === p.colour)?.loop;
  const out: Uint8Array[] = [];
  for (let t = 0; t < 10; t++) {
    const placements = plan.placements.map((p): Placement => { const l = loopOf(p); return l ? { ...p, use: Math.floor((t * 100) / l.ms) % l.frames } : p; });
    const r = d.compose(pieces, d.all, { ...plan, placements });
    after?.(r.img, r.W, r.H);
    const f = new Uint8Array(CROP.w * CROP.h);
    for (let y = 0; y < CROP.h; y++) f.set(r.img.subarray((CROP.y + y) * r.W + CROP.x, (CROP.y + y) * r.W + CROP.x + CROP.w), y * CROP.w);
    out.push(f);
  }
  const deltas = out.map((f, i) => { const prev = out[i - 1]; return prev ? f.map((v, j) => (v === prev[j] ? 0 : v)) : f; });
  writeFileSync(join(ROOT, "preview", `${name}@1x.apng`), encodeIndexedApng(CROP.w, CROP.h, deltas, out.map(() => 100), PALETTE, true));
}

/** Previews: the screens (south and swapped), every proposal (still + animated; the swap rooms from both sides), the ambient strip,
 *  and the proposed layout JSONs. `d.pieces` must already hold the v8 metas. */
export function buildWave2Previews(d: Wave2Deps): void {
  const { all, pieces } = d;
  const lay = join(ROOT, "preview", "w2-layouts");
  mkdirSync(lay, { recursive: true });
  for (const p of PROPOSALS) writeFileSync(join(lay, `${p.id}.json`), JSON.stringify(p, null, 1) + "\n");

  // 1: the screens in the classic room, south and swapped (classic has no partition: this is the swapped-view rule on its own).
  const classic = PROPOSALS.find((p) => p.id === "classic");
  if (!classic) throw new Error("no classic proposal");
  for (const kind of ["wallscreen", "projector"] as const) {
    const items = classic.layout.furniture.filter((f) => !["wallscreen", "window", "longclock"].includes(f.kind));
    const add = kind === "wallscreen" ? [it("wallscreen", 0, 3, "se")] : [it("projector", 0, 2, "se"), it("tripod", 4, 4, "nw")];
    const plan = planOf(d, { ...classic, layout: { furniture: [...items, ...add] } });
    const south = d.compose(pieces, all, plan);
    beamFor(d, pieces, plan)?.(south.img, south.W, south.H);
    write(`w2-screen-${kind}-south`, south);
    const walls = (side: "l" | "r") => (i: number) => `wall/${side}/${["plain", "plain", "plain", "plain", "plain", side === "l" ? "window0" : "poster0", side === "l" ? "window1" : "poster1", "plain", "sconce", "plain"][i] ?? "plain"}`;
    const nv = d.northView(pieces, all, plan, { floor: plank, l: walls("l"), r: walls("r"), corner: "wall/corner", lEnd: "wall/l/end", rEnd: "wall/r/end" });
    nv.plan.standing = plan.standing.map(([key, c0, r]): [string, number, number] => [key.replace(/\/(ne|nw|se|sw)\//, (_m, dd: FurnDir) => `/${TURN[dd]}/`), 9 - c0, 9 - r]);
    const north = d.compose(nv.pieces, all, nv.plan);
    nearWalls(north.img, north.W, north.H, all, plan.placements.filter((p) => p.id === kind));
    write(`w2-screen-${kind}-north`, north);
  }

  // 2: the five revamps, 3: the swap rooms (south everyone sees; north from behind the partition, the screen ghosted on the near wall).
  for (const p of PROPOSALS) {
    const plan = planOf(d, p);
    const sh = p.layout.shell ? SHELLS[p.layout.shell] : undefined;
    if (sh) plan.shell = sh.south;
    const after = beamFor(d, pieces, plan);
    const r = d.compose(pieces, all, plan);
    after?.(r.img, r.W, r.H);
    write(`w2-${p.id}${sh ? "-south" : ""}`, r);
    animate(`w2-${p.id}${sh ? "-south" : ""}`, d, pieces, plan, after);
    if (!sh) continue;
    const nv = d.northView(pieces, all, plan, sh.north);
    const north = d.compose(nv.pieces, all, nv.plan);
    nearWalls(north.img, north.W, north.H, all, plan.placements.filter((q) => q.id === "wallscreen" || q.id === "projector"));
    write(`w2-${p.id}-north`, north);
  }

  // Ambient strip at 4×: every loop frame of every v8 loop, one row per colour and facing.
  const rows = WAVE2.filter((x) => x.loop).flatMap((x) => x.dirs.map((dir) => ({ x, dir })));
  const colW = 96, rowH = 96, maxN = 4, SW = colW * maxN, SH = rowH * rows.length;
  const strip = new Uint8Array(SW * SH).fill(c("night", 2));
  rows.forEach(({ x, dir }, row) => {
    for (let n = 0; n < maxN; n++) {
      const f = all.get(`furniture/${x.id}/${x.colour}/use/${dir}/${String(n)}`);
      if (!f) continue;
      const ox = n * colW + Math.round(colW / 2 - f.ax), oy = row * rowH + Math.round((rowH - f.h) / 2);
      for (let y = 0; y < f.h; y++) for (let xx = 0; xx < f.w; xx++) {
        const v = f.img[y * f.w + xx] ?? 0, px = ox + xx, py = oy + y;
        if (v && px >= n * colW && px < (n + 1) * colW && py >= row * rowH && py < (row + 1) * rowH) strip[py * SW + px] = v;
      }
    }
  });
  writeFileSync(join(ROOT, "preview", "w2-ambient-strip@4x.png"), encodeIndexedPng(SW * 4, SH * 4, upscale(strip, SW, SH, 4), PALETTE));

  // Tray (OME-2096): no thumbs in v8; the web draws each piece's se frame at 1/n (n = trayScale, apps/web/src/editor/v8-thumbs.ts),
  // nearest-sampled, centred in the 44×40 cubby. @1x = --ui-px 1, @2x = --ui-px 2 (the browser's sampling, not an upscale of @1x).
  const tray = WAVE2.map((x) => all.get(`furniture/${x.id}/${x.colour}/${x.dirs.includes("se") ? "se" : (x.dirs[0] ?? "se")}/back`));
  for (const k of [1, 2]) {
    const CW = 44 * k, CH = 40 * k, G = 4 * k, TW = G + tray.length * (CW + G), TH = CH + 2 * G;
    const img = new Uint8Array(TW * TH).fill(c("night", 1));
    tray.forEach((f, i) => {
      const cx = G + i * (CW + G);
      for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) img[(G + y) * TW + cx + x] = y === CH - 1 || x === CW - 1 ? c("night", 0) : c("night", 2); // sunken well, lit lower edge
      if (!f) return;
      const n = Math.max(2, Math.ceil(f.w / 44), Math.ceil(f.h / 40));
      const w = Math.floor((f.w * k) / n), h = Math.floor((f.h * k) / n), ox = cx + Math.floor((CW - w) / 2), oy = G + Math.floor((CH - h) / 2);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = f.img[Math.floor(((y + 0.5) * n) / k) * f.w + Math.floor(((x + 0.5) * n) / k)] ?? 0;
        if (v) img[(oy + y) * TW + ox + x] = v;
      }
    });
    writeFileSync(join(ROOT, "preview", `w2-tray@${String(k)}x.png`), encodeIndexedPng(TW, TH, img, PALETTE));
  }
}
