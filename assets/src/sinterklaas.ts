// Sinterklaas theme (OME-1187, Nov 14 – Dec 6): a red mitre for every avatar, a steamboat in the window, a shoe with a carrot
// and wrapped surprises on the sill, a paper-flag swag in the back corner and falling pepernoten. No Zwarte Piet imagery, by design.
import { WALL_H, type RoomFrame } from "./room";
import type { RoleMap } from "./sprite";
import { effectFrame, hash, onSill, pad, swag, wallDecal, windowPanels, type DecorMeta, type DecorOn, type HatDef, type HatRows, type Paint, type ThemeDef } from "./theme";

// ---------------------------------------------------------------- mitre

const MITRE_ROLES: RoleMap = {
  K: { ramp: "rust", hi: true, group: "K" },
  N: { ramp: "mustard", hi: true, group: "N" },
  U: { ramp: "mustard", tone: 0, group: "N" },
};

/** baseY: the band's bottom row; body: half-width of the red body; height: band bottom to tip. The band is 2 px wider each side. */
interface MitreFit {
  baseY: number;
  cx: number;
  body: number;
  height: number;
}
/** Wide enough to hide Pip's beanie and Mo's bucket hat; it sits on Juno's puff and between Kiki's buns. */
const MITRE_FITS: Readonly<Record<string, MitreFit>> = {
  juno: { baseY: -3, cx: 8, body: 6, height: 19 },
  pip: { baseY: 2, cx: 8, body: 8, height: 20 },
  mo: { baseY: 3, cx: 8, body: 9, height: 19 },
  kiki: { baseY: -1, cx: 8, body: 5, height: 18 },
};

function mitreRows(f: MitreFit, view: "front" | "back"): HatRows {
  const { put, span, rows } = pad();
  const { baseY, cx, body, height } = f;
  const bandTop = baseY - 2;
  // Body: straight sides with a slight flare, then a pointed arch to the tip.
  const bodyH = height - 3;
  for (let k = 1; k <= bodyH; k++) {
    const t = k / bodyH;
    const half = t < 0.5 ? body + Math.round(t * 2) : Math.round((body + 1) * Math.pow((1 - t) / 0.5, 0.75));
    span(bandTop - k, cx - half, cx + half, "K");
  }
  // Gold band at the base and a gold seam up the middle.
  for (let y = bandTop; y <= baseY; y++) span(y, cx - body - 2, cx + body + 2, "N");
  for (let k = 1; k <= bodyH; k++) put(cx, bandTop - k, "N");
  if (view === "front") {
    // A plain gold cross on the front, centred on the seam.
    const cy = bandTop - Math.round(bodyH * 0.45);
    for (let y = cy - 3; y <= cy + 2; y++) put(cx, y, "U");
    span(cy - 1, cx - 2, cx + 2, "U");
  }
  return rows();
}

export const MITRE: HatDef = {
  roles: MITRE_ROLES,
  replaces: true,
  rows: (id, view) => {
    const fit = MITRE_FITS[id];
    if (!fit) throw new Error(`no mitre fit for ${id}`);
    return mitreRows(fit, view);
  },
};

// ---------------------------------------------------------------- pepernoten

const NOOT_ROLES: RoleMap = {
  O: { ramp: "wood", hi: true, group: "O" },
  y: { ramp: "wood", tone: 2, group: "O" },
};
/** Two frames a quarter turn apart, so a falling pepernoot tumbles. 6×6 + outline = 8×8. */
const NOTEN: readonly (readonly string[])[] = [
  [".OOOO.", "OOOyOO", "OyOOOO", "OOOOyO", "OOyOOO", ".OOOO."],
  [".OOOO.", "OOyOOO", "OOOOyO", "OyOOOO", "OOOyOO", ".OOOO."],
];

export function buildNootFrames(): RoomFrame[] {
  return NOTEN.map((rows, i) => effectFrame(`sinterklaas/pepernoot/${String(i)}`, rows, NOOT_ROLES));
}

// ---------------------------------------------------------------- decor

/** Steamboat at night: harbour water with lamp reflections, a white boat with a red chimney, a string of flags and a puff of smoke. */
function boatPaint(w: number, z: number): Paint {
  const d = (Math.floor(w * 2) + Math.floor(z)) % 2 === 0;
  // Hull: cream with a red waterline band, the bow raised to the right.
  const deck = 104 + (w > 4 ? (w - 4) * 0.6 : 0);
  const stern = -10, bow = 9 - Math.max(0, 100 - z) * 0.4;
  if (z >= 97 && z < deck && w >= stern + (104 - z) * 0.15 && w < bow) return z < 100 ? ["rust", 1] : ["cream", z > deck - 1.5 ? 0 : 1];
  // Cabin with lit portholes, then the chimney (red, a dark rim) and the mast.
  if (z >= 104 && z < 111 && w >= -7 && w < 2) return Math.abs(z - 107.5) < 1 && Math.floor(w + 20) % 3 === 0 ? ["mustard", 0] : ["cream", z >= 110 ? 0 : 2];
  if (w >= 3.5 && w < 6.5 && z >= 104 && z < 121) return z >= 119 ? ["outline", 1] : ["rust", w < 4.5 ? 0 : 1];
  if (Math.abs(w + 8) < 0.5 && z >= 104 && z < 132) return ["wood", 2];
  // Flags on a line from the mast top down to the chimney.
  const line = 132 - ((w + 8) / 13) * 11;
  if (w > -8 && w < 5 && Math.abs(z - line) < 0.6) return ["cream", 2];
  const fi = Math.floor((w + 8) / 2.2);
  const fw = (w + 8) / 2.2 - fi;
  if (w > -7.6 && w < 4.5 && z < line && z > line - 2.6 * (1 - fw)) return [(["rust", "mustard", "teal"] as const)[fi % 3] ?? "rust", 1];
  // Smoke puffs drifting back over the stern.
  for (const [pw, pz, r] of [[5, 124, 1.8], [3.8, 128, 2.2], [2, 132.5, 2]] as const) {
    const q = (w - pw) ** 2 * 4 + (z - pz) ** 2;
    if (q < r * r * 2) return ["cream", q < r * r ? 2 : d ? 2 : 1];
  }
  // Water: dark navy with ripple lines and two warm streaks reflecting the portholes.
  if (z < 98) {
    if (Math.abs(w + 4) < 0.6 || Math.abs(w + 1) < 0.6) return d && Math.floor(z) % 3 !== 0 ? ["mustard", 2] : ["navy", 2];
    return Math.floor(z) % 4 === 0 && hash(Math.floor(w / 3), Math.floor(z)) % 3 !== 0 ? ["navy", 1] : ["navy", 2];
  }
  // Night sky with a few stars and a thin moon.
  const mw = w - 7, mz = z - 157;
  if (mw * mw * 4 + mz * mz < 14 && (mw + 1) * (mw + 1) * 4 + (mz - 1) ** 2 >= 12) return ["cream", 0];
  if (hash(Math.floor(w * 2), Math.floor(z)) % 41 === 0) return ["glow", 0];
  return z < 120 ? (d ? ["night", 1] : ["night", 0]) : ["night", 1];
}

/** A painted wooden clog on the sill with a carrot for the horse, its upturned toe toward the room. */
const SHOE_ROLES: RoleMap = {
  s: { ramp: "mustard", hi: true, group: "s" },
  O: { ramp: "ginger", hi: true, group: "O" },
  g: { ramp: "olive", hi: true, group: "g" },
};
const SHOE = [
  "....g.g.......",
  ".....gg.......",
  "....OOO.......",
  "..sOOOss......",
  ".sssOsssss....",
  ".sssssssssss..",
  ".ssssssssssss.",
  "..ssssssssssss",
  "...sssssssss..",
];

/** Wrapped surprises: a big teal one with a mustard ribbon and bow, a small pink one with a cream ribbon. */
const BOX_ROLES: RoleMap = {
  P: { ramp: "teal", hi: true, group: "P" },
  p: { ramp: "pink", hi: true, group: "p" },
  y: { ramp: "mustard", tone: 0 },
  w: { ramp: "cream", tone: 0 },
};
const BIG_BOX = ["...y...y..", "....yyy...", "PPPPPyPPPP", "PPPPPyPPPP", "yyyyyyyyyy", "PPPPPyPPPP", "PPPPPyPPPP", "PPPPPyPPPP"];
const SMALL_BOX = ["..w.w.", "...w..", "ppwppp", "wwwwww", "ppwppp", "ppwppp"];

/** Paper flags in Sint's colours on a string across the back corner (flat paper: no outline, but a dark fold line). */
const FLAG = ["RRRRRRR", ".RRRRR.", "..RRR..", "...R..."];
const flag = (c: "rust" | "mustard" | "cream"): Readonly<Record<string, Paint>> => ({ R: [c, c === "rust" ? 1 : 0] });

export function buildDecorFrames(): { frames: RoomFrame[]; meta: DecorMeta[] } {
  const frames: RoomFrame[] = [];
  const meta: DecorMeta[] = [];
  const add = (f: RoomFrame, on: DecorOn): void => {
    frames.push(f);
    meta.push({ key: f.key, on });
  };
  for (const p of windowPanels("sinterklaas", boatPaint)) add(p.frame, p.on);
  // On the sill (runs w −14..14): the shoe and the small surprise on window0, the big surprise on window1.
  add(onSill("sinterklaas/shoe", SHOE, SHOE_ROLES, 1), "wall/l/window0");
  add(onSill("sinterklaas/surprise/small", SMALL_BOX, BOX_ROLES, 6), "wall/l/window0");
  add(onSill("sinterklaas/surprise/big", BIG_BOX, BOX_ROLES, 1), "wall/l/window1");
  // Corner swag: one half per wall, from the corner out along the first segment.
  const TOP = WALL_H - 10;
  const order = ["rust", "mustard", "cream", "rust", "mustard"] as const;
  for (const face of ["l", "r"] as const) {
    const motifs = [-5, 0, 5].map((s, i) => ({ s, rows: FLAG, colors: flag(order[(i + (face === "l" ? 0 : 1)) % order.length] ?? "rust") }));
    add(wallDecal(`sinterklaas/flags/corner-${face}`, face, -8, 8, TOP - 20, TOP + 2, swag(face, TOP, 10, ["cream", 2], motifs)), "wall/corner");
  }
  return { frames, meta };
}

export const SINTERKLAAS: ThemeDef = {
  id: "sinterklaas",
  period: { from: "11-14", to: "12-06" },
  hat: MITRE,
  decor: buildDecorFrames,
  effect: { frames: buildNootFrames(), ms: 160, max: 20, motion: "fall" },
  preview: [[0, 330, 170], [1, 410, 250], [0, 520, 140], [1, 600, 300], [0, 690, 200], [1, 760, 260], [0, 450, 360], [1, 300, 420]],
};
