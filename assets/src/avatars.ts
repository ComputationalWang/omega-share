// The 4 omega-share avatars. Templates are drawn facing SE; SW is the mirror (shading is
// applied after mirroring, so light always comes from the top-left).
import { blank, mirror, stamp, type Grid, type RoleMap } from "./sprite";
import type { RampName } from "./palette";

export const CELL = { w: 32, h: 64 } as const;
/** Floor point inside a cell: feet for idle, the floor under the hips for sit. */
export const FLOOR = { x: 16, y: 61 } as const;
/** Seat surface height above the floor point, in 1× pixels. Seats in set (b) match this. */
export const SEAT_HEIGHT = 8;

export type Pose = "idle" | "sit";
export type Dir = "se" | "sw";

// Role letters used by the body templates:
// S skin, E eye, M mouth, C cheek, k ear, T top, B hips/lap, L legs, F shoes.
const HEAD = [
  "....SSSSSSSS....",
  "..SSSSSSSSSSSS..",
  ".SSSSSSSSSSSSSS.",
  ".SSSSSSSSSSSSSS.",
  "SSSSSSSSSSSSSSSS",
  "SSSSSSSSSSSSSSSS",
  "SSSSSSSSSSSSSSSS",
  "SSSSSSSSSSSSSSSS",
  "SSSSkSSSSESSSESS",
  "SSSSkSSSSESSSESS",
  "SSSSSSSSCSSSSSCS",
  ".SSSSSSSSSSMSSS.",
  "..SSSSSSSSSSSSS.",
  "...SSSSSSSSSSS..",
  ".....SSSSSSSS...",
];
const BLINK = [".........S...S..", "........EE..EE.."]; // rows 8–9 of HEAD

const TORSO = [
  "....TTTTTTTT....",
  "..TTTTTTTTTTTT..",
  ".TTTTTTTTTTTTTT.",
  ".TTTTTTTTTTTTTT.",
  ".TT.TTTTTTTT.TT.",
  ".TT.TTTTTTTT.TT.",
  ".TT.TTTTTTTT.TT.",
  ".TT.TTTTTTTT.TT.",
  ".SS.BBBBBBBB.SS.",
  "....BBBBBBBB....",
  "....BBBBBBBB....",
];
const LEGS = [
  "....LLL..LLL....",
  "....LLL..LLL....",
  "....LLL..LLL....",
  "....LLL..LLL....",
  "....LLL..LLL....",
  "....LLL..LLL....",
  "....LLL..LLL....",
  "....LLL..LLL....",
  "....FFF..FFFF...",
  "....FFFF.FFFFF..",
];
// Seated lower body in frame coordinates (rows 49–60): hands on the lap, thighs forward
// along the SE axis (2:1), shins hanging off the seat edge, far knee up-left of the near one.
const SIT_LOWER = [
  ".........TT.TTTTTTTT.TT.........",
  ".........SSBBBBBBBBBBSS.........",
  "............BBBBBBBBBBBB........",
  "............BBBBBBBBBBBBBB......",
  "..............BBBBBBBBBBBB......",
  "..................LLL.LLL.......",
  "..................LLL.LLL.......",
  "..................LLL.LLL.......",
  "..................LLL.LLL.......",
  "..................LLL.LLLL......",
  "..................FFFFFFFFF.....",
  "..................FFFF.FFFFF....",
];

interface Origins {
  head: { x: number; y: number };
  torso: { x: number; y: number };
}
const ORIGINS: Record<Pose, Origins> = {
  idle: { head: { x: 8, y: 25 }, torso: { x: 8, y: 40 } },
  sit: { head: { x: 8, y: 27 }, torso: { x: 8, y: 42 } },
};

/** An overlay stamped relative to the head or torso origin (drawn facing SE). */
interface Overlay {
  on: "head" | "torso";
  /** Only stamp on the open-eye (false) or blink (true) frame. */
  blink?: boolean;
  x: number;
  y: number;
  rows: readonly string[];
  poses?: readonly Pose[];
}

export interface AvatarDef {
  id: string;
  label: string;
  blurb: string;
  /** Main swatch for nickname tags / the picker. */
  swatch: RampName;
  roles: RoleMap;
  overlays: readonly Overlay[];
}

const face = (skin: RampName): RoleMap => ({
  S: { ramp: skin, group: "S" },
  E: { ramp: "outline", tone: 1, group: "S" },
  M: { ramp: skin, tone: 2, group: "S" },
  C: { ramp: "blush", tone: 1, group: "S" },
  k: { ramp: skin, tone: 2, group: "S" },
});

const JUNO: AvatarDef = {
  id: "juno",
  label: "Juno",
  blurb: "Cloud-puff hair, mustard hoodie, headphones round the neck.",
  swatch: "mustard",
  roles: {
    ...face("skinDeep"),
    T: { ramp: "mustard", hi: true },
    B: { ramp: "charcoal" },
    L: { ramp: "charcoal" },
    F: { ramp: "cream" },
    H: { ramp: "hairDark", hi: true },
    A: { ramp: "cream", hi: true },
    d: { ramp: "cream", tone: 2 },
  },
  overlays: [
    {
      on: "head",
      x: -2,
      y: -6,
      rows: [
        "......HHHHHHH.......",
        "....HHHHHHHHHHH.....",
        "..HHHHHHHHHHHHHHH...",
        ".HHHHHHHHHHHHHHHHHH.",
        ".HHHHHHHHHHHHHHHHHH.",
        "HHHHHHHHHHHHHHHHHHHH",
        "HHHHHHHHHHHHHHHHHHHH",
        "HHHHHHHHHHHHHHHHHHHH",
        "HHHHHHHHHHHHHHHHHHHH",
        "HHHHHHHHHHHHHHHHHHHH",
        "HHHHHHHHHHH.HHHHHHH.",
        "HHHHHHH.........HHH.",
        "HHHHHH...........HH.",
        ".HHHHH...........H..",
        ".HHHH...............",
        "..HHH...............",
        "...H................",
      ],
    },
    // Headphones resting round the neck + hoodie drawstrings.
    {
      on: "torso",
      x: 0,
      y: 0,
      rows: ["..AAA......AAA..", "..AAAAAAAAAAAA..", "...AA......AA...", ".......d.d......", ".......d.d......"],
    },
  ],
};

const PIP: AvatarDef = {
  id: "pip",
  label: "Pip",
  blurb: "Slouchy cream beanie with a pom-pom, round glasses, striped teal jumper.",
  swatch: "teal",
  roles: {
    ...face("skinLight"),
    T: { ramp: "teal", hi: true, group: "T" },
    t: { ramp: "cream", tone: 1, group: "T" },
    B: { ramp: "navy" },
    L: { ramp: "navy" },
    F: { ramp: "rust" },
    H: { ramp: "ginger", hi: true },
    A: { ramp: "cream", hi: true },
    b: { ramp: "teal" },
    P: { ramp: "teal", hi: true },
    G: { ramp: "charcoal", tone: 2 },
    g: { ramp: "glow", tone: 0 },
  },
  overlays: [
    {
      on: "head",
      x: -1,
      y: -9,
      rows: [
        "..........PPP.....",
        ".........PPPPP....",
        ".........PPPPP....",
        "..........PPP.....",
        "......AAAAAAA.....",
        "....AAAAAAAAAAA...",
        "...AAAAAAAAAAAAA..",
        "..AAAAAAAAAAAAAAA.",
        ".AAAAAAAAAAAAAAAA.",
        ".AAAAAAAAAAAAAAAA.",
        "bbbbbbbbbbbbbbbbbb",
        "bbbbbbbbbbbbbbbbbb",
        ".HHHHHHHHHHHHHHHH.",
        ".HHHHHH.HHH.H.HH..",
        ".HHHH.............",
        ".HHH..............",
        "..HH..............",
      ],
    },
    // Round glasses.
    {
      on: "head",
      x: 0,
      y: 7,
      rows: ["........GGG.GGG.", "........GgGGGgG.", "........G.G.G.G.", "........GGG.GGG."],
    },
    // Eyes closed behind the lenses.
    { on: "head", x: 0, y: 9, rows: [".........g...g.."], blink: true },
    // Jumper stripes.
    { on: "torso", x: 0, y: 3, rows: [".tttttttttttttt.", "................", "................", ".tt.tttttttt.tt."] },
  ],
};

const MO: AvatarDef = {
  id: "mo",
  label: "Mo",
  blurb: "Broad shoulders, olive bucket hat, full beard, rust bomber jacket.",
  swatch: "rust",
  roles: {
    ...face("skinMedium"),
    C: { ramp: "skinMedium", group: "S" },
    T: { ramp: "rust", hi: true },
    B: { ramp: "navy" },
    L: { ramp: "navy" },
    F: { ramp: "charcoal" },
    H: { ramp: "hairDark", hi: true, group: "H" },
    A: { ramp: "olive", hi: true },
    a: { ramp: "cream", tone: 2 },
    z: { ramp: "cream" },
  },
  overlays: [
    // Short back hair joined to sideburns and a full beard.
    {
      on: "head",
      x: 0,
      y: 2,
      rows: [
        "HHHHH...........",
        "HHHHH...........",
        "HHHH............",
        "HHHH............",
        ".HHH............",
        ".HHH............",
        "..HH............",
        "..HHH...........",
        "..HHHH........H.",
        "...HHHHH.HHMHHH.",
        "...HHHHHHHHHHHH.",
        "....HHHHHHHHHH..",
        ".....HHHHHHHH...",
      ],
    },
    // Bucket hat, pulled low.
    {
      on: "head",
      x: -3,
      y: -4,
      rows: [
        "........AAAAAAAA......",
        "......AAAAAAAAAAAA....",
        ".....AAAAAAAAAAAAAA...",
        ".....AAAAAAAAAAAAAA...",
        ".....aaaaaaaaaaaaaa...",
        "..AAAAAAAAAAAAAAAAAAA.",
        "AAAAAAAAAAAAAAAAAAAAAA",
        ".AAAAAAAAAAAAAAAAAAAA.",
      ],
    },
    // Broad shoulders + collar + zip.
    {
      on: "torso",
      x: -1,
      y: 0,
      rows: ["....zzzzzzzzzz....", "..TTTTTTTTTTTTTT..", "TTTTTTTTTTTTTTTTTT", "TTTTTTTTTTTTTTTTTT", "TTT.....z......TTT", "TTT.....z......TTT", ".TT............TT."],
    },
  ],
};

const KIKI: AvatarDef = {
  id: "kiki",
  label: "Kiki",
  blurb: "Pink twin buns, lilac pinafore, never without a bucket of popcorn.",
  swatch: "lilac",
  roles: {
    ...face("skinTan"),
    T: { ramp: "lilac", hi: true, group: "T" },
    B: { ramp: "lilac", group: "T" },
    L: { ramp: "charcoal" },
    F: { ramp: "pink" },
    H: { ramp: "pink", hi: true, group: "H" },
    A: { ramp: "cream", tone: 1 },
    P: { ramp: "cream", tone: 1, group: "P" },
    R: { ramp: "pink", tone: 2, group: "P" },
    Y: { ramp: "mustard", hi: true },
    h: { ramp: "skinTan", group: "S" },
  },
  overlays: [
    {
      on: "head",
      x: -4,
      y: -6,
      rows: [
        "..HHHH............HHHH..",
        ".HHHHHH..........HHHHHH.",
        "HHHHHHHH........HHHHHHHH",
        "HHHHHHHH.HHHHHH.HHHHHHHH",
        ".HHHHHHHHHHHHHHHHHHHHHH.",
        "..AAAAHHHHHHHHHHHHAAAA..",
        "...HHHHHHHHHHHHHHHHHHH..",
        "...HHHHHHHHHHHHHHHHHHH..",
        "...HHHHHHHHHHHHHHHHHHH..",
        "...HHHHHHHHHHHHHHHHHHH..",
        "...HHHHHHH.HHHH.HHHHHH..",
        "...HHHHHH.........HHH...",
        "...HHHHH..........HH....",
        "...HHHH...........HH....",
        "...HHHH.................",
        "....HH..................",
      ],
    },
    // Skirt flare (idle only; seated uses the lap).
    { on: "torso", x: 0, y: 8, rows: ["................", "...BBBBBBBBBB...", "..BBBBBBBBBBBB.."], poses: ["idle"] },
    // Popcorn bucket held at the hip / on the lap.
    {
      on: "torso",
      x: 8,
      y: 4,
      rows: [".YYYYY.", "YYYYYYY", "PRPRPRP", "hRPRPRh", ".RPRPR.", ".RPRPR."],
      poses: ["idle"],
    },
    {
      on: "torso",
      x: 6,
      y: 3,
      rows: [".YYYYY.", "YYYYYYY", "PRPRPRP", "hRPRPRh", ".RPRPR.", ".RPRPR."],
      poses: ["sit"],
    },
  ],
};

export const AVATARS: readonly AvatarDef[] = [JUNO, PIP, MO, KIKI];

/** Compose one frame as a role grid (before shading/outline). */
export function composeFrame(a: AvatarDef, pose: Pose, dir: Dir, blink: boolean): Grid {
  const g = blank(CELL.w, CELL.h);
  const o = ORIGINS[pose];
  stamp(g, pose === "idle" ? TORSO : TORSO.slice(0, 7), o.torso.x, o.torso.y);
  if (pose === "idle") stamp(g, LEGS, o.torso.x, o.torso.y + TORSO.length);
  else stamp(g, SIT_LOWER, 0, o.torso.y + 7);
  stamp(g, HEAD, o.head.x, o.head.y);
  if (blink) stamp(g, BLINK, o.head.x, o.head.y + 8);
  for (const ov of a.overlays) {
    if (ov.poses && !ov.poses.includes(pose)) continue;
    if (ov.blink !== undefined && ov.blink !== blink) continue;
    const base = ov.on === "head" ? o.head : o.torso;
    stamp(g, ov.rows, base.x + ov.x, base.y + ov.y);
  }
  return dir === "se" ? g : mirror(g);
}
