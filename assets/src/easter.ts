// Easter theme (OME-1187, Easter Sunday − 7 days → Easter Monday): bunny ears for every avatar, blossom branches against a spring sky in
// the window, painted eggs on the sill, a paper-egg swag in the back corner and drifting blossom petals.
import { WALL_H, type RoomFrame } from "./room";
import type { RoleMap } from "./sprite";
import { effectFrame, hash, onSill, pad, swag, wallDecal, windowPanels, type DecorMeta, type DecorOn, type HatDef, type HatRows, type Paint, type ThemeDef } from "./theme";
import { BAND_FITS, bandRows, bandY, type BandFit } from "./valentines";

// ---------------------------------------------------------------- bunny ears

const EAR_ROLES: RoleMap = {
  K: { ramp: "cream", hi: true, group: "K" },
  Q: { ramp: "pink", tone: 1, group: "K" },
};

const EAR_LEN = 11;

/** Two ears on the same band as the heart headband: the near ear stands up and leans out, the far ear bends over at the tip. */
function earRows(f: BandFit, view: "front" | "back"): HatRows {
  const { put, rows } = pad();
  bandRows(f, put, "K");
  const inner = view === "front" ? "Q" : "K";
  for (const side of [-1, 1] as const) {
    const bx = f.cx + side * f.sx - 1; // left column of the 4 px ear
    const base = bandY(f, bx + 1) - 1;
    for (let k = 0; k < EAR_LEN; k++) {
      const y = base - k;
      // Near ear (template-right) leans out a pixel every 4 rows; the far ear stands, then its last 4 rows fold toward the back.
      const fold = side < 0 && k >= EAR_LEN - 4;
      const lean = side > 0 ? Math.floor(k / 4) : 0;
      const x = fold ? bx - (k - (EAR_LEN - 5)) : bx + lean;
      const yy = fold ? base - (EAR_LEN - 5) - Math.floor((k - (EAR_LEN - 5)) / 2) : y;
      const tip = k === EAR_LEN - 1;
      for (let i = 0; i < 4; i++) {
        const edge = i === 0 || i === 3;
        if (tip && edge) continue;
        put(x + i, yy, edge || tip || k < 1 ? "K" : inner);
      }
    }
  }
  return rows();
}

export const BUNNY_EARS: HatDef = {
  roles: EAR_ROLES,
  replaces: false,
  rows: (id, view) => {
    const fit = BAND_FITS[id];
    if (!fit) throw new Error(`no ears fit for ${id}`);
    return earRows(fit, view);
  },
};

// ---------------------------------------------------------------- petals

const PETAL_ROLES: RoleMap = { P: { ramp: "pink", hi: true, group: "P" }, w: { ramp: "cream", tone: 0, group: "P" } };
/** A petal tumbling: face-on, then edge-on. 4×4 + outline = 6×6. */
const PETALS: readonly (readonly string[])[] = [
  ["wP..", "PPP.", ".PPP", "..P."],
  ["....", "wPPP", ".PP.", "...."],
];

export function buildPetalFrames(): RoomFrame[] {
  return PETALS.map((rows, i) => effectFrame(`easter/petal/${String(i)}`, rows, PETAL_ROLES));
}

// ---------------------------------------------------------------- decor

/** Distance from (w, z) to the segment a–b, in window units (w counts double: it is half as dense on screen). */
function seg(w: number, z: number, a: readonly [number, number], b: readonly [number, number]): number {
  const [aw, az] = a, [bw, bz] = b;
  const dw = (bw - aw) * 2, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((w - aw) * 2 * dw + (z - az) * dz) / (dw * dw + dz * dz)));
  return Math.hypot((w - aw) * 2 - t * dw, z - az - t * dz);
}

const BRANCHES: readonly (readonly [readonly [number, number], readonly [number, number], number])[] = [
  // From the bottom-left corner up across both panes, and a second bough down from the top.
  [[12, 100], [2, 126], 1.4],
  [[2, 126], [-7, 152], 1],
  [[5, 119], [9, 136], 0.8],
  [[-1, 133], [-8, 128], 0.8],
  [[-12, 164], [-4, 150], 1.1],
  [[-4, 150], [3, 147], 0.7],
];
const BLOSSOMS: readonly (readonly [number, number])[] = [
  [9, 108], [6, 116], [3, 124], [9, 135], [7, 129], [0, 131], [-6, 129], [-4, 140], [-7, 151], [-2, 149], [3, 146], [-9, 158], [11, 103], [1.5, 138],
];

/** Spring morning: a pale sky with soft clouds over a green hill, blossom branches across both panes. */
function springPaint(w: number, z: number): Paint {
  const d = (Math.floor(w * 2) + Math.floor(z)) % 2 === 0;
  for (const [bw, bz] of BLOSSOMS) {
    // Measured on screen (the wall's 2:1 shear undone), so the flowers stay round.
    const dx = -2 * (w - bw), dy = w - bw - (z - bz);
    const r = Math.hypot(dx, dy);
    if (r < 1.1) return ["mustard", 0];
    if (r < 3) return ["pink", dx + dy < -1 ? 0 : 1];
  }
  for (const [a, b, th] of BRANCHES) if (seg(w, z, a, b) < th) return ["wood", 2];
  // Hill, then sky with two clouds.
  const hill = 96 + 4 * Math.cos((w + 4) / 6);
  if (z < hill) return z > hill - 1.5 ? ["olive", 0] : hash(Math.floor(w * 2), Math.floor(z)) % 13 === 0 ? ["olive", 2] : ["olive", 1];
  for (const [cw, cz, cr] of [[-5, 118, 9], [6, 156, 7]] as const) {
    const q = ((w - cw) * 2) ** 2 / 4 + (z - cz) ** 2;
    if (q < cr * cr * 0.5) return ["cream", 0];
    if (q < cr * cr * 0.8 && d) return ["cream", 1];
  }
  if (z > 150) return ["glow", 2];
  if (z > 130) return d ? ["glow", 2] : ["glow", 1];
  return ["glow", 1];
}

/** Painted eggs on the sill, each in its own colour with a different pattern. */
const egg = (ramp: "teal" | "pink" | "lilac", deco: "cream" | "mustard"): RoleMap => ({ E: { ramp, hi: true, group: "E" }, e: { ramp: deco, tone: 0, group: "E" } });
const EGG_ZIGZAG = [".EE.", "EEEE", "eEeE", "EeEe", "EEEE", ".EE."];
const EGG_DOTS = ["..EE..", ".EEEE.", "EeEEeE", "EEEEEE", "EEeEEE", "EEEEEE", ".EEEE."];
const EGG_BAND = [".EE.", "EEEE", "eeee", "EEEE", ".EE."];

/** Paper eggs on a string across the back corner. Flat paper: no outline. */
const PAPER_EGG = [".XX.", "XXXX", "XyyX", "XXXX", ".XX."];

export function buildDecorFrames(): { frames: RoomFrame[]; meta: DecorMeta[] } {
  const frames: RoomFrame[] = [];
  const meta: DecorMeta[] = [];
  const add = (f: RoomFrame, on: DecorOn): void => {
    frames.push(f);
    meta.push({ key: f.key, on });
  };
  for (const p of windowPanels("easter", springPaint)) add(p.frame, p.on);
  add(onSill("easter/egg/dots", EGG_DOTS, egg("pink", "mustard"), 0), "wall/l/window0");
  add(onSill("easter/egg/zigzag", EGG_ZIGZAG, egg("teal", "cream"), 4.5), "wall/l/window0");
  add(onSill("easter/egg/band", EGG_BAND, egg("lilac", "cream"), 2), "wall/l/window1");
  const TOP = WALL_H - 10;
  const order = ["teal", "pink", "mustard", "lilac"] as const;
  for (const face of ["l", "r"] as const) {
    const motifs = [-5, 0, 5].map((s, i) => ({ s, rows: PAPER_EGG, colors: { X: [order[(i + (face === "l" ? 0 : 2)) % order.length] ?? "teal", 0] as const, y: ["cream", 0] as const } }));
    add(wallDecal(`easter/eggs/corner-${face}`, face, -8, 8, TOP - 20, TOP + 2, swag(face, TOP, 10, ["cream", 2], motifs)), "wall/corner");
  }
  return { frames, meta };
}

export const EASTER: ThemeDef = {
  id: "easter",
  period: { easter: { from: -7, to: 1 } },
  hat: BUNNY_EARS,
  decor: buildDecorFrames,
  effect: { frames: buildPetalFrames(), ms: 220, max: 20, motion: "fall" },
  preview: [[0, 330, 180], [1, 420, 260], [0, 520, 150], [1, 610, 310], [0, 700, 190], [1, 780, 270], [0, 460, 400], [1, 300, 440]],
};
