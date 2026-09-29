// Set (d): avatar motion. Walk cycles, breathing, the wave gesture and the emote icons.
// Everything reuses the set (a) role templates through `composeMotion`, so shading, the plum outline,
// mirroring (SW/NW) and the per-avatar overlays come for free and stay on the shared palette.
import type { Motion, Stamp, View } from "./avatars";
import type { RoleMap } from "./sprite";

/** Walk: 4 frames, contact → passing → contact → passing. The body rises 1 px on the passing frames.
 *  The supporting foot's sole is always on the floor line (y 60), so feet never float or sink. */
export const WALK_FRAME_MS = 150;
/** One cycle (two steps) covers one tile: the sprite moves (±32, ±16) px per 600 ms, i.e. (8, 4) per frame, on the 2:1 axis. */
export const WALK_TILES_PER_CYCLE = 1;

// Legs are 16 wide, stamped at the torso x. Front = facing SE: toes point right, and a foot lower on
// screen is closer to the camera, so the forward (SE) foot is the lower one. Back = facing NE: the forward foot is the higher one.
const WALK_FRONT: readonly (readonly string[])[] = [
// 0 contact (depth): near leg forward and planted, far leg kicked up behind it (sole 4 px off the floor).
  [
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL...lll...",
    ".....LLL..ffff..",
    ".....LLL..fffff.",
    ".....LLL........",
    ".....LLL........",
    ".....FFFF.......",
    ".....FFFFF......",
  ],
  // 1 passing (lift 1): near leg straight under the body, far foot swinging through.
  [
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..ffff...",
    "....LLL..fffff..",
    "....LLL.........",
    "....FFFF........",
    "....FFFFF.......",
  ],
// 2 contact (open V): far foot forward and planted, near foot trailing 3 px out with the heel up.
  [
    "....LLL..lll....",
    "....LLL..lll....",
    "...LLL....lll...",
    "...LLL....lll...",
    "..LLL......lll..",
    ".LLL.......lll..",
    "FFFF.......lll..",
    "FFF........lll..",
    "...........ffff.",
    "...........fffff",
  ],
  // 3 passing (lift 1): far leg straight, near foot swinging through.
  [
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..lll....",
    "....FFFF.lll....",
    "....FFFF.lll....",
    ".........lll....",
    ".........ffff...",
    ".........fffff..",
  ],
];

const WALK_BACK: readonly (readonly string[])[] = [
// 0 contact (open V): near (right) foot forward, landing high; far foot trailing out toward the camera.
  [
    "....lll..LLL....",
    "....lll..LLL....",
    "...lll....LLL...",
    "...lll....LLL...",
    "..lll......LLL..",
    "..lll......LLL..",
    ".lll.......FFF..",
    ".lll.......FFF..",
    ".fff............",
    ".fff............",
  ],
  // 1 passing (lift 1): near leg straight, far foot lifted through.
  [
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..LLL....",
    "....fff..LLL....",
    "....fff..LLL....",
    ".........LLL....",
    ".........FFF....",
    ".........FFF....",
  ],
// 2 contact (depth): far (left) leg kicked up and away (sole 4 px off the floor), near leg planted.
  [
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..LLL....",
    ".....lll.LLL....",
    ".....fff.LLL....",
    ".....fff.LLL....",
    ".........LLL....",
    ".........LLL....",
    ".........FFF....",
    ".........FFF....",
  ],
  // 3 passing (lift 1): far leg straight, near foot lifted through.
  [
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..FFF....",
    "....lll..FFF....",
    "....lll.........",
    "....fff.........",
    "....fff.........",
  ],
];

/** Arm role letters by template side: facing SE the left arm is the near one (T), facing NE it's the far one (r). */
const armRoles = (view: View): { left: string; right: string } => (view === "front" ? { left: "T", right: "r" } : { left: "r", right: "T" });

/** Arm swing against the legs. The arm swinging toward the camera extends 2 rows (hand lower); the one swinging away
 *  foreshortens 2 rows (hand tucked up), so the hands sit 4 px apart and the swing still reads at 1× in ne/nw. On contact 0 the left arm tucks and the right extends,
 *  on contact 2 the reverse (the same rule in both views, because "toward the camera" flips with the view). */
function armSwing(view: View, n: number, holds: boolean): Stamp[] {
  if (n === 1 || n === 3) return [];
  const r = armRoles(view);
  const tuck = (x: number, e: number): Stamp[] => [{ x: e, y: 7, rows: ["____", "____"] }, { x, y: 6, rows: ["SS"] }];
  const extend = (x: number, arm: string): Stamp[] => [{ x, y: 8, rows: [arm + arm, arm + arm, "SS"] }];
  const leftTucks = n === 0;
  const out: Stamp[] = leftTucks ? tuck(1, -1) : extend(1, r.left);
  // Kiki's right hand holds the popcorn bucket, so that arm stays put.
  if (!holds) out.push(...(leftTucks ? extend(13, r.right) : tuck(13, 13)));
  return out;
}

export function walkMotion(view: View, n: number, holds = false): Motion {
  const legs = (view === "front" ? WALK_FRONT : WALK_BACK)[n];
  if (!legs) throw new Error(`no walk frame ${String(n)}`);
  return { legs, lift: n % 2 === 1 ? 1 : 0, after: armSwing(view, n, holds) };
}
export const WALK_FRAMES = WALK_FRONT.length;

/** Breathing out: the head settles 1 px onto the collar. Frame 0 is the set (a) pose itself. */
export const BREATHE: Motion = { headDrop: 1 };
/** Breathe loop: [in (set a /0), out]. Long and slow so a room full of sitters doesn't twitch. */
export const BREATHE_MS: readonly [number, number] = [1400, 1000];

/** One-arm wave with the template-left arm (never Kiki's popcorn hand); the other arm stays at rest. The upper arm goes out
 *  from the shoulder and the forearm swings between upright (hand high beside the head) and 45° out (hand at cheek height):
 *  the hand moves 5 px between frames, so the wave reads at 1×. */
function raisedArm(view: View, n: number): Stamp[] {
  const a = armRoles(view).left;
  const up = ["SS......", "SSS.....", "SSSS....", ".SSS....", ".AA.....", ".AA.....", ".AA.....", ".AA.....", ".AA.....", ".AAA....", ".AAAA...", "..AAAAA.", "...AAAAA"];
  const out = ["SS......", "SSS.....", "SSS.....", ".AA.....", ".AAA....", "..AAA...", "..AAAAA.", "...AAAAA"];
  const rows = (n === 0 ? up : out).map((r) => r.replace(/A/g, a));
  return [{ x: -1, y: 4, rows: ["____", "____", "____", "____", "____"] }, { x: -6, y: 1 - rows.length, rows }];
}
export function waveMotion(view: View, n: number): Motion {
  return { after: raisedArm(view, n) };
}
export const WAVE_FRAMES = 2;
/** One-shot wave: the hand rocks three times, then the base pose returns. */
export const WAVE_SEQUENCE: readonly number[] = [0, 1, 0, 1, 0, 1];
export const WAVE_MS = 160;

// ---- Emote icons ------------------------------------------------------------------------------------------
// 16×16 cells, drawn like the UI icons (auto-shade + plum outline). They float above the name tag.

export const EMOTE_CELL = { w: 16, h: 16 } as const;

export interface EmoteDef {
  id: string;
  label: string;
  roles: RoleMap;
  /** Frame 0: a small pop-in. */
  pop: readonly string[];
  /** Frame 1: the settled icon. */
  art: readonly string[];
  /** Frame 2: the pulse (a beat, a squeeze, a tilt, a jolt). */
  accent: readonly string[];
}

const HEART: EmoteDef = {
  id: "heart",
  label: "Heart",
  roles: { H: { ramp: "pink", group: "H" }, w: { ramp: "pink", tone: 0, group: "H" } },
  pop: [".HH...HH.", "HHHH.HHHH", "HwHHHHHHH", "HHHHHHHHH", ".HHHHHHH.", "..HHHHH..", "...HHH...", "....H...."],
  art: [
    ".HHH...HHH.",
    "HHHHH.HHHHH",
    "HwwHHHHHHHH",
    "HwHHHHHHHHH",
    "HHHHHHHHHHH",
    ".HHHHHHHHH.",
    "..HHHHHHH..",
    "...HHHHH...",
    "....HHH....",
    ".....H.....",
  ],
  // A beat: one size up.
  accent: [
    ".HHHH..HHHH.",
    "HHHHHHHHHHHH",
    "HwwHHHHHHHHH",
    "HwHHHHHHHHHH",
    "HHHHHHHHHHHH",
    "HHHHHHHHHHHH",
    ".HHHHHHHHHH.",
    "..HHHHHHHH..",
    "...HHHHHH...",
    "....HHHH....",
    ".....HH.....",
  ],
};

const LAUGH: EmoteDef = {
  id: "laugh",
  label: "Laugh",
  roles: {
    Y: { ramp: "mustard", group: "Y" },
    E: { ramp: "outline", tone: 1, group: "Y" },
    // The open mouth is the face's own edge shade, so eyes + mouth stay 2 tones (plum, dark mustard).
    d: { ramp: "mustard", tone: 2, group: "Y" },
    t: { ramp: "glow", tone: 1, group: "Y" },
  },
  pop: ["..YYYYY..", ".YYYYYYY.", "YYEYYYEYY", "YEYEYEYEY", "YYYYYYYYY", "YYEEEEEYY", ".YYEdEYY.", "..YYYYY.."],
  art: [
    "...YYYYY...",
    ".YYYYYYYYY.",
    ".YYYYYYYYY.",
    "YYEYYYYYEYY",
    "YEYEYYYEYEY",
    "YYYYYYYYYYY",
    "YYEEEEEEEYY",
    "YYEdddddEYY",
    ".YYEdddEYY.",
    ".YYYEEEYYY.",
    "...YYYYY...",
  ],
  // Squeezed with laughter: eyes shut tight, a tear of joy.
  accent: [
    "............",
    "....YYYYY...",
    "..YYYYYYYYY.",
    ".YYYYYYYYYYY",
    ".YEEYYYYYEEY",
    "tYYYYYYYYYYY",
    "tYYEEEEEEEYY",
    ".YYEdddddEYY",
    ".YYYEdddEYY.",
    "...YYEEEYY..",
    "....YYYYY...",
  ],
};

const QUESTION: EmoteDef = {
  id: "question",
  label: "Question",
  roles: { Q: { ramp: "teal" } },
  pop: [".QQQQ.", "QQQ.QQ", "....QQ", "...QQ.", "..QQ..", "......", "..QQ..", "..QQ.."],
  art: [
    "..QQQQ..",
    ".QQQQQQ.",
    "QQQ..QQQ",
    "QQ...QQQ",
    ".....QQQ",
    "....QQQ.",
    "...QQQ..",
    "...QQ...",
    "........",
    "...QQ...",
    "...QQ...",
  ],
  // Head tilt: the hook leans right.
  accent: [
    "...QQQQ.",
    "..QQQQQQ",
    ".QQQ..QQQ",
    ".QQ...QQQ",
    "......QQQ",
    ".....QQQ.",
    "....QQQ..",
    "...QQQ...",
    "........",
    "...QQ....",
    "...QQ....",
  ],
};

const EXCLAIM: EmoteDef = {
  id: "exclaim",
  label: "Surprise",
  roles: { X: { ramp: "rust" } },
  pop: ["XX", "XX", "XX", "XX", "XX", "..", "XX", "XX"],
  art: [".XX.", "XXXX", "XXXX", "XXXX", ".XX.", ".XX.", ".XX.", "....", ".XX.", ".XX."],
  // A jolt: one size up.
  accent: [".XXXX.", "XXXXXX", "XXXXXX", "XXXXXX", ".XXXX.", "..XX..", "..XX..", "..XX..", "......", "..XX..", "..XX.."],
};

const CLAP: EmoteDef = {
  id: "clap",
  label: "Clap",
  roles: { h: { ramp: "cream" }, c: { ramp: "mustard", tone: 1 }, y: { ramp: "mustard", tone: 0 } },
  pop: ["hh.....hh", "hhh...hhh", ".hhh.hhh.", "..hh.hh..", "..cc.cc.."],
  // Palms open in a V, fingers split.
  art: [
    "h.h......h.h",
    "hhhh....hhhh",
    "hhhh....hhhh",
    "hhhhh..hhhhh",
    ".hhhh..hhhh.",
    "..hhh..hhh..",
    "..cc....cc..",
  ],
  // Palms together, with a burst.
  accent: [
    "y....y....y.",
    ".y.......y..",
    "....hh.hh...",
    "...hhh.hhh..",
    "...hhh.hhh..",
    "...hhh.hhh..",
    "....hh.hh...",
    "....cc.cc...",
  ],
};

export const EMOTES: readonly EmoteDef[] = [HEART, LAUGH, QUESTION, EXCLAIM, CLAP];
export const EMOTE_FRAMES = 3;
/** One-shot icon: pop in, settle, pulse twice, pop out. [frame, ms] pairs. */
export const EMOTE_SEQUENCE: readonly (readonly [number, number])[] = [
  [0, 80],
  [1, 160],
  [2, 200],
  [1, 200],
  [2, 200],
  [1, 400],
  [0, 80],
];
