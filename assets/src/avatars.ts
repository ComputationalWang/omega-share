// The 4 omega-share avatars. Front templates are drawn facing SE and back templates facing NE;
// SW and NW are their mirrors (shading runs after mirroring, so light stays top-left).
import { blank, mirror, stamp, type Grid, type RoleMap, type RoleSpec } from "./sprite";
import type { RampName } from "./palette";

export const CELL = { w: 32, h: 64 } as const;
/** Floor point inside a cell: feet for idle, the floor under the hips for sit. */
export const FLOOR = { x: 16, y: 61 } as const;
/** Seat surface height above the floor point, in 1× pixels. Seats in set (b) match this. */
export const SEAT_HEIGHT = 8;

export type Pose = "idle" | "sit";
export type Dir = "se" | "sw" | "ne" | "nw";
/** Front-facing dirs (face visible, blink frame differs) and back-facing dirs. */
export const FRONT_DIRS: readonly Dir[] = ["se", "sw"];
export const BACK_DIRS: readonly Dir[] = ["ne", "nw"];
type View = "front" | "back";

// Role letters used by the body templates:
// S skin, W eye white, E pupil/lid, M mouth, C cheek, k ear, T top, r far arm, B hips/lap,
// L legs, l far leg, F shoes, f far shoe. Far limbs take the shade tone, so the 3/4 turn reads at 1×.
const HEAD = [
  "....SSSSSSSS....",
  "..SSSSSSSSSSSS..",
  ".SSSSSSSSSSSSSS.",
  ".SSSSSSSSSSSSSS.",
  "SSSSSSSSSSSSSSSS",
  "SSSSSSSSSSSSSSSS",
  "SSSSSSSSSSSSSSSS",
  "SSSSSSSSSSSSSSSS",
  "SSSSkkSSSWESSWES",
  "SSSSkkSSSWESSWES",
  "SSSSSSSSCSSSSSCS",
  ".SSSSSSSSSSMMSS.",
  "..SSSSSSSSSSSSS.",
  "...SSSSSSSSSSSS.",
  ".....SSSSSSSS...",
];
/** Rows 8–9 of HEAD when blinking: whites vanish, a dark lid line drops to row 9. */
const BLINK = [".........SS..SS.", ".........EE..EE."];
/** Back of the head (facing NE): ear on the near (right) side, nape skin below the hair. */
const HEAD_BACK = HEAD.map((row, y) => (y === 8 || y === 9 ? "SSSSSSSSSSSkkSSS" : row.replace(/[WEMC]/g, "S")));

const TORSO = [
  "....TTTTTTTT....",
  "..TTTTTTTTTTTT..",
  ".TTTTTTTTTTTTTr.",
  ".TTTTTTTTTTTTrr.",
  ".TT.TTTTTTTT.rr.",
  ".TT.TTTTTTTT.rr.",
  ".TT.TTTTTTTT.rr.",
  ".TT.TTTTTTTT.rr.",
  ".SS.BBBBBBBB.SS.",
  "....BBBBBBBB....",
  "....BBBBBBBB....",
];
/** From behind (facing NE) the far arm is on the left. */
const TORSO_BACK = [
  "....TTTTTTTT....",
  "..TTTTTTTTTTTT..",
  ".rTTTTTTTTTTTTT.",
  ".rrTTTTTTTTTTTT.",
  ".rr.TTTTTTTT.TT.",
  ".rr.TTTTTTTT.TT.",
  ".rr.TTTTTTTT.TT.",
  ".rr.TTTTTTTT.TT.",
  ".SS.BBBBBBBB.SS.",
  "....BBBBBBBB....",
  "....BBBBBBBB....",
];
const LEGS = [
  "....LLL..lll....",
  "....LLL..lll....",
  "....LLL..lll....",
  "....LLL..lll....",
  "....LLL..lll....",
  "....LLL..lll....",
  "....LLL..lll....",
  "....LLL..ffff...",
  "....FFFF.fffff..",
  "....FFFFF.......",
];
/** Standing, seen from behind: heels toward the camera, far (left) leg a step back. */
const LEGS_BACK = [
  "....lll..LLL....",
  "....lll..LLL....",
  "....lll..LLL....",
  "....lll..LLL....",
  "....lll..LLL....",
  "....lll..LLL....",
  "....lll..LLL....",
  "....fff..LLL....",
  "....fff..FFF....",
  ".........FFF....",
];

interface Origins {
  head: { x: number; y: number };
  torso: { x: number; y: number };
}
const ORIGINS: Record<Pose, Origins> = {
  idle: { head: { x: 8, y: 25 }, torso: { x: 8, y: 40 } },
  sit: { head: { x: 8, y: 27 }, torso: { x: 8, y: 42 } },
};

/** Seated lower body facing SE: a true 3/4 lap with thighs running down the SE (2:1) axis,
 *  the far leg (upper right, shaded) behind the near one, and the feet dangling off the seat. */
function sitLowerSE(g: Grid): void {
  const put = (x: number, y: number, ch: string): void => {
    const row = g[y];
    if (row && x >= 0 && x < row.length) row[x] = ch;
  };
  const rect = (x0: number, y0: number, x1: number, y1: number, ch: string): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, ch);
  };
  // Torso bottom and hands resting at the hips.
  stamp(g, [".TT.TTTTTTTT.rr.", ".SS.BBBBBBBB.SS."], 8, 49);
  rect(12, 51, 19, 52, "B");
  // Far thigh: from the hip (19,50) forward along (+2,+1), 3 px thick; then shin + shoe.
  for (let t = 0; t <= 8; t++) rect(18 + t, 50 + (t >> 1), 18 + t, 52 + (t >> 1), "l");
  rect(24, 55, 26, 58, "l");
  rect(24, 58, 28, 59, "f");
  // Near thigh, lower-left of the far one and drawn over it.
  for (let t = 0; t <= 8; t++) rect(12 + t, 52 + (t >> 1), 12 + t, 54 + (t >> 1), "L");
  rect(18, 57, 20, 59, "L");
  rect(18, 60, 22, 61, "F");
}

/** An overlay stamped relative to the head or torso origin (drawn facing SE or NE). */
interface Overlay {
  on: "head" | "torso";
  /** Only stamp on the open-eye (false) or blink (true) frame. */
  blink?: boolean;
  x: number;
  y: number;
  rows: readonly string[];
  poses?: readonly Pose[];
  /** Front (SE template) or back (NE template); default front. */
  view?: View;
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
  W: { ramp: "cream", tone: 0, group: "S" },
  E: { ramp: "outline", tone: 1, group: "S" },
  M: { ramp: skin, tone: 2, group: "S" },
  C: { ramp: "blush", tone: 1, group: "S" },
  k: { ramp: skin, tone: 2, group: "S" },
});

/** Far limbs: the same ramp as the near limb, fixed to its shade tone. */
function withFarLimbs(roles: RoleMap): RoleMap {
  const far = (src: string, group: string): RoleSpec => {
    const s = roles[src];
    if (!s) throw new Error(`missing role ${src}`);
    return { ramp: s.ramp, tone: 2, group };
  };
  return { ...roles, r: far("T", "r"), l: far("L", "l"), f: far("F", "f") };
}

const JUNO: AvatarDef = {
  id: "juno",
  label: "Juno",
  blurb: "Cloud-puff hair, mustard hoodie, headphones round the neck.",
  swatch: "mustard",
  roles: {
    ...face("skinDeep"),
    T: { ramp: "mustard", hi: true },
    o: { ramp: "mustard", tone: 2, group: "T" },
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
        ".HHHH............H..",
        ".HHH................",
        "..HH................",
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
    // Back: the whole puff, headphone band and the hood lying on the shoulders.
    {
      on: "head",
      view: "back",
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
        "HHHHHHHHHHHHHHHHHHHH",
        "HHHHHHHHHHHHHHHHHHHH",
        "HHHHHHHHHHHHHHHHHHHH",
        ".HHHHHHHHHHHHHHHHHH.",
        ".HHHHHHHHHHHHHHHHHH.",
        "..HHHHHHHHHHHHHHHH..",
        "...HHHHHHHHHHHHHH...",
        ".....HHHHHHHHHH.....",
      ],
    },
    {
      on: "torso",
      view: "back",
      x: 0,
      y: 0,
      rows: ["..AAA......AAA..", "..AoooooooooA...", "...oTTTTTTTTo...", "....oTTTTTTo....", ".....oooooo....."],
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
    G: { ramp: "rust", tone: 2 },
  },
  overlays: [
    ...(["front", "back"] as const).map(
      (view): Overlay => ({
        on: "head",
        view,
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
          ...(view === "front"
            ? [".HHHHHHHHHHHHHHHH.", ".HHHHHH.HHH.H.HH..", ".HHHH.............", ".HHH..............", "..HH.............."]
            : [
                ".HHHHHHHHHHHHHHHH.",
                ".HHHHHHHHHHHHHHHH.",
                ".HHHHHHHHHHHHHHHH.",
                ".HHHHHHHHHHHHHHHH.",
                ".HHHHHHHHHHHHHHHH.",
                ".HHHHHHHHHHH..HHH.",
                ".HHHHHHHHHHH..HHH.",
                "..HHHHHHHHHHHHHH..",
                "...HHHHHHHHHHHH...",
              ]),
        ],
      }),
    ),
    // Round glasses framing both eyes (the blink shows through the lenses).
    { on: "head", x: 0, y: 7, rows: ["........GGGGGGGG", "........G..GG..G", "........G..GG..G", "........GGG.GGG."] },
    // Jumper stripes (front and back).
    ...(["front", "back"] as const).map(
      (view): Overlay => ({ on: "torso", view, x: 0, y: 3, rows: [".tttttttttttttt.", "................", "................", ".tt.tttttttt.tt."] }),
    ),
  ],
};

const MO: AvatarDef = {
  id: "mo",
  label: "Mo",
  blurb: "Broad shoulders, olive bucket hat, trimmed beard, rust bomber jacket.",
  swatch: "rust",
  roles: {
    ...face("skinMedium"),
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
    // Short back hair, a sideburn, then a trimmed jaw beard + moustache that leave the cheek,
    // eyes and mouth open (the face must read as a face at 1×).
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
        "..HH............",
        "..HH.......HHHH.",
        "...HH.....H..H..",
        "....HH...HHHHHH.",
        ".....HHHHHHHH...",
      ],
    },
    // Back: short hair under the hat, beard edge peeking at the near jaw.
    {
      on: "head",
      view: "back",
      x: 0,
      y: 4,
      rows: [
        "HHHHHHHHHHHHHHHH",
        "HHHHHHHHHHHHHHHH",
        "HHHHHHHHHHHHHHHH",
        "HHHHHHHHHHHHHHHH",
        "HHHHHHHHHHH..HHH",
        "HHHHHHHHHHH..HHH",
        ".HHHHHHHHHHHHHH.",
        "..HHHHHHHHHH.HH.",
        "............HH..",
      ],
    },
    // Bucket hat, pulled low (front and back).
    ...(["front", "back"] as const).map(
      (view): Overlay => ({
        on: "head",
        view,
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
      }),
    ),
    // Broad shoulders + collar + zip.
    {
      on: "torso",
      x: -1,
      y: 0,
      rows: ["....zzzzzzzzzz....", "..TTTTTTTTTTTTTT..", "TTTTTTTTTTTTTTTTTr", "TTTTTTTTTTTTTTTTrr", "TTT.....z......rrr", "TTT.....z......rrr", ".TT............rr."],
    },
    // Back: shoulders, collar and a little cream star on the bomber.
    {
      on: "torso",
      view: "back",
      x: -1,
      y: 0,
      rows: ["....zzzzzzzzzz....", "..TTTTTTTTTTTTTT..", "rTTTTTTTTTTTTTTTTT", "rrTTTTTTzTTTTTTTTT", "rrr....zzz.....TTT", "rrr.....z......TTT", ".rr............TT."],
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
    x: { ramp: "lilac", tone: 2, group: "T" },
    L: { ramp: "charcoal" },
    F: { ramp: "pink" },
    H: { ramp: "pink", hi: true, group: "H" },
    q: { ramp: "pink", tone: 2, group: "H" },
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
    // Back: buns + a full bob down to the nape.
    {
      on: "head",
      view: "back",
      x: -4,
      y: -6,
      rows: [
        "..HHHH............HHHH..",
        ".HHHHHH..........HHHHHH.",
        "HHHHHHHH........HHHHHHHH",
        "HHHHHHHH.HHHHHH.HHHHHHHH",
        ".HHHHHHHHHHHHHHHHHHHHHH.",
        "..AAAAHHHHHqHHHHHHAAAA..",
        "...HHHHHHHHqHHHHHHHHHH..",
        "...HHHHHHHHqHHHHHHHHHH..",
        "...HHHqHHHHHqHHHHHqHHH..",
        "...HHHqHHHHHqHHHHHqHHH..",
        "...HHHHqHHHHHqHHHHqHHH..",
        "...HHHHqHHHHHqHHHHHqHH..",
        "...HHHHqHHHHHqHHHHHqHH..",
        "...HHHHHqHHHHqHHHHHqHH..",
        "...HHHHHqHHHHHqHHHHqHH..",
        "...HHHHHHHHHHHqHHHHHHH..",
        "....HHHHHHHHHHHHHHHHH...",
        ".....HHHHHHHHHHHHHHH....",
      ],
    },
    // Pinafore straps crossing on the back.
    { on: "torso", view: "back", x: 0, y: 1, rows: ["....x......x....", ".....x....x.....", "......x..x......", ".......xx.......", ".......xx......."] },
    // Skirt flare (idle only; seated uses the lap).
    ...(["front", "back"] as const).map(
      (view): Overlay => ({ on: "torso", view, x: 0, y: 8, rows: ["................", "...BBBBBBBBBB...", "..BBBBBBBBBBBB.."], poses: ["idle"] }),
    ),
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
    // From behind, the bucket still peeks out at the near hip.
    { on: "torso", view: "back", x: 13, y: 3, rows: [".YYY", "YYYY", "PRPR", "RPRh", "PRP."] },
  ],
};

export const AVATARS: readonly AvatarDef[] = [JUNO, PIP, MO, KIKI].map((a) => ({ ...a, roles: withFarLimbs(a.roles) }));

/** Compose one frame as a role grid (before shading/outline). */
export function composeFrame(a: AvatarDef, pose: Pose, dir: Dir, blink: boolean): Grid {
  const view: View = dir === "se" || dir === "sw" ? "front" : "back";
  const g = blank(CELL.w, CELL.h);
  const o = ORIGINS[pose];
  const torso = view === "front" ? TORSO : TORSO_BACK;
  if (pose === "idle") {
    stamp(g, torso, o.torso.x, o.torso.y);
    stamp(g, view === "front" ? LEGS : LEGS_BACK, o.torso.x, o.torso.y + TORSO.length);
  } else if (view === "front") {
    stamp(g, torso.slice(0, 7), o.torso.x, o.torso.y);
    sitLowerSE(g);
  } else {
    // From behind the legs point away and are hidden by the body; hips rest on the seat.
    stamp(g, [...torso.slice(0, 8), ".SS.BBBBBBBB.SS.", "....BBBBBBBB...."], o.torso.x, o.torso.y);
  }
  stamp(g, view === "front" ? HEAD : HEAD_BACK, o.head.x, o.head.y);
  if (blink && view === "front") stamp(g, BLINK, o.head.x, o.head.y + 8);
  for (const ov of a.overlays) {
    if ((ov.view ?? "front") !== view) continue;
    if (ov.poses && !ov.poses.includes(pose)) continue;
    if (ov.blink !== undefined && ov.blink !== blink) continue;
    const base = ov.on === "head" ? o.head : o.torso;
    stamp(g, ov.rows, base.x + ov.x, base.y + ov.y);
  }
  return dir === "se" || dir === "ne" ? g : mirror(g);
}
