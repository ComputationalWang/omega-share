// Christmas theme (OME-1187, Dec 7 – Dec 31): a Santa hat for every avatar, a pine garland with lights along both walls,
// a snowy night in the window, three stockings under the poster and falling snow.
import { WALL_H, type RoomFrame } from "./room";
import type { RoleMap } from "./sprite";
import { effectFrame, hash, onWall, pad, upright, wallDecal, windowPanels, type DecorMeta, type DecorOn, type HatDef, type HatRows, type Paint, type ThemeDef } from "./theme";

// ---------------------------------------------------------------- Santa hat

const SANTA_ROLES: RoleMap = {
  K: { ramp: "rust", hi: true, group: "K" },
  V: { ramp: "cream", hi: true, group: "V" },
  Q: { ramp: "cream", hi: true, group: "Q" },
};

/** baseY: the fur trim's bottom row; trim: its half-width; height: trim top to the cone's top; lean: how far the cone falls back. */
interface SantaFit {
  baseY: number;
  cx: number;
  trim: number;
  height: number;
  lean: number;
}
/** Wide enough to hide Pip's beanie and Mo's bucket hat; it sits on Juno's puff and between Kiki's buns. */
const SANTA_FITS: Readonly<Record<string, SantaFit>> = {
  juno: { baseY: -3, cx: 8, trim: 9, height: 11, lean: 7 },
  pip: { baseY: 2, cx: 8, trim: 10, height: 15, lean: 5 },
  mo: { baseY: 3, cx: 8, trim: 11, height: 11, lean: 7 },
  kiki: { baseY: -1, cx: 8, trim: 7, height: 10, lean: 6 },
};

function santaRows(f: SantaFit): HatRows {
  const { put, span, rows } = pad();
  const { baseY, cx, trim, height, lean } = f;
  const trimTop = baseY - 2;
  // Red cone, leaning toward the back of the head (template-left) as it rises.
  const base = trim - 1;
  let tipX = cx, tipY = trimTop;
  for (let k = 1; k <= height; k++) {
    const t = k / height;
    const half = Math.max(0, Math.round(base * Math.pow(1 - t, 0.75)));
    const c = cx - Math.round(lean * Math.pow(t, 2.5));
    span(trimTop - k, c - half, c + half, "K");
    tipX = c; tipY = trimTop - k;
  }
  // The floppy end droops down the back, ending in a pom.
  for (let k = 1; k <= 3; k++) span(tipY + k, tipX - k - 1, tipX - k, "K");
  const px = tipX - 5, py = tipY + 4;
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 1], [0, 1], [1, 1], [2, 1], [-1, 2], [0, 2], [1, 2], [2, 2], [0, 3], [1, 3]] as const) put(px + dx, py + dy, "Q");
  // Fur trim: three rows, the top row's ends rounded off.
  span(trimTop, cx - trim + 1, cx + trim - 1, "V");
  span(trimTop + 1, cx - trim, cx + trim, "V");
  span(baseY, cx - trim, cx + trim, "V");
  return rows();
}

export const SANTA_HAT: HatDef = {
  roles: SANTA_ROLES,
  replaces: true,
  rows: (id) => {
    const fit = SANTA_FITS[id];
    if (!fit) throw new Error(`no Santa hat fit for ${id}`);
    return santaRows(fit);
  },
};

// ---------------------------------------------------------------- snow

const FLAKE_ROLES: RoleMap = { X: { ramp: "cream", tone: 0 }, x: { ramp: "glow", tone: 1 } };
/** Three flakes, each ≤ 6×6 with the outline. A particle keeps one; they don't animate. */
const FLAKES: readonly (readonly string[])[] = [
  ["X.X", ".x.", "X.X"],
  [".X.", "XxX", ".X."],
  ["XX", "XX"],
];

export function buildFlakeFrames(): RoomFrame[] {
  return FLAKES.map((rows, i) => effectFrame(`christmas/snow/${String(i)}`, rows, FLAKE_ROLES));
}

// ---------------------------------------------------------------- decor

/** Snowy night: snow-capped rooftops with lit windows, a drift on the outside ledge, snow falling against a night sky. */
function snowPaint(w: number, z: number): Paint {
  const d = (Math.floor(w * 2) + Math.floor(z)) % 2 === 0;
  // Drift along the bottom of the panes, piled into the corners.
  const drift = 90 + 1.5 * Math.cos(w * 0.9) + (Math.abs(w) > 9 ? 2 : 0);
  if (z < drift) return ["cream", z > drift - 1.5 ? 0 : 1];
  // Falling snow in front of everything else.
  const fx = Math.floor(w * 2), fz = Math.floor(z);
  if (hash(fx + 7, fz) % 29 === 0 && hash(fx, fz + 3) % 2 === 0) return ["cream", 0];
  // Rooftops: gables of different heights, each with a snow cap and the odd lit window.
  const col = Math.floor((w + 12) / 4);
  const local = ((w + 12) % 4) - 2;
  const eave = 104 + (hash(col, 11) % 4) * 5;
  const ridge = eave + 4 - Math.abs(local) * 2;
  if (z < ridge) {
    if (z >= ridge - 1.6) return ["cream", 1];
    const lit = Math.abs(local) < 0.75 && z > eave - 9 && z < eave - 5 && hash(col, 5) % 2 === 0;
    return lit ? ["mustard", 1] : ["night", 2];
  }
  // Chimney with a cap of snow on one roof.
  if (col === 1 && local > 0.5 && local < 1.5 && z < ridge + 5) return z >= ridge + 4 ? ["cream", 0] : ["rust", 2];
  // Sky: night, a touch lighter near the roofs, stars higher up.
  if (hash(fx, fz) % 53 === 0 && z > 130) return ["glow", 0];
  if (z < ridge + 10) return d ? ["night", 0] : ["night", 1];
  return ["night", 1];
}

const CROWN = WALL_H - 5;
/** Pine garland swagged along one wall segment, with three lights hanging at the low points. Repeats on every segment. */
function garlandPaint(face: "l" | "r"): (s: number, z: number) => Paint {
  const mid = (s: number): number => CROWN - 4 - 4 * Math.sin((Math.PI * (s + 8)) / 16);
  const bulbs = ([[-4.5, "rust"], [0, "mustard"], [4.5, "teal"]] as const).map(([bs, ramp]) =>
    upright(face, [".c.", "BBB", "BBB", ".B."], { c: ["charcoal", 1], B: [ramp, 0] }, bs, mid(bs) - 1.5),
  );
  return (s, z) => {
    for (const b of bulbs) {
      const p = b(s, z);
      if (p) return p;
    }
    const dz = z - mid(s);
    if (Math.abs(dz) >= 2) return null;
    const h = hash(Math.floor(s * 2), Math.floor(z));
    if (dz > 1 && h % 3 === 0) return null; // ragged top edge: needles
    return h % 5 === 0 ? ["olive", 0] : dz < -0.8 ? ["olive", 2] : ["olive", 1];
  };
}

/** Stockings: a cream cuff, a body in one of three colours with a stripe, toe toward the room. Hung on pegs under the poster. */
const STOCKING = ["..w...", ".AAAA.", ".AAAA.", ".RRRR.", ".yyyy.", ".RRRR.", ".RRRR.", ".RRRRR", ".RRRRRR", "..RRRRR", "...RRR."];
const stockingRoles = (ramp: "rust" | "olive" | "teal", stripe: "cream" | "mustard"): RoleMap => ({
  w: { ramp: "wood", tone: 2 },
  A: { ramp: "cream", hi: true, group: "A" },
  R: { ramp, hi: true, group: "R" },
  y: { ramp: stripe, tone: 0, group: "R" },
});

export function buildDecorFrames(): { frames: RoomFrame[]; meta: DecorMeta[] } {
  const frames: RoomFrame[] = [];
  const meta: DecorMeta[] = [];
  const add = (f: RoomFrame, on: DecorOn): void => {
    frames.push(f);
    meta.push({ key: f.key, on });
  };
  for (const p of windowPanels("christmas", snowPaint)) add(p.frame, p.on);
  add(wallDecal("christmas/garland/l", "l", -8, 8, CROWN - 14, CROWN, garlandPaint("l")), "wall/l");
  add(wallDecal("christmas/garland/r", "r", -8, 8, CROWN - 14, CROWN, garlandPaint("r")), "wall/r");
  // Under the poster (its bottom edge is z 78; the chair rail tops out at z 56). poster0 holds w < 0 (w = s − 8), poster1 w ≥ 0 (w = s + 8).
  add(onWall("christmas/stocking/0", STOCKING, stockingRoles("rust", "cream"), "r", 1, 75), "wall/r/poster0");
  add(onWall("christmas/stocking/1", STOCKING, stockingRoles("olive", "mustard"), "r", 7.5, 75), "wall/r/poster0");
  add(onWall("christmas/stocking/2", STOCKING, stockingRoles("teal", "cream"), "r", -2, 75), "wall/r/poster1");
  return { frames, meta };
}

export const CHRISTMAS: ThemeDef = {
  id: "christmas",
  period: { from: "12-07", to: "12-31" },
  hat: SANTA_HAT,
  decor: buildDecorFrames,
  effect: { frames: buildFlakeFrames(), max: 40, motion: "fall" },
  preview: [
    [0, 320, 180], [1, 380, 260], [2, 440, 150], [0, 520, 320], [1, 580, 120], [2, 640, 240], [0, 700, 170], [1, 760, 300],
    [2, 300, 400], [0, 420, 470], [1, 560, 520], [2, 690, 450], [0, 820, 380], [1, 480, 220], [2, 860, 280], [0, 250, 300],
  ],
};
