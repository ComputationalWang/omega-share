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
const GLASS = { u0: 56, u1: 120, z0: 24, z1: 150 } as const; // cols 4–7
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
      const d = su - 20 - (GLASS.z1 - p.z) * 0.3;
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
/** Sauna cabin, 2×2: slatted cedar, a dark roof trim, a door with a small glowing window on its local −x face. */
const sauna: Build = (k) => {
  const X0 = -7.5, X1 = 23.5, Y0 = -7.5, Y1 = 23.5, H = 120;
  k.box(X0, X1, Y0, Y1, 0, H, "wood", {
    paint: (p, f) => {
      if (f === "top") return ["wood", 2];
      if (p.z > H - 6) return ["charcoal", p.z > H - 2 ? 1 : 2];
      if (p.z < 3) return ["charcoal", 2];
      if (f === "left" || f === "front") {
        const s = f === "left" ? p.y : p.x;
        if (f === "left" && s > 2 && s < 14 && p.z < 92) {
          if (s < 3 || s > 13 || p.z > 90) return ["charcoal", 2];
          if (s > 5 && s < 11 && p.z > 62 && p.z < 84) return ["mustard", p.z > 76 ? 0 : 1]; // hot window
          if (Math.abs(s - 11.5) < 0.8 && Math.abs(p.z - 46) < 4) return ["mustard", 0]; // handle
          return ["wood", 0];
        }
        if (f === "front" && Math.abs(s - 8) < 4 && p.z > 70 && p.z < 82) return Math.abs(p.z - 76) < 3 && Math.abs(s - 8) < 2 ? ["rust", 0] : ["cream", 1]; // thermometer
      }
      const s = f === "right" || f === "left" ? p.y : p.x;
      return ((s + 40) % 4) < 0.6 ? ["wood", 2] : null;
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

/** Big mirror, 2 cells wide on a wall (local x −7…23): thin brass frame, pale glass reflecting the warm room, two sheen
 *  streaks. A brass frame, not the glass wall's black one, so it can't read as a window. `se` mount. */
const bigMirror: Build = (k) => {
  k.box(-7, 23, 6.5, 8, 60, 140, "mustard", {
    paint: (p, f) => {
      if (f === "top") return ["mustard", 2];
      if (p.x < -6 || p.x > 22 || p.z < 61.5 || p.z > 138.5) return ["mustard", p.z > 138 || p.x < -6 ? 1 : 2];
      const d = p.x - (p.z - 60) * 0.3;
      if ((d > 2 && d < 4) || (d > 6 && d < 6.8)) return ["glow", 0];
      if (p.z < 76) return ["wood", 1]; // the deck, reflected
      if (p.z > 128) return ["mustard", 1]; // the cove light, reflected
      return ["glow", p.z < 96 ? 2 : 1];
    },
  });
};

// ------------------------------------------------------------------ the layout (original coordinates)

interface Place {
  build: Build;
  dir: FurnDir;
  col: number;
  row: number;
  turned?: boolean;
  cols?: number;
  rows?: number;
  wall?: boolean;
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
  P(cat("desk"), "se", 0, 7), P(cat("minibar"), "se", 0, 8), P(cat("neonsign", "pink"), "se", 0, 6, { wall: true }),
  P(cat("coffeetable"), "se", 8, 8), P(cat("wingback", "velvet"), "ne", 8, 9), P(cat("wingback", "velvet"), "nw", 9, 8),
];
const SPA: readonly Place[] = [
  P(sauna, "ne", 8, 3, { cols: 2, rows: 2 }),
  P(cat("washbasin"), "se", 9, 0, { turned: true }), P(cat("washbasin"), "se", 9, 1, { turned: true }),
  P(bigMirror, "se", 9, 1, { turned: true, wall: true }),
  P(cat("whirlpool"), "ne", 1, 1, { cols: 2 }),
  P(ofuro, "ne", 4, 2, { cols: 2, rows: 2 }),
  P(recliner, "ne", 6, 0, { cols: 2 }), P(cat("sidetable"), "se", 8, 0),
];

// ------------------------------------------------------------------ compositing

const W = 600, H = 520, OX = 330, OY = 190;
const CV = { w: 300, h: 340, ax: 150, ay: 260 } as const;
const toScreen = (u: number, v: number): { x: number; y: number } => ({ x: OX + 2 * (u - v), y: OY + u + v });

function blitAt(dst: Uint8Array, src: Uint8Array, sw: number, sh: number, ox: number, oy: number): void {
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const v = src[y * sw + x] ?? 0;
      const px = ox + x, py = oy + y;
      if (v !== 0 && px >= 0 && py >= 0 && px < W && py < H) dst[py * W + px] = v;
    }
  }
}

/** Painter's order as in the room: wall pieces, then objects by footprint centre (u + v), then x. */
function drawPieces(dst: Uint8Array, list: readonly Place[], view: View): void {
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
    return { k, au, av, key: pl.wall === true ? -1e9 : (su + sv) / n, x: (su - sv) / n };
  });
  items.sort((a, b) => a.key - b.key || a.x - b.x);
  for (const it of items) {
    const img = renderSolids(it.k.parts.map((p) => p.solid), CV.w, CV.h, CV.ax, CV.ay, "all").img;
    const s = toScreen(it.au, it.av);
    blitAt(dst, img, CV.w, CV.h, s.x - CV.ax, s.y - CV.ay);
  }
}

const RAMP_OF = new Map<number, Paint>();
for (const name of Object.keys(RAMPS) as RampName[]) {
  for (const t of [0, 1, 2] as const) {
    const i = colorIndex(name, t);
    if (!RAMP_OF.has(i)) RAMP_OF.set(i, [name, t]);
  }
}
/** Seen through glass: one tone darker, and a sparse cool haze. */
function tint(i: number, x: number, y: number): number {
  const rt = RAMP_OF.get(i);
  if (!rt || i === OUTLINE) return i;
  if ((x + 2 * y) % 7 === 0) return colorIndex("night", 1);
  return colorIndex(rt[0], rt[1] === 0 ? 1 : 2);
}

function scene(view: View): Uint8Array {
  const sh = shell(view);
  const bg = colorIndex("night", 2);
  // The far compartment, drawn only where the glass or the doorway lets you see it.
  const far = renderSolids(sh.far, W, H, OX, OY, "all").img;
  drawPieces(far, view === "south" ? SPA : BEDROOM, view);
  const solids = [...sh.near, sh.glass, sh.door];
  const gi = solids.length - 2, di = solids.length - 1;
  const r = renderSolids(solids, W, H, OX, OY, "all");
  const img = new Uint8Array(W * H).fill(bg);
  const stripe = new Set([colorIndex("glow", 0), colorIndex("glow", 1)]);
  for (let i = 0; i < img.length; i++) {
    const id = r.ids[i] ?? -1, v = r.img[i] ?? 0, f = far[i] ?? 0;
    const x = i % W, y = Math.floor(i / W);
    if (id === gi) img[i] = stripe.has(v) ? v : f !== 0 ? tint(f, x, y) : colorIndex("glow", 2);
    else if (id === di) img[i] = f !== 0 ? f : colorIndex("charcoal", 2);
    else if (v !== 0) img[i] = v;
  }
  if (view === "south") {
    const tv = renderSolids(tvSolids().map((s) => shift(s, 0, 80)), W, H, OX, OY, "all").img;
    for (let i = 0; i < img.length; i++) if (tv[i]) img[i] = tv[i] ?? 0;
  }
  drawPieces(img, view === "south" ? BEDROOM : SPA, view);
  // People for scale: two in the near compartment (view cells).
  const people: [number, Dir, number, number][] = view === "south" ? [[0, "se", 3, 7], [3, "sw", 5, 8]] : [[2, "se", 4, 7], [1, "sw", 3, 9]];
  for (const [ai, dir, c, rr] of people) {
    const a = AVATARS[ai];
    if (!a) continue;
    const s = toScreen(c * 16, rr * 16);
    blitAt(img, render(composeMotion(a, "idle", dir, {}), a.roles), CELL.w, CELL.h, s.x - FLOOR.x, s.y - FLOOR.y);
  }
  return img;
}

const NIGHT: RGBA[] = PALETTE.map((c) => {
  const m = (v: number, t: number): number => Math.round(v * (0.5 + (0.5 * t) / 255));
  return { r: m(c.r, 36), g: m(c.g, 48), b: m(c.b, 110), a: c.a };
});

for (const view of ["south", "north"] as const) {
  const img = scene(view);
  for (const [suffix, pal] of [["", PALETTE], ["-night", NIGHT]] as const) {
    writeFileSync(join(ROOT, "preview", `dungeon2-${view}${suffix}@1x.png`), encodeIndexedPng(W, H, img, pal));
    writeFileSync(join(ROOT, "preview", `dungeon2-${view}${suffix}@2x.png`), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), pal));
  }
}
