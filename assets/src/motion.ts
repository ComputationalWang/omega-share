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
  // 0 contact: near leg forward and planted, far leg trailing with the heel up.
  [
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..lll....",
    ".....LLL.lll....",
    ".....LLL.fff....",
    ".....LLL.ffff...",
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
  // 2 contact: far leg forward and planted, near leg trailing with the heel up.
  [
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..lll....",
    "....LLL..lll....",
    "...LLL....lll...",
    "...LLL....lll...",
    "...LLL....lll...",
    "..FFFF....lll...",
    "..FFFFF...ffff..",
    "..........fffff.",
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
  // 0 contact: near (right) leg forward, so its heel lands higher; far leg trailing toward the camera.
  [
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..LLL....",
    "...lll....LLL...",
    "...lll....LLL...",
    "...lll....LLL...",
    "...lll....FFF...",
    "...fff....FFF...",
    "...fff..........",
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
  // 2 contact: far (left) leg forward and high, near leg trailing with its heel toward the camera.
  [
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..LLL....",
    "....lll..LLL....",
    ".....lll.LLL....",
    ".....lll.LLL....",
    ".....fff.LLL....",
    ".....fff.LLL....",
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

/** The arm on the template's left (near arm facing SE, far arm facing NE). It's never the arm holding
 *  Kiki's popcorn, so every avatar can swing and wave it. Role letter per view: near arm T, far arm r. */
const armRole = (view: View): string => (view === "front" ? "T" : "r");

/** Arm swing, opposite to the legs: the hand rises 1 px when the arm swings forward (foreshortened)
 *  and drops back 1 px out from the body when it swings back. */
function armSwing(view: View, n: number): Stamp[] {
  const a = armRole(view);
  // Which way the arm swings on each contact frame depends on which leg is forward.
  const forward = view === "front" ? n === 2 : n === 0;
  if (n === 1 || n === 3) return [];
  if (forward) return [{ x: 1, y: 7, rows: ["SS", "__"] }];
  return [{ x: 0, y: 6, rows: [`${a}${a}_`, `${a}${a}_`, "SS_"] }];
}

export function walkMotion(view: View, n: number): Motion {
  const legs = (view === "front" ? WALK_FRONT : WALK_BACK)[n];
  if (!legs) throw new Error(`no walk frame ${String(n)}`);
  return { legs, lift: n % 2 === 1 ? 1 : 0, after: armSwing(view, n) };
}
export const WALK_FRAMES = WALK_FRONT.length;

/** Breathing out: the head settles 1 px onto the collar. Frame 0 is the set (a) pose itself. */
export const BREATHE: Motion = { headDrop: 1 };
/** Breathe loop: [in (set a /0), out]. Long and slow so a room full of sitters doesn't twitch. */
export const BREATHE_MS: readonly [number, number] = [1400, 1000];

/** Erase the hanging arm (Mo's wider sleeve too), then raise it: upper arm out from the shoulder, elbow bent,
 *  forearm up beside the head (never over it), open hand rocking out and in. */
function raisedArm(view: View, n: number): Stamp[] {
  const a = armRole(view);
  const hand = n === 0 ? ["SS.....", "SSS....", "SSSS...", ".SSS..."] : ["..SS...", ".SSS...", "SSSS...", ".SSS..."];
  const arm = [".AA.....", ".AA.....", ".AA.....", ".AA.....", ".AA.....", ".AAA....", ".AAAAAA.", "..AAAAAA"].map((r) => r.replace(/A/g, a));
  return [
    { x: -1, y: 4, rows: ["____", "____", "____", "____", "____"] },
    { x: -6, y: -10, rows: hand },
    { x: -6, y: -6, rows: arm },
  ];
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
  roles: { H: { ramp: "pink", hi: true, group: "H" }, w: { ramp: "cream", tone: 0, group: "H" } },
  pop: [".HH.HH.", "HwHHHHH", "HHHHHHH", ".HHHHH.", "..HHH..", "...H..."],
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
    Y: { ramp: "mustard", hi: true, group: "Y" },
    E: { ramp: "outline", tone: 1, group: "Y" },
    p: { ramp: "pink", tone: 1, group: "Y" },
    t: { ramp: "glow", tone: 1, group: "Y" },
  },
  pop: [".YYYYY.", "YEYYYEY", "YYYYYYY", "YEEEEEY", "YYEpEYY", ".YYYYY."],
  art: [
    "...YYYYY...",
    ".YYYYYYYYY.",
    ".YYYYYYYYY.",
    "YYEYYYYYEYY",
    "YEYEYYYEYEY",
    "YYYYYYYYYYY",
    "YYEEEEEEEYY",
    "YYEEEEEEEYY",
    ".YYEpppEYY.",
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
    ".YYEEEEEEEYY",
    ".YYYEpppEYY.",
    "...YYYYYYY..",
  ],
};

const QUESTION: EmoteDef = {
  id: "question",
  label: "Question",
  roles: { Q: { ramp: "teal", hi: true } },
  pop: [".QQQ.", "QQ.QQ", "...QQ", "..QQ.", ".....", "..QQ."],
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
  roles: { X: { ramp: "rust", hi: true } },
  pop: ["XX", "XX", "XX", "..", "XX"],
  art: [".XX.", "XXXX", "XXXX", "XXXX", ".XX.", ".XX.", ".XX.", "....", ".XX.", ".XX."],
  // A jolt: taller, with two shock lines.
  accent: [
    "..X....XX....X..",
    "...X..XXXX..X...",
    "......XXXX......",
    "......XXXX......",
    "......XXXX......",
    ".......XX.......",
    ".......XX.......",
    ".......XX.......",
    "................",
    ".......XX.......",
    ".......XX.......",
  ].map((r) => r.slice(2, 14)),
};

const CLAP: EmoteDef = {
  id: "clap",
  label: "Clap",
  roles: { h: { ramp: "cream", hi: true }, c: { ramp: "mustard", tone: 1 }, y: { ramp: "mustard", tone: 0 } },
  pop: ["hh..hh", ".hhhh.", ".c..c."],
  // Palms open in a V.
  art: [
    "hh........hh",
    "hhh......hhh",
    "hhhh....hhhh",
    ".hhhh..hhhh.",
    "..hhh..hhh..",
    "..hhh..hhh..",
    "...cc..cc...",
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
