// Set (g): furniture catalogue v1 for customizable rooms (M4/M5). Same recipe as set (b): pieces are 3D solids
// ray-cast on the 2:1 grid (src/iso.ts), lit from the top-left, outlined in plum, on the shared palette.
// Every piece is modelled once in a local frame and turned into each facing, so light stays top-left on all of them.
//
// Local frame: x runs along the piece (width), the piece's front faces −y, z is up. One tile is 16×16 units,
// the origin cell spans x, y ∈ [−8, 8), and wider pieces grow toward +x (the next col or row).
import { SEAT_HEIGHT } from "./avatars";
import { addOutline, box, renderSolids, type Facing, type Solid, type Vec3 } from "./iso";
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import type { RoomFrame } from "./room";
import { blank, mirror, render as renderRoles, stamp, type Grid, type RoleMap } from "./sprite";

export type FurnDir = "ne" | "nw" | "se" | "sw";
type Paint = readonly [RampName, Tone];
/** A face in the piece's own frame. "front" is the side a sitter faces out of. */
type LFace = "top" | "front" | "back" | "right" | "other";
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
/** Which local face the two camera-facing world faces are, per facing. */
const FACE: Record<FurnDir, { sw: LFace; se: LFace }> = {
  ne: { sw: "back", se: "right" },
  nw: { sw: "right", se: "back" },
  se: { sw: "right", se: "front" },
  sw: { sw: "front", se: "right" },
};

/** Collects solids for one facing of one piece, written in local coordinates. */
class Kit {
  readonly parts: { solid: Solid; front: boolean }[] = [];
  constructor(readonly dir: FurnDir) {}

  private extra(o: PartOpts): Omit<Solid, "planes" | "ramp"> {
    const d = this.dir;
    const paint = o.paint;
    const out: Omit<Solid, "planes" | "ramp"> = {};
    if (o.tones) out.tones = o.tones;
    if (paint) {
      out.paint = (p: Vec3, f: Facing) => {
        const l = toLocal(d, p.u, p.v);
        const lf: LFace = f === "top" ? "top" : f === "sw" ? FACE[d].sw : f === "se" ? FACE[d].se : "other";
        return paint({ x: l.x, y: l.y, z: p.z }, lf);
      };
    }
    return out;
  }

  private worldBox(x0: number, x1: number, y0: number, y1: number): [number, number, number, number] {
    const a = toWorld(this.dir, x0, y0), b = toWorld(this.dir, x1, y1);
    return [Math.min(a.u, b.u), Math.max(a.u, b.u), Math.min(a.v, b.v), Math.max(a.v, b.v)];
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, ramp: RampName, o: PartOpts = {}): void {
    const [u0, u1, v0, v1] = this.worldBox(x0, x1, y0, y1);
    this.parts.push({ solid: box(u0, u1, v0, v1, z0, z1, ramp, this.extra(o)), front: o.front === true });
  }

  /** Ellipsoid (rz = Infinity: vertical cylinder) at (cx, cy, cz), clipped to the local box [x0,x1]×[y0,y1]×[z0,z1]. */
  ell(c: L3, r: L3, clip: readonly [number, number, number, number, number, number], ramp: RampName, o: PartOpts = {}): void {
    const [u0, u1, v0, v1] = this.worldBox(clip[0], clip[1], clip[2], clip[3]);
    const wc = toWorld(this.dir, c.x, c.y);
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
  const knob = (x: number, z: number, kx: number): Paint | null => (Math.hypot(x - kx, z - 36) < 1.1 ? ["mustard", 0] : Math.abs(x - kx) < 0.6 && Math.abs(z - 33.5) < 0.6 ? ["outline", 1] : null);
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

function sleepyCat(dir: FurnDir, c: RampName, s = 1, cv: Canvas = CANVAS): Uint8Array {
  const k = new Kit(dir);
  const bed: LPaint = (p, f) => (f === "top" && Math.hypot(p.x, p.y) < 5.2 ? ["lilac", 2] : null);
  k.ell({ x: 0, y: 0, z: 0 }, { x: 7, y: 7, z: Infinity }, [-8, 8, -8, 8, 0, 3], "lilac", { paint: bed });
  const r = renderSolids(k.parts.map((q) => q.solid), cv.w, cv.h, cv.ax, cv.ay, "none", s);
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
  walkable?: boolean;
  /** "In use" loop: `frames` extra back frames (build gets n = 1..frames; n = 0 is the idle frame), each shown `ms`. */
  use?: { frames: number; ms: number };
  /** Has an "open" frame: build gets n = 1 for it. */
  open?: true;
  build?: (k: Kit, colour: string, n: number) => void;
  image?: (dir: FurnDir, colour: string, s?: number, cv?: Canvas) => Uint8Array;
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
  { id: "cat", label: "Sleepy cat", kind: "fun", colours: ["ginger", "charcoal"], dirs: ["se", "sw"], cols: 1, rows: 1, image: (d, c, s, cv) => sleepyCat(d, asRamp(c), s, cv) },
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
];

/** Catalogue v2 (OME-1103): shipped as its own lazy atlas, `furniture/furniture-v2.json`. */
export const CATALOGUE_V2: ReadonlySet<string> = new Set(["floorcushion", "bench", "turntable", "speaker", "cat", "wallshelf", "garland", "coffeetable", "pouf", "neonsign", "aquarium", "arcade", "wallclock", "door"]);

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
function pieceFrames(def: PieceDef, colour: string, dir: FurnDir): RoomFrame[] {
  const base = `furniture/${def.id}/${colour}/${dir}`;
  if (def.image) return [crop(`${base}/back`, def.image(dir, colour))];
  const k = new Kit(dir);
  def.build?.(k, colour, 0);
  const back = k.parts.filter((p) => !p.front).map((p) => p.solid);
  const front = k.parts.filter((p) => p.front).map((p) => p.solid);
  const all = [...back, ...front];
  const full = renderSolids(all, CANVAS.w, CANVAS.h, CANVAS.ax, CANVAS.ay, "all");
  if (front.length === 0 && def.open) {
    // Closed and open share one rect (the union), so one anchor: swap the texture in place.
    const ko = new Kit(dir);
    def.build?.(ko, colour, 1);
    const openImg = renderSolids(ko.parts.map((p) => p.solid), CANVAS.w, CANVAS.h, CANVAS.ax, CANVAS.ay, "all").img;
    const both = full.img.map((v, i) => v || (openImg[i] ?? 0));
    const { rect } = crop(`${base}/both`, both);
    return [crop(`${base}/back`, full.img, rect), crop(`furniture/${def.id}/${colour}/open/${dir}`, openImg, rect)];
  }
  if (front.length === 0) {
    const idle = crop(`${base}/back`, full.img);
    return [idle, ...useFrames(def, colour, dir, idle.rect)];
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
  return [crop(`${base}/back`, backImg, rect), crop(`${base}/front`, frontImg, rect)];
}

/** The "in use" loop of a back-only piece, cut to the idle frame's rect (so one anchor), checked to move only inside it. */
function useFrames(def: PieceDef, colour: string, dir: FurnDir, rect: { x0: number; y0: number; w: number; h: number }): RoomFrame[] {
  const out: RoomFrame[] = [];
  for (let n = 1; n <= (def.use?.frames ?? 0); n++) {
    const k = new Kit(dir);
    def.build?.(k, colour, n);
    const img = renderSolids(k.parts.map((p) => p.solid), CANVAS.w, CANVAS.h, CANVAS.ax, CANVAS.ay, "all").img;
    const key = `furniture/${def.id}/${colour}/use/${dir}/${String(n - 1)}`;
    const f = crop(key, img, rect);
    const r = crop(`${key}/all`, img).rect;
    if (r.x0 < rect.x0 || r.y0 < rect.y0 || r.x0 + r.w > rect.x0 + rect.w || r.y0 + r.h > rect.y0 + rect.h) throw new Error(`${key} spills out of the idle frame`);
    out.push(f);
  }
  return out;
}

const swapsAxes = (d: FurnDir): boolean => d === "nw" || d === "se";

export function buildFurniture(): { frames: RoomFrame[]; pieces: PieceMeta[] } {
  const frames: RoomFrame[] = [];
  const pieces: PieceMeta[] = [];
  for (const def of PIECES) {
    const layersByDir: PieceMeta["layersByDir"] = {};
    for (const colour of def.colours) {
      for (const dir of def.dirs) {
        const fs = pieceFrames(def, colour, dir);
        frames.push(...fs);
        layersByDir[dir] = fs.filter((f) => !f.key.includes("/use/") && !f.key.includes("/open/")).map((f) => (f.key.endsWith("/front") ? "front" : "back"));
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
      if (def.seats) seatsByDir[dir] = def.seats.map((i) => (swapsAxes(dir) ? { col: 0, row: i, dir } : { col: i, row: 0, dir }));
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
    for (const colour of def.colours) {
      const at = (s: number): Uint8Array => pieceImage(def, colour, dir, s, cv);
      let s = 0.5;
      for (;;) {
        const img = at(s);
        let x0 = cv.w, y0 = cv.h, x1 = -1, y1 = -1;
        for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) if ((img[y * cv.w + x] ?? 0) !== 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        if (w > THUMB_BOX.w || h > THUMB_BOX.h) { s -= 1 / 32; continue; }
        const crop = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) crop.set(img.subarray((y0 + y) * cv.w + x0, (y0 + y) * cv.w + x0 + w), y * w);
        out.push({ key: `thumb/${def.id}/${colour}`, w, h, img: crop, ax: Math.floor(w / 2), ay: Math.floor(h / 2) });
        break;
      }
    }
  }
  return out;
}
