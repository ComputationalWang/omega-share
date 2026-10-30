// OME-1956: Dank Dungeon rework, concept only (not shipped). One 10×10 room split by an interior wall at row 5 into a
// bedroom (rows 5–9) and a spa (rows 0–4). Each view looks from one side: "south" sees the bedroom up close with the spa
// only through the glass and the doorway; "north" is the same room turned 180° (every piece re-cast from its 3D model with
// Kit's `turned`), so the spa is up close and the beds show through the glass. Walls nearest the camera are not drawn.
// Run: bun assets/src/dungeon2-concept.ts → assets/preview/dungeon2-{south,north}{,-night}@{1x,2x}.png
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AVATARS, CELL, FLOOR, composeMotion, type Dir } from "./avatars";
import { Kit, PIECES, type FurnDir } from "./furniture";
import { box, renderSolids, type Solid, type Vec3 } from "./iso";
import { OUTLINE, PALETTE, RAMPS, colorIndex, type RampName, type Tone } from "./palette";
import { encodeIndexedPng, type RGBA } from "./png";
import { WALL_H, tvSolids } from "./room";
import { render, upscale } from "./sprite";

type View = "south" | "north";
type Paint = readonly [RampName, Tone];
const ROOT = join(import.meta.dir, "..");
const C2 = 144; // u' = C2 − u turns the room 180° about its centre (72, 72)
const WALL_V = 72, WT = 2; // interior wall plane and half thickness
const GLASS = { u0: 36, u1: 128, z0: 16, z1: 150 } as const; // cols 3–8: wide enough that both beds, feet included, show from the spa
const DOOR = { u0: 8, u1: 24, z1: 120 } as const; // col 1

// ------------------------------------------------------------------ geometry helpers

function shift(s: Solid, du: number, dv: number): Solid {
  const out: Solid = { ...s, planes: s.planes.map((pl) => ({ n: pl.n, d: pl.d + pl.n.u * du + pl.n.v * dv })) };
  if (s.quad) out.quad = { c: { u: s.quad.c.u + du, v: s.quad.c.v + dv, z: s.quad.c.z }, r: s.quad.r };
  const paint = s.paint;
  if (paint) out.paint = (q, f) => paint({ u: q.u - du, v: q.v - dv, z: q.z }, f);
  return out;
}

/** The whole-room 180° turn for raw solids (shell, TV console). Paint sees original coordinates and the view's facing. */
function turn(s: Solid): Solid {
  const out: Solid = { ...s, planes: s.planes.map((pl) => ({ n: { u: -pl.n.u, v: -pl.n.v, z: pl.n.z }, d: pl.d - C2 * (pl.n.u + pl.n.v) })) };
  if (s.quad) out.quad = { c: { u: C2 - s.quad.c.u, v: C2 - s.quad.c.v, z: s.quad.c.z }, r: s.quad.r };
  const paint = s.paint;
  if (paint) out.paint = (q, f) => paint({ u: C2 - q.u, v: C2 - q.v, z: q.z }, f);
  return out;
}

const hash = (a: number, b: number): number => {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};

// ------------------------------------------------------------------ shell

type Side = "bed" | "spa";
/** Wood panelling, as in the reference: pale oak in the bedroom, dark smoked wood in the spa. Seams every 16, a grain
 *  fleck, a dark skirting and a warm cove light under the top. `s` runs along the wall. */
function panel(side: Side, s: number, z: number, lit: boolean): Paint {
  const ramp: RampName = side === "bed" ? "floor" : "wood";
  if (z < 4) return ["charcoal", 2];
  if (z >= WALL_H - 16 && z < WALL_H - 12) return ["mustard", lit ? 0 : 1];
  if (z >= WALL_H - 12) return [ramp, lit ? 0 : 1];
  // The old dungeon's purple wainscot under a wood rail, so the room still belongs to the set.
  if (z >= 34 && z < 38) return ["wood", z >= 36 ? 0 : 2];
  if (z < 34) return (((s + 4) % 32) + 32) % 32 < 1 || z < 6 ? ["wall", 2] : ["wall", lit ? 1 : 2];
  const seam = (((s + 8) % 16) + 16) % 16 < 0.6;
  if (seam) return [ramp, 2];
  const fleck = hash(Math.floor(s * 2), Math.floor(z / 7)) % 23 === 0;
  return [ramp, lit ? (fleck ? 2 : 1) : fleck ? 1 : 2];
}

/** The bedroom's far wall window with drawn charcoal curtains (only ever seen from the spa, through the glass). */
function bedWindow(s: number, z: number, lit: boolean): Paint | null {
  if (s < 52 || s >= 124 || z < 70 || z >= 176) return null;
  if (s < 62 || s >= 114) return ["charcoal", Math.floor(s) % 3 === 0 ? 2 : lit ? 1 : 2]; // curtains
  if (z < 74 || z >= 172 || Math.abs(s - 88) < 0.75) return ["charcoal", 2];
  return ["cream", z > 150 ? 0 : 1];
}

function wallBox(u0: number, u1: number, v0: number, v1: number, z0: number, z1: number, along: "u" | "v"): Solid {
  const side: Side = v0 >= WALL_V ? "bed" : "spa";
  return box(u0, u1, v0, v1, z0, z1, "wood", {
    paint: (p, f) => {
      const s = along === "u" ? p.u : p.v;
      if (f === "top") return [side === "bed" ? "floor" : "wood", 0];
      const lit = f === "sw";
      if (side === "bed" && along === "u" && p.v > 150) return bedWindow(s, p.z, lit) ?? panel(side, s, p.z, lit);
      return panel(side, s, p.z, lit);
    },
  });
}

/** Interior wall faces: which side a face belongs to is decided by which way it faces, not where it is. */
function interiorBox(u0: number, u1: number, z0: number, z1: number, view: View): Solid {
  const side: Side = view === "south" ? "bed" : "spa";
  return box(u0, u1, WALL_V - WT, WALL_V + WT, z0, z1, "wood", {
    paint: (p, f) => (f === "top" ? [side === "bed" ? "floor" : "wood", 0] : panel(side, p.u, p.z, f === "sw")),
  });
}

/** Dark carpet with thin gold veins (bedroom), slatted wood deck with dark gaps (spa). */
function carpet(p: Vec3): Paint {
  const a = Math.abs(((p.u * 0.8 + 7 * Math.sin(p.v / 11) + 400) % 41) - 20.5);
  const b = Math.abs(((p.v * 0.9 + 6 * Math.sin(p.u / 9) + 400) % 53) - 26.5);
  const vein = (a < 0.55 && hash(Math.floor(p.v / 9), 1) % 3 !== 0) || (b < 0.55 && hash(Math.floor(p.u / 13), 2) % 2 === 0);
  return vein ? ["mustard", 2] : ["charcoal", 1];
}
function deck(p: Vec3): Paint {
  const gap = (((p.v + 8) % 5) + 5) % 5 < 0.7;
  if (gap) return ["charcoal", 2];
  const plank = Math.floor((p.v + 8) / 5);
  const joint = (((p.u + plank * 23 + 400) % 48) + 48) % 48 < 0.7;
  return ["wood", joint ? 2 : hash(plank, Math.floor((p.u + plank * 23 + 400) / 48)) % 3 === 0 ? 0 : 1];
}

interface Shell {
  near: Solid[];
  far: Solid[];
  glass: Solid;
  door: Solid;
}

/** In original (south) coordinates; the north view turns it. Back walls only: west + north for south, east + south for north. */
function shell(view: View): Shell {
  const bedFloor = box(-8, 152, WALL_V, 152, -6, 0, "charcoal", { paint: (p, f) => (f === "top" ? carpet(p) : null) });
  const spaFloor = box(-8, 152, -8, WALL_V, -6, 0, "wood", { paint: (p, f) => (f === "top" ? deck(p) : null) });
  const H = WALL_H;
  const bed: Solid[] = [bedFloor], spa: Solid[] = [spaFloor];
  if (view === "south") {
    bed.push(wallBox(-12, -8, WALL_V, 152, 0, H, "v"));
    spa.push(wallBox(-12, -8, -8, WALL_V, 0, H, "v"), wallBox(-12, 152, -12, -8, 0, H, "u"));
  } else {
    spa.push(wallBox(152, 156, -8, WALL_V, 0, H, "v"));
    bed.push(wallBox(152, 156, WALL_V, 152, 0, H, "v"), wallBox(-8, 156, 152, 156, 0, H, "u"));
  }
  const iw: Solid[] = [
    interiorBox(-8, DOOR.u0, 0, H, view),
    interiorBox(DOOR.u0, DOOR.u1, DOOR.z1, H, view),
    interiorBox(DOOR.u1, GLASS.u0, 0, H, view),
    interiorBox(GLASS.u0, GLASS.u1, 0, GLASS.z0, view),
    interiorBox(GLASS.u0, GLASS.u1, GLASS.z1, H, view),
    interiorBox(GLASS.u1, 152, 0, H, view),
  ];
  // Black window frame (as in the photos) and a wood door casing, both standing 1 proud of each face.
  const F = 2, P = WT + 1;
  const frame = (u0: number, u1: number, z0: number, z1: number, ramp: RampName, tone: Tone): Solid =>
    box(u0, u1, WALL_V - P, WALL_V + P, z0, z1, ramp, { tones: { top: tone, sw: tone, se: 2 } });
  iw.push(
    frame(GLASS.u0 - F, GLASS.u1 + F, GLASS.z0 - F, GLASS.z0, "charcoal", 2),
    frame(GLASS.u0 - F, GLASS.u1 + F, GLASS.z1, GLASS.z1 + F, "charcoal", 2),
    frame(GLASS.u0 - F, GLASS.u0, GLASS.z0, GLASS.z1, "charcoal", 2),
    frame(GLASS.u1, GLASS.u1 + F, GLASS.z0, GLASS.z1, "charcoal", 2),
    frame(DOOR.u0 - F, DOOR.u0, 0, DOOR.z1 + F, "wood", 1),
    frame(DOOR.u1, DOOR.u1 + F, 0, DOOR.z1 + F, "wood", 1),
    frame(DOOR.u0 - F, DOOR.u1 + F, DOOR.z1, DOOR.z1 + F, "wood", 1),
  );
  // The one stripe: a single pale diagonal across the pane, so it reads as glass and not as a hole.
  const glass = box(GLASS.u0, GLASS.u1, WALL_V - 0.5, WALL_V + 0.5, GLASS.z0, GLASS.z1, "glow", {
    paint: (p) => {
      // Measured from the pane's left edge as this view sees it, so the stripe leans the same way in both views.
      const su = view === "south" ? p.u - GLASS.u0 : GLASS.u1 - p.u;
      // Across the top-left corner only, clear of the beds low in the pane.
      const d = su + (GLASS.z1 - p.z) * 0.7 - 46;
      return d >= 0 && d < 5 ? ["glow", d < 3 ? 0 : 1] : ["glow", 2];
    },
  });
  const door = box(DOOR.u0, DOOR.u1, WALL_V - WT, WALL_V + WT, 0, DOOR.z1, "night");
  const t = (list: Solid[]): Solid[] => (view === "north" ? list.map(turn) : list);
  const near = view === "south" ? bed : spa, far = view === "south" ? spa : bed;
  const [g, d] = t([glass, door]);
  if (!g || !d) throw new Error("glass");
  return { near: t([...near, ...iw]), far: t(far), glass: g, door: d };
}

// ------------------------------------------------------------------ new pieces (concept)

type Build = (k: Kit) => void;
/** Sauna cabin, 2×2, in pale cedar (lighter than the smoked wall). Front: a window onto the bench and the glowing stone
 *  heater, with wisps of steam. Side: a glazed door with a long wood handle. A thermometer and a dark roof trim. */
const sauna: Build = (k) => {
  const X0 = -7.5, X1 = 23.5, Y0 = -7.5, Y1 = 23.5, H = 120;
  k.box(X0, X1, Y0, Y1, 0, H, "floor", {
    paint: (p, f) => {
      if (f === "top") return ["wood", 1];
      if (p.z > H - 6) return ["charcoal", p.z > H - 2 ? 1 : 2];
      if (p.z < 3) return ["charcoal", 2];
      if (f === "front") {
        const s = p.x;
        if (s > -1 && s < 17 && p.z > 48 && p.z < 92) {
          if (s < 0.5 || s > 15.5 || p.z < 49.5 || p.z > 90.5) return ["charcoal", 2]; // window frame
          if (s < 7 && p.z < 62) return p.z < 51 || s < 0.8 || s > 6.2 ? ["charcoal", 1] : ["charcoal", 2]; // heater
          if (s < 7 && p.z < 67) return hash(Math.floor(s * 2), Math.floor(p.z)) % 3 === 0 ? ["mustard", 0] : ["rust", hash(Math.floor(s), Math.floor(p.z)) % 2 === 0 ? 0 : 1]; // hot stones
          if (s >= 7 && p.z > 64 && p.z < 69) return ["floor", 0]; // bench
          if (s >= 7 && p.z <= 64 && (Math.abs(s - 9) < 0.8 || Math.abs(s - 14) < 0.8)) return ["wood", 2];
          if (p.z > 72 && (Math.abs(s - 10 - 2 * Math.sin(p.z / 3)) < 0.7 || Math.abs(s - 13 - 1.5 * Math.sin(p.z / 3 + 2)) < 0.6)) return ["cream", 0]; // steam
          return ["ginger", p.z > 80 ? 2 : 1]; // warm glow inside
        }
        if (Math.abs(s - 21) < 1.6 && p.z > 70 && p.z < 86) return p.z < 73 ? ["rust", 0] : Math.abs(s - 21) < 0.6 ? ["rust", 1] : ["cream", 0]; // thermometer
      }
      if (f === "left") {
        const s = p.y;
        if (s > 1 && s < 15 && p.z < 96) {
          if (s < 2.5 || s > 13.5 || p.z > 94) return ["wood", 1]; // door frame
          if (Math.abs(s - 12) < 0.7 && p.z > 34 && p.z < 62) return ["wood", 2]; // handle
          if (s > 4 && s < 12 && p.z > 22 && p.z < 88) {
            const g = s - (p.z - 22) * 0.12;
            return g > 5 && g < 6.5 ? ["cream", 0] : ["ginger", p.z > 60 ? 0 : 1]; // tinted glass, lit inside
          }
          return ["floor", 0];
        }
      }
      const s = f === "right" || f === "left" ? p.y : p.x;
      return ((s + 40) % 4) < 0.6 ? ["floor", 2] : null;
    },
  });
};

/** Round cedar soaking tub (ofuro), 2×2: two dark hoops, water flush with the rim; a little bucket beside it. */
const ofuro: Build = (k) => {
  const R = 13;
  k.ell({ x: 8, y: 8, z: 0 }, { x: R, y: R, z: Infinity }, [-8, 24, -8, 24, 0, 22], "wood", {
    paint: (p, f) => {
      const dr = Math.hypot(p.x - 8, p.y - 8);
      if (f === "top") return dr < R - 2.2 ? (hash(Math.floor(p.x * 2), Math.floor(p.y * 2)) % 9 === 0 ? ["glow", 0] : ["teal", dr < R - 5 ? 1 : 0]) : ["wood", 0];
      if (Math.abs(p.z - 5) < 1.2 || Math.abs(p.z - 16) < 1.2) return ["charcoal", 2];
      return ((Math.atan2(p.y - 8, p.x - 8) * 30 + 200) % 4) < 0.5 ? ["wood", 2] : null;
    },
  });
  k.ell({ x: 20, y: -3, z: 0 }, { x: 3, y: 3, z: Infinity }, [17, 23, -6, 0, 0, 6], "wood", { paint: (_p, f) => (f === "top" ? ["wood", 2] : null) });
};

/** Zero-gravity recliner, 2×1, as in the spa photo: dark frame, charcoal sling, a little head pillow. */
const recliner: Build = (k) => {
  for (const y of [-5, 4]) {
    k.box(-6, 14, y, y + 1, 2, 3, "charcoal");
    k.box(-6, -5, y, y + 1, 0, 8, "charcoal");
    k.box(12, 13, y, y + 1, 0, 6, "charcoal");
  }
  k.box(-4, 8, -4, 4, 8, 10, "charcoal", { tones: { top: 1 } });
  for (let i = 0; i < 6; i++) k.box(-10 + i, -9 + i, -4, 4, 10, 30 - i * 3.5, "charcoal", { tones: { top: 1 } });
  k.box(-11, -9, -3, 3, 26, 32, "cream", { tones: { top: 1 } });
  k.box(8, 18, -4, 4, 6, 8, "charcoal", { tones: { top: 1 } });
};

/** Big mirror, 2 cells wide on a wall (local x −7…23): a chunky brass frame and a neutral silver pane (cream and glow
 *  dithered), with the room faintly reflected (deck below, the sauna's cedar to one side) and two sheen streaks. `se` mount. */
const bigMirror: Build = (k) => {
  k.box(-7, 23, 6.5, 8, 60, 140, "mustard", {
    paint: (p, f) => {
      if (f === "top") return ["mustard", 0];
      if (p.x < -5 || p.x > 21 || p.z < 63 || p.z > 137) {
        if (p.z > 136 || p.x < -5.5) return ["mustard", 0];
        return p.x > 21.5 || p.z < 62 ? ["mustard", 2] : ["mustard", 1];
      }
      const d = p.x - (p.z - 60) * 0.35;
      if ((d > 1 && d < 3.5) || (d > 6 && d < 7)) return ["glow", 0]; // sheen
      if (p.z < 72) return ["wood", 0]; // the deck, reflected
      if (p.x > 14 && p.z < 116) return ["floor", p.x < 15 ? 1 : 0]; // the sauna, reflected
      return ["cream", p.z > 110 ? 1 : 2]; // silver
    },
  });
};

/** Bar fridge, 1×1, its own piece beside the desk: cream body, a freezer seam, a long dark handle, a kick plate and two
 *  bottles on top. */
const fridge: Build = (k) => {
  const H = 32;
  k.box(-6, 6, -1, 8, 0, H, "cream", {
    paint: (p, f) => {
      if (f === "top") return ["cream", 0];
      if (p.z < 2.5) return ["charcoal", 2];
      if (f !== "front") return null;
      if (Math.abs(p.z - 23) < 0.5 || Math.abs(p.x) > 5.4) return ["cream", 2]; // door seams
      if (Math.abs(p.x - 4) < 0.6 && ((p.z > 8 && p.z < 21) || (p.z > 24.5 && p.z < 30))) return ["charcoal", 2]; // handles
      if (Math.abs(p.x + 3) < 1 && Math.abs(p.z - 27) < 0.8) return ["teal", 0]; // badge
      return null;
    },
  });
  k.ell({ x: -2, y: 3, z: 0 }, { x: 1.2, y: 1.2, z: Infinity }, [-99, 99, -99, 99, H, H + 7], "teal");
  k.ell({ x: 2, y: 4, z: 0 }, { x: 1.2, y: 1.2, z: Infinity }, [-99, 99, -99, 99, H, H + 6], "rust");
};

/** Oval velvet rug with a gold border, in front of the doorway (and seen through it from the spa). */
const rug: Build = (k) => {
  k.ell({ x: 8, y: 8, z: 0 }, { x: 16, y: 11, z: Infinity }, [-99, 99, -99, 99, 0, 0.6], "velvet", {
    paint: (p, f) => {
      if (f !== "top") return ["velvet", 2];
      const e = ((p.x - 8) / 16) ** 2 + ((p.y - 8) / 11) ** 2;
      if (e > 0.78) return ["mustard", e > 0.86 ? 1 : 2];
      return e < 0.25 && Math.abs(p.x - 8) + Math.abs(p.y - 8) * 1.4 < 5 ? ["mustard", 1] : ["velvet", 1];
    },
  });
};

/** A flat-screen TV on the corner console (console coordinates, back corner at u = v = −8), facing the room square on:
 *  a thin dark bezel, a dark screen with a lit picture glowing low and a glint top-left, a stand and a power light. */
function flatTv(): Solid[] {
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
      if (g < -18 && g > -26) return ["glow", 2]; // glint
      if (p.z < Z0 + 9) return ["teal", p.z < Z0 + 5 ? 1 : 0]; // the picture's lit lower third
      return ["navy", p.z > Z1 - 8 ? 2 : 1];
    },
  };
  return [box(4, 7, 4, 7, 20, Z0, "charcoal"), box(2, 9, 2, 9, 20, 21, "charcoal", { tones: { top: 1, sw: 2, se: 2 } }), screen];
}

// ------------------------------------------------------------------ the layout (original coordinates)

type Glow = "warm" | "pink" | "cool";
interface Place {
  build: Build;
  dir: FurnDir;
  col: number;
  row: number;
  turned?: boolean;
  cols?: number;
  rows?: number;
  wall?: boolean;
  flat?: boolean;
  /** At night this piece throws a pool of light of this colour and radius (screen px). */
  light?: readonly [Glow, number];
}
const cat = (id: string, colour?: string): Build => {
  const def = PIECES.find((d) => d.id === id);
  if (!def?.build) throw new Error(`no piece ${id}`);
  const b = def.build;
  return (k) => {
    b(k, colour ?? def.colours[0] ?? "", 0);
  };
};
const P = (build: Build, dir: FurnDir, col: number, row: number, o: Partial<Place> = {}): Place => ({ build, dir, col, row, ...o });

const BEDROOM: readonly Place[] = [
  P(cat("bed"), "nw", 5, 5, { cols: 2 }), P(cat("sidetable"), "se", 6, 5), P(cat("bed"), "nw", 7, 5, { cols: 2 }),
  P(cat("desk"), "se", 0, 7, { light: ["warm", 44] }), P(fridge, "se", 0, 9),
  P(cat("neonsign", "pink"), "se", 0, 6, { wall: true, light: ["pink", 30] }),
  P(rug, "se", 3, 6, { flat: true }),
  P(cat("coffeetable"), "se", 8, 8), P(cat("wingback", "velvet"), "ne", 8, 9), P(cat("wingback", "velvet"), "nw", 9, 8),
];
const SPA: readonly Place[] = [
  P(sauna, "ne", 8, 3, { cols: 2, rows: 2, light: ["warm", 72] }),
  P(cat("washbasin"), "se", 9, 0, { turned: true }), P(cat("washbasin"), "se", 9, 1, { turned: true }),
  P(bigMirror, "se", 9, 1, { turned: true, wall: true, light: ["warm", 60] }),
  P(cat("whirlpool"), "ne", 1, 1, { cols: 2 }),
  P(ofuro, "ne", 4, 2, { cols: 2, rows: 2, light: ["cool", 30] }),
  P(recliner, "ne", 6, 0, { cols: 2 }), P(cat("sidetable"), "se", 8, 0),
];

// ------------------------------------------------------------------ compositing

const W = 600, H = 520, OX = 330, OY = 190;
const CV = { w: 300, h: 340, ax: 150, ay: 260 } as const;
const toScreen = (u: number, v: number): { x: number; y: number } => ({ x: OX + 2 * (u - v), y: OY + u + v });

interface Light {
  glow: Glow;
  r: number;
  src: { x: number; y: number };
  floor: { x: number; y: number };
}

function blitAt(dst: Uint8Array, src: Uint8Array, sw: number, sh: number, ox: number, oy: number, mask?: Uint8Array): void {
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const v = src[y * sw + x] ?? 0;
      const px = ox + x, py = oy + y;
      if (v !== 0 && px >= 0 && py >= 0 && px < W && py < H) {
        dst[py * W + px] = v;
        if (mask) mask[py * W + px] = 1;
      }
    }
  }
}

/** Painter's order as in the room: wall pieces, flat rugs, then objects by footprint centre (u + v), then x. Returns the
 *  night lights: each from its sprite's centroid, with a pool on the floor under its footprint. */
function drawPieces(dst: Uint8Array, list: readonly Place[], view: View, mask?: Uint8Array): Light[] {
  const items = list.map((pl) => {
    const turned = (pl.turned === true) !== (view === "north");
    const au = view === "north" ? C2 - pl.col * 16 : pl.col * 16, av = view === "north" ? C2 - pl.row * 16 : pl.row * 16;
    const k = new Kit(pl.dir, turned);
    pl.build(k);
    let su = 0, sv = 0, n = 0;
    for (let i = 0; i < (pl.cols ?? 1); i++) for (let j = 0; j < (pl.rows ?? 1); j++) {
      const w = k.world(16 * i, 16 * j);
      su += au + w.u; sv += av + w.v; n++;
    }
    const key = pl.wall === true ? -1e9 : pl.flat === true ? -1e8 : (su + sv) / n;
    return { pl, k, au, av, key, x: (su - sv) / n, floor: toScreen(su / n, sv / n) };
  });
  items.sort((a, b) => a.key - b.key || a.x - b.x);
  const lights: Light[] = [];
  for (const it of items) {
    const img = renderSolids(it.k.parts.map((p) => p.solid), CV.w, CV.h, CV.ax, CV.ay, "all").img;
    const s = toScreen(it.au, it.av);
    const ox = s.x - CV.ax, oy = s.y - CV.ay;
    blitAt(dst, img, CV.w, CV.h, ox, oy, mask);
    if (!it.pl.light) continue;
    let cx = 0, cy = 0, n = 0;
    for (let i = 0; i < img.length; i++) if (img[i]) { cx += i % CV.w; cy += Math.floor(i / CV.w); n++; }
    const src = { x: ox + cx / n, y: oy + cy / n };
    // A wall light only haloes; a standing one also pools on the floor under it.
    if (n) lights.push({ glow: it.pl.light[0], r: it.pl.light[1], src, floor: it.pl.wall === true ? src : it.floor });
  }
  return lights;
}

const RAMP_OF = new Map<number, Paint>();
for (const name of Object.keys(RAMPS) as RampName[]) {
  for (const t of [0, 1, 2] as const) {
    const i = colorIndex(name, t);
    if (!RAMP_OF.has(i)) RAMP_OF.set(i, [name, t]);
  }
}
/** Seen through glass or the doorway: colours as they are, but the dark carpet one tone lighter so the beds stand out
 *  on it. No haze: the stripe and the frame already say "glass". */
function tint(i: number): number {
  const rt = RAMP_OF.get(i);
  if (!rt || i === OUTLINE || rt[0] !== "charcoal" || rt[1] === 0) return i;
  return colorIndex("charcoal", rt[1] === 2 ? 1 : 0);
}

interface Scene {
  img: Uint8Array;
  /** 1 glass interior, 2 glass stripe, 3 doorway, 4 near wall left plane, 5 near wall interior plane, 6 TV, 7 bare floor */
  zone: Uint8Array;
  lights: Light[];
}

function scene(view: View): Scene {
  const sh = shell(view);
  const bg = colorIndex("night", 2);
  // The far compartment, drawn only where the glass or the doorway lets you see it.
  const far = renderSolids(sh.far, W, H, OX, OY, "all").img;
  drawPieces(far, view === "south" ? SPA : BEDROOM, view);
  const solids = [...sh.near, sh.glass, sh.door];
  const gi = solids.length - 2, di = solids.length - 1;
  const r = renderSolids(solids, W, H, OX, OY, "all");
  const img = new Uint8Array(W * H).fill(bg);
  const zone = new Uint8Array(W * H);
  const stripe = new Set([colorIndex("glow", 0), colorIndex("glow", 1)]);
  const cornerX = OX + 2 * (-8 - (WALL_V + WT));
  for (let i = 0; i < img.length; i++) {
    const id = r.ids[i] ?? -1, v = r.img[i] ?? 0, f = far[i] ?? 0;
    const x = i % W;
    if (id === gi) {
      img[i] = stripe.has(v) ? v : f !== 0 ? tint(f) : colorIndex("glow", 2);
      zone[i] = stripe.has(v) ? 2 : 1;
    } else if (id === di) {
      img[i] = f !== 0 ? tint(f) : colorIndex("charcoal", 2);
      zone[i] = 3;
    } else if (v !== 0) {
      img[i] = v;
      zone[i] = id === 0 ? 7 : x < cornerX ? 4 : 5; // id 0 is the floor
    }
  }
  const covered = new Uint8Array(W * H);
  if (view === "south") {
    const tvMask = new Uint8Array(W * H);
    blitAt(img, renderSolids([...tvSolids().slice(0, -1), ...flatTv()].map((s) => shift(s, 0, 80)), W, H, OX, OY, "all").img, W, H, 0, 0, covered);
    blitAt(tvMask, renderSolids(flatTv().map((s) => shift(s, 0, 80)), W, H, OX, OY, "none").img, W, H, 0, 0);
    for (let i = 0; i < img.length; i++) if (tvMask[i]) zone[i] = 6;
  }
  const lights = drawPieces(img, view === "south" ? BEDROOM : SPA, view, covered);
  // People for scale: two in the near compartment (view cells).
  const people: [number, Dir, number, number][] = view === "south" ? [[0, "se", 3, 7], [3, "sw", 5, 8]] : [[2, "se", 4, 7], [1, "sw", 3, 9]];
  for (const [ai, dir, c, rr] of people) {
    const a = AVATARS[ai];
    if (!a) continue;
    const s = toScreen(c * 16, rr * 16);
    blitAt(img, render(composeMotion(a, "idle", dir, {}), a.roles), CELL.w, CELL.h, s.x - FLOOR.x, s.y - FLOOR.y, covered);
  }
  // Anything drawn over the shell takes its own light (pools and the cove wash only light bare surfaces, the warm glass
  // tint only what is behind the glass).
  for (let i = 0; i < img.length; i++) if (zone[i] !== 6 && covered[i]) zone[i] = 0;
  return { img, zone, lights };
}

// ------------------------------------------------------------------ night

type Mode = "dark" | "warm" | "pink" | "cool" | "amber" | "self";
const MUL: Record<Mode, readonly [number, number, number]> = {
  dark: [0, 0, 0], // the room's night formula, below
  warm: [1.04, 0.9, 0.7],
  pink: [1.05, 0.72, 0.92],
  cool: [0.75, 0.92, 1.05],
  amber: [0.9, 0.8, 0.7],
  self: [1, 1, 1],
};
function shade(c: RGBA, m: Mode): RGBA {
  if (m === "dark") {
    const f = (v: number, t: number): number => Math.round(v * (0.5 + (0.5 * t) / 255));
    return { r: f(c.r, 36), g: f(c.g, 48), b: f(c.b, 110), a: c.a };
  }
  const [a, b, d] = MUL[m];
  const f = (v: number, k: number): number => Math.min(255, Math.round(v * k));
  return { r: f(c.r, a), g: f(c.g, b), b: f(c.b, d), a: c.a };
}

/** Night is a lighting pass, not a filter: everything drops to the dark ramp, then lamp and neon pools, the cove strip's
 *  wash down the walls, a warm glass and doorway, and the TV glow bring their own colours back. A fresh indexed palette. */
/** Lamp bulbs, the glass stripe, sauna embers and the neon tube glow on their own. */
const EMISSIVE = new Set((["glow", "ginger", "pink"] as const).flatMap((n) => ([0, 1, 2] as const).map((t) => colorIndex(n, t))));

function night(sc: Scene): { img: Uint8Array; pal: RGBA[] } {
  const pal: RGBA[] = [{ r: 0, g: 0, b: 0, a: 0 }];
  const slot = new Map<string, number>();
  const at = (i: number, m: Mode): number => {
    const key = `${String(i)}:${m}`;
    const hit = slot.get(key);
    if (hit !== undefined) return hit;
    const c = PALETTE[i];
    if (!c) return 0;
    pal.push(shade(c, m));
    if (pal.length > 256) throw new Error("night palette over 256");
    slot.set(key, pal.length - 1);
    return pal.length - 1;
  };
  const zc = WALL_H - 14;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) {
    const v = sc.img[i] ?? 0;
    if (v === 0) continue;
    const x = i % W, y = Math.floor(i / W), z = sc.zone[i] ?? 0;
    const lit = (s: number): boolean => s >= 0.66 || (s > 0.3 && (x + y) % 2 === 0);
    let mode: Mode = "dark";
    if (z === 1 || z === 3) mode = "amber";
    else if (z === 2 || z === 6 || EMISSIVE.has(v)) mode = "self";
    // Strongest pool wins; pools land on bare floor and wall only, never as a disc across furniture.
    let best = 0;
    if (z >= 4 && z !== 6) for (const l of sc.lights) {
      const a = 1 - Math.hypot((x - l.src.x) / 2, y - l.src.y) / (l.r * 0.6);
      const b = 1 - Math.hypot((x - l.floor.x) / 2, y - l.floor.y) / l.r;
      const s = Math.max(a, b);
      if (s > best && lit(s)) { best = s; mode = l.glow; }
    }
    if (z === 4 || z === 5) {
      // The cove strip at z = WALL_H − 14 on this wall's plane, and its wash downward.
      const yc = z === 4 ? OY + (-8 + (-8 - (x - OX) / 2)) - zc : OY + (WALL_V + WT + (x - OX) / 2) + WALL_V + WT - zc;
      const dy = y - yc;
      const s = dy < -4 ? 0 : dy < 10 ? 1 : 1 - (dy - 10) / 34;
      if (s > best && lit(s)) mode = "warm";
    }
    // A lit bare surface also comes up one tone, so a pool reads even on the dark carpet.
    const rt = RAMP_OF.get(v);
    const base = mode !== "dark" && mode !== "self" && mode !== "amber" && z >= 4 && rt && rt[1] > 0 ? colorIndex(rt[0], rt[1] === 2 ? 1 : 0) : v;
    out[i] = at(base, mode);
  }
  return { img: out, pal };
}

for (const view of ["south", "north"] as const) {
  const sc = scene(view);
  const n = night(sc);
  for (const [suffix, img, pal] of [["", sc.img, PALETTE], ["-night", n.img, n.pal]] as const) {
    writeFileSync(join(ROOT, "preview", `dungeon2-${view}${suffix}@1x.png`), encodeIndexedPng(W, H, img, pal));
    writeFileSync(join(ROOT, "preview", `dungeon2-${view}${suffix}@2x.png`), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), pal));
  }
}
