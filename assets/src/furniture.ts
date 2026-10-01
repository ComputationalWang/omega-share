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
import { mirror, render as renderRoles, type Grid, type RoleMap } from "./sprite";

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
}

interface PieceDef {
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
  build?: (k: Kit, colour: string) => void;
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
];

interface Canvas { w: number; h: number; ax: number; ay: number }
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
  def.build?.(k, colour);
  const back = k.parts.filter((p) => !p.front).map((p) => p.solid);
  const front = k.parts.filter((p) => p.front).map((p) => p.solid);
  const all = [...back, ...front];
  const full = renderSolids(all, CANVAS.w, CANVAS.h, CANVAS.ax, CANVAS.ay, "all");
  if (front.length === 0) return [crop(`${base}/back`, full.img)];
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
        layersByDir[dir] = fs.map((f) => (f.key.endsWith("/front") ? "front" : "back"));
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
    pieces.push(meta);
  }
  return { frames, pieces };
}

// ---------------------------------------------------------------- set (h): tray thumbnails

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
      const at = (s: number): Uint8Array => {
        if (def.image) return def.image(dir, colour, s, cv);
        const k = new Kit(dir);
        def.build?.(k, colour);
        return renderSolids(k.parts.map((p) => p.solid), cv.w, cv.h, cv.ax, cv.ay, "all", s).img;
      };
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
