// Valentine's theme (OME-1187, Feb 10 – Feb 14): a heart headband for every avatar, paper heart bunting along both walls,
// a pink accent on the lamps and hearts floating up.
import { RAMPS } from "./palette";
import { WALL_H, type RoomFrame } from "./room";
import type { RoleMap } from "./sprite";
import { effectFrame, pad, swag, wallDecal, type DecorMeta, type DecorOn, type HatDef, type HatRows, type ThemeDef } from "./theme";

// ---------------------------------------------------------------- heart headband

const BAND_ROLES: RoleMap = {
  K: { ramp: "velvet", hi: true, group: "K" },
  N: { ramp: "pink", hi: true, group: "N" },
  U: { ramp: "mustard", tone: 0 },
};

/** A band that follows the top of the head or hair, with two hearts on springs. Shared with the bunny ears (easter.ts). */
export interface BandFit {
  cx: number;
  /** Top of the head, hair or headwear at the centre column. */
  topY: number;
  half: number;
  /** How far the band falls from the top to its ends. */
  drop: number;
  /** Hearts / ears: offset from the centre and the spring length. */
  sx: number;
  spring: number;
}
/** Worn over Pip's beanie and Mo's bucket hat (a band can't hide them); on top of Juno's puff, between Kiki's buns. */
export const BAND_FITS: Readonly<Record<string, BandFit>> = {
  juno: { cx: 7, topY: -6, half: 9, drop: 4, sx: 4, spring: 3 },
  pip: { cx: 8, topY: -5, half: 8, drop: 4, sx: 5, spring: 4 },
  mo: { cx: 8, topY: -4, half: 8, drop: 3, sx: 4, spring: 3 },
  kiki: { cx: 8, topY: -3, half: 6, drop: 2, sx: 4, spring: 3 },
};

/** The band's top row at column x. */
export const bandY = (f: BandFit, x: number): number => f.topY + Math.round(f.drop * ((x - f.cx) / f.half) ** 2);

export function bandRows(f: BandFit, put: (x: number, y: number, ch: string) => void, ch: string): void {
  for (let x = f.cx - f.half; x <= f.cx + f.half; x++) {
    put(x, bandY(f, x), ch);
    put(x, bandY(f, x) + 1, ch);
  }
}

const HEART = ["NN.NN", "NNNNN", ".NNN.", "..N.."];

function headbandRows(f: BandFit): HatRows {
  const { put, rows } = pad();
  bandRows(f, put, "K");
  for (const dx of [-f.sx, f.sx]) {
    const x = f.cx + dx;
    const top = bandY(f, x) - 1;
    for (let k = 0; k < f.spring; k++) put(x + (k % 2 === 0 ? 0 : dx < 0 ? -1 : 1), top - k, "U");
    const hy = top - f.spring - HEART.length + 1;
    HEART.forEach((r, y) => {
      for (let i = 0; i < r.length; i++) if (r.charAt(i) === "N") put(x - 2 + i, hy + y, "N");
    });
  }
  return rows();
}

export const HEART_HEADBAND: HatDef = {
  roles: BAND_ROLES,
  replaces: false,
  rows: (id) => {
    const fit = BAND_FITS[id];
    if (!fit) throw new Error(`no headband fit for ${id}`);
    return headbandRows(fit);
  },
};

// ---------------------------------------------------------------- floating hearts

const HEART_ROLES: RoleMap = { P: { ramp: "pink", hi: true, group: "P" } };
/** A heart that beats as it floats up: full, then a beat smaller. 6×5 + outline = 8×7. */
const HEARTS: readonly (readonly string[])[] = [
  ["PP..PP", "PPPPPP", "PPPPPP", ".PPPP.", "..PP.."],
  ["......", ".PP.PP", ".PPPPP", "..PPP.", "...P.."],
];

export function buildHeartFrames(): RoomFrame[] {
  return HEARTS.map((rows, i) => effectFrame(`valentines/heart/${String(i)}`, rows, HEART_ROLES));
}

// ---------------------------------------------------------------- decor

/** Paper hearts on a string, two per wall segment (pink, then cream), repeating along both walls. Flat paper: no outline. */
const PAPER = [".HH.HH.", "HHHHHHH", "HHHHHHH", ".HHHHH.", "..HHH..", "...H..."];

export function buildDecorFrames(): { frames: RoomFrame[]; meta: DecorMeta[] } {
  const frames: RoomFrame[] = [];
  const meta: DecorMeta[] = [];
  const add = (f: RoomFrame, on: DecorOn): void => {
    frames.push(f);
    meta.push({ key: f.key, on });
  };
  const TOP = WALL_H - 9;
  for (const face of ["l", "r"] as const) {
    const lit = face === "r";
    const motifs = [
      { s: -4, rows: PAPER, colors: { H: ["pink", lit ? 0 : 1] as const } },
      { s: 4, rows: PAPER, colors: { H: ["cream", lit ? 0 : 1] as const } },
    ];
    add(wallDecal(`valentines/bunting/${face}`, face, -8, 8, TOP - 16, TOP + 2, swag(face, TOP, 4, ["velvet", 1], motifs)), `wall/${face}`);
  }
  return { frames, meta };
}

export const VALENTINES: ThemeDef = {
  id: "valentines",
  period: { from: "02-10", to: "02-14" },
  hat: HEART_HEADBAND,
  decor: buildDecorFrames,
  effect: { frames: buildHeartFrames(), ms: 300, max: 12, motion: "rise" },
  accent: { lamps: RAMPS.pink[0] },
  preview: [[0, 360, 200], [1, 470, 300], [0, 600, 160], [1, 720, 240], [0, 820, 330], [1, 280, 380]],
};
