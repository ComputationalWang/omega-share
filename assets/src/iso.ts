// Tiny isometric ray caster for furniture and room pieces. Solids are convex polytopes
// (half-space sets) in world units, where 1 unit of u (col axis) or v (row axis) moves
// (+2,+1) or (-2,+1) screen px and 1 unit of z moves 1 px up. A floor tile is 16×16 units.
// Every pixel centre is cast along the view axis, so edges land exactly on the 2:1 grid.
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";

export interface Vec3 {
  u: number;
  v: number;
  z: number;
}
/** n·p <= d */
export interface HalfSpace {
  n: Vec3;
  d: number;
}
/** Which way a hit surface faces, after lighting from the top-left. */
export type Facing = "top" | "sw" | "se" | "other";

export interface Solid {
  planes: readonly HalfSpace[];
  ramp: RampName;
  /** Tone per facing; defaults: top 0, sw 1, se 2. */
  tones?: Partial<Record<Facing, Tone>>;
  /** Per-pixel detail: return a [ramp, tone] override, or null to keep the default. */
  paint?: (p: Vec3, facing: Facing) => readonly [RampName, Tone] | null;
  /** Facings that are never drawn (e.g. wall segment end faces, so segments butt seamlessly). */
  skip?: readonly Facing[];
  /** Optional axis-aligned ellipsoid, intersected with `planes`. A radius of Infinity on z makes it a vertical
   *  cylinder. Curved pixels take the facing of their normal, so the same top-left light applies. */
  quad?: { c: Vec3; r: Vec3 };
}

export interface Rendered {
  img: Uint8Array;
  /** Index into `solids` of the visible solid per pixel, -1 where empty. */
  ids: Int16Array;
}

/** Axis-aligned box [u0,u1]×[v0,v1]×[z0,z1]. */
export function box(u0: number, u1: number, v0: number, v1: number, z0: number, z1: number, ramp: RampName, extra: Omit<Solid, "planes" | "ramp"> = {}): Solid {
  return {
    ramp,
    ...extra,
    planes: [
      { n: { u: 1, v: 0, z: 0 }, d: u1 },
      { n: { u: -1, v: 0, z: 0 }, d: -u0 },
      { n: { u: 0, v: 1, z: 0 }, d: v1 },
      { n: { u: 0, v: -1, z: 0 }, d: -v0 },
      { n: { u: 0, v: 0, z: 1 }, d: z1 },
      { n: { u: 0, v: 0, z: -1 }, d: -z0 },
    ],
  };
}

// View ray direction toward the camera: points along (1,1,2) share a pixel.
const VIEW: Vec3 = { u: 1, v: 1, z: 2 };
const dot = (a: Vec3, b: Vec3): number => a.u * b.u + a.v * b.v + a.z * b.z;

/** Facing of a curved surface: mostly-up normals read as top, otherwise whichever camera-facing side dominates. */
function quadFacing(n: Vec3): Facing {
  const len = Math.hypot(n.u, n.v, n.z);
  if (n.z > 0.6 * len) return "top";
  return n.v >= n.u ? "sw" : "se";
}

/** Ray–ellipsoid interval [t0, t1] along base + t·VIEW, or null on a miss. */
function quadInterval(q: { c: Vec3; r: Vec3 }, base: Vec3): [number, number] | null {
  const iz = Number.isFinite(q.r.z) ? 1 / q.r.z : 0;
  const ou = (base.u - q.c.u) / q.r.u, ov = (base.v - q.c.v) / q.r.v, oz = (base.z - q.c.z) * iz;
  const du = VIEW.u / q.r.u, dv = VIEW.v / q.r.v, dz = VIEW.z * iz;
  const a = du * du + dv * dv + dz * dz;
  const b = 2 * (ou * du + ov * dv + oz * dz);
  const c = ou * ou + ov * ov + oz * oz - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  return [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
}

function facingOf(n: Vec3): Facing {
  if (n.z > 0 && Math.abs(n.u) < 1e-9 && Math.abs(n.v) < 1e-9) return "top";
  if (n.v > 0 && n.u <= 0 && Math.abs(n.z) < 1e-9) return "sw";
  if (n.u > 0 && n.v <= 0 && Math.abs(n.z) < 1e-9) return "se";
  return "other";
}

/**
 * Render solids into a w×h index image. (ox, oy) is the screen position of world origin
 * (u=v=z=0). Returns palette indices; outline is added around the whole silhouette.
 */
export function renderSolids(solids: readonly Solid[], w: number, h: number, ox: number, oy: number, outline: "all" | "top" | "none" = "all", scale = 1): Rendered {
  const out = new Uint8Array(w * h);
  const ids = new Int16Array(w * h).fill(-1);
  const depth = new Float64Array(w * h).fill(-Infinity);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      // Point on the z=0 plane that projects to this pixel centre.
      // `scale` < 1 casts the same world at a coarser pixel grid (set h's tray thumbnails), so light and shading stay identical.
      const sx = (px + 0.5 - ox) / scale;
      const sy = (py + 0.5 - oy) / scale;
      const base: Vec3 = { u: (sy + sx / 2) / 2, v: (sy - sx / 2) / 2, z: 0 };
      for (let si = 0; si < solids.length; si++) {
        const s = solids[si];
        if (!s) continue;
        // Cyrus–Beck: find the parameter range [tIn, tOut] inside all half-spaces.
        // The camera looks from +t toward -t, so the visible hit is at tOut.
        let tIn = -Infinity;
        let tOut = Infinity;
        let exitPlane: HalfSpace | null = null;
        let ok = true;
        for (const pl of s.planes) {
          const nd = dot(pl.n, VIEW);
          const np = dot(pl.n, base);
          if (Math.abs(nd) < 1e-12) {
            if (np > pl.d) { ok = false; break; }
            continue;
          }
          const t = (pl.d - np) / nd;
          if (nd > 0) {
            if (t < tOut) { tOut = t; exitPlane = pl; }
          } else if (t > tIn) tIn = t;
        }
        let f: Facing | null = exitPlane === null ? null : facingOf(exitPlane.n);
        if (ok && s.quad) {
          const qi = quadInterval(s.quad, base);
          if (qi === null) continue;
          tIn = Math.max(tIn, qi[0]);
          if (qi[1] < tOut) {
            tOut = qi[1];
            const q = s.quad;
            const iz = Number.isFinite(q.r.z) ? 1 / (q.r.z * q.r.z) : 0;
            const hit: Vec3 = { u: base.u + VIEW.u * tOut, v: base.v + VIEW.v * tOut, z: base.z + VIEW.z * tOut };
            f = quadFacing({ u: (hit.u - q.c.u) / (q.r.u * q.r.u), v: (hit.v - q.c.v) / (q.r.v * q.r.v), z: (hit.z - q.c.z) * iz });
          }
        }
        if (!ok || tIn > tOut || f === null) continue;
        const i = py * w + px;
        if (tOut <= (depth[i] ?? -Infinity)) continue;
        if (s.skip?.includes(f) === true) continue;
        depth[i] = tOut;
        ids[i] = si;
        const p: Vec3 = { u: base.u + VIEW.u * tOut, v: base.v + VIEW.v * tOut, z: base.z + VIEW.z * tOut };
        const def: Record<Facing, Tone> = { top: 0, sw: 1, se: 2, other: 1 };
        const tone = s.tones?.[f] ?? def[f];
        const o = s.paint?.(p, f) ?? null;
        out[i] = o ? colorIndex(o[0], o[1]) : colorIndex(s.ramp, tone);
      }
    }
  }
  if (outline !== "none") addOutline(out, w, h, outline === "top");
  return { img: out, ids };
}

/** 1 px, 4-connected plum outline around every silhouette (or only above it, for tiling walls). */
export function addOutline(img: Uint8Array, w: number, h: number, topOnly = false): void {
  const filled = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && (img[y * w + x] ?? 0) !== 0 && (img[y * w + x] ?? 0) !== OUTLINE;
  const marks: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((img[y * w + x] ?? 0) !== 0) continue;
      const hit = topOnly ? filled(x, y + 1) : filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1);
      if (hit) marks.push(y * w + x);
    }
  }
  for (const i of marks) img[i] = OUTLINE;
}

/** Screen offset of a world point relative to the world origin. */
export function project(p: Vec3): { x: number; y: number } {
  return { x: 2 * (p.u - p.v), y: p.u + p.v - p.z };
}
