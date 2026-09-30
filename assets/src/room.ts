// Set (b): room shell (floor, rug, walls), seats and the TV. Every frame is anchored at the
// floor point of the cell it belongs to (the tile centre), in 1× pixels.
import { SEAT_HEIGHT } from "./avatars";
import { addOutline, box, renderSolids, type Facing, type Solid, type Vec3 } from "./iso";
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import { render as renderRoles, type Grid, type RoleMap } from "./sprite";

export const TILE = { w: 64, h: 32 } as const;
/** Wall height above the floor, px. With the web's origin (back corner at y 220) the top sits at y 8. */
export const WALL_H = 212;
const WALL_T = 4;

export interface RoomFrame {
  key: string;
  w: number;
  h: number;
  img: Uint8Array;
  /** Anchor in pixels (floor point). */
  ax: number;
  ay: number;
}

type Paint = readonly [RampName, Tone];
const hash = (a: number, b: number): number => {
  let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};

/** Crop an image to its non-empty bbox; the anchor moves with it. */
function crop(key: string, img: Uint8Array, w: number, h: number, ax: number, ay: number): RoomFrame {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((img[y * w + x] ?? 0) === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error(`${key} is empty`);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) out.set(img.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + cw), y * cw);
  return { key, w: cw, h: ch, img: out, ax: ax - x0, ay: ay - y0 };
}

// ---------------------------------------------------------------- floor

/** Pixel (px,py) of a 64×32 tile → cell-local (u,v) on the floor; exact half-open partition. */
function tileUV(px: number, py: number): { u: number; v: number } | null {
  const sx = px + 0.5 - TILE.w / 2;
  const sy = py + 0.5 - TILE.h / 2;
  const u = (sy + sx / 2) / 2;
  const v = (sy - sx / 2) / 2;
  return u >= -8 && u < 8 && v >= -8 && v < 8 ? { u, v } : null;
}

function floorTile(key: string, paint: (u: number, v: number) => Paint): RoomFrame {
  const img = new Uint8Array(TILE.w * TILE.h);
  for (let py = 0; py < TILE.h; py++) {
    for (let px = 0; px < TILE.w; px++) {
      const uv = tileUV(px, py);
      if (!uv) continue;
      const [ramp, tone] = paint(uv.u, uv.v);
      img[py * TILE.w + px] = colorIndex(ramp, tone);
    }
  }
  return { key, w: TILE.w, h: TILE.h, img, ax: TILE.w / 2, ay: TILE.h / 2 };
}

/** Honey planks running along the col axis, 4 per tile, with staggered butt joints. */
function planks(variant: number): (u: number, v: number) => Paint {
  return (u, v) => {
    const lane = Math.floor((v + 8) / 4);
    if ((v + 8) % 4 < 0.5) return ["floor", 2];
    const joint = -8 + ((lane * 7 + variant * 5 + 3) % 16);
    if (Math.abs(u - joint) < 0.5) return ["floor", 2];
    // A soft grain streak in some planks.
    const grain = hash(lane + variant * 11, Math.floor((u + 8) / 5)) % 7 === 0 && (v + 8) % 4 > 2 && (v + 8) % 4 < 2.5;
    if (grain) return ["floor", 2];
    return ["floor", (lane + variant) % 2 === 0 ? 1 : 0];
  };
}

/** Rug 9-slice. Parts name the screen side of the cell on the rug's rim: edges ne/se/sw/nw
 *  (−v, +u, +v, −u) and corners n/e/s/w; `c` is the field. */
export const RUG_PARTS = ["c", "ne", "se", "sw", "nw", "n", "e", "s", "w"] as const;
type RugPart = (typeof RUG_PARTS)[number];
function rug(part: RugPart, variant: number): (u: number, v: number) => Paint {
  const rimU0 = part === "nw" || part === "n" || part === "w";
  const rimU1 = part === "se" || part === "e" || part === "s";
  const rimV0 = part === "ne" || part === "n" || part === "e";
  const rimV1 = part === "sw" || part === "s" || part === "w";
  const base = planks(variant);
  return (u, v) => {
    // Distance to the rug's outer rim, in units (rug edge sits 2 units inside the rim cells).
    const d = Math.min(rimU0 ? u + 6 : 99, rimU1 ? 6 - u : 99, rimV0 ? v + 6 : 99, rimV1 ? 6 - v : 99);
    if (d < 0) return base(u, v);
    if (d < 0.5) return ["navy", 2];
    if (d < 3) return ["mustard", d < 1 ? 2 : 1];
    if (d < 3.5) return ["navy", 2];
    // Field: navy with a lattice of small lozenges (teal ring, mustard heart).
    const gu = ((u + 8) % 8 + 8) % 8;
    const gv = ((v + 8) % 8 + 8) % 8;
    const m = Math.abs(gu - 4) + Math.abs(gv - 4);
    if (m < 1.1) return ["mustard", 0];
    if (m < 2.1) return ["navy", 0];
    return ["navy", 1];
  };
}

// ---------------------------------------------------------------- walls

type WallVariant = "plain" | "window0" | "window1" | "poster0" | "poster1" | "sconce";
const LEFT_VARIANTS: readonly WallVariant[] = ["plain", "window0", "window1", "sconce"];
const RIGHT_VARIANTS: readonly WallVariant[] = ["plain", "poster0", "poster1", "sconce"];

/**
 * Paint a wall face at position s along the wall (−8..8 within the segment) and height z.
 * `lit` is the right wall (faces SW, catches the top-left light); the left wall faces SE (shade).
 */
function wallPaint(variant: WallVariant, s: number, z: number, lit: boolean): Paint {
  const t = (hiTone: Tone, loTone: Tone): Tone => (lit ? hiTone : loTone);
  // Continuous coordinate across a two-segment decoration (window, poster), 0 at the seam.
  const w = variant.endsWith("0") ? s - 8 : variant.endsWith("1") ? s + 8 : s;
  if (variant === "window0" || variant === "window1") {
    const p = windowPaint(w, z, lit);
    if (p) return p;
  }
  if (variant === "poster0" || variant === "poster1") {
    const p = posterPaint(w, z, lit);
    if (p) return p;
  }
  if (variant === "sconce") {
    const p = sconcePaint(s, z, lit);
    if (p) return p;
  }
  // Baseboard, wainscot panel, chair rail, wallpaper, crown.
  if (z < 5) return ["wood", t(2, 2)];
  if (z < 6) return ["wood", t(0, 1)];
  if (z < 52) {
    const inPanel = s > -6 && s < 6 && z > 11 && z < 47;
    if (!inPanel) return ["wood", t(1, 2)];
    if (z > 46 || s < -5) return ["wood", t(2, 2)];
    if (z < 12 || s > 5) return ["wood", t(0, 1)];
    return ["wood", t(1, 2)];
  }
  if (z < 53) return ["wood", t(2, 2)];
  if (z < 56) return ["wood", t(0, 1)];
  if (z >= WALL_H - 5) return z >= WALL_H - 1 ? ["wall", t(0, 1)] : ["wall", t(1, 2)];
  // Wallpaper: a sparse lattice of tiny lozenges.
  const gs = ((s + 8) % 8 + 8) % 8;
  const gz = (z - 56) % 12;
  const row = Math.floor((z - 56) / 12) % 2;
  const cx = row === 0 ? 4 : 0;
  const dz = Math.abs(gz - 6);
  const ds = Math.min(Math.abs(gs - cx), 8 - Math.abs(gs - cx));
  if (dz + ds * 2 < 1.6) return ["wall", t(0, 1)];
  return ["wall", t(1, 2)];
}

function windowPaint(w: number, z: number, lit: boolean): Paint | null {
  const x0 = -12, x1 = 12, z0 = 84, z1 = 168;
  if (z >= z0 - 5 && z < z0 && w >= x0 - 2 && w < x1 + 2) return ["wood", z >= z0 - 1 ? (lit ? 0 : 1) : 2]; // sill
  if (w < x0 || w >= x1 || z < z0 || z >= z1) return null;
  const frame = w < x0 + 1.5 || w >= x1 - 1.5 || z < z0 + 3 || z >= z1 - 3 || Math.abs(w) < 0.75 || (z >= 138 && z < 141);
  if (frame) return ["wood", lit ? 1 : 2];
  // Skyline silhouette with a few lit windows.
  const col = Math.floor((w + 12) / 3);
  const top = z0 + 3 + 6 + (hash(col, 7) % 5) * 4;
  if (z < top) {
    const lit1 = Math.floor(w * 2) % 3 === 0 && Math.floor(z) % 4 === 0 && hash(Math.floor(w * 2), Math.floor(z)) % 3 === 0;
    return lit1 ? ["mustard", 1] : ["night", 2];
  }
  // Moon.
  const mw = w - 6, mz = z - 150;
  if (mw * mw * 4 + mz * mz < 30) return ["cream", mw * mw * 4 + mz * mz < 14 ? 0 : 1];
  // Stars.
  if (hash(Math.floor(w * 2), Math.floor(z)) % 61 === 0 && z > 120) return ["glow", 0];
  // Dusk gradient with dithered steps.
  const dither = (Math.floor(w * 2) + Math.floor(z)) % 2 === 0;
  if (z < top + 6) return ["pink", dither ? 2 : 1];
  if (z < top + 12) return dither ? ["pink", 2] : ["lilac", 2];
  if (z < top + 20) return ["lilac", 2];
  if (z < top + 26) return dither ? ["lilac", 2] : ["night", 0];
  if (z < 150) return ["night", 0];
  if (z < 156) return dither ? ["night", 0] : ["night", 1];
  return ["night", 1];
}

function posterPaint(w: number, z: number, lit: boolean): Paint | null {
  const x0 = -10, x1 = 10, z0 = 78, z1 = 164;
  if (w < x0 || w >= x1 || z < z0 || z >= z1) return null;
  if (w < x0 + 1 || w >= x1 - 1 || z < z0 + 1.5 || z >= z1 - 1.5) return ["charcoal", 2]; // frame
  // Title band with "type" (blocks, not letters).
  if (z < z0 + 14) {
    const line = z >= z0 + 5 && z < z0 + 10 && Math.floor(w + 20) % 3 !== 0 && Math.abs(w) < 7;
    return line ? ["rust", 2] : ["cream", lit ? 0 : 1];
  }
  // A ringed planet over a night sky, with a little rocket.
  const pw = w + 1, pz = z - 124;
  const ring = Math.abs(pw * pw + (pz * 2.6) * (pz * 2.6) - 90) < 22 && !(pz > 0 && pw * pw + pz * pz < 42);
  if (ring) return ["mustard", 0];
  if (pw * pw + pz * pz < 42) return ["teal", pw + pz < -3 ? 0 : pz < -3 ? 2 : 1];
  const rw = w - 5, rz = z - 150;
  if (Math.abs(rw) < 1 && rz > -4 && rz < 5) return ["cream", 0];
  if (Math.abs(rw) < 2 && rz > -4 && rz < -1) return ["rust", 1];
  if (Math.abs(rw) < 0.6 && rz > -8 && rz <= -4) return ["mustard", 1];
  if (hash(Math.floor(w * 2) + 99, Math.floor(z)) % 37 === 0) return ["cream", 0];
  return ["navy", 2];
}

function sconcePaint(s: number, z: number, lit: boolean): Paint | null {
  const ds = Math.abs(s);
  // Brass back plate + arm, then a round cream globe lit from inside.
  if (ds < 1.5 && z >= 112 && z < 122) return ["mustard", lit ? 1 : 2];
  const gz = z - 128;
  const g2 = ds * ds * 1.6 + gz * gz;
  if (g2 < 30) return ["cream", g2 < 10 && gz > -2 ? 0 : 1];
  // Warm halo on the wallpaper, dithered.
  const dz = z - 128;
  const r = Math.sqrt(ds * ds * 2.2 + dz * dz);
  const px = Math.floor(s * 2) + Math.floor(z);
  if (z >= 56 && z < WALL_H - 5 && r < 18 && px % 2 === 0) return r < 11 ? ["mustard", 2] : ["wall", lit ? 0 : 1];
  return null;
}

/** Left wall segment: stands on the top-left (u = −8) edge of cell (0,row). */
function leftWall(variant: WallVariant): Solid {
  return box(-8 - WALL_T, -8, -8, 8, 0, WALL_H, "wall", {
    skip: ["sw", "other"],
    paint: (p: Vec3, f: Facing) => (f === "top" ? ["wall", 0] : f === "se" ? wallPaint(variant, p.v, p.z, false) : null),
  });
}
/** Right wall segment: stands on the top-right (v = −8) edge of cell (col,0). */
function rightWall(variant: WallVariant): Solid {
  return box(-8, 8, -8 - WALL_T, -8, 0, WALL_H, "wall", {
    skip: ["se", "other"],
    paint: (p: Vec3, f: Facing) => (f === "top" ? ["wall", 0] : f === "sw" ? wallPaint(variant, p.u, p.z, true) : null),
  });
}

const CANVAS = { w: 400, h: 340, ax: 200, ay: 290 } as const;

/** `keepOutline(x, y)` (anchor-relative) can drop outline pixels that would land on a neighbour frame. */
function solidsFrame(key: string, solids: readonly Solid[], outline: "all" | "top" | "none" = "all", keepOutline?: (x: number, y: number) => boolean): RoomFrame {
  const r = renderSolids(solids, CANVAS.w, CANVAS.h, CANVAS.ax, CANVAS.ay, outline);
  if (keepOutline) {
    for (let i = 0; i < r.img.length; i++) {
      if (r.img[i] === OUTLINE && !keepOutline((i % CANVAS.w) - CANVAS.ax, Math.floor(i / CANVAS.w) - CANVAS.ay)) r.img[i] = 0;
    }
  }
  return crop(key, r.img, CANVAS.w, CANVAS.h, CANVAS.ax, CANVAS.ay);
}

// ---------------------------------------------------------------- seats

export type SeatDir = "ne" | "nw" | "se" | "sw";
export const SEAT_DIRS: readonly SeatDir[] = ["ne", "nw", "se", "sw"];

/** Velvet lounge armchair. Built facing NE (toward −v, backrest on the +v side toward the camera) or
 *  SE (toward +u, backrest on the far −u side); NW and SW swap the u/v axes, which keeps the lighting correct. */
function armchairSolids(dir: SeatDir): { back: Solid[]; front: Solid[] } {
  const swap = dir === "nw" || dir === "sw";
  const B = (u0: number, u1: number, v0: number, v1: number, z0: number, z1: number, ramp: RampName, extra: Omit<Solid, "planes" | "ramp"> = {}): Solid =>
    swap ? box(v0, v1, u0, u1, z0, z1, ramp, swapPaint(extra)) : box(u0, u1, v0, v1, z0, z1, ramp, extra);
  const facingCamera = dir === "se" || dir === "sw";
  const tuft = (p: Vec3, f: Facing): Paint | null => {
    // Button tufts on the backrest's sitting face: sw (+v) when it faces NE, se (+u) when it faces SE.
    const along = facingCamera ? p.v : p.u;
    const face: Facing = facingCamera ? "se" : "sw";
    if (f === face && p.z > 10 && p.z < 18 && Math.abs(((along + 8) % 4) - 2) < 0.6 && Math.abs(((p.z - 11) % 4) - 2) < 0.6) return ["velvet", 2];
    if (f === "top") return ["velvet", 0];
    return null;
  };
  // Mustard piping on the base; a shade seam where the cushion meets the base, so the seat reads as a cushion.
  const piping = (p: Vec3, f: Facing): Paint | null => (f === "top" ? ["velvet", 0] : p.z > 3.2 && p.z < 4.2 ? ["mustard", 2] : null);
  const cap = (_p: Vec3, f: Facing): Paint | null => (f === "top" ? ["velvet", 0] : null);
  const seam = (p: Vec3, f: Facing): Paint | null => (f === "top" ? ["velvet", 0] : p.z < 5.6 ? ["velvet", 2] : null);
  if (!facingCamera) {
    const legs = [B(-5, -4, -5, -4, 0, 2, "wood"), B(4, 5, -5, -4, 0, 2, "wood"), B(-5, -4, 5, 6, 0, 2, "wood"), B(4, 5, 5, 6, 0, 2, "wood")];
    const base = B(-6, 6, -6, 7, 2, 5, "velvet", { paint: piping });
    const cushion = B(-4, 4, -5, 4, 5, SEAT_HEIGHT, "velvet", { tones: { top: 0, sw: 1, se: 2 }, paint: seam });
    const armFar = B(-6, -4, -6, 7, 5, 11, "velvet", { paint: cap });
    const armNear = B(4, 6, -6, 7, 5, 11, "velvet", { paint: cap });
    const backrest = B(-6, 6, 5, 7, 5, 19, "velvet", { paint: tuft });
    return { back: [...legs.slice(0, 2), base, cushion, armFar], front: [...legs.slice(2), armNear, backrest] };
  }
  // Facing SE: backrest on the far (−u) side, arms along u. Only the near (+v) arm draws over the sitter.
  const legs = [B(-6, -5, -5, -4, 0, 2, "wood"), B(-6, -5, 4, 5, 0, 2, "wood"), B(4, 5, -5, -4, 0, 2, "wood"), B(4, 5, 4, 5, 0, 2, "wood")];
  const base = B(-7, 6, -6, 6, 2, 5, "velvet", { paint: piping });
  const backrest = B(-7, -5, -6, 6, 5, 19, "velvet", { paint: tuft });
  const cushion = B(-5, 5, -4, 4, 5, SEAT_HEIGHT, "velvet", { tones: { top: 0, sw: 1, se: 2 }, paint: seam });
  const armFar = B(-7, 6, -6, -4, 5, 11, "velvet", { paint: cap });
  const armNear = B(-7, 6, 4, 6, 5, 11, "velvet", { paint: cap });
  return { back: [...legs, base, backrest, cushion, armFar], front: [armNear] };
}
function swapPaint(extra: Omit<Solid, "planes" | "ramp">): Omit<Solid, "planes" | "ramp"> {
  const swapF = (f: Facing): Facing => (f === "sw" ? "se" : f === "se" ? "sw" : f);
  const out: Omit<Solid, "planes" | "ramp"> = { ...extra };
  if (extra.tones) out.tones = { top: extra.tones.top ?? 0, sw: extra.tones.se ?? 2, se: extra.tones.sw ?? 1 };
  const paint = extra.paint;
  if (paint) out.paint = (p, f) => paint({ u: p.v, v: p.u, z: p.z }, swapF(f));
  return out;
}

/** Back + front layers of one armchair. The front keeps only pixels owned by front solids
 *  (plus their outline), so it can be drawn over a seated avatar. */
function armchairFrames(dir: SeatDir): RoomFrame[] {
  const { back, front } = armchairSolids(dir);
  const all = [...back, ...front];
  const full = renderSolids(all, CANVAS.w, CANVAS.h, CANVAS.ax, CANVAS.ay, "all");
  const backImg = renderSolids(back, CANVAS.w, CANVAS.h, CANVAS.ax, CANVAS.ay, "all").img;
  const frontImg = new Uint8Array(CANVAS.w * CANVAS.h);
  const isFront = (i: number): boolean => (full.ids[i] ?? -1) >= back.length;
  for (let y = 0; y < CANVAS.h; y++) {
    for (let x = 0; x < CANVAS.w; x++) {
      const i = y * CANVAS.w + x;
      if (isFront(i)) frontImg[i] = full.img[i] ?? 0;
      else if (full.img[i] === OUTLINE) {
        const n = [x > 0 ? i - 1 : -1, x < CANVAS.w - 1 ? i + 1 : -1, y > 0 ? i - CANVAS.w : -1, y < CANVAS.h - 1 ? i + CANVAS.w : -1];
        if (n.some((j) => j >= 0 && isFront(j))) frontImg[i] = OUTLINE;
      }
    }
  }
  // Same crop rect for both layers so they share one anchor offset.
  const both = new Uint8Array(CANVAS.w * CANVAS.h);
  for (let i = 0; i < both.length; i++) both[i] = (backImg[i] ?? 0) || (frontImg[i] ?? 0);
  const box0 = crop("tmp", both, CANVAS.w, CANVAS.h, CANVAS.ax, CANVAS.ay);
  const cropTo = (key: string, img: Uint8Array): RoomFrame => {
    const x0 = CANVAS.ax - box0.ax;
    const y0 = CANVAS.ay - box0.ay;
    const out = new Uint8Array(box0.w * box0.h);
    for (let y = 0; y < box0.h; y++) out.set(img.subarray((y0 + y) * CANVAS.w + x0, (y0 + y) * CANVAS.w + x0 + box0.w), y * box0.w);
    return { key, w: box0.w, h: box0.h, img: out, ax: box0.ax, ay: box0.ay };
  };
  return [cropTo(`armchair/${dir}/back`, backImg), cropTo(`armchair/${dir}/front`, frontImg)];
}

// ---------------------------------------------------------------- TV (console + projector) and the DOM TV frame painters

/** DOM bezel widths outside the player rect (px, 1 art px = 1 CSS px), outline included. They fit layout.ts (ADR 0012):
 *  6 px above the player (tv.y = 6) and the 8 px gap between the player and the control bar. */
export const TV_BEZEL = { side: 6, top: 6, bottom: 8 } as const;
/** Speaker cabinet width on each side of the transport slot (jamb 2 + grille 32 + end 2), and the rail under the slot. */
export const TV_SHELF = { speaker: 36, rail: 4 } as const;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Wood bezel around a screen rect `s`, in any coordinate space where (x, y) is a pixel inside the bezel box.
 * Shared by the room's `tv/0` and the DOM 9-slice `tv/bezel`, so both frames are the same pixels.
 * Returns null inside the screen rect.
 */
export function bezelPaint(x: number, y: number, s: Rect): Paint | null {
  const sx1 = s.x + s.w, sy1 = s.y + s.h;
  if (x >= s.x && x < sx1 && y >= s.y && y < sy1) return null;
  // Out from the player: 1 px charcoal lip, then wood, then the plum outline (added by the caller).
  // Top/left: lip, 1 base, 3 highlight. Bottom: lip, 2 base, then 4 shade; right: lip, 1 base, 3 shade.
  if (x >= s.x - 1 && x < sx1 + 1 && y >= s.y - 1 && y < sy1 + 1) return ["charcoal", 2];
  // Power light in the bottom-right corner (inside the 9-slice corner, so the slice stays stretchable).
  if (y >= sy1 + 3 && y < sy1 + 5 && x >= sx1 + 1 && x < sx1 + 4) return ["glow", 0];
  if (y >= sy1 + 3) return ["wood", 2];
  if (x < s.x - 2 || y < s.y - 2) return ["wood", 0];
  if (x >= sx1 + 2) return ["wood", 2];
  return ["wood", 1];
}

/**
 * Front of the media shelf (DOM `tvframe/shelf`). `x` runs −half..half, `y` from the top of the front face (0) down;
 * `slot` is the transport slot rect in the same space, a flat sunken well (plum shadow top/left, lit lip bottom/right)
 * like the set (e) seek track, so the transport reads as set into the furniture. Speaker cabinets fill both ends.
 */
export function shelfPaint(x: number, y: number, half: number, h: number, slot: Rect): Paint {
  const sx1 = slot.x + slot.w, sy1 = slot.y + slot.h;
  if (x >= slot.x && x < sx1 && y >= slot.y && y < sy1) {
    if (y === slot.y || x === slot.x) return ["outline", 1];
    if (y === sy1 - 1 || x === sx1 - 1) return ["night", 0];
    return ["night", 2];
  }
  if (y === 0) return ["wood", 0];
  if (y >= h - 2) return ["wood", 2];
  const ax = Math.abs(x + 0.5);
  // Speaker cabinets: a 2 px wood jamb, then a charcoal grille with a dot mesh and a round woofer ring.
  if (ax >= slot.w / 2) {
    if (ax >= half - 2 || ax < slot.w / 2 + 2) return ["wood", ax >= half - 2 ? 2 : 1];
    if (y < slot.y + 2 || y >= sy1 - 2) return ["wood", 1];
    const gx = ax - slot.w / 2 - 2;
    const gy = y + 0.5 - slot.y - 2;
    const gw = half - 2 - slot.w / 2 - 2, gh = slot.h - 4;
    const r = Math.hypot(gx - gw / 2, gy - gh / 2);
    if (Math.abs(r - 10) < 0.8 || r < 2.5) return ["charcoal", 0];
    if (r < 9.2 && r > 3.2) return ["charcoal", 1];
    return Math.floor(gx) % 3 === 1 && Math.floor(gy) % 3 === 1 ? ["charcoal", 0] : ["charcoal", 2];
  }
  return ["wood", 1];
}

/** The projector's slide gate on the `tv/0` console (relative to its anchor = cellCenter(0,0)): 16:9, lit.
 *  (It's the bounding box of the lens glass.) Decorative since ADR 0012: the live player is page chrome above the stage, framed by `tvframe/*` in the UI atlas. */
export const TV_SCREEN = { x: -12, y: -13, w: 16, h: 9 } as const;

function tvFrame(): RoomFrame {
  // Cell (0,0) frame: the room's back corner is at u = v = −8. The picture is up on the big screen above the room
  // (page chrome); down here is the corner console with the little projector that "throws" it.
  const plane = (nu: number, nv: number, nz: number, d: number): { n: Vec3; d: number } => ({ n: { u: nu, v: nv, z: nz }, d });
  // Corner media console: a triangle against both walls, front plane u+v = 40, 20 px tall.
  const CF = 24;
  const half = 2 * (CF + 8);
  const console_: Solid = {
    ramp: "wood",
    planes: [plane(-1, 0, 0, 8), plane(0, -1, 0, 8), plane(1, 1, 0, CF), plane(0, 0, 1, 20), plane(0, 0, -1, 0)],
    paint: (p, f) => {
      if (f === "top") return ["wood", 1];
      const x = 2 * (p.u - p.v);
      const z = p.z;
      if (z < 2) return ["charcoal", 2]; // plinth
      if (z >= 18) return ["wood", 0]; // top lip
      // Speaker grilles at both ends, doors with brass knobs between.
      const g = half - 26;
      if (Math.abs(x) > g) {
        if (Math.abs(x) > half - 4) return ["wood", 2];
        const dot = Math.floor(x) % 3 === 0 && Math.floor(z) % 3 === 0;
        return dot ? ["charcoal", 0] : ["charcoal", 2];
      }
      const dw = (2 * g) / 2;
      const door = Math.floor((x + g) / dw);
      const dx = x + g - door * dw;
      if (dx < 1.5 || z < 4 || z >= 16.5) return ["wood", 2];
      if (Math.abs(dx - dw / 2) < 1.5 && z >= 9 && z < 11) return ["mustard", 0];
      return ["wood", 1];
    },
  };
  // Little things on the console top: a potted succulent (left), a tape stack (right).
  const pot = box(12, 16, -6, -2, 20, 26, "rust");
  const leaf1 = box(12.5, 15.5, -5.5, -2.5, 26, 32, "olive");
  const tapes = [0, 1, 2].map((i) => box(-6, 0, 8, 14, 20 + i * 2, 22 + i * 2, i === 1 ? "teal" : "charcoal", { tones: { top: 0, sw: 1, se: 2 } }));
  // Retro projector on the console. Its front is a camera-facing plane u+v = 18, so the lens glass is a clean
  // screen-space ellipse; TV_SCREEN is the glass's 16×9 bounding box.
  const PF = 18, PB = 8, PZ0 = 20, PZ1 = PF + 16;
  const s = TV_SCREEN;
  const lcx = s.x + s.w / 2, lcy = s.y + s.h / 2;
  const projector: Solid = {
    ramp: "cream",
    planes: [plane(1, 1, 0, PF), plane(-1, -1, 0, -PB), plane(1, -1, 0, 7), plane(-1, 1, 0, 7), plane(0, 0, 1, PZ1), plane(0, 0, -1, -PZ0)],
    paint: (p, f) => {
      if (f === "top") return ["cream", 0];
      const x = 2 * (p.u - p.v) + 0.5, y = p.u + p.v - p.z + 0.5;
      const e = ((x - lcx) / (s.w / 2)) ** 2 + ((y - lcy) / (s.h / 2)) ** 2;
      if (e < 1) {
        // Lit glass: bright top-left, cooler bottom-right.
        const t = (x - lcx) / s.w + (y - lcy) / s.h;
        return ["glow", t < -0.25 ? 0 : t < 0.3 ? 1 : 2];
      }
      if (e < 1.6) return ["charcoal", e < 1.3 ? 2 : 1]; // lens barrel rim
      if (x > 8 && x < 13 && Math.floor(y) % 2 === 0 && y > -14 && y < -4) return ["cream", 2]; // vent
      if (y > -3) return ["cream", 2]; // foot
      return null;
    },
  };
  const r = renderSolids([console_, pot, leaf1, ...tapes, projector], CANVAS.w, CANVAS.h, CANVAS.ax, CANVAS.ay + 0, "all");
  const img = r.img;
  // Two film reels standing on the projector (drawn flat, facing the camera), then outline them.
  const reel = (cx: number, cy: number): void => {
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > 5.6) continue;
        let paint: Paint = d > 4.6 ? (dx + dy < 0 ? ["charcoal", 0] : ["charcoal", 2]) : ["charcoal", 1];
        if (d < 1.5) paint = ["cream", 0];
        for (const a of [0, 2.094, 4.189]) {
          if (Math.hypot(dx - 2.8 * Math.cos(a - 1.57), dy - 2.8 * Math.sin(a - 1.57)) < 1.3) paint = ["charcoal", 2];
        }
        img[(CANVAS.ay + cy + dy) * CANVAS.w + CANVAS.ax + cx + dx] = colorIndex(paint[0], paint[1]);
      }
    }
  };
  reel(-6, -27);
  reel(6, -28);
  addOutline(img, CANVAS.w, CANVAS.h);
  return crop("tv/0", img, CANVAS.w, CANVAS.h, CANVAS.ax, CANVAS.ay);
}

// ---------------------------------------------------------------- props (role-grid, like avatars)

const PROP_ROLES: RoleMap = {
  G: { ramp: "olive", hi: true, group: "G" },
  g: { ramp: "olive", tone: 2, group: "G" },
  P: { ramp: "rust", hi: true },
  p: { ramp: "rust", tone: 2 },
  s: { ramp: "floor", tone: 2 },
  M: { ramp: "mustard", hi: true },
  C: { ramp: "cream", tone: 0, group: "C" },
  c: { ramp: "cream", tone: 1, group: "C" },
  K: { ramp: "charcoal" },
};
function gridFrame(key: string, rows: readonly string[], floor: { x: number; y: number }): RoomFrame {
  const w = Math.max(...rows.map((r) => r.length)) + 2;
  const h = rows.length + 2;
  const g: Grid = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => rows[y - 1]?.[x - 1] ?? "."));
  const img = renderRoles(g, PROP_ROLES);
  return { key, w, h, img, ax: floor.x + 1, ay: floor.y + 1 };
}

const PLANT = [
  "..........G.......G.....",
  ".........GG......GG.....",
  "....G...GGG.....GGg.....",
  "...GG..GGGg....GGgg..G..",
  "..GGG..GGgg...GGgg..GG..",
  "..GGGg.GGg...GGgg..GGg..",
  "..GGgg.GGg..GGgg..GGgg..",
  "...Ggg..Gg.GGgg..GGgg...",
  "...Ggg..GgGGgg..GGgg....",
  "G...Ggg.GgGgg..GGgg...G.",
  "GG..Ggg.GGgg.GGgg....GG.",
  "GGG..Gg.GGg.GGgg....GGg.",
  ".GGG.GggGGgGGgg...GGGg..",
  "..GGGgGgGGGGgg..GGGgg...",
  "...GGGGgGGGgGGGGGgg.....",
  "....GGGGGGGGGGgg........",
  ".....GGgGGGgggg.........",
  "......GGgGGgg...........",
  ".......gGGgg............",
  "........ggg.............",
  ".....PPPPPPPPPPP........",
  ".....PPPPPPPPPPP........",
  "......pppppppppp........",
  "......PPPPPPPPP.........",
  "......PPPPPPPPP.........",
  ".......PPPPPPPp.........",
  ".......PPPPPPPp.........",
  "........PPPPPp..........",
  "........sssssss.........",
];
const LAMP = [
  "......CCCCCCCC......",
  ".....CCCCCCCCCC.....",
  "....CCCCCCCCCCcc....",
  "...CCCCCCCCCCCccc...",
  "..CCCCCCCCCCCCcccc..",
  ".cccccccccccccccccc.",
  "........MMMM........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".........KK.........",
  ".....KKKKKKKKKK.....",
  "....KKKKKKKKKKKK....",
  ".....KKKKKKKKKK.....",
];

// ---------------------------------------------------------------- all frames

export function buildRoomFrames(): RoomFrame[] {
  const frames: RoomFrame[] = [];
  frames.push(floorTile("floor/0", planks(0)), floorTile("floor/1", planks(1)));
  for (const part of RUG_PARTS) frames.push(floorTile(`rug/${part}`, rug(part, 0)));
  for (const v of LEFT_VARIANTS) frames.push(solidsFrame(`wall/l/${v}`, [leftWall(v)], "top"));
  for (const v of RIGHT_VARIANTS) frames.push(solidsFrame(`wall/r/${v}`, [rightWall(v)], "top"));
  // Back corner block (only its top shows) and the two open wall ends at the front.
  frames.push(solidsFrame("wall/corner", [box(-8 - WALL_T, -8, -8 - WALL_T, -8, 0, WALL_H, "wall", { paint: (_p, f) => (f === "top" ? ["wall", 0] : null) })], "top"));
  frames.push(solidsFrame("wall/l/end", [box(-8 - WALL_T, -8, 7, 8, 0, WALL_H, "wall", { skip: ["se", "other"], paint: (_p, f) => (f === "top" ? ["wall", 0] : ["wall", 1]) })], "all", (x) => x < -32));
  frames.push(solidsFrame("wall/r/end", [box(7, 8, -8 - WALL_T, -8, 0, WALL_H, "wall", { skip: ["sw", "other"], paint: (_p, f) => (f === "top" ? ["wall", 0] : ["wall", 2]) })], "all", (x) => x >= 32));
  for (const d of SEAT_DIRS) frames.push(...armchairFrames(d));
  frames.push(tvFrame());
  frames.push(gridFrame("plant/0", PLANT, { x: 11, y: 27 }));
  frames.push(gridFrame("lamp/0", LAMP, { x: 10, y: 61 }));
  return frames;
}

/** Suggested default room for the web's 10×10 floor (layout.ts). Seats stay in layout.ts. */
export function defaultLayout(): {
  floor: string[][];
  walls: { l: string[]; r: string[] };
  props: { frame: string; col: number; row: number }[];
} {
  const N = 10;
  const R0 = 1, R1 = 7;
  const floor: string[][] = [];
  for (let r = 0; r < N; r++) {
    const row: string[] = [];
    for (let c = 0; c < N; c++) {
      if (c >= R0 && c <= R1 && r >= R0 && r <= R1) {
        const nw = c === R0, se = c === R1, ne = r === R0, sw = r === R1;
        const part = nw && ne ? "n" : se && ne ? "e" : se && sw ? "s" : nw && sw ? "w" : nw ? "nw" : se ? "se" : ne ? "ne" : sw ? "sw" : "c";
        row.push(`rug/${part}`);
      } else row.push(`floor/${String(hash(c, r) % 2)}`);
    }
    floor.push(row);
  }
  const l = ["plain", "plain", "plain", "plain", "plain", "window0", "window1", "plain", "sconce", "plain"].map((v) => `wall/l/${v}`);
  const rr = ["plain", "plain", "plain", "plain", "plain", "poster0", "poster1", "plain", "sconce", "plain"].map((v) => `wall/r/${v}`);
  return { floor, walls: { l, r: rr }, props: [{ frame: "plant/0", col: 0, row: 9 }, { frame: "lamp/0", col: 9, row: 0 }] };
}
