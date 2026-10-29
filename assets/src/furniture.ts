// Set (g): furniture catalogue v1 for customizable rooms (M4/M5). Same recipe as set (b): pieces are 3D solids
// ray-cast on the 2:1 grid (src/iso.ts), lit from the top-left, outlined in plum, on the shared palette.
// Every piece is modelled once in a local frame and turned into each facing, so light stays top-left on all of them.
//
// Local frame: x runs along the piece (width), the piece's front faces −y, z is up. One tile is 16×16 units,
// the origin cell spans x, y ∈ [−8, 8), and wider pieces grow toward +x (the next col or row).
import { SEAT_HEIGHT } from "./avatars";
import { WALK_FRAMES, WALK_FRAME_MS } from "./motion";
import { addOutline, box, renderSolids, type Facing, type Solid, type Vec3 } from "./iso";
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import { WALL_H, panelPaint, tvSolids, wallPaint, type RoomFrame } from "./room";
import { blank, mirror, render as renderRoles, stamp, type Grid, type RoleMap } from "./sprite";

export type FurnDir = "ne" | "nw" | "se" | "sw";
type Paint = readonly [RampName, Tone];
/** A face in the piece's own frame. "front" is the side a sitter faces out of. */
type LFace = "top" | "front" | "back" | "right" | "left" | "other";
interface L3 {
  x: number;
  y: number;
  z: number;
}
type LPaint = (p: L3, f: LFace) => Paint | null;
interface PartOpts {
  paint?: LPaint;
  tones?: Partial<Record<Facing, Tone>>;
  /** Draws over a seated avatar (backrest toward the camera, near arm). */
  front?: boolean;
}

const toWorld = (d: FurnDir, x: number, y: number): { u: number; v: number } =>
  d === "ne" ? { u: x, v: y } : d === "nw" ? { u: y, v: x } : d === "se" ? { u: -y, v: x } : { u: x, v: -y };
const toLocal = (d: FurnDir, u: number, v: number): { x: number; y: number } =>
  d === "ne" ? { x: u, y: v } : d === "nw" ? { x: v, y: u } : d === "se" ? { x: v, y: -u } : { x: u, y: -v };
/** Local face with outward normal (x, y): +x right, -x left (never camera-facing unless turned), +y back, -y front. */
const faceOf = (x: number, y: number): LFace => (x > 0 ? "right" : x < 0 ? "left" : y > 0 ? "back" : "front");

/** Collects solids for one facing of one piece, written in local coordinates. `turned` spins the piece 180° about its
 *  anchor: the same model seen from the other side of the room (the Dank Dungeon north view, OME-1956). */
export class Kit {
  readonly parts: { solid: Solid; front: boolean }[] = [];
  private readonly k: number;
  constructor(readonly dir: FurnDir, turned = false) {
    this.k = turned ? -1 : 1;
  }

  world(x: number, y: number): { u: number; v: number } {
    const p = toWorld(this.dir, x, y);
    return { u: this.k * p.u, v: this.k * p.v };
  }

  private extra(o: PartOpts): Omit<Solid, "planes" | "ramp"> {
    const d = this.dir, k = this.k;
    const paint = o.paint;
    const out: Omit<Solid, "planes" | "ramp"> = {};
    if (o.tones) out.tones = o.tones;
    if (paint) {
      out.paint = (p: Vec3, f: Facing) => {
        const l = toLocal(d, k * p.u, k * p.v);
        const n = f === "sw" ? toLocal(d, 0, k) : f === "se" ? toLocal(d, k, 0) : null;
        const lf: LFace = f === "top" ? "top" : n ? faceOf(n.x, n.y) : "other";
        return paint({ x: l.x, y: l.y, z: p.z }, lf);
      };
    }
    return out;
  }

  private worldBox(x0: number, x1: number, y0: number, y1: number): [number, number, number, number] {
    const a = this.world(x0, y0), b = this.world(x1, y1);
    return [Math.min(a.u, b.u), Math.max(a.u, b.u), Math.min(a.v, b.v), Math.max(a.v, b.v)];
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, ramp: RampName, o: PartOpts = {}): void {
    const [u0, u1, v0, v1] = this.worldBox(x0, x1, y0, y1);
    this.parts.push({ solid: box(u0, u1, v0, v1, z0, z1, ramp, this.extra(o)), front: o.front === true });
  }

  /** Ellipsoid (rz = Infinity: vertical cylinder) at (cx, cy, cz), clipped to the local box [x0,x1]×[y0,y1]×[z0,z1]. */
  ell(c: L3, r: L3, clip: readonly [number, number, number, number, number, number], ramp: RampName, o: PartOpts = {}): void {
    const [u0, u1, v0, v1] = this.worldBox(clip[0], clip[1], clip[2], clip[3]);
    const wc = this.world(c.x, c.y);
    const swap = this.dir === "nw" || this.dir === "se";
    const solid = box(u0, u1, v0, v1, clip[4], clip[5], ramp, this.extra(o));
    solid.quad = { c: { u: wc.u, v: wc.v, z: c.z }, r: { u: swap ? r.y : r.x, v: swap ? r.x : r.y, z: r.z } };
    this.parts.push({ solid, front: o.front === true });
  }
}

const hash = (a: number, b: number): number => {
  let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};

// ---------------------------------------------------------------- pieces

/** Club sofa: the room's armchair grown to two seats. Tufted back, mustard piping, a split seat cushion. */
function sofa(k: Kit, c: RampName): void {
  const legs: [number, number][] = [[-6, -5], [22, -5], [-6, 5], [22, 5]];
  for (const [x, y] of legs) k.box(x, x + 1, y, y + 1, 0, 2, "wood");
  const piping: LPaint = (p, f) => (f === "top" ? [c, 0] : p.z > 3.2 && p.z < 4.2 ? ["mustard", 2] : null);
  k.box(-7, 23, -6, 7, 2, 5, c, { paint: piping });
  const seam: LPaint = (p, f) => (f === "top" ? [c, 0] : p.z < 5.6 ? [c, 2] : null);
  k.box(-5, 7.5, -5, 4.5, 5, SEAT_HEIGHT, c, { paint: seam });
  k.box(8.5, 21, -5, 4.5, 5, SEAT_HEIGHT, c, { paint: seam });
  const cap: LPaint = (_p, f) => (f === "top" ? [c, 0] : null);
  k.box(-7, -5, -6, 7, 5, 11, c, { paint: cap });
  k.box(21, 23, -6, 7, 5, 11, c, { paint: cap, front: true });
  const ne = k.dir === "ne" || k.dir === "nw";
  const tuft: LPaint = (p, f) => {
    if (f === "top") return [c, 0];
    const face: LFace = ne ? "back" : "front";
    // Tufts on the face the sitter leans on: the inner face (front) is what we see when the sofa faces the camera.
    if (!ne && f === face && p.z > 10 && p.z < 18 && Math.abs(((p.x + 8) % 4) - 2) < 0.6 && Math.abs(((p.z - 11) % 4) - 2) < 0.6) return [c, 2];
    return null;
  };
  k.box(-7, 23, 5, 7, 5, 19, c, { paint: tuft, front: ne });
}

/** Low lounge couch: a plinth, deep seat, two slouchy back cushions over a low frame, short bolster arms. */
function couch(k: Kit, c: RampName): void {
  k.box(-7, 23, -6, 6, 0, 2, "charcoal");
  k.box(-8, 24, -7, 7, 2, 6, c, { paint: (p, f) => (f === "top" ? [c, 0] : p.z < 2.9 ? [c, 2] : null) });
  const cushion: LPaint = (p, f) => (f === "top" ? [c, 0] : p.z < 6.8 ? [c, 2] : null);
  k.box(-8, 7.6, -7, 4, 6, SEAT_HEIGHT, c, { paint: cushion });
  k.box(8.4, 24, -7, 4, 6, SEAT_HEIGHT, c, { paint: cushion });
  const ne = k.dir === "ne" || k.dir === "nw";
  k.box(-8, 24, 5, 7, 6, 12, c, { front: ne });
  // Back cushions lean on the frame, taller than it, with a crease across the middle.
  const crease: LPaint = (p, f) => (f === "top" ? [c, 0] : Math.abs(p.z - 12.5) < 0.5 ? [c, 2] : null);
  k.box(-7, 7.4, 3, 6, 8, 17, c, { paint: crease, front: ne });
  k.box(8.6, 23, 3, 6, 8, 17, c, { paint: crease, front: ne });
  k.box(-8, -6, -7, 5, 6, 11, c, { paint: (_p, f) => (f === "top" ? [c, 0] : null) });
  k.box(22, 24, -7, 5, 6, 11, c, { paint: (_p, f) => (f === "top" ? [c, 0] : null), front: true });
}

/** Leather wingback reading chair: tall back, side wings, brass studs along the arm fronts, tapered legs. */
function wingback(k: Kit, c: RampName): void {
  for (const [x, y] of [[-5, -5], [4, -5], [-5, 4], [4, 4]] as const) k.box(x, x + 1, y, y + 1, 0, 3, "wood");
  k.box(-6, 6, -6, 6, 3, 6, c, { paint: (p, f) => (f === "top" ? [c, 0] : p.z < 3.8 ? [c, 2] : null) });
  k.box(-4.5, 4.5, -5.5, 4, 6, SEAT_HEIGHT, c, { paint: (p, f) => (f === "top" ? [c, 0] : p.z < 6.6 ? [c, 2] : null) });
  const ne = k.dir === "ne" || k.dir === "nw";
  const studs: LPaint = (p, f) => {
    if (f === "top") return [c, 0];
    if (f === "front" && Math.abs(p.z - 10) < 0.6 && Math.floor(p.x * 2) % 2 === 0) return ["mustard", 0];
    return null;
  };
  k.box(-6, -4.5, -6, 6, 6, 12, c, { paint: studs });
  k.box(4.5, 6, -6, 6, 6, 12, c, { paint: studs, front: true });
  // Channel stitching down the back, on the side we see.
  const channels: LPaint = (p, f) => {
    if (f === "top") return [c, 0];
    if ((f === "front" || f === "back") && p.z > 9 && p.z < 25 && Math.abs(((p.x + 8) % 3) - 1.5) < 0.4) return [c, 2];
    return null;
  };
  k.box(-6, 6, 4, 6, 6, 25, c, { paint: channels, front: ne });
  k.box(-5, 5, 4, 6, 25, 27, c, { paint: (_p, f) => (f === "top" ? [c, 0] : null), front: ne });
  const wing: LPaint = (_p, f) => (f === "top" ? [c, 0] : null);
  // Wings step down toward the front in three 1 px stairs, so they read as a curve at 1×.
  for (const [y0, z1] of [[3, 24], [0.5, 21], [-1.5, 17]] as const) {
    k.box(-6, -4.5, y0, 6, 12, z1, c, { paint: wing, front: ne });
    k.box(4.5, 6, y0, 6, 12, z1, c, { paint: wing, front: true });
  }
}

/** Beanbag: a squashed round body and a soft back hump, with a cream tag on the seam. */
function beanbag(k: Kit, c: RampName): void {
  const ne = k.dir === "ne" || k.dir === "nw";
  const body: LPaint = (p, f) => {
    if (f === "front" && Math.abs(p.x - 3) < 0.8 && p.z > 3 && p.z < 5) return ["cream", 0];
    return null;
  };
  k.ell({ x: 0, y: -0.5, z: 3.5 }, { x: 7.2, y: 7, z: 5 }, [-8, 8, -8, 8, 0, 20], c, { paint: body });
  k.ell({ x: 0, y: 4.5, z: 7 }, { x: 6.6, y: 3.4, z: 9.5 }, [-8, 8, -8, 8, 4, 30], c, { front: ne });
}

/** Arc floor lamp: marble foot, brass pole arching forward, a cream dome over a glowing bulb. */
function arcLamp(k: Kit): void {
  k.ell({ x: -3, y: 4, z: 0 }, { x: 3.6, y: 3.6, z: Infinity }, [-8, 8, -8, 8, 0, 2], "charcoal");
  k.box(-3.5, -2.5, 3.5, 4.5, 2, 38, "mustard");
  // Quarter-circle-and-a-bit arc in the y/z plane, as 1-unit brass knuckles.
  const cy = -1.5, cz = 38, R = 5.5;
  for (let a = 0; a <= 192; a += 12) {
    const t = (a * Math.PI) / 180;
    const y = cy + R * Math.cos(t), z = cz + R * Math.sin(t);
    k.box(-3.5, -2.5, y - 0.5, y + 0.5, z - 0.5, z + 0.5, "mustard");
  }
  const sy = cy - R;
  // A bell shade: a tall half-ellipsoid with a brass rim, the bulb peeping out underneath.
  k.ell({ x: -3, y: sy, z: 30 }, { x: 1.4, y: 1.4, z: 1.6 }, [-8, 8, -8, 8, 28, 31], "glow", { tones: { top: 0, sw: 0, se: 1 } });
  const bell: LPaint = (p, f) => (p.z < 31 ? ["mustard", f === "top" ? 0 : 1] : f === "top" ? ["cream", 0] : null);
  k.ell({ x: -3, y: sy, z: 30 }, { x: 3.6, y: 3.6, z: 9 }, [-8, 8, -8, 8, 30, 40], "cream", { paint: bell });
}

/** Round side table with a popcorn bowl and a mug of cocoa. */
function sideTable(k: Kit): void {
  k.ell({ x: 0, y: 0, z: 0 }, { x: 3.6, y: 3.6, z: Infinity }, [-8, 8, -8, 8, 0, 1.5], "charcoal");
  k.ell({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: Infinity }, [-8, 8, -8, 8, 1.5, 13], "wood");
  k.ell({ x: 0, y: 0, z: 0 }, { x: 5.6, y: 5.6, z: Infinity }, [-8, 8, -8, 8, 13, 15], "wood", {
    paint: (p, f) => (f !== "top" && p.z < 13.8 ? ["wood", 2] : null),
  });
  // Bowl: a rust half-ellipsoid with a cream band, heaped with popcorn.
  const bx = -1.6, by = 1;
  k.ell({ x: bx, y: by, z: 18 }, { x: 3, y: 3, z: 3 }, [-8, 8, -8, 8, 15, 18], "rust", {
    paint: (p, f) => (f !== "top" && p.z > 16.4 && p.z < 17.2 ? ["cream", 0] : null),
  });
  k.ell({ x: bx, y: by, z: 18 }, { x: 2.7, y: 2.7, z: 1.8 }, [-8, 8, -8, 8, 18, 22], "cream", {
    paint: (p) => (hash(Math.floor(p.x * 2), Math.floor(p.y * 2 + p.z * 3)) % 5 === 0 ? ["mustard", 0] : ["cream", 0]),
  });
  k.ell({ x: 2.6, y: -1.8, z: 0 }, { x: 1.2, y: 1.2, z: Infinity }, [-8, 8, -8, 8, 15, 18.5], "teal", {
    paint: (_p, f) => (f === "top" ? ["hairDark", 0] : null),
  });
  k.box(3.6, 4.4, -2.2, -1.4, 15.8, 17.6, "teal");
}

/** Bookcase for a wall: two bays of mixed-height spines, a globe and a film reel, and a cactus on top. */
function bookshelf(k: Kit): void {
  const W0 = -7, W1 = 23, D0 = 1, D1 = 8, H = 62;
  const shade: LPaint = (_p, f) => (f === "top" ? ["wood", 0] : null);
  k.box(W0, W0 + 2, D0, D1, 0, H, "wood", { paint: shade });
  k.box(W1 - 2, W1, D0, D1, 0, H, "wood", { paint: shade });
  k.box(7, 9, D0 + 0.5, D1, 3, H - 2, "wood", { paint: shade });
  k.box(W0, W1, D0, D1, H - 2, H, "wood", { paint: shade });
  k.box(W0, W1, D0, D1, 0, 3, "wood", { paint: (p, f) => (f === "top" ? ["wood", 0] : p.z < 1 ? ["charcoal", 2] : null) });
  k.box(W0 + 2, W1 - 2, D1 - 1, D1, 3, H - 2, "wood", { tones: { top: 2, sw: 2, se: 2 } });
  const shelves = [3, 22, 41];
  for (const z of shelves.slice(1)) k.box(W0 + 2, W1 - 2, D0, D1 - 1, z - 1.5, z, "wood", { paint: shade });
  const spines: RampName[] = ["rust", "teal", "mustard", "navy", "lilac", "cream", "olive", "velvet", "night"];
  shelves.forEach((z0, si) => {
    const bays: [number, number][] = [[W0 + 2, 7], [9, W1 - 2]];
    bays.forEach(([x0, x1], bi) => {
      let x = x0 + 0.5;
      let n = si * 7 + bi * 3;
      // Bay with a keepsake: a globe (top shelf left), a film reel (middle right).
      const keep = (si === 2 && bi === 0) || (si === 1 && bi === 1);
      const stop = keep ? x0 + (x1 - x0) * 0.55 : x1 - 0.5;
      while (x < stop - 1.4) {
        const w = 1.4 + (hash(n, 3) % 3) * 0.5;
        const h = 11 + (hash(n, 5) % 6);
        const ramp = spines[hash(n, 9) % spines.length] ?? "rust";
        const band = 0.7 * h;
        k.box(x, Math.min(x + w, stop), D0 + 1 + (hash(n, 4) % 2) * 0.6, D1 - 1, z0, z0 + h, ramp, {
          paint: (p, f) => (f !== "top" && Math.abs(p.z - z0 - band) < 0.5 ? [ramp, 0] : null),
        });
        x += w + (hash(n, 11) % 5 === 0 ? 1 : 0.15);
        n++;
      }
      if (si === 2 && bi === 0) {
        k.box(x1 - 4, x1 - 1, D0 + 2, D1 - 2, z0, z0 + 1, "mustard");
        k.ell({ x: x1 - 2.5, y: (D0 + D1) / 2, z: z0 + 6 }, { x: 3, y: 3, z: 3.6 }, [-99, 99, -99, 99, z0 + 1, 99], "teal", {
          paint: (p) => (Math.sin(p.x * 1.7) + Math.cos(p.z * 1.3 + p.y) > 0.9 ? ["olive", 1] : null),
        });
      }
      if (si === 1 && bi === 1) {
        const cx = x1 - 3.4, cz = z0 + 4.4;
        k.box(cx - 3.4, cx + 3.4, D0 + 2, D0 + 3, z0, z0 + 8.8, "charcoal", {
          paint: (p, f) => {
            if (f !== "front") return null;
            const r = Math.hypot(p.x - cx, p.z - cz);
            if (r > 3.5) return null;
            if (r < 0.9) return ["cream", 0];
            for (const a of [0, 2.094, 4.189]) if (Math.hypot(p.x - cx - 2 * Math.cos(a + 0.5), p.z - cz - 2 * Math.sin(a + 0.5)) < 0.8) return ["charcoal", 2];
            return ["charcoal", r > 3 ? 0 : 1];
          },
        });
      }
    });
  });
  // A cactus in a pot on top.
  k.ell({ x: 17, y: 4.5, z: 0 }, { x: 2, y: 2, z: Infinity }, [-99, 99, -99, 99, H, H + 4], "rust");
  k.ell({ x: 17, y: 4.5, z: H + 4 }, { x: 1.3, y: 1.3, z: 5 }, [-99, 99, -99, 99, H + 4, H + 12], "olive", {
    paint: (p) => (Math.abs(Math.atan2(p.y - 4.5, p.x - 17)) % 1 < 0.25 ? ["olive", 2] : null),
  });
}

type Artwork = "dusk" | "tide";
/** Framed print for a wall. Two prints, same frame: a dusk mountain range, and a moonlit tide with a little boat. */
function wallFrame(k: Kit, art: Artwork): void {
  const x0 = -6, x1 = 6, z0 = 76, z1 = 108;
  k.box(x0, x1, 6.5, 8, z0, z1, "wood", {
    paint: (p, f) => {
      if (f !== "front") return f === "top" ? ["wood", 0] : ["wood", 2];
      const x = p.x, z = p.z;
      if (x < x0 + 1 || z >= z1 - 1.5) return ["wood", 0];
      if (x >= x1 - 1 || z < z0 + 1.5) return ["wood", 2];
      if (x < x0 + 1.75 || x >= x1 - 1.75 || z < z0 + 3 || z >= z1 - 3) return ["cream", 1]; // mat
      return art === "dusk" ? duskPrint(x, z - z0) : tidePrint(x, z - z0);
    },
  });
}
function duskPrint(x: number, z: number): Paint {
  const ridge1 = 10 + 5 * Math.abs(Math.sin((x + 6) * 0.42)) + (x > 0 ? 4 - x * 0.5 : 0);
  const ridge2 = 6 + 3 * Math.abs(Math.cos(x * 0.6));
  if (z < ridge2) return ["navy", 2];
  if (z < ridge1) return ["lilac", 2];
  const sx = x + 2, sz = z - 19;
  if (sx * sx * 2 + sz * sz < 14) return ["mustard", 0];
  if (z < 17) return ["pink", 1];
  if (z < 21) return Math.floor(x * 2 + z) % 2 === 0 ? ["pink", 1] : ["pink", 0];
  return ["pink", 0];
}
function tidePrint(x: number, z: number): Paint {
  const wave = 9 + 1.5 * Math.sin(x * 1.3);
  if (z < 5 + Math.sin(x * 1.9 + 1)) return ["navy", 2];
  if (z < wave) return Math.abs(z - wave + 1) < 0.6 ? ["glow", 0] : ["teal", 2];
  // A little sailboat on the swell.
  const bx = x + 1.5;
  if (z < wave + 1.6 && Math.abs(bx) < 2.4 - (wave + 1.6 - z) * 0.5) return ["rust", 1];
  if (Math.abs(bx + 0.2) < 0.5 && z < wave + 7) return ["cream", 2];
  if (bx > 0.3 && bx < 3 && z > wave + 2 && z < wave + 7 - bx * 1.3) return ["cream", 0];
  const mx = x - 2.5, mz = z - 22;
  if (mx * mx * 2 + mz * mz < 7) return ["cream", 0];
  if (hash(Math.floor(x * 2) + 40, Math.floor(z)) % 23 === 0) return ["glow", 0];
  return ["night", 1];
}

/** Popcorn cart: striped rust-and-cream body on spoked wheels, a glass case of popcorn, and a two-tier awning. */
function popcornCart(k: Kit): void {
  // Spoked wheel: brass hub and spokes, charcoal tyre.
  const wheel: LPaint = (p) => {
    const r = Math.hypot(p.y, p.z - 3.4);
    if (r < 0.9) return ["mustard", 0];
    if (r > 2.6) return ["charcoal", 2];
    return Math.abs(Math.sin(Math.atan2(p.z - 3.4, p.y) * 3)) < 0.35 ? ["mustard", 1] : ["charcoal", 1];
  };
  k.ell({ x: 6.3, y: 0, z: 3.4 }, { x: 0.9, y: 3.4, z: 3.4 }, [5.4, 7.2, -8, 8, 0, 8], "charcoal", { paint: wheel });
  k.box(-6, -5, -4, -3, 0, 2, "charcoal");
  const stripes: LPaint = (p, f) => {
    if (f === "top") return ["cream", 0];
    if (p.z > 14) return ["cream", f === "front" ? 1 : 2];
    if (p.z < 3.8) return ["rust", 2];
    const along = f === "front" ? p.x : p.y;
    return Math.floor((along + 20) / 2) % 2 === 0 ? ["rust", f === "front" ? 1 : 2] : ["cream", f === "front" ? 1 : 2];
  };
  k.box(-5.5, 5.5, -4, 4, 2, 16, "rust", { paint: stripes });
  const glass: LPaint = (p, f) => {
    if (f === "top") return ["rust", 0];
    const along = f === "front" ? p.x : p.y;
    const half = f === "front" ? 5 : 3.5;
    if (Math.abs(along) > half - 0.6 || p.z > 27.2) return ["rust", f === "front" ? 1 : 2];
    if (p.z < 22 + Math.sin(along * 1.7) * 0.8) {
      const pop = hash(Math.floor(along * 2) + 7, Math.floor(p.z * 1.4)) % 4;
      return pop === 0 ? ["mustard", 0] : pop === 1 ? ["cream", 1] : ["cream", 0];
    }
    if (Math.abs(along + (p.z - 24) * 0.8 + 2) < 0.5) return ["glow", 0];
    return ["glow", f === "front" ? 2 : 2];
  };
  k.box(-5, 5, -3.5, 3.5, 16, 28, "glow", { paint: glass });
  const awning: LPaint = (p, f) => {
    if (f === "top") return Math.floor((p.x + 20) / 2) % 2 === 0 ? ["rust", 0] : ["cream", 0];
    const along = f === "front" ? p.x : p.y;
    const t: Tone = f === "front" ? 1 : 2;
    return Math.floor((along + 20) / 2) % 2 === 0 ? ["rust", t] : ["cream", t];
  };
  k.box(-6.5, 6.5, -5, 5, 28, 30.5, "rust", { paint: awning });
  k.box(-4.5, 4.5, -3.5, 3.5, 30.5, 32.5, "rust", { paint: awning });
  k.ell({ x: 0, y: 0, z: 34 }, { x: 1.4, y: 1.4, z: 1.6 }, [-8, 8, -8, 8, 32.5, 40], "mustard");
}

// ---------------------------------------------------------------- catalogue v2 (OME-1103)

/** Floor cushions: two stacked square cushions (the top one button-tufted, cream-piped) and a striped bolster to lean on. */
function floorCushion(k: Kit, c: RampName): void {
  const ne = k.dir === "ne" || k.dir === "nw";
  const piping: LPaint = (p, f) => (f === "top" ? [c, 0] : Math.abs(p.z - 2.4) < 0.5 ? ["cream", f === "front" || f === "right" ? 1 : 2] : null);
  k.box(-7, 7, -7, 6, 0, 4.5, c, { paint: piping });
  const tuft: LPaint = (p, f) => {
    if (f !== "top") return p.z < 5.2 ? [c, 2] : null;
    const x = p.x, y = p.y + 0.5, d = Math.hypot(x, y);
    if (d < 0.9) return [c, 2];
    // Creases from the button toward each corner.
    if (d < 5 && Math.abs(Math.abs(x) - Math.abs(y)) < 0.5) return [c, 1];
    return null;
  };
  k.box(-6, 6, -6, 5, 4.5, SEAT_HEIGHT, c, { paint: tuft });
  for (const x of [-6.2, 5.2]) k.box(x, x + 1, -6.8, -5.8, 2.5, 5.5, "cream");
  const stripes: LPaint = (p) => (Math.floor((p.x + 20) / 2.5) % 2 === 0 ? [c, 1] : ["cream", 1]);
  k.ell({ x: 0, y: 4.8, z: SEAT_HEIGHT + 3 }, { x: Infinity, y: 2.6, z: 3.2 }, [-6.5, 6.5, 1, 8, SEAT_HEIGHT - 1, 20], "cream", { paint: stripes, front: ne });
}

/** Storage bench: a wood frame with woven cane panels, a long seat pad, and a folded throw over the front. */
function bench(k: Kit, c: RampName): void {
  const throwC: RampName = c === "teal" ? "mustard" : "lilac";
  for (const [x, y] of [[-7, -6], [22, -6], [-7, 5], [22, 5]] as const) k.box(x, x + 1, y, y + 1, 0, 1.5, "wood");
  const cane: LPaint = (p, f) => {
    if (f === "top") return ["wood", 0];
    const along = f === "front" || f === "back" ? p.x : p.y;
    const inPanel = f === "front" || f === "back"
      ? (along > -5.5 && along < 6.5) || (along > 9.5 && along < 21.5)
      : Math.abs(along) < 4.5;
    if (!inPanel || p.z < 2.6 || p.z > 5.2) return null;
    const t: Tone = f === "front" ? 1 : 2;
    return (Math.floor(along * 2) + Math.floor(p.z * 2)) % 2 === 0 ? ["mustard", t] : ["mustard", t === 1 ? 0 : 1];
  };
  k.box(-7.5, 23.5, -6.5, 6.5, 1.5, 6, "wood", { paint: cane });
  const pad: LPaint = (p, f) => {
    if (f === "top") return Math.abs(p.x - 8) < 0.5 ? [c, 2] : [c, 0];
    return p.z < 6.6 ? [c, 2] : null;
  };
  k.box(-7, 23, -6, 6, 6, SEAT_HEIGHT, c, { paint: pad });
  const ne = k.dir === "ne" || k.dir === "nw";
  // The throw: folded over the far end of the pad and down its side, fringed at the bottom.
  const fringe: LPaint = (p, f) => {
    if (f === "top") return Math.abs(p.y) < 0.5 ? ["cream", 0] : [throwC, 0];
    if (p.z < 3.4) return Math.floor((p.y + 20) * 2) % 2 === 0 ? ["cream", 1] : null;
    return Math.abs(p.y) < 0.5 ? ["cream", 0] : null;
  };
  k.box(19.5, 24, -5, 5, 2.4, SEAT_HEIGHT + 0.6, throwC, { paint: fringe, front: true });
  // A square pillow between the two seats, leaning on the wall side, with a button.
  const pillow: LPaint = (p, f) => (f !== "top" && Math.hypot(p.x - 8, p.z - 12) < 0.8 ? [throwC, 2] : f === "top" ? [throwC, 0] : null);
  k.box(4.5, 11.5, 3.5, 6.5, SEAT_HEIGHT, 15.5, throwC, { paint: pillow, front: ne });
}

/** Floating wall shelf on iron brackets: a trailing pothos, three books and a candle. */
function wallShelf(k: Kit): void {
  const Z = 76;
  k.box(-7, 7, 3, 8, Z - 2, Z, "wood", { paint: (p, f) => (f === "top" ? ["wood", 0] : p.z < Z - 1.4 ? ["wood", 2] : null) });
  for (const x of [-4.5, 4]) for (const [y0, z0] of [[7, Z - 6], [6, Z - 4], [5, Z - 3]] as const) k.box(x, x + 0.8, y0, 8, z0, Z - 2, "charcoal");
  // Pothos: a cream pot with a teal band, a leafy mound and two vines over the edge.
  k.ell({ x: -4.5, y: 5.5, z: 0 }, { x: 1.9, y: 1.9, z: Infinity }, [-99, 99, -99, 99, Z, Z + 4], "cream", {
    paint: (p, f) => (f !== "top" && p.z > Z + 1.4 && p.z < Z + 2.4 ? ["teal", 1] : null),
  });
  const leafy: LPaint = (p) => (hash(Math.floor(p.x * 1.5) + 9, Math.floor(p.z * 1.2 + p.y)) % 3 === 0 ? ["olive", 0] : null);
  k.ell({ x: -4.5, y: 5.5, z: Z + 4.4 }, { x: 2.8, y: 2.4, z: 2.6 }, [-99, 99, -99, 99, Z + 3.6, Z + 9], "olive", { paint: leafy });
  for (const [x, len] of [[-6.4, 13], [-3, 8]] as const) {
    for (let z = Z - 1; z > Z - len; z -= 1.2) {
      const side = Math.floor(z) % 2 === 0 ? -0.8 : 0.8;
      k.box(x - 0.4, x + 0.4, 2.4, 3.2, z - 1.2, z, "olive", { tones: { top: 2, sw: 2, se: 2 } });
      k.box(x + side - 0.6, x + side + 0.6, 2.2, 3.2, z - 1.1, z - 0.2, "olive");
    }
  }
  // Books: rust, navy and mustard, standing; then a candle with a glow flame.
  ([[-1.6, "rust", 9], [-0.2, "navy", 10.5], [1.2, "mustard", 8.5]] as const).forEach(([x, ramp, h]) => {
    k.box(x, x + 1.3, 4.2, 7.6, Z, Z + h, ramp, { paint: (p, f) => (f !== "top" && Math.abs(p.z - Z - h * 0.75) < 0.5 ? ["cream", 0] : null) });
  });
  k.ell({ x: 4.8, y: 5.5, z: 0 }, { x: 1, y: 1, z: Infinity }, [-99, 99, -99, 99, Z, Z + 4.5], "cream");
  k.ell({ x: 4.8, y: 5.5, z: Z + 6.2 }, { x: 0.7, y: 0.7, z: 1.5 }, [-99, 99, -99, 99, Z + 4.5, Z + 8], "glow", { tones: { top: 0, sw: 0, se: 0 } });
}

/** One wall segment of string lights. The wire meets the next segment at the same height, so garlands in a row join up. */
const GARLAND_BULBS: Record<string, readonly RampName[]> = { warm: ["glow", "mustard"], party: ["pink", "teal", "mustard", "lilac"] };
function garland(k: Kit, colour: string): void {
  const bulbs = GARLAND_BULBS[colour] ?? ["glow"];
  const wire = (x: number): number => 112 - 7 * (1 - (x / 8) ** 2);
  for (let x = -8; x < 8; x += 0.5) k.box(x, x + 0.5, 7.3, 8, wire(x + 0.25) - 0.6, wire(x + 0.25) + 0.3, "charcoal");
  // Bulbs every 4 units (so the spacing holds across segments), hanging a little below the wire.
  [-6, -2, 2, 6].forEach((x, i) => {
    const z = wire(x);
    k.box(x - 0.4, x + 0.4, 6.5, 7.3, z - 1.4, z - 0.4, "charcoal");
    const ramp = bulbs[i % bulbs.length] ?? "glow";
    k.ell({ x, y: 6.6, z: z - 3.2 }, { x: 1.5, y: 1.5, z: 1.8 }, [-99, 99, -99, 99, z - 6, z - 1.4], ramp, { tones: { top: 0, sw: 0, se: 1 } });
  });
}

/** Record console: a mid-century cabinet (grille + drawers) with a turntable on top and a stack of sleeves beside it. */
function recordConsole(k: Kit, n = 0): void {
  for (const [x, y] of [[-6, -4], [5, -4], [-6, 3], [5, 3]] as const) k.box(x, x + 1, y, y + 1, 0, 4, "wood", { tones: { top: 0, sw: 2, se: 2 } });
  const front: LPaint = (p, f) => {
    if (f === "top") return ["wood", 0];
    if (f !== "front") return null;
    if (p.z < 5 || p.z > 14 || Math.abs(p.x) < 0.5 || Math.abs(p.x) > 6.5) return ["wood", 1];
    if (p.x < 0) return (Math.floor(p.x * 2) + Math.floor(p.z * 2)) % 2 === 0 ? ["cream", 2] : ["cream", 1];
    if (Math.abs(p.z - 9.5) < 0.4) return ["wood", 2];
    if (Math.abs(p.x - 3.5) < 0.6 && (Math.abs(p.z - 12) < 0.6 || Math.abs(p.z - 7) < 0.6)) return ["mustard", 0];
    return null;
  };
  k.box(-7, 7, -5, 5, 4, 15, "wood", { paint: front });
  k.box(-6.5, 2, -4.5, 4.5, 15, 16.5, "charcoal");
  const vinyl: LPaint = (p, f) => {
    if (f !== "top") return ["charcoal", 2];
    const dx = p.x + 2.2, r = Math.hypot(dx, p.y);
    if (r < 0.4) return ["cream", 0];
    // In use the record turns: a dot on the label and a glint across the grooves step a quarter turn per frame.
    const a = Math.atan2(p.y, dx) - (n * Math.PI) / 2, da = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
    if (n > 0 && r < 1.3) return r > 0.6 && da < 0.9 ? ["cream", 1] : ["rust", 0];
    if (r < 1.3) return ["rust", 0];
    if (n > 0 && r > 1.6 && r < 3.1 && Math.abs(da - Math.PI) < 0.45) return ["charcoal", 0];
    return Math.abs(r - 2.4) < 0.3 ? ["charcoal", 0] : ["hairDark", 1];
  };
  k.ell({ x: -2.2, y: 0, z: 0 }, { x: 3.4, y: 3.4, z: Infinity }, [-99, 99, -99, 99, 16.5, 17.4], "hairDark", { paint: vinyl });
  k.ell({ x: 1, y: 3, z: 0 }, { x: 0.8, y: 0.8, z: Infinity }, [-99, 99, -99, 99, 16.5, 18.6], "mustard");
  k.box(0.6, 1.3, -0.6, 3, 18, 18.6, "mustard");
  k.box(0.2, 1.4, -1.6, -0.6, 17.6, 18.6, "mustard");
  const sleeves: RampName[] = ["pink", "teal", "mustard", "navy", "cream", "rust"];
  sleeves.forEach((ramp, i) => {
    const y = -4 + i * 1.3, h = 6 + (hash(i, 21) % 3);
    k.box(3, 6.5, y, y + 1.1, 15, 15 + h, ramp, { paint: (p, f) => (f !== "top" && Math.abs(p.z - 15 - h * 0.55) < 0.8 && Math.abs(p.x - 4.75) < 0.8 ? ["cream", 0] : null) });
  });
}

/** Floor speaker on splayed legs: woofer, tweeter and port on a fabric baffle, framed in the cabinet colour. */
function floorSpeaker(k: Kit, c: RampName): void {
  for (const [x, y] of [[-4, -3], [3, -3], [-4, 2], [3, 2]] as const) k.box(x, x + 1, y, y + 1, 0, 3, "charcoal");
  const baffle: LPaint = (p, f) => {
    if (f === "top") return [c, 0];
    if (f !== "front") return null;
    if (Math.abs(p.x) > 3.5 || p.z < 4.5 || p.z > 34.5) return null;
    const w = Math.hypot(p.x * 2, p.z - 13);
    if (w < 1.6) return ["charcoal", 0];
    if (w < 5.6) return ["charcoal", 2];
    if (w < 6.6) return ["mustard", 1];
    const t = Math.hypot(p.x * 2, p.z - 26);
    if (t < 1) return ["cream", 0];
    if (t < 2.6) return ["mustard", 1];
    if (Math.abs(p.z - 31.5) < 0.6 && Math.abs(p.x) < 1.6) return ["outline", 1];
    return ["charcoal", 1];
  };
  k.box(-4.5, 4.5, -3.5, 3.5, 3, 36, c, { paint: baffle });
}

// ---------------------------------------------------------------- catalogue v3 (OME-1348): same parts and ramps, six more pieces

/** Low coffee table: the console's square legs, a magazine shelf, and a book stack, a remote and a mug on top. */
function coffeeTable(k: Kit): void {
  for (const [x, y] of [[-6.5, -4.5], [5.5, -4.5], [-6.5, 3.5], [5.5, 3.5]] as const) k.box(x, x + 1, y, y + 1, 0, 9, "wood", { tones: { top: 0, sw: 2, se: 2 } });
  k.box(-6, 6, -4, 4, 3, 4, "wood", { tones: { top: 1, sw: 2, se: 2 } });
  k.box(-4.5, 1.5, -3, 2.5, 4, 5, "pink", { paint: (p, f) => (f === "top" && Math.abs(p.y + 1.6) < 0.5 ? ["cream", 0] : null) });
  k.box(-7.5, 7.5, -5.5, 5.5, 9, 11, "wood", { paint: (p, f) => (f !== "top" && p.z < 9.8 ? ["wood", 2] : null) });
  const band: LPaint = (p, f) => (f !== "top" && Math.abs(p.z - 11.7) < 0.4 ? ["cream", 0] : null);
  k.box(-5.5, -0.5, -3.5, 2, 11, 12.4, "navy", { paint: band });
  k.box(-5, -1, -3, 1.5, 12.4, 13.6, "rust", { paint: (p, f) => (f === "top" && Math.abs(p.x + 3) < 0.5 ? ["cream", 0] : null) });
  k.box(1, 5, -4, -2.8, 11, 11.8, "charcoal", { paint: (p, f) => (f === "top" && Math.floor(p.x * 1.2) % 2 === 0 ? ["rust", 0] : null) });
  k.ell({ x: 3.6, y: 1.8, z: 0 }, { x: 1.2, y: 1.2, z: Infinity }, [-8, 8, -8, 8, 11, 14.5], "teal", { paint: (_p, f) => (f === "top" ? ["hairDark", 0] : null) });
  k.box(4.6, 5.4, 1.4, 2.2, 11.8, 13.6, "teal");
}

/** Knitted pouf: a squat drum with cable-knit ribs, a cream welt round the middle and a button on the top. */
function pouf(k: Kit, c: RampName): void {
  const knit: LPaint = (p, f) => {
    // The top is eight knitted wedges, alternately catching the light, round a cream button.
    if (f === "top") return Math.hypot(p.x, p.y) < 1.1 ? ["cream", 0] : Math.floor((Math.atan2(p.y, p.x) * 4) / Math.PI + 8) % 2 === 0 ? [c, 0] : [c, 1];
    if (Math.abs(p.z - 4) < 0.6) return ["cream", 1];
    // Chevrons: rib stripes that zig-zag, one row of knit per 2 units of height.
    const a = Math.atan2(p.y, p.x) * 4;
    return Math.floor(a + (Math.floor(p.z / 2) % 2 === 0 ? 0.5 : 0) + 40) % 2 === 0 ? [c, 2] : null;
  };
  k.ell({ x: 0, y: 0, z: 0 }, { x: 6.4, y: 6.4, z: Infinity }, [-8, 8, -8, 8, 0, SEAT_HEIGHT - 1], c, { paint: knit });
  k.ell({ x: 0, y: 0, z: SEAT_HEIGHT - 1.6 }, { x: 6.4, y: 6.4, z: 1.8 }, [-8, 8, -8, 8, SEAT_HEIGHT - 1, SEAT_HEIGHT + 1], c, { paint: knit });
}

/** Neon sign on a smoked backplate: a little TV with a play mark, one tube colour per variant, brass stand-offs at the corners. */
function neonSign(k: Kit, c: RampName, n = 0): void {
  const X0 = -7, X1 = 7, Z0 = 82, Z1 = 102;
  // Distance to the tube path in the wall plane: a rounded screen, two antennae and a play triangle inside.
  const seg = (x: number, z: number, ax: number, az: number, bx: number, bz: number): number => {
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(x - ax - t * dx, z - az - t * dz);
  };
  const tube = (x: number, z: number): number => {
    const rx = Math.max(Math.abs(x) - 3.5, 0), rz = Math.max(Math.abs(z - 90.5) - 3, 0);
    const screen = Math.abs(Math.hypot(rx, rz) - 1.8);
    const ant = Math.min(seg(x, z, -0.6, 95.3, -2.6, 99), seg(x, z, 0.6, 95.3, 2.6, 99));
    const play = Math.min(seg(x, z, -1.1, 89, -1.1, 92), seg(x, z, -1.1, 89, 1.6, 90.5), seg(x, z, -1.1, 92, 1.6, 90.5));
    return Math.min(screen, ant, play);
  };
  const antenna = (x: number, z: number): boolean => Math.min(seg(x, z, -0.6, 95.3, -2.6, 99), seg(x, z, 0.6, 95.3, 2.6, 99)) < 1.9 && z > 96.4;
  const halo = n === 1 ? 1.5 : n === 2 ? 1.1 : 1.3;
  k.box(X0, X1, 7, 8, Z0, Z1, "night", {
    paint: (p, f) => {
      if (f !== "front") return f === "top" ? ["night", 0] : ["night", 2];
      if ((Math.abs(p.x - X0 - 1) < 0.6 || Math.abs(p.x - X1 + 1) < 0.6) && (Math.abs(p.z - Z0 - 1.5) < 0.8 || Math.abs(p.z - Z1 + 1.5) < 0.8)) return ["mustard", 0];
      const d = tube(p.x, p.z);
      // In use the tube hums: the halo swells and shrinks, and the antennae blink out for a frame (a clean gap above the screen).
      if (n === 3 && antenna(p.x, p.z)) return ["night", 1];
      if (d < 0.4) return n === 2 ? [c, 0] : ["cream", 0];
      if (d < 0.9) return [c, 0];
      if (d < halo) return [c, 2];
      // A dark gap round the glow keeps the glyph apart from the plate at 1×.
      if (d < 1.9) return ["outline", 1];
      return ["night", 1];
    },
  });
}

/** Fish tank on a wood stand: gravel, a swaying weed, two fish and a stream of bubbles behind glass, under a charcoal lid. */
function aquarium(k: Kit, n = 0): void {
  k.box(-7, 7, -4.5, 4.5, 0, 1.5, "charcoal");
  const doors: LPaint = (p, f) => {
    if (f === "top") return ["wood", 0];
    if (f !== "front") return null;
    if (Math.abs(p.x) < 0.4) return ["wood", 2];
    return Math.abs(Math.abs(p.x) - 1.4) < 0.5 && Math.abs(p.z - 8) < 1 ? ["mustard", 0] : null;
  };
  k.box(-6.5, 6.5, -4, 4, 1.5, 12, "wood", { paint: doors });
  const water: LPaint = (p, f) => {
    if (f === "top") return ["teal", 0];
    const along = f === "front" ? p.x : p.y;
    const t: Tone = f === "front" ? 1 : 2;
    if (Math.abs(along) > (f === "front" ? 6.4 : 3.4)) return ["glow", 2]; // glass edge
    if (p.z < 14 + Math.sin(along * 1.4) * 0.5) return hash(Math.floor(along * 2) + 3, Math.floor(p.z * 2)) % 3 === 0 ? ["mustard", 1] : ["cream", 2];
    if (f === "front") {
      const fish = (cx: number, cz: number, ramp: RampName): Paint | null => {
        const dx = p.x - cx, dz = p.z - cz;
        if (dx * dx * 0.5 + dz * dz * 2 < 1.6) return Math.abs(dx - 0.6) < 0.3 && dz > 0 ? ["outline", 1] : [ramp, 0];
        if (dx < -1.4 && dx > -2.6 && Math.abs(dz) < (-dx - 1.4) * 0.9) return [ramp, 1];
        return null;
      };
      const hit = fish(2.5, 22, "ginger") ?? fish(-3, 18, "pink");
      if (hit) return hit;
      if (Math.abs(p.x + 4.5 + Math.sin(p.z * 0.6) * 0.8) < 0.6 && p.z < 23) return ["olive", 0];
      // In use the bubble stream rises one unit per frame (three frames make the 3-unit pitch loop).
      if (Math.abs(p.x - 4.8) < 0.5 && Math.floor(p.z - n) % 3 === 0 && p.z > 15) return ["glow", 0];
    }
    if (p.z > 26.6) return ["glow", 1];
    return ["teal", t];
  };
  k.box(-6.8, 6.8, -3.8, 3.8, 12, 27.5, "teal", { paint: water });
  k.box(-7, 7, -4, 4, 27.5, 29, "charcoal", { paint: (p, f) => (f === "top" && Math.abs(p.x - 3) < 1.5 && Math.abs(p.y) < 1 ? ["charcoal", 2] : null) });
}

/** Arcade cabinet: a night-blue body with lilac side stripes, a joystick deck, a screen mid-game and a lit marquee. */
function arcade(k: Kit, n = 0): void {
  const side: LPaint = (p, f) => {
    if (f === "top") return ["night", 0];
    if (f === "right" && Math.abs(p.y - p.z * 0.25 + 4) < 1.2) return ["lilac", 1];
    return null;
  };
  k.box(-6, 6, -3, 5, 0, 22, "night", {
    paint: (p, f) => {
      if (f === "front" && p.z > 6 && p.z < 12 && Math.abs(p.x) < 2) return Math.abs(p.z - 9) < 0.5 && Math.abs(p.x) < 1 ? ["glow", 0] : ["charcoal", 2]; // coin door
      return side(p, f);
    },
  });
  const deck: LPaint = (p, f) => {
    if (f !== "top") return f === "front" ? ["charcoal", 1] : side(p, f);
    for (const [bx, ramp] of [[1.5, "pink"], [3.3, "teal"], [5, "mustard"]] as const) if (Math.hypot(p.x - bx + 1, p.y + 3.5) < 0.8) return [ramp, 0];
    return ["charcoal", 0];
  };
  k.box(-6, 6, -6, 5, 22, 24, "charcoal", { paint: deck });
  k.ell({ x: -3, y: -4, z: 0 }, { x: 0.4, y: 0.4, z: Infinity }, [-8, 8, -8, 8, 24, 26], "charcoal");
  k.ell({ x: -3, y: -4, z: 26.6 }, { x: 0.9, y: 0.9, z: 0.9 }, [-8, 8, -8, 8, 25.6, 28], "rust");
  const screen: LPaint = (p, f) => {
    if (f !== "front") return side(p, f);
    if (Math.abs(p.x) > 5 || p.z < 25.5 || p.z > 38) return ["night", 1];
    const gx = Math.floor((p.x + 5) * 1.2), gz = Math.floor((p.z - 25.5) * 1.2);
    // A 12×15 game: two rows of invaders, a ship and its shot. In use the invaders step side to side, the shot climbs
    // and a bright scan band rolls down the glass.
    const ix = gx + 3 - (n % 2);
    if (gx === 5 && gz === (n === 0 ? 4 : 3 + n * 2)) return ["cream", 0];
    if (gz >= 11 && gz <= 13 && (ix % 3 === 1 || (gz === 12 && ix % 3 !== 2))) return gz === 13 ? ["pink", 0] : ["pink", 1];
    if (gz >= 7 && gz <= 8 && (ix + 1) % 4 !== 3) return ["mustard", 0];
    if (gz <= 1 && Math.abs(gx - 5) <= 1 - gz + 1) return ["teal", 0];
    if (n > 0 && gz === 15 - n * 4) return ["night", 0];
    return hash(gx, gz + n * 7) % 29 === 0 ? ["glow", 2] : ["outline", 1];
  };
  k.box(-6, 6, -1, 5, 24, 39, "night", { paint: screen });
  const marquee: LPaint = (p, f) => {
    if (f !== "front") return f === "top" ? ["night", 0] : side(p, f);
    if (p.z < 40 || p.z > 44.5 || Math.abs(p.x) > 5) return ["night", 1];
    return Math.abs(p.z - 42.2 - Math.sin(p.x * 1.1) * 1.2) < 0.7 ? ["pink", 0] : ["glow", 0];
  };
  k.box(-6, 6, -2.5, 5, 39, 45.5, "night", { paint: marquee });
}

/** Sunburst wall clock: a cream face in a dark rim with four soft ticks and bold hands on a brass hub, eight rays in light and mid tone. */
function wallClock(k: Kit): void {
  const CZ = 94;
  // Eight thick brass rays, long and short in turn, stepped down in width so they taper (a wall slant squashes thin ones).
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const len = i % 2 === 0 ? 10.5 : 8.5;
    for (let r = 5; r < len; r += 0.5) {
      const w = r < len - 2.5 ? 1.3 : r < len - 1 ? 0.9 : 0.6;
      // Long rays catch the light, short ones a mid tone (the darkest mustard went muddy next to the other brass props).
      k.box(Math.cos(a) * r - w, Math.cos(a) * r + w, 7.4, 8, CZ + Math.sin(a) * r - w, CZ + Math.sin(a) * r + w, "mustard", { tones: i % 2 === 0 ? { top: 0, sw: 0, se: 1 } : { top: 1, sw: 1, se: 2 } });
    }
  }
  const face: LPaint = (p, f) => {
    if (f === "top") return ["mustard", 0];
    const x = p.x, z = p.z - CZ, r = Math.hypot(x, z);
    if (r > 4.6) return ["mustard", r > 5.2 ? 2 : 1];
    if (r > 3.9) return ["wood", 2]; // dark rim between the brass bezel and the face
    if (r < 0.5) return ["mustard", 0];
    // Ticks at 12, 3, 6 and 9 in a soft brown at the rim, so at 1× only the dark hands read as hands.
    if (r > 3.2 && (Math.abs(x) < 0.55 || Math.abs(z) < 0.55)) return ["wood", 1];
    // Ten past ten: bold dark hands that stop short of the ticks, leaving a cream gap.
    const onHand = (t: number, l: number): boolean => r < l && Math.abs(x * Math.sin(t) - z * Math.cos(t)) < 0.55 && x * Math.cos(t) + z * Math.sin(t) > 0;
    if (onHand((Math.PI * 5) / 6, 2.2) || onHand(Math.PI / 6, 3)) return ["outline", 1];
    return ["cream", 0];
  };
  k.ell({ x: 0, y: 7, z: CZ }, { x: 5.6, y: Infinity, z: 5.6 }, [-8, 8, 6.4, 8, 0, 200], "cream", { paint: face });
}

// ---------------------------------------------------------------- doors (OME-1424): the bookcase's wall-backed build, the print's frame trims

/** Panel door in a cased frame, flush on the wall it backs onto. Wood: a stained six-panel slab. Painted: teal, panels shaded
 *  in its own ramp. Open: the slab swings 90° into the room on its left hinges, so the doorway shows a dark hall with a lit sill. */
function door(k: Kit, painted: boolean, open: boolean): void {
  const X0 = -6, X1 = 6, H = 74, T = 1.6; // opening, then the casing's width
  const slabC: RampName = painted ? "teal" : "wood";
  // Casing: lit on the top-left edges and in shade on the bottom-right ones, like the framed print's trim.
  const trim: LPaint = (p, f) => (f === "top" ? ["wood", 0] : f !== "front" ? ["wood", 2] : p.x < X0 - T + 0.8 || p.z >= H + T - 0.8 ? ["wood", 0] : p.x >= X1 + T - 0.8 ? ["wood", 2] : null);
  k.box(X0 - T, X0, 5.5, 8, 0, H, "wood", { paint: trim });
  k.box(X1, X1 + T, 5.5, 8, 0, H, "wood", { paint: trim });
  k.box(X0 - T - 0.6, X1 + T + 0.6, 5, 8, H, H + T + 0.6, "wood", { paint: trim });
  // Sill: a brass threshold strip.
  k.box(X0, X1, 5.5, 8, 0, 0.8, "mustard", { tones: { top: 0, sw: 1, se: 2 } });
  // Panels: 2 columns × 3 rows of recessed fields on each face; the edge of a field is the beading.
  const panel = (x: number, z: number, x0: number, x1: number): Paint | null => {
    const cols = [[x0 + 1.4, (x0 + x1) / 2 - 0.7], [(x0 + x1) / 2 + 0.7, x1 - 1.4]] as const;
    const rows = [[4, 26], [29, 51], [54, H - 4]] as const;
    for (const [a, b] of cols) for (const [c, d] of rows) {
      if (x < a || x >= b || z < c || z >= d) continue;
      const edge = x < a + 0.7 || z >= d - 0.7 ? 2 : x >= b - 0.7 || z < c + 0.7 ? 0 : -1; // a groove: shadow top-left, catch-light bottom-right
      return edge === -1 ? [slabC, 1] : [slabC, edge];
    }
    return [slabC, 0];
  };
  const knob = (x: number, z: number, kx: number): Paint | null => (Math.hypot(x - kx, z - 36) < 1.1 ? ["mustard", 0] : Math.hypot(x - kx, z - 36) < 1.7 ? ["outline", 1] : Math.abs(x - kx) < 0.6 && Math.abs(z - 33.5) < 0.6 ? ["outline", 1] : null);
  if (!open) {
    k.box(X0, X1, 6.5, 8, 0.8, H, slabC, {
      paint: (p, f) => (f === "front" ? knob(p.x, p.z, X1 - 1.8) ?? panel(p.x, p.z, X0, X1) : f === "top" ? [slabC, 0] : [slabC, 2]),
    });
    return;
  }
  // The doorway: a dark hall, deeper toward the top, with lamplight on the floor.
  k.box(X0, X1, 7.4, 8, 0.8, H, "night", {
    paint: (p) => (p.z < 4 ? ["mustard", 2] : p.z < 9 && (Math.floor(p.x * 2 + p.z) & 1) === 0 ? ["night", 0] : p.z < 9 ? ["night", 1] : p.z > H - 22 ? ["outline", 1] : ["night", 2]),
  });
  // The slab swung open on the left hinges: we see its room-side face edge-on and its inner face.
  const w = X1 - X0;
  k.box(X0, X0 + 1.5, 6.5 - w, 6.5, 0.8, H, slabC, {
    paint: (p, f) => (f === "right" ? knob(-p.y, p.z, -(6.5 - w) - 1.8) ?? panel(-p.y, p.z, -6.5, w - 6.5) : f === "top" ? [slabC, 0] : [slabC, 2]),
  });
  // Brass hinge knuckles on the jamb.
  for (const z of [12, H - 12]) k.box(X0 - 0.4, X0 + 0.4, 6, 6.8, z - 2, z + 2, "mustard", { tones: { top: 0, sw: 0, se: 1 } });
}

// ---------------------------------------------------------------- batch 6 (OME-1437): hammock, stool, bar counter, piano, fireplace

/** Hammock on a bent-wood stand: a striped sling (rust or teal, cream and mustard) that sags between two spreader bars,
 *  hung by cord fans from brass hooks. In use it sways: the sling's belly and its fringe swing sideways, the ends stay put. */
function hammock(k: Kit, c: RampName, n = 0): void {
  // Stand: a floor runner with two cross feet and an arm rising and leaning out at each end.
  k.box(-6, 22, -1, 1, 0, 1.5, "wood", { tones: { top: 0, sw: 1, se: 2 } });
  for (const x of [-7.5, 20.5]) k.box(x, x + 3, -6, 6, 0, 1.5, "wood");
  for (const [x0, dx] of [[-5.5, -1], [21.5, 1]] as const) {
    for (let t = 0; t <= 1; t += 0.05) k.box(x0 + dx * 2 * t - 0.7, x0 + dx * 2 * t + 0.7, -0.7, 0.7, 1.5 + 20 * t, 2.7 + 20 * t, "wood");
    k.box(x0 + dx * 2 - 0.5, x0 + dx * 2 + 0.5, -0.5, 0.5, 22.2, 23.4, "mustard", { tones: { top: 0, sw: 0, se: 1 } });
  }
  const X0 = -3, X1 = 19, sag = (x: number): number => 6 + 0.036 * (x - 8) ** 2;
  const zEnd = sag(X0);
  // Sway [+1, 0, −1, 0]: the belly moves most, the ends not at all; the fringe lags a little further.
  const s = Math.round(Math.sin((n * Math.PI) / 2));
  const dy = (x: number): number => 0.9 * s * (zEnd - sag(x)) / (zEnd - sag(8));
  const stripe = (y: number): Paint => {
    const b = Math.floor((y + 5) / 2);
    return b === 2 ? ["mustard", 0] : b % 2 === 0 ? [c, 0] : ["cream", 0];
  };
  for (let x = X0; x < X1; x += 1) {
    const xc = x + 0.5, d = dy(xc);
    for (let y = -5; y < 5; y += 2) {
      const top = sag(xc) + 0.07 * (y + 1) ** 2;
      k.box(x, x + 1, y + d, y + 2 + d, top - 1.2, top, c, {
        // Step faces between slices take the stripe's own tone, so the sling reads as one smooth cloth; only its edges shade.
        paint: (p, f) => (f === "top" || Math.abs(p.y - d) < 4.9 ? stripe(p.y - d) : [stripe(p.y - d)[0], 2]),
      });
    }
    // Fringe: cream tassels every other unit along both long edges.
    if (Math.round(xc + 0.5) % 2 === 0 && xc > X0 + 1 && xc < X1 - 1) {
      for (const y of [-5.6, 5]) {
        const top = sag(xc) + 0.07 * (y + 1) ** 2 - 1;
        k.box(x + 0.2, x + 0.8, y + d, y + 0.6 + d, top - 1.6, top, "cream", { tones: { top: 0, sw: 1, se: 2 } });
        k.box(x + 0.2, x + 0.8, y + d * 1.6, y + 0.6 + d * 1.6, top - 3.2, top - 1.6, "cream", { tones: { top: 0, sw: 1, se: 2 } });
      }
    }
  }
  // Spreader bars and the cord fans up to the hooks.
  for (const [xb, xh] of [[X0 - 0.5, -7.5], [X1 + 0.5, 23.5]] as const) {
    k.box(xb - 0.5, xb + 0.5, -6, 6, zEnd + 0.4, zEnd + 1.6, "wood", { tones: { top: 0, sw: 1, se: 2 } });
    for (const y of [-5, 0, 5]) {
      for (let t = 0; t < 1; t += 0.08) {
        const x = xb + (xh - xb) * t, yy = y * (1 - t), z = zEnd + 1.6 + (22.2 - zEnd - 1.6) * t;
        k.box(x - 0.3, x + 0.3, yy - 0.3, yy + 0.3, z - 0.4, z + 0.4, "cream", { tones: { top: 1, sw: 1, se: 2 } });
      }
    }
  }
}

/** Low stool. Wood: a woven rush seat in a wood rim on three splayed legs. Padded (teal): a buttoned cushion with cream piping
 *  on four charcoal legs and a brass foot ring. */
function stool(k: Kit, colour: string): void {
  const padded = colour !== "wood";
  const c: RampName = padded ? asRamp(colour) : "wood";
  const legC: RampName = padded ? "charcoal" : "wood";
  const legs = padded ? [0.785, 2.356, 3.927, 5.498] : [1.9, 4.0, 6.1];
  for (const a of legs) {
    for (let z = 0; z < 6.5; z += 0.5) {
      const r = 5 - z * 0.3;
      k.box(Math.cos(a) * r - 0.6, Math.cos(a) * r + 0.6, Math.sin(a) * r - 0.6, Math.sin(a) * r + 0.6, z, z + 0.5, legC, { tones: { top: 0, sw: 1, se: 2 } });
    }
  }
  if (!padded) {
    k.ell({ x: 0, y: 0, z: 0 }, { x: 5.8, y: 5.8, z: Infinity }, [-8, 8, -8, 8, 6, SEAT_HEIGHT], "wood", {
      paint: (p, f) => {
        if (f !== "top") return p.z < 6.8 ? ["wood", 2] : null;
        // Rush weave inside the rim: diagonal mustard bands that catch the light in turn.
        if (Math.hypot(p.x, p.y) > 4.6) return null;
        return Math.floor((p.x + p.y + 20) / 1.5) % 2 === 0 ? ["mustard", 0] : ["mustard", 1];
      },
    });
    return;
  }
  for (let a = 0; a < 2 * Math.PI; a += 0.2) k.box(Math.cos(a) * 4.1 - 0.4, Math.cos(a) * 4.1 + 0.4, Math.sin(a) * 4.1 - 0.4, Math.sin(a) * 4.1 + 0.4, 2.4, 3, "mustard", { tones: { top: 0, sw: 0, se: 1 } });
  k.ell({ x: 0, y: 0, z: 0 }, { x: 5.4, y: 5.4, z: Infinity }, [-8, 8, -8, 8, 5.8, 6.6], "charcoal");
  k.ell({ x: 0, y: 0, z: 6.4 }, { x: 5.8, y: 5.8, z: 1.8 }, [-8, 8, -8, 8, 6.6, SEAT_HEIGHT + 0.4], c, {
    paint: (p, f) => (f !== "top" ? (p.z < 7.2 ? ["cream", 1] : null) : Math.hypot(p.x, p.y) < 0.8 ? [c, 2] : null),
  });
}

/** Bar counter for a wall: a teal tongue-and-groove front in a wood frame over a charcoal kick, a brass foot rail, a slate top with a brass
 *  edge, and on it a jar of lemons, two tumblers and a service bell. */
function barCounter(k: Kit): void {
  const W0 = -7.5, W1 = 23.5, H = 28;
  k.box(W0 + 0.5, W1 - 0.5, -3.5, 7, 0, 1.5, "charcoal");
  const slats: LPaint = (p, f) => {
    if (f === "top") return ["wood", 0];
    if (f !== "front") return null;
    if (p.x < W0 + 2 || p.x > W1 - 2 || p.z > H - 2.5 || Math.abs(p.x - 8) < 0.8) return null;
    return Math.abs(((p.x + 40) % 2.5) - 1.25) > 0.95 ? ["teal", 2] : ["teal", 1];
  };
  k.box(W0 + 0.5, W1 - 0.5, -4, 7.5, 1.5, H, "wood", { paint: slats });
  // Foot rail on three brass brackets.
  k.ell({ x: 0, y: -6, z: 3.6 }, { x: Infinity, y: 0.7, z: 0.7 }, [W0 + 1.5, W1 - 1.5, -8, 8, 0, 9], "mustard");
  for (const x of [W0 + 2, 8, W1 - 3]) k.box(x, x + 1, -6, -4, 3.2, 4, "mustard", { tones: { top: 0, sw: 1, se: 2 } });
  k.box(W0, W1, -5.5, 8, H, H + 2, "charcoal", {
    paint: (p, f) => (f === "top" ? (Math.abs(p.y + 5) < 0.5 ? ["charcoal", 1] : ["charcoal", 0]) : f === "front" ? ["mustard", p.z > H + 1 ? 0 : 1] : null),
  });
  // Jar of lemons: glass over yellow fruit, a cork lid.
  k.ell({ x: -2.5, y: 2, z: 0 }, { x: 2.3, y: 2.3, z: Infinity }, [-99, 99, -99, 99, H + 2, H + 8], "glow", {
    paint: (p, f) => (f === "top" ? ["wood", 0] : p.z > H + 7 ? ["wood", 1] : p.z < H + 6 && hash(Math.floor(p.x * 1.4 + 9), Math.floor(p.z * 1.2)) % 4 !== 0 ? ["mustard", (p.z < H + 3.5 ? 1 : 0)] : null),
  });
  // Two tumblers, then the bell.
  for (const [x, y] of [[5.5, -1], [8, 1.5]] as const) {
    k.ell({ x, y, z: 0 }, { x: 1, y: 1, z: Infinity }, [-99, 99, -99, 99, H + 2, H + 5], "glow", {
      paint: (p, f) => (f !== "top" && p.z < H + 3.2 ? ["rust", 0] : null),
    });
  }
  k.ell({ x: 17, y: 1, z: 0 }, { x: 1.8, y: 1.8, z: Infinity }, [-99, 99, -99, 99, H + 2, H + 2.6], "wood");
  k.ell({ x: 17, y: 1, z: H + 2.6 }, { x: 1.6, y: 1.6, z: 2.2 }, [-99, 99, -99, 99, H + 2.6, H + 6], "mustard");
  k.box(16.6, 17.4, 0.6, 1.4, H + 4.6, H + 5.8, "mustard");
}

/** Upright piano for a wall: two raised panels, cheeks round a keyboard, sheet music on the desk, brass pedals; a metronome
 *  and a vase of tulips on the lid. Wood or charcoal (black) case. In use the keys go down a chord at a time and the
 *  metronome ticks left, then right. */
function piano(k: Kit, c: RampName, n = 0): void {
  const W0 = -7, W1 = 23, KZ = 20;
  const panels: LPaint = (p, f) => {
    if (f === "top") return [c, 0];
    if (f !== "front") return null;
    // Two raised fields above the keys, one long field below, with a dark groove round each.
    const fields = [[-5, 7, KZ + 5, 34], [9, 21, KZ + 5, 34], [-4, 20, 3, KZ - 6]] as const;
    for (const [x0, x1, z0, z1] of fields) {
      if (p.x < x0 || p.x >= x1 || p.z < z0 || p.z >= z1) continue;
      return p.x < x0 + 0.7 || p.z >= z1 - 0.7 ? [c, 2] : p.x >= x1 - 0.7 || p.z < z0 + 0.7 ? [c, 0] : null;
    }
    return null;
  };
  k.box(W0, W1, 2, 8, 0, 37, c, { paint: panels });
  k.box(W0 - 0.5, W1 + 0.5, 1.5, 8, 37, 38.5, c, { paint: (p, f) => (f !== "top" && p.z < 37.6 ? [c, 2] : null) });
  // Cheeks, the legs under them and the keybed.
  for (const x of [W0, W1 - 1.8]) {
    k.box(x, x + 1.8, -3.5, 2, KZ - 3, KZ + 3, c, { paint: (_p, f) => (f === "top" ? [c, 0] : null) });
    k.box(x + 0.3, x + 1.5, -3, -1.6, 0, KZ - 3, c);
  }
  k.box(W0 + 1.8, W1 - 1.8, -3.2, 2, KZ - 2.5, KZ - 0.5, c, { paint: (_p, f) => (f === "front" ? [c, 2] : null) });
  // Keys: 18 white, each its own box; the black ones sit on the back half. Frame n presses one chord.
  const chords = [[], [0, 2, 4, 9, 14], [3, 5, 7, 12, 16]] as const;
  const down = new Set<number>(chords[n] ?? []);
  const KW = (W1 - W0 - 3.6) / 18;
  for (let i = 0; i < 18; i++) {
    const x0 = W0 + 1.8 + i * KW, pressed = down.has(i);
    k.box(x0 + 0.1, x0 + KW - 0.1, -3, 2, KZ - 0.5, pressed ? KZ + 0.2 : KZ + 0.7, "cream", {
      tones: pressed ? { top: 2, sw: 2, se: 2 } : { top: 0, sw: 1, se: 2 },
    });
  }
  for (let i = 0; i < 17; i++) {
    if (![0, 1, 3, 4, 5].includes(i % 7)) continue;
    const xb = W0 + 1.8 + (i + 1) * KW, pressed = n > 0 && (i + n * 3) % 6 === 0;
    k.box(xb - 0.35, xb + 0.35, 0, 2, KZ + 0.7, pressed ? KZ + 0.9 : KZ + 1.3, "outline", { tones: { top: 1, sw: 1, se: 1 } });
  }
  // Fallboard (open, standing up behind the keys) and the desk with sheet music.
  k.box(W0 + 1.8, W1 - 1.8, 2, 3, KZ - 0.5, KZ + 3, c, { paint: (p, f) => (f === "front" && Math.abs(p.z - KZ - 2) < 0.4 && Math.abs(p.x - 8) < 2 ? ["mustard", 0] : null) });
  k.box(1, 15, 1.5, 2.4, KZ + 3, KZ + 10, "cream", {
    paint: (p, f) => (f === "front" && Math.abs(p.x - 8) > 0.5 && (Math.round((p.z - KZ - 4) * 2) % 3 === 0) && p.z < KZ + 9 ? ["cream", 2] : null),
  });
  // Brass pedals.
  for (const x of [5.5, 8, 10.5]) k.box(x - 0.5, x + 0.5, -0.5, 2, 1, 1.6, "mustard", { tones: { top: 0, sw: 1, se: 2 } });
  // Metronome: a stepped charcoal pyramid (dark on either case, so the arm reads) with a brass arm, upright idle, swinging left then right in use.
  const MX = 17, MY = 5, Z0 = 38.5;
  for (let i = 0; i < 6; i++) {
    const r = 2.2 - i * 0.32;
    k.box(MX - r, MX + r, MY - r, MY + r, Z0 + i * 1.3, Z0 + (i + 1) * 1.3, "charcoal", {
      paint: (p, f) => {
        if (f !== "front") return null;
        const t = [0, -0.5, 0.5][n] ?? 0;
        const dx = p.x - MX, dz = p.z - Z0 - 1;
        const along = dx * Math.sin(t) + dz * Math.cos(t), across = dx * Math.cos(t) - dz * Math.sin(t);
        if (along > 0 && along < 6.5 && Math.abs(across) < 0.45) return Math.abs(along - 4) < 0.8 ? ["cream", 0] : ["mustard", 0];
        return ["outline", 1];
      },
    });
  }
  // Vase of tulips.
  k.ell({ x: -2, y: 5, z: 0 }, { x: 1.3, y: 1.3, z: Infinity }, [-99, 99, -99, 99, Z0, Z0 + 4], "teal");
  for (const [x, y, h, ramp] of [[-2.6, 4.6, 7, "pink"], [-1.3, 5.4, 8.2, "rust"], [-2.2, 5.8, 6.2, "mustard"]] as const) {
    k.box(x - 0.2, x + 0.2, y - 0.2, y + 0.2, Z0 + 4, Z0 + h, "olive", { tones: { top: 1, sw: 1, se: 2 } });
    k.ell({ x, y, z: Z0 + h + 0.6 }, { x: 0.8, y: 0.8, z: 1.1 }, [-99, 99, -99, 99, Z0 + h - 0.6, Z0 + h + 1.8], ramp);
  }
}

/** Fireplace for a wall: a cream stone surround, a brick-lined firebox with two crossed logs, a slate hearth and a wood mantel
 *  with candles and a little vase. Idle it burns low; in use (during playback) the flames leap and flicker and a spark rises. */
function fireplace(k: Kit, n = 0): void {
  const D0 = 2, D1 = 8, OX = 4.5, OZ = 16, MZ = 30;
  k.box(-8, 8, -1.5, D1, 0, 1.4, "charcoal", { paint: (p, f) => (f === "top" ? (p.y < D0 && Math.abs(p.x) < OX && n > 0 ? ["charcoal", 0] : ["charcoal", 1]) : null) });
  const stone: LPaint = (p, f) => {
    if (f === "top") return ["cream", 0];
    // Brick border round the opening; big blocks with faint joints elsewhere.
    const inBorder = Math.abs(p.x) < OX + 1.2 && p.z < OZ + 1.2;
    if (f === "front" && inBorder) return (Math.floor(p.z / 1.5) + (Math.abs(p.x) > OX + 0.6 ? 1 : 0)) % 2 === 0 ? ["rust", 1] : ["rust", 2];
    if (f === "front" && (Math.abs(p.z - 9) < 0.3 || Math.abs(p.z - 22) < 0.3)) return ["cream", 2];
    return null;
  };
  k.box(-7.5, -OX, D0, D1, 1.4, MZ, "cream", { paint: stone });
  k.box(OX, 7.5, D0, D1, 1.4, MZ, "cream", { paint: stone });
  k.box(-OX, OX, D0, D1, OZ, MZ, "cream", { paint: stone });
  k.box(-OX, OX, D0, D1, 1.4, 1.8, "charcoal", { tones: { top: 2, sw: 2, se: 2 } });
  // Flames on the firebox's back wall: three tongues, low and steady idle, leaping in four flicker frames.
  const tongues = [
    [[-2, 4, 1.6], [0.3, 6, 2], [2.4, 3.5, 1.4]],
    [[-2.2, 6.5, 1.8], [0.2, 10, 2.2], [2.6, 5, 1.5]],
    [[-1.8, 8, 1.8], [0.6, 7.5, 2.1], [2.3, 7, 1.6]],
    [[-2.4, 5.5, 1.7], [0, 11, 2.3], [2.5, 6.5, 1.6]],
    [[-1.9, 7, 1.9], [0.5, 9, 2], [2.2, 4.5, 1.4]],
  ] as const;
  const fire = (x: number, z: number): Paint | null => {
    const zb = 3.2;
    let best = 0;
    for (const [cx, h, w] of tongues[n] ?? tongues[0]) {
      const t = (z - zb) / h;
      if (t < 0 || t > 1) continue;
      const half = w * (1 - t) * (1 + 0.3 * Math.sin(t * 6 + cx));
      const q = 1 - Math.abs(x - cx) / half;
      if (q > best) best = q;
    }
    if (best <= 0) return null;
    return best > 0.65 ? ["glow", 0] : best > 0.4 ? ["mustard", 0] : best > 0.18 ? ["ginger", 0] : ["rust", 0];
  };
  const spark = (x: number, z: number): boolean => n > 0 && Math.abs(x - ([0, 1.5, -1, 2, -2][n] ?? 0)) < 0.5 && Math.abs(z - (9 + n * 1.5)) < 0.5;
  k.box(-OX, OX, 5, D1, 1.8, OZ, "outline", {
    paint: (p, f) => {
      if (f !== "front") return null;
      const flame = fire(p.x, p.z);
      if (flame) return flame;
      if (spark(p.x, p.z)) return ["mustard", 0];
      // Firelit brick on the back wall, sooty toward the top.
      if (p.z > OZ - 4) return ["outline", 1];
      return (Math.floor(p.z / 1.5) + Math.floor((p.x + 9 + (Math.floor(p.z / 1.5) % 2) * 1.5) / 3)) % 2 === 0 ? ["rust", 2] : ["velvet", 2];
    },
  });
  // Two logs: one across, one laid over it at an angle (stepped), end grain toward us.
  const bark: LPaint = (p, f) => (f === "top" ? ["wood", 1] : Math.abs(p.x) > 3.2 ? ["wood", 0] : ["wood", 2]);
  k.ell({ x: 0, y: 3.6, z: 3 }, { x: Infinity, y: 1.2, z: 1.2 }, [-3.6, 3.6, -9, 9, 1.8, 9], "wood", { paint: bark });
  for (let i = 0; i < 5; i++) k.box(-2.6 + i * 1.2, -1.4 + i * 1.2, 2.4 + i * 0.4, 3.6 + i * 0.4, 3.6, 5, "hairDark", { tones: { top: 0, sw: 1, se: 2 } });
  // Mantel and what stands on it.
  k.box(-8.5, 8.5, D0 - 1.5, D1, MZ, MZ + 2, "wood", { paint: (p, f) => (f !== "top" && p.z < MZ + 0.8 ? ["wood", 2] : null) });
  for (const [x, h] of [[-6, 4.5], [-4.6, 3]] as const) {
    k.ell({ x, y: 4, z: 0 }, { x: 0.7, y: 0.7, z: Infinity }, [-99, 99, -99, 99, MZ + 2, MZ + 2 + h], "cream");
    const lit = n === 0 || (n + (x < -5 ? 0 : 1)) % 2 === 0;
    k.ell({ x, y: 4, z: MZ + 3.3 + h }, { x: 0.5, y: 0.5, z: lit ? 1.3 : 0.9 }, [-99, 99, -99, 99, MZ + 2 + h, MZ + 5 + h], "glow", { tones: { top: 0, sw: 0, se: 0 } });
  }
  k.ell({ x: 4.5, y: 4.5, z: 0 }, { x: 1.4, y: 1.4, z: Infinity }, [-99, 99, -99, 99, MZ + 2, MZ + 5.5], "teal", { paint: (p, f) => (f !== "top" && Math.abs(p.z - MZ - 4) < 0.4 ? ["cream", 0] : null) });
  k.box(4.1, 4.9, 4.1, 4.9, MZ + 5.5, MZ + 9, "olive");
}

// ---------------------------------------------------------------- sleepy cat (hand-pixelled role grid on a ray-cast cushion)

/** Loaf cat facing sw (head front-left), eyes shut, tail wrapped round its front. `o` is a hand-placed inner contour. */
const CAT_SW: readonly string[] = [
  "...h.....h..............",
  "..hph...hph.............",
  "..hpph.hpph..bbbbbb.....",
  "..hhhhhhhhhhobbsbbbbb...",
  ".hhhhhhhhhhhhobbbsbbbb..",
  ".hheehhhheehhobbbbsbbbb.",
  ".hhhhhwnwhhhhobbbbbsbbb.",
  ".hhhhwwwwwhhhobbbbbbsbbb",
  "..hhhhwwwhhhobbbbbbbsbbb",
  "...hhhhhhhhobbbbbbbbsbbb",
  "....owwwwwobbbbbbbbbbbbb",
  "...bbwwwwwbbbbbbbbbbbbb.",
  ".tttttttttttttbbbbbbbb..",
  ".ttttttttttttttttbbbb...",
  "..wwwtttttttttttt.......",
];
const catRoles = (c: RampName): RoleMap => ({
  h: { ramp: c, hi: true },
  b: { ramp: c, hi: true },
  t: { ramp: c, hi: true },
  s: { ramp: c, tone: 2 },
  p: { ramp: "pink", tone: 1 },
  n: { ramp: "pink", tone: 1 },
  e: { ramp: "outline", tone: 1 },
  o: { ramp: c, tone: 2 },
  w: { ramp: "cream", tone: 1 },
});

function sleepyCat(dir: FurnDir, c: RampName, s = 1, cv: Canvas = CANVAS, empty = false): Uint8Array {
  const k = new Kit(dir);
  const bed: LPaint = (p, f) => (f === "top" && Math.hypot(p.x, p.y) < 5.2 ? ["lilac", 2] : null);
  k.ell({ x: 0, y: 0, z: 0 }, { x: 7, y: 7, z: Infinity }, [-8, 8, -8, 8, 0, 3], "lilac", { paint: bed });
  const r = renderSolids(k.parts.map((q) => q.solid), cv.w, cv.h, cv.ax, cv.ay, "none", s);
  if (empty) {
    addOutline(r.img, cv.w, cv.h);
    return r.img;
  }
  const g0 = blank(CAT_SW[0]?.length ?? 0, CAT_SW.length);
  stamp(g0, CAT_SW, 0, 0);
  const g = dir === "sw" ? g0 : mirror(g0);
  const cat = renderRoles(g, catRoles(c));
  const gw = g[0]?.length ?? 0, gh = g.length;
  // Paws rest just inside the cushion's top; nearest-neighbour sampling for the tray thumbnail (s < 1).
  const W = Math.round(gw * s), H = Math.round(gh * s);
  const ox = cv.ax - Math.round((gw / 2) * s), oy = cv.ay - Math.round(2 * s) - H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = cat[Math.floor(y / s) * gw + Math.floor(x / s)] ?? 0;
      if (v !== 0) r.img[(oy + y) * cv.w + ox + x] = v;
    }
  }
  addOutline(r.img, cv.w, cv.h);
  return r.img;
}

// The cat off its cushion (OME-1519): a 4-frame walk on the avatars' clock and a sit, same roles and ramp as the loaf, eyes open.
// Drawn facing sw (head front-left) and mirrored for se, like the loaf. Feet always land on the grid's last row.
/** Walk body without legs: the back rises to the right (the rump is the far end in iso); `E` is the eye's glint. */
const CAT_WALK_BODY: readonly string[] = [
  "...h.....h..................",
  "..hph...hph.................",
  "..hpph.hpph.................",
  "..hhhhhhhhhh................",
  ".hhhhhhhhhhhh...............",
  ".hhEehhhhEehh...bbbbbbbb....",
  ".hhhhhwnwhhhhobbbsbbbsbbb...",
  ".hhhhwwwwwhhhobbbbsbbbsbbb..",
  "..hhhhwwwhhhobbbbbsbbbsbbb..",
  "...hhhhhhhhobbbbbbbbbbbbbb..",
  "....owwwwwobbbbbbbbbbbbbbb..",
  "....wwwwwwbbbbbbbbbbbbbbb...",
  ".....wwwwbbbbbbbbbbbbbbb....",
];
/** Tail rows above/behind the rump, by sway (−1, 0, +1): it rises from the rump's top-right and hooks over at the tip. */
const catTail = (sway: number): readonly [number, number][] => [
  [24, 5], [25, 5], [25, 4], [26, 4], [25 + Math.min(sway, 0), 3], [26 + Math.min(sway, 0), 3],
  [25 + sway, 2], [26 + sway, 2], [24 + sway, 1], [25 + sway, 1], [23 + sway, 0], [24 + sway, 0],
];
/** Per frame: body drop (contact frames sit 1 px lower) and each foot's x shift [near front, far front, near hind, far hind]. */
const CAT_GAIT: readonly { drop: number; feet: readonly [number, number, number, number]; sway: number }[] = [
  { drop: 1, feet: [-2, 1, 2, -1], sway: 0 },
  { drop: 0, feet: [0, 0, 0, 0], sway: 1 },
  { drop: 1, feet: [1, -2, -1, 2], sway: 0 },
  { drop: 0, feet: [0, 0, 0, 0], sway: -1 },
];
const CAT_WALK_H = 19;
/** Walk frame n (0..3) as a role grid facing sw. Far legs are drawn first in the shade tone (`o`, paw `W`), near legs over them. */
function catWalkGrid(n: number): Grid {
  const g = blank(CAT_WALK_BODY[0]?.length ?? 0, CAT_WALK_H);
  const f = CAT_GAIT[n % 4] ?? { drop: 0, feet: [0, 0, 0, 0], sway: 0 };
  const top = 11 + f.drop, foot = CAT_WALK_H - 1;
  const leg = (x: number, dx: number, far: boolean): void => {
    const end = far ? foot - 1 : foot;
    for (let y = top; y <= end; y++) {
      const lx = x + Math.round((dx * (y - top)) / (end - top));
      const ch = y === end ? (far ? "W" : "w") : far ? "o" : "b";
      stamp(g, [ch + ch], lx, y);
    }
  };
  leg(8, f.feet[1], true);
  leg(22, f.feet[3], true);
  stamp(g, CAT_WALK_BODY, 0, f.drop);
  for (const [x, y] of catTail(f.sway)) stamp(g, ["t"], x, y + f.drop);
  leg(5, f.feet[0], false);
  leg(19, f.feet[2], false);
  return g;
}
/** Sitting upright facing sw: the loaf's head over a pear-shaped body, straight cream forelegs, tail curled round the front. */
const CAT_SIT_SW: readonly string[] = [
  "...h.....h.........",
  "..hph...hph........",
  "..hpph.hpph........",
  "..hhhhhhhhhh.......",
  ".hhhhhhhhhhhh......",
  ".hhEehhhhEehh......",
  ".hhhhhwnwhhhh......",
  ".hhhhwwwwwhhh......",
  "..hhhhwwwhhhobb....",
  "...hhhhhhhhobbbb...",
  "....owwwwwobbsbb...",
  "....wwwwwwobbbsbb..",
  "....wwwwwwobbbbsbb.",
  "....wwwwwwobbbbsbb.",
  "...bwwwwwwobbbbbsbb",
  "...bbwwwwwobbbbbbbb",
  "...bbwwbwwbbbbbbbbb",
  "...bbwwbwwbbbbbbbb.",
  "..ttwwttwwttttttbb.",
  ".tttttttttttttttb..",
];
const walkRoles = (c: RampName): RoleMap => ({ ...catRoles(c), E: { ramp: "mustard", tone: 0 }, W: { ramp: "cream", tone: 2 } });

/** One cat role grid (sw art) as a CANVAS image, mirrored for se, its feet's centre on the anchor. */
function catPose(g0: Grid, dir: FurnDir, c: RampName, footX: number): Uint8Array {
  const g = dir === "sw" ? g0 : mirror(g0);
  const gw = g[0]?.length ?? 0, gh = g.length;
  const cat = renderRoles(g, walkRoles(c));
  const img = new Uint8Array(CANVAS.w * CANVAS.h);
  const ox = CANVAS.ax - (dir === "sw" ? footX : gw - 1 - footX), oy = CANVAS.ay - gh + 1;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) img[(oy + y) * CANVAS.w + ox + x] = cat[y * gw + x] ?? 0;
  addOutline(img, CANVAS.w, CANVAS.h);
  return img;
}
/** Walk loop (`furniture/cat/<colour>/walk/<dir>/<0..3>`, one shared rect so one anchor), the sit (`.../sit/<dir>`) and the
 *  cushion it left (`.../bed/<dir>`, in `back`'s rect so it swaps in place). */
function catMotion(colour: string, dir: FurnDir, back: { x0: number; y0: number; w: number; h: number }): RoomFrame[] {
  const c = asRamp(colour);
  const walk = Array.from({ length: WALK_FRAMES }, (_, n) => n).map((n) => catPose(catWalkGrid(n), dir, c, 14));
  const both = new Uint8Array(CANVAS.w * CANVAS.h);
  for (const w of walk) w.forEach((v, i) => { if (v !== 0) both[i] = v; });
  const { rect } = crop("cat/walk/all", both);
  const sit = blank(CAT_SIT_SW[0]?.length ?? 0, CAT_SIT_SW.length);
  stamp(sit, CAT_SIT_SW, 0, 0);
  return [
    ...walk.map((img, n) => crop(`furniture/cat/${colour}/walk/${dir}/${String(n)}`, img, rect)),
    crop(`furniture/cat/${colour}/sit/${dir}`, catPose(sit, dir, c, 9)),
    crop(`furniture/cat/${colour}/bed/${dir}`, sleepyCat(dir, c, 1, CANVAS, true), back),
  ];
}

// ---------------------------------------------------------------- monstera (role grid leaves on a ray-cast pot)

const LEAF_ROLES: RoleMap = {
  A: { ramp: "olive", hi: true },
  B: { ramp: "olive", hi: true },
  C: { ramp: "olive", hi: true },
  v: { ramp: "olive", tone: 2 },
  s: { ramp: "olive", tone: 2 },
};
const LEAVES: readonly { a: number; len: number; w: number; stem: number }[] = [
  { a: -62, len: 12, w: 10, stem: 8 },
  { a: 58, len: 13, w: 11, stem: 9 },
  { a: -22, len: 14, w: 12, stem: 15 },
  { a: 26, len: 13, w: 11, stem: 18 },
  { a: 2, len: 15, w: 13, stem: 7 },
];
/** Fenestrated leaves around a stem base at (cx, h-1) of a w×h grid; deterministic, drawn back to front. */
function monsteraGrid(s = 1): Grid {
  const W = Math.round(49 * s), H = Math.round(46 * s), cx = 24, by = 45;
  const g: Grid = Array.from({ length: H }, () => Array.from({ length: W }, () => "."));
  const set = (x: number, y: number, ch: string): void => {
    const row = g[y];
    if (row && x >= 0 && x < W) row[x] = ch;
  };
  LEAVES.forEach((L, i) => {
    const t = (L.a * Math.PI) / 180;
    const dx = Math.sin(t), dy = -Math.cos(t);
    // Stem: a gentle curve out from the base.
    for (let q = 0; q <= L.stem; q += 0.5) set(Math.floor((cx + dx * q * (0.6 + 0.4 * (q / L.stem)) + 0.5) * s), Math.floor((by + dy * q + 0.5) * s), "s");
    const sx = cx + dx * L.stem, sy = by + dy * L.stem;
    // Blade tilts further out than the stem and droops a little at the tip.
    const bt = t * 1.35;
    const ax = Math.sin(bt), ay = -Math.cos(bt) * 0.8 + 0.25;
    const an = Math.hypot(ax, ay);
    const ux = ax / an, uy = ay / an;
    const ch = ["A", "B", "C"][i % 3] ?? "A";
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = (x + 0.5) / s - sx, py = (y + 0.5) / s - sy;
        const a = px * ux + py * uy;
        const b = -px * uy + py * ux;
        const ca = a - L.len / 2;
        if ((ca / (L.len / 2)) ** 2 + (b / (L.w / 2)) ** 2 > 1) continue;
        if (a < 1.6 && Math.abs(b) < 1) continue; // heart notch at the stem
        // Slits from the edge toward the midrib, angled to the tip.
        const ab = Math.abs(b);
        if (ab > L.w * 0.24 && ((a - ab * 0.7 + 40) % 4.2) < 1 && a > 2.5 && a < L.len - 2) continue;
        set(x, y, ab < 0.5 && a > 2 && a < L.len - 3 ? "v" : ch);
      }
    }
  });
  return g;
}

function monstera(dir: FurnDir, pot: RampName, s = 1, cv: Canvas = CANVAS): Uint8Array {
  const k = new Kit(dir);
  const rimPaint: LPaint = (_p, f) => (f === "top" ? ["hairDark", 1] : null);
  k.ell({ x: 0, y: 0, z: 0 }, { x: 4, y: 4, z: Infinity }, [-8, 8, -8, 8, 0, 9], pot, {
    paint: (p, f) => (f !== "top" && p.z > 4 && p.z < 5 ? [pot, 0] : null),
  });
  k.ell({ x: 0, y: 0, z: 0 }, { x: 4.8, y: 4.8, z: Infinity }, [-8, 8, -8, 8, 9, 11], pot, { paint: rimPaint });
  const r = renderSolids(k.parts.map((p) => p.solid), cv.w, cv.h, cv.ax, cv.ay, "none", s);
  const g0 = monsteraGrid(s);
  const g = dir === "sw" ? g0 : mirror(g0);
  const leaves = renderRoles(g, LEAF_ROLES);
  const gw = g[0]?.length ?? 0, gh = g.length;
  // Stem base sits on the soil, 1 px below the pot rim's top.
  const ox = cv.ax - Math.round(24 * s), oy = cv.ay - Math.round(11 * s) - gh + 1;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const v = leaves[y * gw + x] ?? 0;
      if (v !== 0) r.img[(oy + y) * cv.w + ox + x] = v;
    }
  }
  addOutline(r.img, cv.w, cv.h);
  return r.img;
}

// ---------------------------------------------------------------- rug (flat, floor layer)

/** Kilim runner, 3×2 tiles: rounded corners, a stepped-diamond field, and cream tassels on the short ends. */
function rugImage(dir: "ne" | "nw", field: RampName, accent: RampName, s = 1, cv: Canvas = CANVAS): Uint8Array {
  const img = new Uint8Array(cv.w * cv.h);
  const X0 = -7, X1 = 39, Y0 = -6, Y1 = 22, R = 3;
  for (let py = 0; py < cv.h; py++) {
    for (let px = 0; px < cv.w; px++) {
      const sx = (px + 0.5 - cv.ax) / s, sy = (py + 0.5 - cv.ay) / s;
      const u = (sy + sx / 2) / 2, v = (sy - sx / 2) / 2;
      const { x, y } = dir === "ne" ? { x: u, y: v } : { x: v, y: u };
      let p: Paint | null = null;
      if (y >= Y0 + 1 && y < Y1 - 1 && ((x >= X0 - 2 && x < X0) || (x >= X1 && x < X1 + 2))) {
        if (Math.floor(y) % 2 === 0) p = ["cream", x < X0 || x >= X1 + 1 ? 1 : 0];
      }
      if (x >= X0 && x < X1 && y >= Y0 && y < Y1) {
        const cxr = Math.max(X0 + R - x, x - (X1 - R), 0), cyr = Math.max(Y0 + R - y, y - (Y1 - R), 0);
        if (cxr * cxr + cyr * cyr <= R * R) p = rugPaint(x - X0, y - Y0, X1 - X0, Y1 - Y0, field, accent);
      }
      if (p) img[py * cv.w + px] = colorIndex(p[0], p[1]);
    }
  }
  addOutline(img, cv.w, cv.h);
  return img;
}
function rugPaint(x: number, y: number, w: number, h: number, field: RampName, accent: RampName): Paint {
  const d = Math.min(x, y, w - x, h - y);
  if (d < 1.5) return [accent, 2];
  if (d < 3) return ["cream", 1];
  if (d < 4) return [accent, 1];
  // Stepped diamonds down the middle, a row of small ticks either side.
  const mx = (x % 12) - 6, my = y - h / 2;
  const m = Math.floor(Math.abs(mx)) + Math.floor(Math.abs(my) * 1.4);
  if (m < 2) return ["cream", 0];
  if (m < 4) return [accent, 0];
  if (m < 6) return [field, 2];
  if (Math.abs(Math.abs(my) - 9) < 1 && Math.floor(x) % 4 < 2) return ["cream", 1];
  return [field, (Math.floor(x) + Math.floor(y)) % 7 === 0 ? 0 : 1];
}

// ---------------------------------------------------------------- teleport pad (OME-1546): the runner's flat floor cast, the "found" sparkle

/** Teleport pad, 1×1 on the floor layer: a round plate 2 px thick with a dark rim and eight brass studs, a cream ring and a
 *  `field` dish holding a four-point cream sparkle with a mustard heart (the site's "found" sparkle). `field` is the only ramp
 *  that changes with the colour, so every colour is a palette remap of any other. Active (n = 1, someone stands on it): the
 *  dish brightens, the ring and studs light in glow and mustard, and the sparkle grows out to the ring. */
function padImage(field: RampName, n = 0, s = 1, cv: Canvas = CANVAS): Uint8Array {
  const img = new Uint8Array(cv.w * cv.h);
  const on = n === 1, R = 7.5, T = 2;
  const star = (x: number, y: number, len: number, w: number): boolean => {
    // Arms along the floor diagonals, so they point straight up, down, left and right on screen.
    const p = Math.abs(x + y) / Math.SQRT2, q = Math.abs(x - y) / Math.SQRT2;
    return Math.max(p, q) < len && Math.min(p, q) < w * (1 - Math.max(p, q) / len);
  };
  const top = (x: number, y: number): Paint | null => {
    const r = Math.hypot(x, y);
    if (r >= R) return null;
    if (r >= R - 1.3) {
      const a = ((Math.atan2(y, x) / (Math.PI / 4)) % 1 + 1) % 1;
      return Math.min(a, 1 - a) < 0.12 ? ["mustard", on ? 0 : 2] : [field, 2];
    }
    if (r >= R - 2.4) return on ? ["glow", 0] : ["cream", 1];
    if (r < (on ? 1.5 : 1.1)) return ["mustard", on ? 0 : 1];
    if (star(x, y, on ? 5.2 : 3.9, on ? 1.4 : 1.1)) return ["cream", 0];
    if (r >= R - 3) return on ? ["glow", 1] : [field, 2];
    return [field, on ? 0 : 1];
  };
  for (let py = 0; py < cv.h; py++) {
    for (let px = 0; px < cv.w; px++) {
      const sx = (px + 0.5 - cv.ax) / s, sy = (py + 0.5 - cv.ay) / s;
      const at = (z: number): { x: number; y: number } => ({ x: (sy + z + sx / 2) / 2, y: (sy + z - sx / 2) / 2 });
      const t = at(T);
      let p = top(t.x, t.y);
      // The plate's edge below the top: rim colour, darker toward the floor.
      for (let z = T - 1; !p && z >= 0; z--) { const b = at(z); if (Math.hypot(b.x, b.y) < R) p = [field, 2]; }
      if (p) img[py * cv.w + px] = colorIndex(p[0], p[1]);
    }
  }
  addOutline(img, cv.w, cv.h);
  return img;
}

// ---------------------------------------------------------------- Dank Dungeon (OME-1670): a hotel suite after dark

/** Queen bed (OME-1983), 2×2: a plinth, a plum duvet folded back over cream sheets, a mustard throw at the foot, two big pillows
 *  and two cushions against a tufted headboard at the anchor end (the −x end, so it backs onto the left wall facing ne and the
 *  right wall facing nw). Local y is the width: 0..16 facing ne/nw, −16..0 facing se/sw (the footprint's second row is on
 *  the −y side there). `n` 2 and 3 draw only the duvet pulled up over sleeper 0 (the front, −y half, where the seats are) or 1. */
function bed(k: Kit, c: RampName, n = 0): void {
  const O = k.dir === "se" || k.dir === "sw" ? -16 : 0;
  const Y0 = O - 7.5, Y1 = O + 23.5, MID = O + 8;
  const halves = [O, O + 16];
  const sleeper = halves[n - 2];
  if (sleeper !== undefined) {
    // The duvet over one sleeper: from the shoulders to the foot, over their half, the outer edge draping down the side.
    const y0 = sleeper === O ? Y0 + 0.1 : MID, y1 = sleeper === O ? MID : Y1 - 0.1;
    const lo = (y: number): boolean => (sleeper === O ? y < Y0 + 0.6 : y > Y1 - 0.6);
    const quilt: LPaint = (p, f) => {
      if (f === "top") return p.x < 3.2 ? ["cream", 0] : Math.abs(((p.x + 40) % 6) - 3) < 0.35 ? [c, 1] : null;
      return lo(p.y) && p.z < 6 ? [c, 2] : null;
    };
    k.box(1.5, 23.9, y0, y1, 3.6, SEAT_HEIGHT + 1, c, { paint: quilt });
    k.ell({ x: 11, y: sleeper, z: SEAT_HEIGHT + 1 }, { x: 9.5, y: 5.6, z: 5 }, [1.5, 21, y0, y1, SEAT_HEIGHT + 1, 40], c, {
      paint: (p, f) => (f === "top" && p.x < 3.2 ? ["cream", 0] : null),
    });
    return;
  }
  k.box(-7, 23, Y0 + 0.5, Y1 - 0.5, 0, 1.5, "charcoal");
  k.box(-7.5, 23.5, Y0, Y1, 1.5, 4, "wood", { paint: (p, f) => (f !== "top" && p.z < 2.4 ? ["wood", 2] : null) });
  k.box(-7, 23.5, Y0, Y1, 4, 6.5, "cream", { paint: (p, f) => (f !== "top" && p.z < 4.8 ? ["cream", 2] : null) });
  // The duvet drapes over both long sides; its top edge is folded back, showing a cream sheet band. A seam down the middle.
  const duvet: LPaint = (p, f) => {
    if (f !== "top") return p.z < 5 ? [c, 2] : null;
    if (p.x < 3) return ["cream", 0];
    if (p.x < 4.5) return [c, 0];
    return Math.abs(p.y - MID) < 0.4 ? [c, 1] : null;
  };
  k.box(-1, 23.8, Y0 - 0.4, Y1 + 0.4, 3.6, SEAT_HEIGHT, c, { paint: duvet });
  k.box(17, 21, Y0 - 0.6, Y1 + 0.6, 3, SEAT_HEIGHT + 0.4, "mustard", { paint: (p, f) => (f === "top" && Math.abs(p.x - 19) < 0.5 ? ["mustard", 2] : null) });
  k.box(-7, -1, Y0, Y1, 6.5, SEAT_HEIGHT, "cream", { tones: { top: 0, sw: 1, se: 2 } });
  const tufts: LPaint = (p, f) => {
    if (f === "top") return [c, 0];
    return Math.abs(((p.y + 40) % 4) - 2) < 0.6 && Math.abs(((p.z - 10) % 4) - 2) < 0.6 ? [c, 2] : null;
  };
  k.box(-8, -6.5, Y0 - 0.5, Y1 + 0.5, 1.5, 26, c, { paint: tufts });
  k.box(-8, -6.5, Y0 - 0.5, Y1 + 0.5, 26, 27, "mustard", { tones: { top: 0, sw: 1, se: 2 } });
  // Two big cream pillows, one per sleeper, then a plum and a mustard cushion in front of them and a teal bolster between.
  const pillow = (x: number, y: number, z: number, r: L3, ramp: RampName): void => {
    k.ell({ x, y, z }, r, [-8, 24, Y0 - 1, Y1 + 1, 0, 40], ramp, { paint: (p, f) => (f !== "top" && Math.abs(p.y - y) < 0.4 ? [ramp, 2] : null) });
  };
  for (const y of halves) pillow(-4.2, y, 12.6, { x: 2.4, y: 6, z: 4.6 }, "cream");
  pillow(-1.6, O, 11.2, { x: 1.8, y: 3.4, z: 3.4 }, c);
  pillow(-1.6, O + 16, 11.2, { x: 1.8, y: 3.4, z: 3.4 }, "mustard");
  pillow(-0.6, MID, 9.8, { x: 1.4, y: 2.6, z: 2 }, "teal");
}

/** Whirlpool for two: a cream acrylic tub on a wood skirt, teal water that bubbles while someone is in it (frames 1–2),
 *  a rolled plum towel and a rubber duck on the rim. Water and rim in front of a sitter are the `front` layer, so the
 *  sitter is in the tub up to the waist. */
function whirlpool(k: Kit, n = 0): void {
  const X0 = -7.5, X1 = 23.5, Y0 = -7.5, Y1 = 7.5, RIM = 13, WATER = 11.6, T = 1.6;
  const seats = [k.world(0, 0), k.world(16, 0)];
  // In front of the nearest sitter: further toward the camera (u + v) than the sitter's own spot.
  const near = (x: number, y: number): boolean => {
    const w = k.world(x, y);
    const s = seats.reduce((a, b) => (Math.hypot(w.u - b.u, w.v - b.v) < Math.hypot(w.u - a.u, w.v - a.v) ? b : a));
    return w.u - s.u + (w.v - s.v) > 1;
  };
  const skirt: LPaint = (p, f) => (f === "top" ? null : p.z < 1.2 ? ["charcoal", 2] : Math.abs(((p.x + p.y + 40) % 4) - 2) < 0.4 ? ["wood", 2] : null);
  k.box(X0, X1, Y0, Y1, 0, RIM - 3, "wood", { paint: skirt });
  const rim: LPaint = (_p, f) => (f === "top" ? ["cream", 0] : null);
  const walls: [number, number, number, number][] = [[X0, X1, Y0, Y0 + T], [X0, X1, Y1 - T, Y1], [X0, X0 + T, Y0, Y1], [X1 - T, X1, Y0, Y1]];
  // Rim walls in 2-unit pieces too: a long wall can pass in front of one sitter and behind the other.
  for (const [a, b, c, d] of walls) {
    for (let x = a; x < b - 0.01; x += 2) for (let y = c; y < d - 0.01; y += 2) {
      const x1 = Math.min(x + 2, b), y1 = Math.min(y + 2, d);
      k.box(x, x1, y, y1, RIM - 3, RIM, "cream", { paint: rim, front: near((x + x1) / 2, (y + y1) / 2) });
    }
  }
  // Water in 2-unit tiles, so each tile can be in front of or behind a sitter. Bubbles (2-unit clusters, never touching
  // the rim, so no lone pixel at the edge) drift a step per frame on the back tiles; the front layer has no use frames.
  for (let x = X0 + T; x < X1 - T - 0.01; x += 2) {
    for (let y = Y0 + T; y < Y1 - T - 0.01; y += 2) {
      const x1 = Math.min(x + 2, X1 - T), y1 = Math.min(y + 2, Y1 - T);
      const front = near((x + x1) / 2, (y + y1) / 2);
      k.box(x, x1, y, y1, WATER - 1, WATER, "teal", {
        front,
        paint: (p, f) => {
          if (f !== "top") return null;
          const edge = p.x < X0 + T + 1 || p.x > X1 - T - 1 || p.y < Y0 + T + 1 || p.y > Y1 - T - 1;
          if (n === 0 || front || edge) return ["teal", 1];
          const h = hash(Math.floor((p.x + 20) / 2), Math.floor((p.y + 20) / 2) + 7 * n);
          return h % 5 === 0 ? ["cream", 0] : h % 5 === 1 ? ["glow", 1] : ["teal", 1];
        },
      });
    }
  }
  // Towel roll on the far end of the rim, a duck on the near corner.
  k.ell({ x: 21, y: -2, z: RIM + 1.4 }, { x: 1.6, y: 3.6, z: 1.4 }, [-99, 99, -99, 99, RIM, RIM + 3], "velvet", { paint: (p, f) => (f !== "top" && Math.abs(p.y + 2) < 0.4 ? ["velvet", 2] : null) });
  k.ell({ x: -4, y: 5.2, z: RIM + 1.4 }, { x: 1.4, y: 1.2, z: 1.3 }, [-99, 99, -99, 99, RIM, RIM + 3], "mustard");
  k.ell({ x: -4.6, y: 5.2, z: RIM + 3.1 }, { x: 0.8, y: 0.8, z: 0.8 }, [-99, 99, -99, 99, RIM + 2, RIM + 4.2], "mustard");
  k.box(-5.8, -5.2, 4.9, 5.5, RIM + 2.8, RIM + 3.3, "ginger", { tones: { top: 0, sw: 0, se: 0 } });
}

/** Big oval wall mirror (OME-1685: an oval with pale glass, so it never reads as the door or the night window). A bevelled
 *  brass frame (lit outer edge top-left, lit inner edge bottom-right), pale glass that darkens toward the bottom, two
 *  diagonal sheen streaks and the reflected lamp glow. */
function wallMirror(k: Kit): void {
  const CZ = 100, RX = 8, RZ = 30;
  const face: LPaint = (p, f) => {
    if (f === "top") return ["mustard", 0];
    const x = p.x, z = p.z - CZ, r = Math.hypot(x / RX, z / RZ);
    const litSide = x - z / 3 < 0; // the top-left half of the ring
    if (r > 0.93) return ["mustard", litSide ? 0 : 2];
    if (r > 0.85) return ["mustard", litSide ? 2 : 0];
    const sheen = x * 3 - z;
    if (Math.abs(sheen - 6) < 2.2 || Math.abs(sheen - 14) < 1) return ["glow", 0];
    if (Math.hypot(x - 3, (z - 14) / 2) < 1.8) return ["mustard", 0];
    return ["glow", z < -12 ? 2 : 1];
  };
  k.ell({ x: 0, y: 7, z: CZ }, { x: RX, y: Infinity, z: RZ }, [-RX - 1, RX + 1, 6.4, 8, 0, 200], "glow", { paint: face });
}

/** Minibar: a short wood cabinet with a lit glass door (bottles and cans inside) and an ice bucket with a bottle on top. */
function minibar(k: Kit): void {
  const H = 18;
  k.box(-6.5, 6.5, -5.5, 6, 0, 1.2, "charcoal");
  const door: LPaint = (p, f) => {
    if (f === "top") return ["wood", 0];
    if (f !== "front") return null;
    if (p.x < -5 || p.x > 5 || p.z < 2.5 || p.z > H - 2) return null;
    if (p.x < -4.2 || p.x > 4.2 || p.z < 3.3 || p.z > H - 2.8) return ["charcoal", 1];
    if (Math.abs(p.z - 10) < 0.4) return ["glow", 2];
    const bottle = Math.floor((p.x + 4.2) / 1.7);
    if (p.z > 10.4 && p.z < 10.4 + 3 + (bottle % 2) * 2.4 && ((p.x + 4.2) % 1.7) < 1.1) return [(["rust", "olive", "mustard", "velvet", "teal"] as const)[bottle % 5] ?? "rust", 1];
    if (p.z > 3.3 && p.z < 7 && ((p.x + 4.2) % 2.1) < 1.5) return [(["pink", "teal", "mustard", "lilac"] as const)[Math.floor((p.x + 4.2) / 2.1) % 4] ?? "pink", 0];
    return ["glow", 1];
  };
  k.box(-6, 6, -5, 5.5, 1.2, H, "wood", { paint: door });
  k.box(4.2, 4.8, -5.6, -5, 6, 13, "mustard", { tones: { top: 0, sw: 0, se: 1 } });
  k.ell({ x: -1.5, y: 1, z: 0 }, { x: 2.6, y: 2.6, z: Infinity }, [-99, 99, -99, 99, H, H + 4], "mustard", { paint: (_p, f) => (f === "top" ? ["glow", 0] : null) });
  k.ell({ x: -1.2, y: 1.4, z: 0 }, { x: 0.9, y: 0.9, z: Infinity }, [-99, 99, -99, 99, H + 4, H + 9], "olive", { paint: (p) => (p.z > H + 7.6 ? ["mustard", 0] : null) });
  k.box(2, 4.6, -1.5, 1.5, H, H + 0.6, "cream");
}

/** Writing desk for a wall: a slim wood top on charcoal legs, a drawer, a brass desk lamp with a lit shade, and a hotel
 *  notepad and pen. */
function desk(k: Kit): void {
  const W0 = -7, W1 = 7, D0 = -1, D1 = 8, H = 20;
  for (const [x, y] of [[W0 + 0.5, D0 + 0.5], [W1 - 1.5, D0 + 0.5], [W0 + 0.5, D1 - 1.5], [W1 - 1.5, D1 - 1.5]] as const) k.box(x, x + 1, y, y + 1, 0, H, "charcoal");
  k.box(0, W1 - 1, D0 + 0.5, D1 - 0.5, H - 5, H, "wood", { paint: (p, f) => (f === "front" && Math.abs(p.z - (H - 2.5)) < 0.5 && Math.abs(p.x - 3) < 1.2 ? ["mustard", 0] : null) });
  k.box(W0, W1, D0, D1, H, H + 1.5, "wood", { paint: (p, f) => (f !== "top" && p.z < H + 0.6 ? ["wood", 2] : null) });
  // Lamp: a round foot, a stem, a cone shade over a glow bulb.
  k.ell({ x: -3.5, y: 5, z: 0 }, { x: 2, y: 2, z: Infinity }, [-99, 99, -99, 99, H + 1.5, H + 2.3], "mustard");
  k.box(-3.9, -3.1, 4.6, 5.4, H + 2.3, H + 13, "mustard");
  k.ell({ x: -3.5, y: 5, z: H + 12 }, { x: 1.2, y: 1.2, z: 1.2 }, [-99, 99, -99, 99, H + 10.5, H + 12.5], "glow", { tones: { top: 0, sw: 0, se: 0 } });
  k.ell({ x: -3.5, y: 5, z: H + 12 }, { x: 3.4, y: 3.4, z: 5 }, [-99, 99, -99, 99, H + 12.5, H + 17], "cream", { paint: (p) => (p.z < H + 13.3 ? ["mustard", 0] : null) });
  k.box(0, 4.4, 0, 4, H + 1.5, H + 2, "cream", { paint: (p, f) => (f === "top" && Math.floor(p.y * 1.4) % 2 === 0 && p.x > 0.6 && p.x < 3.8 ? ["cream", 2] : null) });
  k.box(5, 5.6, 0, 4, H + 1.5, H + 2.1, "navy");
}

/** Washbasin for a wall: a wood vanity with two doors, a cream stone counter, a round vessel basin with a chrome tap,
 *  a soap bar and a teal hand towel on a rail. */
function washbasin(k: Kit): void {
  const D0 = -2, D1 = 8, H = 17;
  k.box(-7, 7, D0 + 0.5, D1, 0, 1.5, "charcoal");
  const doors: LPaint = (p, f) => {
    if (f === "top") return ["wood", 0];
    if (f !== "front") return null;
    if (Math.abs(p.x) < 0.4) return ["wood", 2];
    if (Math.abs(Math.abs(p.x) - 1.4) < 0.4 && p.z > 8 && p.z < 12) return ["mustard", 0];
    return null;
  };
  k.box(-7, 7, D0, D1, 1.5, H, "wood", { paint: doors });
  k.box(-7.5, 7.5, D0 - 0.5, D1, H, H + 1.6, "cream", { paint: (p, f) => (f === "top" && hash(Math.floor(p.x * 2 + 30), Math.floor(p.y * 2 + 30)) % 9 === 0 ? ["cream", 2] : null) });
  k.ell({ x: -0.5, y: 3, z: H + 1.6 }, { x: 4, y: 3.6, z: 3.4 }, [-99, 99, -99, 99, H + 1.6, H + 4.4], "cream", { paint: (p, f) => (f === "top" ? (Math.hypot(p.x + 0.5, p.y - 3) < 2.8 ? ["glow", 1] : ["cream", 0]) : null) });
  k.box(-1, 0, 6.4, 7.4, H + 1.6, H + 8, "glow", { tones: { top: 0, sw: 1, se: 2 } });
  k.box(-1, 0, 4, 7.4, H + 7, H + 8, "glow", { tones: { top: 0, sw: 1, se: 2 } });
  k.box(4.4, 6.6, 3.6, 5.6, H + 1.6, H + 2.6, "pink");
  k.box(-7.4, 7.4, D0 - 1.2, D0 - 0.6, H - 2, H - 1.4, "glow");
  k.box(-5, 1, D0 - 1.6, D0 - 0.9, H - 9, H - 1.4, "teal", { paint: (p, f) => (f !== "top" && Math.abs(p.z - (H - 7.5)) < 0.4 ? ["cream", 0] : null) });
}

// ---------------------------------------------------------------- Dank Dungeon rework (OME-1977): its own lazy sheet, furniture-v7

/** Sauna cabin, 2×2, backing onto a wall: pale cedar boards (lighter than either panelling) under a dark roof trim. Front (into the
 *  room): a glazed door lit from inside, a long handle, light spilling from under it onto the floor, a curl of steam over it and a
 *  thermometer beside it. Side: a window onto a slatted two-tier bench and a stone-topped heater with embers and steam. */
function sauna(k: Kit): void {
  const X0 = -7.5, X1 = 23.5, Y0 = -7.5, Y1 = 23.5, H = 116;
  const boards = (s: number): boolean => ((s + 40) % 4) < 0.6;
  k.box(X0, X1, Y0, Y1, 0, H, "floor", {
    paint: (p, f) => {
      if (f === "top") return ["wood", (Math.floor(p.x + p.y) % 6) < 1 ? 2 : 1];
      if (p.z > H - 6) return ["charcoal", p.z > H - 2 ? 0 : 1];
      if (p.z < 3) return ["charcoal", 2];
      if (f === "right") {
        const s = p.y, z = p.z;
        if (s > -4 && s < 20 && z > 34 && z < 90) {
          if (s < -2.8 || s > 18.8 || z < 35.4 || z > 88.6) return ["charcoal", 2]; // window frame
          // Heater: a dark iron box, a heap of grey stones on top with embers between them, a glow round it.
          if (s < 5 && z < 52) return z > 50.8 || s > 4 ? ["charcoal", 1] : ["charcoal", 2];
          if (s < 5.6 && z < 58) {
            const bump = Math.abs(((s + 20) % 2.4) - 1.2) * 1.6 + (z - 52);
            if (bump > 5.4) return ["ginger", 0];
            const h = hash(Math.floor(s * 2) + 40, Math.floor(z * 2));
            return h % 5 === 0 ? ["mustard", 0] : h % 5 === 1 ? ["rust", 0] : ["charcoal", h % 2 === 0 ? 0 : 1];
          }
          // Steam: a few loose cream pixels rising off the stones.
          if (s < 6 && z > 60 && hash(Math.floor(s * 2) + 7, Math.floor(z)) % 7 === 0) return ["cream", 0];
          // Two-tier bench: a lower step (z 46–49) and the upper seat (z 62–66) with a back rail, slats in pale cedar.
          if (s >= 6) {
            // Dark against the glow, so the bench reads as a silhouette at 1×; slat gaps pick up the light.
            if (z > 61 && z < 66) return ((s + 40) % 2.5) < 0.7 ? ["ginger", 0] : ["wood", z > 64.6 ? 1 : 2];
            if (z > 45 && z < 49) return ((s + 41) % 2.5) < 0.7 ? ["ginger", 0] : ["wood", z > 47.6 ? 1 : 2];
            if (z > 74 && z < 77) return ["wood", 1]; // back rail
            if (z <= 62 && z >= 49 && (Math.abs(s - 8) < 0.7 || Math.abs(s - 17) < 0.7)) return ["wood", 2]; // posts
            if (z <= 46 && (Math.abs(s - 8) < 0.7 || Math.abs(s - 17) < 0.7)) return ["wood", 2];
          }
          return ["ginger", z > 72 ? 1 : 0]; // warm light inside
        }
      }
      if (f === "front") {
        const s = p.x - 4, z = p.z;
        if (Math.abs(s - 15.5) < 1.2 && z > 66 && z < 84) return z < 69 ? ["rust", 0] : Math.abs(s - 15.5) < 0.5 ? ["rust", 1] : ["cream", 0]; // thermometer
        if (s > -1 && s < 13 && z < 96) {
          if (z < 4.5 && s > 0.5 && s < 11.5) return ["mustard", 0]; // light under the door
          if (s < 0.5 || s > 11.5 || z > 94.5) return ["charcoal", 1]; // frame
          if (Math.abs(s - 1.8) < 0.6 && z > 40 && z < 64) return ["wood", 2]; // handle
          if (s > 3 && s < 10.5 && z > 20 && z < 88) {
            const g = s - (z - 20) * 0.1;
            return g > 7 && g < 8.2 ? ["cream", 0] : ["ginger", z > 58 ? 1 : 0]; // glazed, lit inside
          }
          return ["wood", 0];
        }
        if (s > 2 && s < 10 && z > 97 && z < 106 && hash(Math.floor(s * 2) + 3, Math.floor(z)) % 4 === 0) return ["cream", 0]; // steam
      }
      const s = f === "right" ? p.y : p.x;
      return boards(s) ? ["floor", 2] : null;
    },
  });
  // Warm light spilling from under the door onto the floor in front of it.
  k.box(4.5, 15.5, -10.5, -7.5, 0, 0.3, "mustard", { paint: (p, f) => (f !== "top" ? null : p.y > -9 ? ["mustard", 0] : ["ginger", 0]) });
}

/** Round cedar soaking tub for two, 2×2: staves with two dark hoops, the water up to the rim, a little bucket and ladle. The
 *  rim and water in front of each sitter are the `front` layer, as for the whirlpool, so a sitter is in it to the chest. */
function soakTub(k: Kit): void {
  // Centred between the two seats (local y 0), so both sitters are well inside the water; the bucket stands behind it.
  const CX = 8, CY = 4, R = 12, WATER = 15;
  const seats = [k.world(0, 0), k.world(16, 0)];
  // In front of a sitter (toward the camera) and in their screen column (u − v within a body's width): that's what hides them.
  const near = (x: number, y: number): boolean => {
    const w = k.world(x, y);
    return seats.some((s) => w.u - s.u + (w.v - s.v) > 1 && Math.abs(w.u - s.u - (w.v - s.v)) < 8);
  };
  const staves: LPaint = (p, f) => {
    if (f === "top") return ["floor", 0];
    if (Math.abs(p.z - 3.5) < 1.1 || Math.abs(p.z - 10.5) < 1.1) return ["charcoal", 1];
    return ((Math.atan2(p.y - CY, p.x - CX) * 24 + 200) % 3) < 0.45 ? ["floor", 2] : null;
  };
  // The wall in 4-unit wedges so each can sit in front of or behind a sitter; the water in 2-unit tiles for the same reason.
  for (let x = CX - R; x < CX + R - 0.01; x += 4) for (let y = CY - R; y < CY + R - 0.01; y += 4) {
    const mx = x + 2, my = y + 2;
    if (Math.hypot(mx - CX, my - CY) < R - 4.5) continue;
    k.ell({ x: CX, y: CY, z: 0 }, { x: R, y: R, z: Infinity }, [x, x + 4, y, y + 4, 0, WATER - 1], "floor", { paint: staves, front: near(mx, my) });
  }
  for (let x = CX - R + 1; x < CX + R - 1; x += 2) for (let y = CY - R + 1; y < CY + R - 1; y += 2) {
    const mx = x + 1, my = y + 1;
    if (Math.hypot(mx - CX, my - CY) > R + 1.5) continue;
    k.ell({ x: CX, y: CY, z: 0 }, { x: R, y: R, z: Infinity }, [x, x + 2, y, y + 2, WATER - 1, WATER], "teal", {
      front: near(mx, my),
      paint: (p, f) => {
        if (f !== "top") return null;
        const d = Math.hypot(p.x - CX, p.y - CY);
        if (d > R - 1.6) return ["floor", 0]; // the rim's top
        if (d > R - 2.6) return ["floor", 2]; // its inner edge, in shadow
        return hash(Math.floor(p.x * 2) + 50, Math.floor(p.y * 2) + 50) % 13 === 0 ? ["glow", 0] : ["teal", d < 6 ? 1 : 0];
      },
    });
  }
  // Bucket and ladle on the floor beside it (outside the circle, on the near-right corner of the footprint).
  k.ell({ x: 19.5, y: 19.5, z: 0 }, { x: 2.6, y: 2.6, z: Infinity }, [-99, 99, -99, 99, 0, 6], "floor", { paint: (p, f) => (f === "top" ? ["teal", 0] : Math.abs(p.z - 3) < 0.7 ? ["charcoal", 1] : null) });
  k.box(19.2, 19.8, 19, 20, 5, 11, "wood");
  k.box(18.6, 20.4, 18.4, 20.6, 10.4, 11.4, "wood", { tones: { top: 0 } });
}

/** Spa lounger, 2×1: a teak frame on four legs, a thick cream mattress with a raised back at the head (local −x), a rolled teal
 *  towel under the head and a folded one at the foot. Reads as a bed you lie on, not a machine. */
function lounger(k: Kit): void {
  const H = 6.5, MAT = 9.5;
  for (const [x, y] of [[-7, -6.5], [21.5, -6.5], [-7, 5.5], [21.5, 5.5]] as const) k.box(x, x + 1, y, y + 1, 0, H, "wood", { tones: { top: 1 } });
  // Frame rails with slat ends showing along the sides.
  k.box(-7.5, 23.5, -7, 7, H - 1.5, H, "wood", { paint: (p, f) => (f === "top" ? null : ((p.x + p.y + 40) % 2.5) < 0.6 ? ["wood", 2] : ["wood", 1]) });
  k.box(-2, 23, -6.2, 6.2, H, MAT, "cream", { paint: (p, f) => (f === "top" ? (Math.abs(p.x - 10) < 0.4 ? ["cream", 2] : null) : p.z < H + 0.8 ? ["cream", 2] : null) });
  // The raised back: stacked steps leaning toward the head, the mattress carried up it.
  for (let i = 0; i < 6; i++) k.box(-7 + i * 0.9, -6 + i * 0.9, -6.2, 6.2, H, MAT + 11 - i * 2.2, "cream", { tones: { top: 0, sw: 1, se: 2 } });
  k.box(-7.6, -6.6, -6.6, 6.6, H, MAT + 12, "wood", { tones: { top: 0 } });
  k.ell({ x: -2.6, y: 0, z: MAT + 4 }, { x: 1.6, y: 5.2, z: 1.6 }, [-99, 99, -5.2, 5.2, MAT, MAT + 8], "teal", { paint: (p, f) => (f !== "top" && Math.abs(p.y) % 3 < 0.6 ? ["cream", 0] : null) });
  k.box(17, 21.5, -5.5, 5.5, MAT, MAT + 1.6, "teal", { paint: (p, f) => (f !== "top" && Math.abs(p.z - MAT - 0.8) < 0.4 ? ["teal", 2] : Math.abs(p.y) < 0.4 ? ["cream", 0] : null) });
}

/** Tall rectangular wall mirror (OME-1977, the judge's note): a thin brass frame round a cool blue-grey pane, lighter at the top,
 *  one soft diagonal sheen and the faint reflection of someone standing in front of it. One segment, so two hang side by side
 *  over a pair of basins. */
function silverMirror(k: Kit): void {
  const Z0 = 66, Z1 = 158, HW = 6.5;
  const face: LPaint = (p, f) => {
    if (f === "top") return ["mustard", 0];
    const x = p.x, z = p.z;
    if (Math.abs(x) > HW - 1 || z < Z0 + 1 || z > Z1 - 1) return x < -HW + 1 || z > Z1 - 1 ? ["mustard", 0] : ["mustard", 2];
    const sheen = x * 2.2 + (z - Z0) * 0.5;
    if (sheen > 30 && sheen < 33.5) return ["glow", 0];
    // A head and shoulders, centred and faint (one tone off the pane).
    const head = Math.hypot(x - 0.5, (z - 116) / 1.25) < 3.2;
    const body = z < 110 && z > Z0 + 18 && Math.abs(x - 0.5) < 4.6 - Math.max(0, (z - 104) * 0.5);
    if (head || body) return ["navy", 0];
    return ["glow", z > 132 ? 1 : 2];
  };
  k.box(-HW, HW, 6.6, 8, Z0, Z1, "glow", { paint: face });
}

/** Cream bar fridge, 1×1, standing on its own: a freezer seam, two long dark handles, a kick plate, a teal badge and two bottles. */
function barFridge(k: Kit): void {
  const H = 32;
  k.box(-6, 6, -1, 8, 0, H, "cream", {
    paint: (p, f) => {
      if (f === "top") return ["cream", 0];
      if (p.z < 2.5) return ["charcoal", 2];
      if (f !== "front") return null;
      if (Math.abs(p.z - 23) < 0.5 || Math.abs(p.x) > 5.4) return ["cream", 2];
      if (Math.abs(p.x - 4) < 0.6 && ((p.z > 8 && p.z < 21) || (p.z > 24.5 && p.z < 30))) return ["charcoal", 2];
      if (Math.abs(p.x + 3) < 1 && Math.abs(p.z - 27) < 0.8) return ["teal", 0];
      return null;
    },
  });
  k.ell({ x: -2, y: 3, z: 0 }, { x: 1.2, y: 1.2, z: Infinity }, [-99, 99, -99, 99, H, H + 7], "teal");
  k.ell({ x: 2, y: 4, z: 0 }, { x: 1.2, y: 1.2, z: Infinity }, [-99, 99, -99, 99, H, H + 6], "rust");
}

/** Oval velvet rug, 2×2, flat: a velvet field with a darker inner ring, a gold border and a little gold lozenge in the middle. */
function ovalRugImage(s = 1, cv: Canvas = CANVAS): Uint8Array {
  const img = new Uint8Array(cv.w * cv.h);
  const at = (u: number, v: number): number => ((u - 8) / 15.5) ** 2 + ((v - 8) / 11) ** 2;
  for (let py = 0; py < cv.h; py++) {
    for (let px = 0; px < cv.w; px++) {
      const sx = (px + 0.5 - cv.ax) / s, sy = (py + 0.5 - cv.ay) / s;
      const u = (sy + sx / 2) / 2, v = (sy - sx / 2) / 2;
      const e = at(u, v);
      if (e > 1) continue;
      let p: Paint = ["velvet", 1];
      if (e > 0.8) p = ["mustard", e > 0.9 ? 2 : 1];
      else if (e > 0.62 && e < 0.68) p = ["velvet", 2];
      else if (Math.abs(u - 8) + Math.abs(v - 8) * 1.4 < 4) p = ["mustard", 1];
      img[py * cv.w + px] = colorIndex(p[0], p[1]);
    }
  }
  // Plum outline round the oval, like every floor piece.
  addOutline(img, cv.w, cv.h);
  return img;
}

/** A flat-screen TV on the room's corner console (cell (0,0) units, as `tvSolids`): a thin dark bezel, a navy screen lit teal low
 *  down, a glint top-left, a stand and a power light. The console and its knick-knacks are the room's, minus the projector. */
function flatTvImage(s = 1, cv: Canvas = CANVAS): Uint8Array {
  const pl = (u: number, v: number, d: number): { n: Vec3; d: number } => ({ n: { u, v, z: 0 }, d });
  const Z0 = 27, Z1 = 55, HW = 15;
  const screen: Solid = {
    ramp: "charcoal",
    planes: [pl(1, 1, 15), pl(-1, -1, -12), pl(1, -1, HW), pl(-1, 1, HW), { n: { u: 0, v: 0, z: 1 }, d: Z1 }, { n: { u: 0, v: 0, z: -1 }, d: -Z0 }],
    paint: (p, f) => {
      if (f === "top") return ["charcoal", 1];
      if (p.u + p.v < 14.6) return ["charcoal", 2];
      const x = 2 * (p.u - p.v);
      if (Math.abs(x) > 2 * HW - 2.5 || p.z < Z0 + 1.5 || p.z > Z1 - 1.2) return Math.abs(x + 1) < 1 && p.z < Z0 + 1 ? ["mustard", 0] : ["charcoal", 2];
      const g = x + 2 * (p.z - Z0);
      if (g < -18 && g > -26) return ["glow", 2];
      if (p.z < Z0 + 9) return ["teal", p.z < Z0 + 5 ? 1 : 0];
      return ["navy", p.z > Z1 - 8 ? 2 : 1];
    },
  };
  const solids = [...tvSolids().slice(0, -1), box(4, 7, 4, 7, 20, Z0, "charcoal"), box(2, 9, 2, 9, 20, 21, "charcoal", { tones: { top: 1, sw: 2, se: 2 } }), screen];
  return renderSolids(solids, cv.w, cv.h, cv.ax, cv.ay, "all", s).img;
}

// ---------------------------------------------------------------- theatre set v2 (OME-1639): its own lazy sheet, furniture-v5

/** Riser height per theatre-row variant, px (= z units): what the web lifts a sitter by (`meta.omega.pieces[].seatLiftByColour`). */
export const THEATRE_LIFT = { floor: 0, step: 10, high: 20 } as const;
type RowLevel = keyof typeof THEATRE_LIFT;
const levelOf = (c: string): RowLevel => (c === "step" || c === "high" ? c : "floor");

/** Theatre carpet in world units: a navy field on a 16-unit lattice, gold diamonds at the crossings, wine dots between.
 *  Periodic in 16, so tiles and risers butt seamlessly wherever they land on the grid. */
function carpetPaint(u: number, v: number): Paint {
  const a = ((u % 16) + 16) % 16, b = ((v % 16) + 16) % 16;
  const da = Math.min(a, 16 - a), db = Math.min(b, 16 - b);
  if (da + db < 1.2) return ["mustard", 0];
  if (da + db < 2.2) return ["mustard", 2];
  const ca = Math.abs(a - 8), cb = Math.abs(b - 8);
  if (ca + cb < 1.6) return ["velvet", 1];
  if (da < 0.5 || db < 0.5) return ["night", 2];
  return ["night", 1];
}

/** Two flip-down velvet seats on charcoal standards with wood arm caps; variants `step` and `high` stand them on a
 *  carpeted riser whose back edge carries a lit brass nosing, so the rows read as tiers from behind. */
function theatreRow(k: Kit, colour: string): void {
  const L = THEATRE_LIFT[levelOf(colour)];
  if (L > 0) {
    k.box(-8, 24, -8, 8, 0, L, "night", {
      paint: (p, f) => {
        if (f === "top") return carpetPaint(p.x, p.y);
        // The nosing: a brass strip under the riser's top edge with a warm step light every half seat.
        if (p.z >= L - 2) return Math.abs(((p.x + p.y + 64) % 8) - 4) < 0.9 && p.z < L - 0.5 ? ["glow", 0] : ["mustard", p.z >= L - 1 ? 0 : 1];
        return p.z < 1 ? ["night", 2] : ["night", 1];
      },
    });
  }
  const cap: LPaint = (p, f) => (p.z >= L + 11.5 ? (f === "top" ? ["wood", 0] : ["wood", 1]) : null);
  const standard = (x0: number, front: boolean): void => { k.box(x0, x0 + 1.6, -5.5, 4.5, L, L + 12.8, "charcoal", { paint: cap, front }); };
  standard(-8, false);
  standard(7.2, false);
  standard(22.4, true);
  for (const c of [0, 16]) {
    // Seat pan: piped front edge.
    k.box(c - 6.2, c + 6.2, -5, 3, L + 4.5, L + SEAT_HEIGHT, "velvet", { paint: (p, f) => (f === "top" ? ["velvet", 0] : p.z < L + 5.4 ? ["velvet", 2] : null) });
    // Backrest: rounded crown, two channel seams and a brass seat plate on the back the audience behind sees.
    k.box(c - 6.2, c + 6.2, 3, 6.5, L + 4.5, L + 21, "velvet", {
      front: true,
      paint: (p, f) => {
        if (f === "top") return ["velvet", 0];
        if (p.z >= L + 20) return ["velvet", 0];
        if (f !== "back") return null;
        const dx = p.x - c;
        if (Math.abs(dx) < 1.6 && p.z >= L + 16.5 && p.z < L + 18.5) return ["mustard", p.z >= L + 17.5 ? 0 : 1];
        if (Math.abs(Math.abs(dx) - 2.6) < 0.4 && p.z < L + 15.5 && p.z > L + 6) return ["velvet", 2];
        return p.z < L + 6 ? ["velvet", 2] : null;
      },
    });
  }
}

/** Partition stub height (OME-1959): low enough that an avatar one row behind shows from the knees up. */
export const PARTITION_STUB = 16;
const PARTITION_BAND = [110, 114] as const;
/** The panelled glass's stripe (OME-1977): thinner and up near the header, clear of the beds and the tub behind the pane. */
const PANEL_BAND = [133, 135] as const;
/** A partition cell's outline (OME-1959): none on its trailing end (local x = −8, the side the previous cell in the run is drawn
 *  on), so a row joins like one wall; none round the glass band, so it reads as a frosted stripe, not a rail. */
function partitionOutline(dir: FurnDir, colour: string, x: number, y: number): boolean {
  // Screen x = 2(u − v), y = u + v − z. Along the trailing end plane: s = how far across the wall's thickness, z = height.
  const s = dir === "sw" ? -8 - x / 2 : x / 2 - 8;
  const z = -8 + s - y;
  if (s >= -2.5 && z >= -3 && z <= WALL_H + 2) return false;
  const zMid = (dir === "sw" ? x / 2 : -x / 2) - y; // height on the wall's mid plane
  const band = colour === "panelglass" ? PANEL_BAND : PARTITION_BAND;
  return !((colour === "glass" || colour === "panelglass") && zMid > band[0] - 2.5 && zMid < band[1] + 2.5);
}
/** Interior wall cell (OME-1959): the room's own wall (wainscot, lozenge paper, crown), one wall thick through the cell's middle, so
 *  a row of them reads as part of the shell. `glass`: a wainscot sill at mattress height and a header, each with a black frame, open
 *  in between except one frosted stripe, which lines up from cell to cell into a single band through the whole window. `cut` (n = 1):
 *  the low stub for a viewer whose avatar is behind the wall, sawn off flat; the glass one keeps its black sill cap. */
function partition(k: Kit, colour: string, cut: boolean): void {
  const T = 2, SILL = 24, HEAD = 150, lit = k.dir === "sw";
  const glass = colour === "glass" || colour === "panelglass";
  // OME-1977: `panel` / `panelglass` wear the spa's smoked panelling (the side the camera sees) instead of the room's paper.
  const paint = colour.startsWith("panel") ? (s: number, z: number, l: boolean): Paint => panelPaint("smoke", s, z, l) : (s: number, z: number, l: boolean): Paint => wallPaint("plain", s, z, l);
  const band = colour === "panelglass" ? PANEL_BAND : PARTITION_BAND;
  const wall: LPaint = (p, f) => (f === "top" ? ["wall", 0] : f === "front" ? paint(p.x, p.z, lit) : paint(p.y, p.z, !lit));
  // The wainscot without its panel inset, which a sill or a stub would cut in half.
  const wood: LPaint = (p, f) => (f === "top" ? ["wood", 0] : p.z < 5 ? ["wood", 2] : ["wood", (f === "front") === lit ? 1 : 2]);
  const frame = (z0: number, z1: number): void => { k.box(-8, 8, -T - 0.5, T + 0.5, z0, z1, "charcoal", { tones: { top: 1, sw: 2, se: 2 } }); };
  if (cut) {
    k.box(-8, 8, -T, T, 0, glass ? PARTITION_STUB - 2 : PARTITION_STUB, "wood", { paint: wood });
    if (glass) frame(PARTITION_STUB - 2, PARTITION_STUB);
    return;
  }
  if (!glass) {
    k.box(-8, 8, -T, T, 0, WALL_H, "wall", { paint: wall });
    return;
  }
  k.box(-8, 8, -T, T, 0, SILL, "wood", { paint: colour === "panelglass" ? wall : wood });
  frame(SILL, SILL + 2);
  k.box(-8, 8, -0.5, 0.5, band[0], band[1], "glow", { tones: { top: 0, sw: 0, se: 1 } });
  frame(HEAD - 2, HEAD);
  k.box(-8, 8, -T, T, HEAD, WALL_H, "wall", { paint: wall });
}

/** Stage curtain for a wall segment: deep velvet folds from a gold-fringed pelmet to the floor, cinched by a brass tie-back
 *  and flaring out below it. One kind: facing se it hangs on the left wall, sw on the right, so a pair frames the screen. */
function curtain(k: Kit): void {
  const TOP = 186, TIE = 64;
  const half = (z: number): number => (z >= 110 ? 8 : z >= TIE ? 4.5 + (3.5 * (z - TIE)) / (110 - TIE) : 4.5 + (2.8 * (TIE - z)) / TIE);
  const folds: LPaint = (p, f) => {
    if (f === "top") return ["velvet", 1];
    if (f !== "front") return ["velvet", 2];
    // Folds: highlight on each fold's left flank (light from the top-left), shade in the trough; pinched toward the tie-back.
    const w = half(p.z);
    const t = (((p.x / w) * 2.5 + 10) % 1 + 1) % 1;
    return t < 0.28 ? ["velvet", 0] : t < 0.72 ? ["velvet", 1] : ["velvet", 2];
  };
  for (let z = 0; z < TOP; z += 2) {
    const w = half(z + 1);
    k.box(-w, w, 2.5, 7.5, z, z + 2, "velvet", { paint: folds });
  }
  k.box(-5.5, 5.5, 2, 7.6, TIE - 2, TIE + 2, "mustard", { tones: { top: 0, sw: 0, se: 1 } });
  k.ell({ x: 4.6, y: 2.2, z: TIE - 5 }, { x: 1.3, y: 1.3, z: 3.2 }, [-99, 99, -99, 99, TIE - 9, TIE - 1], "mustard", { tones: { top: 0, sw: 0, se: 1 } });
  // Pelmet: a velvet box with gold piping and a scalloped fringe.
  k.box(-9, 9, 1, 8, TOP, TOP + 14, "velvet", {
    paint: (p, f) => {
      if (f === "top") return ["velvet", 0];
      if (p.z >= TOP + 12) return ["mustard", 0];
      if (p.z < TOP + 2.5) return Math.floor(p.x + 20) % 3 === 0 ? ["mustard", 2] : ["mustard", 1];
      return f === "front" ? ["velvet", 1] : ["velvet", 2];
    },
  });
}

/** The 2× screen frame: a raised stage across the back corner (front plane u + v = 22) with a pleated velvet skirt, and a
 *  big camera-facing screen behind it in a charcoal frame with a brass lip. World units of cell (0,0), like the TV console. */
function bigScreen(k: Kit): void {
  const plane = (nu: number, nv: number, nz: number, d: number): { n: Vec3; d: number } => ({ n: { u: nu, v: nv, z: nz }, d });
  const SF = 22, SZ = 7;
  const stage: Solid = {
    ramp: "wood",
    planes: [plane(-1, 0, 0, 8), plane(0, -1, 0, 8), plane(1, 1, 0, SF), plane(0, 0, 1, SZ), plane(0, 0, -1, 0)],
    paint: (p, f) => {
      if (f === "top") return Math.floor(p.u - p.v + 64) % 6 === 0 ? ["wood", 2] : ["wood", 1];
      if (p.z >= SZ - 1.2) return ["mustard", 0];
      const x = 2 * (p.u - p.v);
      return Math.abs(((x + 64) % 6) - 3) < 1 ? ["velvet", 2] : Math.abs(((x + 64) % 6) - 3) < 2 ? ["velvet", 1] : ["velvet", 0];
    },
  };
  // The screen slab: the frame is the slab's rim, the picture its face. 2:1 → x = 2(u − v), so the face is 112 px wide.
  const FB = 12, FF = 15, Z0 = SZ + 6, Z1 = SZ + 78, HW = 2 * (FF + 16) - 2;
  const screen: Solid = {
    ramp: "charcoal",
    planes: [plane(-1, 0, 0, 8), plane(0, -1, 0, 8), plane(1, 1, 0, FF), plane(-1, -1, 0, -FB), plane(0, 0, 1, Z1), plane(0, 0, -1, -Z0)],
    paint: (p, f) => {
      if (f === "top") return ["charcoal", 0];
      const x = 2 * (p.u - p.v), z = p.z;
      const e = Math.min(HW - Math.abs(x), z - Z0, Z1 - z);
      if (e < 2) return ["charcoal", x < 0 || z > Z1 - 2 ? 0 : 2];
      if (e < 3) return ["mustard", x < 0 || z > Z1 - 3 ? 0 : 1];
      if (e < 5) return ["outline", 1];
      // The picture: lit white-blue, a soft sheen across the top-left, falling off toward the bottom edge.
      const t = (x + HW) / (2 * HW) + (Z1 - z) / (Z1 - Z0);
      return t < 0.55 ? ["glow", 0] : z - Z0 < 9 ? ["glow", 2] : ["glow", 1];
    },
  };
  k.parts.push({ solid: stage, front: false }, { solid: screen, front: false });
}

/** Aisle floor light: a slim charcoal rail with three warm lamps along the aisle, each spilling a dithered pool on the floor. */
function aisleLightImage(dir: FurnDir, s = 1, cv: Canvas = CANVAS): Uint8Array {
  const k = new Kit(dir);
  k.box(-7, 7, -0.9, 0.9, 0, 0.8, "charcoal");
  const lamps = [-4.8, 0, 4.8];
  for (const x of lamps) k.ell({ x, y: 0, z: 0.8 }, { x: 1.6, y: 1.6, z: 1.2 }, [-99, 99, -99, 99, 0.8, 2.4], "mustard", { paint: (p, f) => (f === "top" && Math.hypot(p.x - x, p.y) < 0.9 ? ["cream", 0] : null), tones: { top: 0, sw: 0, se: 1 } });
  const img = renderSolids(k.parts.map((q) => q.solid), cv.w, cv.h, cv.ax, cv.ay, "none", s).img;
  addOutline(img, cv.w, cv.h);
  // The pools stay unoutlined: every other pixel near each lamp, so the planks read through like light.
  for (let py = 0; py < cv.h; py++) {
    for (let px = 0; px < cv.w; px++) {
      if ((img[py * cv.w + px] ?? 0) !== 0 || (px + py) % 2 !== 0) continue;
      const sx = (px + 0.5 - cv.ax) / s, sy = (py + 0.5 - cv.ay) / s;
      const u = (sy + sx / 2) / 2, v = (sy - sx / 2) / 2;
      const { x, y } = dir === "ne" ? { x: u, y: v } : { x: v, y: u };
      if (lamps.some((lx) => Math.hypot(x - lx, y) < 4)) img[py * cv.w + px] = colorIndex("mustard", 0);
    }
  }
  return img;
}

/** Carpet tile, 2×2: the theatre carpet with no outline, so neighbouring tiles join into one floor. */
function carpetImage(s = 1, cv: Canvas = CANVAS): Uint8Array {
  const img = new Uint8Array(cv.w * cv.h);
  for (let py = 0; py < cv.h; py++) {
    for (let px = 0; px < cv.w; px++) {
      const sx = (px + 0.5 - cv.ax) / s, sy = (py + 0.5 - cv.ay) / s;
      const u = (sy + sx / 2) / 2, v = (sy - sx / 2) / 2;
      if (u < -8 || u >= 24 || v < -8 || v >= 24) continue;
      const p = carpetPaint(u, v);
      img[py * cv.w + px] = colorIndex(p[0], p[1]);
    }
  }
  return img;
}

// ---------------------------------------------------------------- catalogue

export interface PieceMeta {
  id: string;
  label: string;
  kind: "seat" | "table" | "light" | "plant" | "rug" | "storage" | "wall" | "fun";
  mount: "floor" | "wall";
  layer: "floor" | "object" | "wall";
  /** Colour (or artwork) variants: the third key segment. The first one is the default. */
  colours: string[];
  dirs: FurnDir[];
  /** Cells covered, growing from the anchor cell toward +col/+row. Wall pieces cover none (they hang on that cell's wall). */
  footprint: { cols: number; rows: number };
  /** Footprint cells per dir; ne/sw keep (cols, rows), nw/se swap them. */
  footprintByDir: Partial<Record<FurnDir, { cols: number; rows: number }>>;
  /** Z-sort floor point relative to the anchor, px: the footprint's centre. */
  sortByDir: Partial<Record<FurnDir, { x: number; y: number }>>;
  /** Seat cells relative to the anchor cell, with the sitter's facing (use `<avatar>/sit/<dir>`). */
  seatsByDir?: Partial<Record<FurnDir, { col: number; row: number; dir: FurnDir }[]>>;
  walkable: boolean;
  /** Layers per dir: `front` exists only where something sits between a sitter and the camera. */
  layersByDir: Partial<Record<FurnDir, ("back" | "front")[]>>;
  /** "In use" loop, drawn in place of `back`: `furniture/<id>/<colour>/use/<dir>/<0..frames-1>`, each frame shown `ms`. */
  use?: { frames: number; ms: number };
  /** Has an "open" frame, drawn in place of `back` (same rect, so same anchor): `furniture/<id>/<colour>/open/<dir>`. */
  open?: true;
  /** Has a cut-down stub (OME-1959), drawn in place of `back` while the viewer's avatar is behind it: `furniture/<id>/<colour>/cut/<dir>`.
   *  Its own tight rect and anchor (the same floor point), so draw it as its own sprite at the piece's cell. */
  cut?: true;
  /** The piece walks off on its own (the cat): `furniture/<id>/<colour>/walk/<dir>/<0..frames-1>`, each shown `ms` (the avatars'
   *  walk clock), rests in `furniture/<id>/<colour>/sit/<dir>` (both anchored on the feet's centre) and leaves
   *  `furniture/<id>/<colour>/bed/<dir>` behind (the empty cushion, `back`'s rect and anchor). */
  walk?: { frames: number; ms: number };
  /** A raised seat (the theatre rows, OME-1639): draw its sitters this many px higher, per colour. Absent = 0. */
  seatLiftByColour?: Record<string, number>;
  /** Sleepers side by side (the queen bed, OME-1983): `furniture/<id>/<colour>/cover/<dir>/<0..covers-1>`, the duvet pulled
   *  over that sleeper, in `back`'s rect (same anchor). Draw it right after its sleeper (lying.json `pieces`). */
  covers?: number;
}

export interface PieceDef {
  id: string;
  label: string;
  kind: PieceMeta["kind"];
  mount?: "wall";
  layer?: "floor" | "wall";
  colours: readonly string[];
  dirs: readonly FurnDir[];
  cols: number;
  rows: number;
  /** Seat cells along local x (0 = anchor cell). */
  seats?: readonly number[];
  /** The seats are on the front (−y) row of a 2-row piece, which is the footprint's last row facing se/sw (the queen bed). */
  frontRow?: true;
  /** Duvet frames pulled over each of this many sleepers: build gets n = 2.. for them (see PieceMeta `coverKey`). */
  covers?: number;
  walkable?: boolean;
  /** "In use" loop: `frames` extra back frames (build gets n = 1..frames; n = 0 is the idle frame), each shown `ms`. */
  use?: { frames: number; ms: number };
  /** Has an "open" frame: build gets n = 1 for it. */
  open?: true;
  /** Has a cut-down stub: build gets n = 1 for it. */
  cut?: true;
  /** Keep only the plum outline pixels this says yes to (anchor-relative px), so a run of cells joins without seams. */
  keepOutline?: (dir: FurnDir, colour: string, x: number, y: number) => boolean;
  build?: (k: Kit, colour: string, n: number) => void;
  /** `n`: the use frame (1..use.frames), as for `build`; 0 = idle. */
  image?: (dir: FurnDir, colour: string, s?: number, cv?: Canvas, n?: number) => Uint8Array;
  /** Walk loop, sit and empty-bed frames (see PieceMeta.walk). */
  walk?: { frames: number; ms: number; draw: (dir: FurnDir, colour: string, back: { x0: number; y0: number; w: number; h: number }) => RoomFrame[] };
  /** How far a sitter is lifted per colour, px (see PieceMeta.seatLiftByColour). */
  seatLift?: Readonly<Record<string, number>>;
}

const ALL: readonly FurnDir[] = ["ne", "nw", "se", "sw"];
const asRamp = (c: string): RampName => c as RampName;
export const PIECES: readonly PieceDef[] = [
  { id: "sofa", label: "Club sofa", kind: "seat", colours: ["velvet", "navy"], dirs: ALL, cols: 2, rows: 1, seats: [0, 1], build: (k, c) => { sofa(k, asRamp(c)); } },
  { id: "couch", label: "Lounge couch", kind: "seat", colours: ["cream", "olive"], dirs: ALL, cols: 2, rows: 1, seats: [0, 1], build: (k, c) => { couch(k, asRamp(c)); } },
  { id: "wingback", label: "Wingback chair", kind: "seat", colours: ["ginger"], dirs: ALL, cols: 1, rows: 1, seats: [0], build: (k, c) => { wingback(k, asRamp(c)); } },
  { id: "beanbag", label: "Beanbag", kind: "seat", colours: ["blush", "navy"], dirs: ALL, cols: 1, rows: 1, seats: [0], build: (k, c) => { beanbag(k, asRamp(c)); } },
  { id: "sidetable", label: "Snack table", kind: "table", colours: ["wood"], dirs: ["se", "sw"], cols: 1, rows: 1, build: (k) => { sideTable(k); } },
  { id: "arclamp", label: "Arc lamp", kind: "light", colours: ["brass"], dirs: ["se", "sw"], cols: 1, rows: 1, build: (k) => { arcLamp(k); } },
  { id: "monstera", label: "Monstera", kind: "plant", colours: ["rust", "teal"], dirs: ["se", "sw"], cols: 1, rows: 1, image: (d, c, s, cv) => monstera(d, asRamp(c), s, cv) },
  { id: "popcorn", label: "Popcorn cart", kind: "fun", colours: ["rust"], dirs: ["se", "sw"], cols: 1, rows: 1, build: (k) => { popcornCart(k); } },
  { id: "bookshelf", label: "Bookcase", kind: "storage", colours: ["wood"], dirs: ["se", "sw"], cols: 2, rows: 1, build: (k) => { bookshelf(k); } },
  {
    id: "rug", label: "Kilim runner", kind: "rug", layer: "floor", colours: ["lilac", "teal"], dirs: ["ne", "nw"], cols: 3, rows: 2, walkable: true,
    image: (d, c, s, cv) => rugImage(d === "nw" ? "nw" : "ne", c === "teal" ? "teal" : "lilac", c === "teal" ? "mustard" : "pink", s, cv),
  },
  { id: "frame", label: "Framed print", kind: "wall", mount: "wall", layer: "wall", colours: ["dusk", "tide"], dirs: ["se", "sw"], cols: 0, rows: 0, walkable: true, build: (k, c) => { wallFrame(k, c === "tide" ? "tide" : "dusk"); } },
  // Catalogue v2 (OME-1103).
  { id: "floorcushion", label: "Floor cushions", kind: "seat", colours: ["mustard", "teal"], dirs: ALL, cols: 1, rows: 1, seats: [0], build: (k, c) => { floorCushion(k, asRamp(c)); } },
  { id: "bench", label: "Storage bench", kind: "seat", colours: ["teal", "pink"], dirs: ALL, cols: 2, rows: 1, seats: [0, 1], build: (k, c) => { bench(k, asRamp(c)); } },
  { id: "turntable", label: "Record console", kind: "fun", colours: ["wood"], dirs: ["se", "sw"], cols: 1, rows: 1, use: { frames: 4, ms: 120 }, build: (k, _c, n) => { recordConsole(k, n); } },
  { id: "speaker", label: "Floor speaker", kind: "fun", colours: ["wood", "teal"], dirs: ["se", "sw"], cols: 1, rows: 1, build: (k, c) => { floorSpeaker(k, asRamp(c)); } },
  { id: "cat", label: "Sleepy cat", kind: "fun", colours: ["ginger", "charcoal"], dirs: ["se", "sw"], cols: 1, rows: 1, image: (d, c, s, cv) => sleepyCat(d, asRamp(c), s, cv), walk: { frames: WALK_FRAMES, ms: WALK_FRAME_MS, draw: (d, c, r) => catMotion(c, d, r) } },
  { id: "wallshelf", label: "Wall shelf", kind: "wall", mount: "wall", layer: "wall", colours: ["wood"], dirs: ["se", "sw"], cols: 0, rows: 0, walkable: true, build: (k) => { wallShelf(k); } },
  { id: "garland", label: "String lights", kind: "light", mount: "wall", layer: "wall", colours: ["warm", "party"], dirs: ["se", "sw"], cols: 0, rows: 0, walkable: true, build: (k, c) => { garland(k, c); } },
  // Catalogue v3 (OME-1348), packed into the v2 sheet.
  { id: "coffeetable", label: "Coffee table", kind: "table", colours: ["wood"], dirs: ["se", "sw"], cols: 1, rows: 1, build: (k) => { coffeeTable(k); } },
  { id: "pouf", label: "Knitted pouf", kind: "seat", colours: ["rust", "lilac"], dirs: ALL, cols: 1, rows: 1, seats: [0], build: (k, c) => { pouf(k, asRamp(c)); } },
  { id: "neonsign", label: "Neon sign", kind: "light", mount: "wall", layer: "wall", colours: ["pink", "teal"], dirs: ["se", "sw"], cols: 0, rows: 0, walkable: true, use: { frames: 3, ms: 140 }, build: (k, c, n) => { neonSign(k, asRamp(c), n); } },
  { id: "aquarium", label: "Aquarium", kind: "fun", colours: ["teal"], dirs: ["se", "sw"], cols: 1, rows: 1, use: { frames: 3, ms: 220 }, build: (k, _c, n) => { aquarium(k, n); } },
  { id: "arcade", label: "Arcade cabinet", kind: "fun", colours: ["night"], dirs: ["se", "sw"], cols: 1, rows: 1, use: { frames: 3, ms: 160 }, build: (k, _c, n) => { arcade(k, n); } },
  // Batch 5 (OME-1424), packed into the v2 sheet.
  { id: "door", label: "Panel door", kind: "fun", colours: ["wood", "painted"], dirs: ["se", "sw"], cols: 1, rows: 1, walkable: true, open: true, build: (k, c, n) => { door(k, c === "painted", n === 1); } },
  { id: "wallclock", label: "Sunburst clock", kind: "wall", mount: "wall", layer: "wall", colours: ["brass"], dirs: ["se", "sw"], cols: 0, rows: 0, walkable: true, build: (k) => { wallClock(k); } },
  // Batch 6 (OME-1437): its own small lazy sheet, furniture-v4.
  { id: "hammock", label: "Hammock", kind: "seat", colours: ["rust"], dirs: ALL, cols: 2, rows: 1, seats: [0, 1], use: { frames: 4, ms: 260 }, build: (k, c, n) => { hammock(k, asRamp(c), n); } },
  { id: "stool", label: "Stool", kind: "seat", colours: ["wood", "teal"], dirs: ALL, cols: 1, rows: 1, seats: [0], build: (k, c) => { stool(k, c); } },
  { id: "barcounter", label: "Bar counter", kind: "table", colours: ["wood"], dirs: ["se", "sw"], cols: 2, rows: 1, build: (k) => { barCounter(k); } },
  { id: "piano", label: "Upright piano", kind: "fun", colours: ["wood", "charcoal"], dirs: ["se", "sw"], cols: 2, rows: 1, use: { frames: 2, ms: 300 }, build: (k, c, n) => { piano(k, asRamp(c), n); } },
  { id: "fireplace", label: "Fireplace", kind: "fun", colours: ["stone"], dirs: ["se", "sw"], cols: 1, rows: 1, use: { frames: 4, ms: 120 }, build: (k, _c, n) => { fireplace(k, n); } },
  // Batch 12 (OME-1546), packed into the v4 sheet. Round, so one facing (the contract's `se`); the active frame is its one-frame "in use" loop.
  { id: "pad", label: "Teleport pad", kind: "fun", layer: "floor", colours: ["teal", "lilac"], dirs: ["se"], cols: 1, rows: 1, walkable: true, use: { frames: 1, ms: 1000 }, image: (_d, c, s, cv, n) => padImage(asRamp(c), n, s, cv) },
  // Dank Dungeon (OME-1670): its own lazy sheet, furniture-v6. The desk and the washbasin back onto a wall like the bookcase.
  { id: "bed", label: "Queen bed", kind: "seat", colours: ["velvet"], dirs: ALL, cols: 2, rows: 2, seats: [0, 1], frontRow: true, covers: 2, build: (k, c, n) => { bed(k, asRamp(c), n); } },
  { id: "whirlpool", label: "Whirlpool", kind: "seat", colours: ["teal"], dirs: ALL, cols: 2, rows: 1, seats: [0, 1], use: { frames: 2, ms: 200 }, build: (k, _c, n) => { whirlpool(k, n); } },
  { id: "mirror", label: "Wall mirror", kind: "wall", mount: "wall", layer: "wall", colours: ["brass", "silver"], dirs: ["se", "sw"], cols: 0, rows: 0, walkable: true, build: (k, c) => { if (c === "silver") silverMirror(k); else wallMirror(k); } },
  { id: "minibar", label: "Minibar", kind: "fun", colours: ["wood", "fridge"], dirs: ["se", "sw"], cols: 1, rows: 1, build: (k, c) => { if (c === "fridge") barFridge(k); else minibar(k); } },
  { id: "desk", label: "Writing desk", kind: "table", colours: ["wood"], dirs: ["se", "sw"], cols: 1, rows: 1, build: (k) => { desk(k); } },
  { id: "washbasin", label: "Washbasin", kind: "fun", colours: ["cream"], dirs: ["se", "sw"], cols: 1, rows: 1, build: (k) => { washbasin(k); } },
  // Interior wall (OME-1959), packed into v6 with the room it was made for. Facing picks the axis like the curtain: sw runs along a row, se along a col.
  { id: "partition", label: "Interior wall", kind: "wall", colours: ["solid", "glass", "panel", "panelglass"], dirs: ["se", "sw"], cols: 1, rows: 1, cut: true, keepOutline: partitionOutline, build: (k, c, n) => { partition(k, c, n === 1); } },
  // Theatre set v2 (OME-1639): its own lazy sheet, furniture-v5. A row's colour is its riser height (THEATRE_LIFT).
  { id: "theatrerow", label: "Theatre row", kind: "seat", colours: ["floor", "step", "high"], dirs: ["ne", "nw"], cols: 2, rows: 1, seats: [0, 1], seatLift: THEATRE_LIFT, build: (k, c) => { theatreRow(k, c); } },
  { id: "curtain", label: "Stage curtain", kind: "wall", mount: "wall", layer: "wall", colours: ["velvet"], dirs: ["se", "sw"], cols: 0, rows: 0, walkable: true, build: (k) => { curtain(k); } },
  { id: "bigscreen", label: "Big screen", kind: "fun", colours: ["charcoal"], dirs: ["se"], cols: 1, rows: 1, build: (k) => { bigScreen(k); } },
  { id: "aislelight", label: "Aisle lights", kind: "light", layer: "floor", colours: ["warm"], dirs: ["ne", "nw"], cols: 1, rows: 1, walkable: true, image: (d, _c, s, cv) => aisleLightImage(d, s, cv) },
  { id: "carpet", label: "Theatre carpet", kind: "rug", layer: "floor", colours: ["navy", "oval"], dirs: ["se"], cols: 2, rows: 2, walkable: true, image: (_d, c, s, cv) => (c === "oval" ? ovalRugImage(s, cv) : carpetImage(s, cv)) },
  // Dank Dungeon rework (OME-1977): its own lazy sheet, furniture-v7, with the new colours above (V7_COLOURS). The sauna backs onto
  // a wall; the tub is round, so one facing; the TV is the room's corner console with a flat screen instead of the projector.
  { id: "sauna", label: "Sauna cabin", kind: "fun", colours: ["cedar"], dirs: ["se", "sw"], cols: 2, rows: 2, build: (k) => { sauna(k); } },
  { id: "soaktub", label: "Cedar soaking tub", kind: "seat", colours: ["cedar"], dirs: ["se"], cols: 2, rows: 2, seats: [0, 1], build: (k) => { soakTub(k); } },
  { id: "lounger", label: "Spa lounger", kind: "seat", colours: ["teak"], dirs: ALL, cols: 2, rows: 1, seats: [0, 1], build: (k) => { lounger(k); } },
  { id: "tv", label: "Flat TV", kind: "fun", colours: ["flat"], dirs: ["se"], cols: 1, rows: 1, image: (_d, _c, s, cv) => flatTvImage(s, cv) },
];

/** Catalogue v2 (OME-1103): shipped as its own lazy atlas, `furniture/furniture-v2.json`. */
export const CATALOGUE_V2: ReadonlySet<string> = new Set(["floorcushion", "bench", "turntable", "speaker", "cat", "wallshelf", "garland", "coffeetable", "pouf", "neonsign", "aquarium", "arcade", "wallclock", "door"]);
/** Batch 6 (OME-1437): a third lazy atlas, `furniture/furniture-v4.json`, same schema. */
export const CATALOGUE_V4: ReadonlySet<string> = new Set(["hammock", "stool", "barcounter", "piano", "fireplace", "pad"]);
/** Dank Dungeon (OME-1670): `furniture/furniture-v6.json`, same schema, loaded only by rooms that use one of these. */
export const CATALOGUE_V6: ReadonlySet<string> = new Set(["bed", "whirlpool", "mirror", "minibar", "desk", "washbasin", "partition"]);
/** Dank Dungeon rework (OME-1977): `furniture/furniture-v7.json`, same schema. Whole kinds, plus new colours of kinds that live in
 *  older sheets (`<id>/<colour>`): those sheets keep their frames, and v7's `meta.omega.pieces` lists only the new colours. */
export const CATALOGUE_V7: ReadonlySet<string> = new Set(["sauna", "soaktub", "lounger", "tv"]);
export const V7_COLOURS: ReadonlySet<string> = new Set(["mirror/silver", "minibar/fridge", "carpet/oval", "partition/panel", "partition/panelglass"]);
/** Theatre set v2 (OME-1639): a fourth lazy atlas, `furniture/furniture-v5.json`, same schema plus `seatLiftByColour`. */
export const CATALOGUE_V5: ReadonlySet<string> = new Set(["theatrerow", "curtain", "bigscreen", "aislelight", "carpet"]);

export interface Canvas { w: number; h: number; ax: number; ay: number }
const CANVAS: Canvas = { w: 480, h: 400, ax: 220, ay: 300 };

function crop(key: string, img: Uint8Array, box0?: { x0: number; y0: number; w: number; h: number }): RoomFrame & { rect: { x0: number; y0: number; w: number; h: number } } {
  let rect = box0;
  if (!rect) {
    let x0: number = CANVAS.w, y0: number = CANVAS.h, x1 = -1, y1 = -1;
    for (let y = 0; y < CANVAS.h; y++) {
      for (let x = 0; x < CANVAS.w; x++) {
        if ((img[y * CANVAS.w + x] ?? 0) === 0) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    if (x1 < 0) throw new Error(`${key} is empty`);
    if (x0 === 0 || y0 === 0 || x1 === CANVAS.w - 1 || y1 === CANVAS.h - 1) throw new Error(`${key} touches the canvas edge`);
    rect = { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  const out = new Uint8Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++) out.set(img.subarray((rect.y0 + y) * CANVAS.w + rect.x0, (rect.y0 + y) * CANVAS.w + rect.x0 + rect.w), y * rect.w);
  return { key, w: rect.w, h: rect.h, img: out, ax: CANVAS.ax - rect.x0, ay: CANVAS.ay - rect.y0, rect };
}

/** Back (+ front, for seats) layers of one piece facing `dir`. Both layers share one crop rect, so one anchor. */
export function pieceFrames(def: PieceDef, colour: string, dir: FurnDir): RoomFrame[] {
  const base = `furniture/${def.id}/${colour}/${dir}`;
  if (def.image) {
    const back = crop(`${base}/back`, def.image(dir, colour));
    return [back, ...useFrames(def, colour, dir, back.rect), ...(def.walk?.draw(dir, colour, back.rect) ?? [])];
  }
  const k = new Kit(dir);
  def.build?.(k, colour, 0);
  const back = k.parts.filter((p) => !p.front).map((p) => p.solid);
  const front = k.parts.filter((p) => p.front).map((p) => p.solid);
  const all = [...back, ...front];
  const keep = def.keepOutline;
  const draw = (solids: readonly Solid[]): ReturnType<typeof renderSolids> => {
    const r = renderSolids(solids, CANVAS.w, CANVAS.h, CANVAS.ax, CANVAS.ay, keep ? "none" : "all");
    if (keep) {
      const lined = r.img.slice();
      addOutline(lined, CANVAS.w, CANVAS.h);
      lined.forEach((v, i) => { if (v !== r.img[i] && keep(dir, colour, (i % CANVAS.w) - CANVAS.ax, Math.floor(i / CANVAS.w) - CANVAS.ay)) r.img[i] = v; });
    }
    return r;
  };
  const full = draw(all);
  const alt = def.open ? "open" : def.cut ? "cut" : null;
  if (front.length === 0 && alt) {
    // Closed and open share one rect (the union), so one anchor: swap the texture in place.
    const ko = new Kit(dir);
    def.build?.(ko, colour, 1);
    const openImg = draw(ko.parts.map((p) => p.solid)).img;
    // A stub is a fraction of the wall's height, so it gets its own tight rect (and anchor); the web places it, not swaps it.
    if (alt === "cut") return [crop(`${base}/back`, full.img), crop(`furniture/${def.id}/${colour}/cut/${dir}`, openImg)];
    const both = full.img.map((v, i) => v || (openImg[i] ?? 0));
    const { rect } = crop(`${base}/both`, both);
    return [crop(`${base}/back`, full.img, rect), crop(`furniture/${def.id}/${colour}/${alt}/${dir}`, openImg, rect)];
  }
  if (front.length === 0) {
    const idle = crop(`${base}/back`, full.img);
    const covers = Array.from({ length: def.covers ?? 0 }, (_, s) => {
      const kc = new Kit(dir);
      def.build?.(kc, colour, 2 + s);
      return crop(`furniture/${def.id}/${colour}/cover/${dir}/${String(s)}`, draw(kc.parts.map((p) => p.solid)).img, idle.rect);
    });
    return [idle, ...useFrames(def, colour, dir, idle.rect), ...covers];
  }
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
  const both = new Uint8Array(CANVAS.w * CANVAS.h);
  for (let i = 0; i < both.length; i++) both[i] = (backImg[i] ?? 0) || (frontImg[i] ?? 0);
  const { rect } = crop(`${base}/both`, both);
  // A seat's use loop replaces only its back layer (the front stays put), so its frames are the back parts alone.
  return [crop(`${base}/back`, backImg, rect), crop(`${base}/front`, frontImg, rect), ...useFrames(def, colour, dir, rect, true)];
}

function kitImage(def: PieceDef, colour: string, dir: FurnDir, n: number, backOnly = false): Uint8Array {
  const k = new Kit(dir);
  def.build?.(k, colour, n);
  return renderSolids(k.parts.filter((p) => !(backOnly && p.front)).map((p) => p.solid), CANVAS.w, CANVAS.h, CANVAS.ax, CANVAS.ay, "all").img;
}

/** The "in use" loop of a back-only piece, cut to the idle frame's rect (so one anchor), checked to move only inside it. */
function useFrames(def: PieceDef, colour: string, dir: FurnDir, rect: { x0: number; y0: number; w: number; h: number }, backOnly = false): RoomFrame[] {
  const out: RoomFrame[] = [];
  for (let n = 1; n <= (def.use?.frames ?? 0); n++) {
    const img = def.image ? def.image(dir, colour, 1, CANVAS, n) : kitImage(def, colour, dir, n, backOnly);
    const key = `furniture/${def.id}/${colour}/use/${dir}/${String(n - 1)}`;
    const f = crop(key, img, rect);
    const r = crop(`${key}/all`, img).rect;
    if (r.x0 < rect.x0 || r.y0 < rect.y0 || r.x0 + r.w > rect.x0 + rect.w || r.y0 + r.h > rect.y0 + rect.h) throw new Error(`${key} spills out of the idle frame`);
    out.push(f);
  }
  return out;
}

const swapsAxes = (d: FurnDir): boolean => d === "nw" || d === "se";
/** Frames beside a facing's `back`/`front` layers: loops, alternates, the cat's frames, the queen bed's covers. */
const EXTRA_FRAMES: ReadonlySet<string> = new Set(["use", "open", "cut", "walk", "sit", "bed", "cover"]);

export function buildFurniture(): { frames: RoomFrame[]; pieces: PieceMeta[] } {
  const frames: RoomFrame[] = [];
  const pieces: PieceMeta[] = [];
  for (const def of PIECES) {
    const layersByDir: PieceMeta["layersByDir"] = {};
    for (const colour of def.colours) {
      for (const dir of def.dirs) {
        const fs = pieceFrames(def, colour, dir);
        frames.push(...fs);
        // The 4th key segment names the frame (`furniture/<id>/<colour>/<dir|use|cover…>`): `/bed/` alone also matched the bed's own id.
        layersByDir[dir] = fs.filter((f) => !EXTRA_FRAMES.has(f.key.split("/")[3] ?? "")).map((f) => (f.key.endsWith("/front") ? "front" : "back"));
      }
    }
    const footprintByDir: PieceMeta["footprintByDir"] = {};
    const sortByDir: PieceMeta["sortByDir"] = {};
    const seatsByDir: NonNullable<PieceMeta["seatsByDir"]> = {};
    for (const dir of def.dirs) {
      const fp = swapsAxes(dir) ? { cols: def.rows, rows: def.cols } : { cols: def.cols, rows: def.rows };
      footprintByDir[dir] = fp;
      const dc = Math.max(fp.cols - 1, 0) / 2, dr = Math.max(fp.rows - 1, 0) / 2;
      sortByDir[dir] = { x: (dc - dr) * 32, y: (dc + dr) * 16 };
      const f = def.frontRow && (dir === "se" || dir === "sw") ? def.rows - 1 : 0;
      if (def.seats) seatsByDir[dir] = def.seats.map((i) => (swapsAxes(dir) ? { col: f, row: i, dir } : { col: i, row: f, dir }));
    }
    const meta: PieceMeta = {
      id: def.id,
      label: def.label,
      kind: def.kind,
      mount: def.mount ?? "floor",
      layer: def.layer ?? "object",
      colours: [...def.colours],
      dirs: [...def.dirs],
      footprint: { cols: def.cols, rows: def.rows },
      footprintByDir,
      sortByDir,
      walkable: def.walkable === true,
      layersByDir,
    };
    if (def.seats) meta.seatsByDir = seatsByDir;
    if (def.use) meta.use = { ...def.use };
    if (def.open) meta.open = true;
    if (def.cut) meta.cut = true;
    if (def.covers) meta.covers = def.covers;
    if (def.seatLift) meta.seatLiftByColour = { ...def.seatLift };
    if (def.walk) meta.walk = { frames: def.walk.frames, ms: def.walk.ms };
    pieces.push(meta);
  }
  return { frames, pieces };
}

// ---------------------------------------------------------------- set (h): tray thumbnails

/** One piece re-cast at scale `s` (back and front layers together) on canvas `cv`, world origin = the anchor cell centre at (cv.ax, cv.ay). */
export function pieceImage(def: PieceDef, colour: string, dir: FurnDir, s: number, cv: Canvas): Uint8Array {
  if (def.image) return def.image(dir, colour, s, cv);
  const k = new Kit(dir);
  def.build?.(k, colour, 0);
  return renderSolids(k.parts.map((p) => p.solid), cv.w, cv.h, cv.ax, cv.ay, "all", s).img;
}

/** Largest thumbnail, art px: what fits inside a `slot/*` (set h) with a 2 px margin. */
export const THUMB_BOX = { w: 44, h: 40 } as const;

/** Picker-tray thumbnail of one piece + colour: the same model re-cast at a smaller scale (≤ ½, so it fits THUMB_BOX),
 *  not a downscaled sprite, so the light, tones and plum outline are the catalogue's own. Seats show their default
 *  `se` facing (toward the camera); the rug shows `ne`. Anchor = the visual centre (centre it in the slot). */
export function buildThumbs(): RoomFrame[] {
  const cv: Canvas = { w: 240, h: 200, ax: 110, ay: 150 };
  const out: RoomFrame[] = [];
  for (const def of PIECES) {
    const dir: FurnDir = def.dirs.includes("se") ? "se" : "ne";
    for (const colour of def.colours) out.push(padThumb(fitThumb(`thumb/${def.id}/${colour}`, cv, (s) => pieceImage(def, colour, dir, s, cv))));
  }
  return out;
}

/** OME-1983: the queen bed's thumb keeps the twin's 43×34 rect (centred, transparent margin), so the edit sheet doesn't repack
 *  and the eager `reference.css` stays byte-identical. */
const THUMB_RECT: Readonly<Record<string, { w: number; h: number }>> = { "thumb/bed/velvet": { w: 43, h: 34 } };
function padThumb(t: RoomFrame): RoomFrame {
  const r = THUMB_RECT[t.key];
  if (!r || (r.w === t.w && r.h === t.h)) return t;
  if (t.w > r.w || t.h > r.h) throw new Error(`${t.key}: ${String(t.w)}×${String(t.h)} outgrew its kept rect`);
  const dx = Math.floor((r.w - t.w) / 2), dy = Math.floor((r.h - t.h) / 2);
  const img = new Uint8Array(r.w * r.h);
  for (let y = 0; y < t.h; y++) img.set(t.img.subarray(y * t.w, (y + 1) * t.w), (y + dy) * r.w + dx);
  return { ...t, w: r.w, h: r.h, img, ax: t.ax + dx, ay: t.ay + dy };
}

/** The largest scale ≤ ½ at which `at(s)` (drawn on `cv`) fits THUMB_BOX, cropped; anchor = its visual centre. */
export function fitThumb(key: string, cv: Canvas, at: (s: number) => Uint8Array): RoomFrame {
  for (let s = 0.5; s > 0; s -= 1 / 32) {
    const img = at(s);
    let x0 = cv.w, y0 = cv.h, x1 = -1, y1 = -1;
    for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) if ((img[y * cv.w + x] ?? 0) !== 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w > THUMB_BOX.w || h > THUMB_BOX.h) continue;
    const crop = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) crop.set(img.subarray((y0 + y) * cv.w + x0, (y0 + y) * cv.w + x0 + w), y * w);
    return { key, w, h, img: crop, ax: Math.floor(w / 2), ay: Math.floor(h / 2) };
  }
  throw new Error(`${key}: no scale fits the tray thumbnail box`);
}
