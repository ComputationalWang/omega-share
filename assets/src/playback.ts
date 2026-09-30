// Set (e): synced-playback chrome for M1b. Same palette, plum outline and top-left light as set (c).
// Two materials carry the meaning, so "who does this affect?" reads before any label:
//   shared (everyone)  = the TV's warm wood + brass, like the TV frame itself: it's the room's remote.
//   personal (only you) = dusk-night blue with the mustard "you" rim that `tag/self` already uses.
// The TV's cool `glow` marks what the video itself says: seek progress and chat system lines.
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import { blank, render, stamp, type Grid, type RoleMap } from "./sprite";
import { all, lit, nine, slab, type Borders, type UiFrame } from "./ui";

const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const O = OUTLINE;

type KeyState = "idle" | "hover" | "press";

/** Chunky key with a 2 px lip, like `button/*`. `shared` = wood face; `self` = night face in a mustard rim. */
function key(kind: "shared" | "self", state: KeyState): UiFrame {
  const W = 16, H = 20;
  const face: RampName = kind === "shared" ? "wood" : "night";
  const img = slab(W, H, 2, (d, e) => {
    if (d === 0) return O;
    if (kind === "self" && d === 1) {
      if (state === "press" && e === "t") return O;
      return lit(e) ? c("mustard", state === "hover" ? 0 : 1) : c("mustard", 2);
    }
    if (state === "press") {
      if (d === 1 && e === "t") return O;
      if ((d === 1 && e === "l") || (d === 2 && e === "t")) return c(face, 2);
      return c(face, 1);
    }
    if (e === "b" && d <= 2) return c(face, 2);
    if (d === 1 && e === "r") return c(face, 2);
    if (d === 1 && lit(e)) return state === "hover" ? c("cream", 0) : c(face, 0);
    return state === "hover" ? c(face, 0) : c(face, 1);
  });
  return nine(`button/${kind}/${state}`, W, H, img, { left: 5, top: 5, right: 5, bottom: 5 });
}

/** Sunken groove (shadow top-left, lit lip bottom-right), for the seek/volume tracks and the time readout. */
function well(keyName: string, W: number, H: number, ramp: RampName, borders: Borders): UiFrame {
  const img = slab(W, H, 2, (d, e) => {
    if (d === 0) return O;
    if (d === 1) return lit(e) ? O : c(ramp, 0);
    return c(ramp, 2);
  });
  return nine(keyName, W, H, img, borders);
}

/** Flat progress fill: highlight row, base rows, shade row. Stretches seamlessly (every column is identical). */
function fill(keyName: string, H: number, ramp: RampName): UiFrame {
  const W = 4;
  const img = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img[y * W + x] = c(ramp, y === 0 ? 0 : y === H - 1 ? 2 : 1);
  return nine(keyName, W, H, img, { left: 0, top: 1, right: 0, bottom: 1 });
}

/** Personal pod: plum line, mustard rim (lit top-left), plum line, night fill. */
function selfPanel(): UiFrame {
  const W = 16;
  const img = slab(W, W, 3, (d, e) => {
    if (d === 0 || d === 2) return O;
    if (d === 1) return lit(e) ? c("mustard", 0) : c("mustard", 2);
    return c("night", 1);
  });
  return nine("panel/self", W, W, img, all(6));
}

/** Small label chips: `shared` in a wood rim, `self` in the mustard rim. */
function chip(kind: "shared" | "self"): UiFrame {
  const W = 12;
  const img = slab(W, W, 2, (d, e) => {
    if (d === 0) return O;
    if (d === 1) return kind === "shared" ? c("wood", lit(e) ? 0 : 2) : c("mustard", lit(e) ? 0 : 2);
    return kind === "shared" ? c("charcoal", 2) : c("night", 2);
  });
  return nine(`chip/${kind}`, W, W, img, all(4));
}

/** Chat system line: a dark strip with the TV's glow bar down its left side. No tail, no card: it's the room talking. */
function systemLine(): UiFrame {
  const W = 14, H = 12;
  const img = slab(W, H, 2, (d, e) => {
    if (d === 0) return O;
    if (e === "l" && d <= 2) return c("glow", d === 1 ? 0 : 2);
    if (d === 1) return e === "t" ? c("charcoal", 1) : c("charcoal", 2);
    return c("charcoal", 2);
  });
  return nine("chat/system", W, H, img, { left: 5, top: 4, right: 4, bottom: 4 });
}

const ROLES: RoleMap = {
  c: { ramp: "cream", hi: true },
  C: { ramp: "cream", tone: 2 },
  m: { ramp: "mustard", hi: true },
  M: { ramp: "mustard", tone: 1, group: "m" },
  P: { ramp: "mustard", tone: 2, group: "m" },
  w: { ramp: "wood", hi: true },
  x: { ramp: "charcoal", hi: true },
  X: { ramp: "charcoal", tone: 2, group: "x" },
  k: { ramp: "night", hi: true },
  t: { ramp: "teal", hi: true },
  V: { ramp: "velvet", hi: true },
  r: { ramp: "rust", hi: true },
  g: { ramp: "glow", hi: true },
  o: { ramp: "outline", tone: 1 },
  // Flat sticker roles (catching-up hourglass): base tone + auto shade, no highlight band, like the emotes.
  W: { ramp: "wood" },
  G: { ramp: "glow" },
  S: { ramp: "mustard" },
};

function art(keyName: string, rows: readonly string[], ax: number, ay: number): UiFrame {
  const w = rows[0]?.length ?? 0;
  const g = blank(w, rows.length);
  stamp(g, rows, 0, 0);
  return { key: keyName, w, h: rows.length, img: render(g, ROLES), ax, ay };
}

// 16×16 icons, drawn on the keys. Play is a 2:1 stair (2 px across per row), the same slope as the floor.
const ICONS: Record<string, readonly string[]> = {
  play: [
    "................",
    "................",
    "................",
    "....cc..........",
    "....cccc........",
    "....cccccc......",
    "....cccccccc....",
    "....cccccccccc..",
    "....cccccccccc..",
    "....cccccccc....",
    "....cccccc......",
    "....cccc........",
    "....cc..........",
    "................",
    "................",
    "................",
  ],
  pause: [
    "................",
    "................",
    "................",
    "...cccc..cccc...",
    "...cccc..cccc...",
    "...cccc..cccc...",
    "...cccc..cccc...",
    "...cccc..cccc...",
    "...cccc..cccc...",
    "...cccc..cccc...",
    "...cccc..cccc...",
    "...cccc..cccc...",
    "...cccc..cccc...",
    "................",
    "................",
    "................",
  ],
  sound: [
    "................",
    "................",
    "................",
    "......cc...m....",
    ".....ccc....m...",
    "....cccc..m..m..",
    ".ccccccc...m.m..",
    ".ccccccc...m..m.",
    ".ccccccc...m..m.",
    ".ccccccc...m.m..",
    "....cccc..m..m..",
    ".....ccc....m...",
    "......cc...m....",
    "................",
    "................",
    "................",
  ],
  muted: [
    "................",
    "................",
    "................",
    "......cc........",
    ".....ccc........",
    ".ccccccc.rr..rr.",
    ".ccccccc..rrrr..",
    ".ccccccc...rr...",
    ".ccccccc...rr...",
    ".ccccccc..rrrr..",
    ".ccccccc.rr..rr.",
    ".....ccc........",
    "......cc........",
    "................",
    "................",
    "................",
  ],
  // Personal: headphones (mustard band, night cushions), the "only you" mark.
  you: [
    "................",
    "................",
    ".....mmmmmm.....",
    "...mmmmmmmmmm...",
    "..mmm......mmm..",
    "..mm........mm..",
    ".mm..........mm.",
    ".mm..........mm.",
    ".mm..........mm.",
    "kkkk........kkkk",
    "kkkk........kkkk",
    "kkkk........kkkk",
    ".kkk........kkk.",
    "................",
    "................",
    "................",
  ],
};

const OFF_ICONS = ["play", "pause", "sound", "muted"] as const;

// 8×8 glyphs for one-line text (system lines, readouts): 6×6 art plus the outline.
const GLYPHS: Record<string, readonly string[]> = {
  play: ["........", ".gg.....", ".gggg...", ".gggggg.", ".gggggg.", ".gggg...", ".gg.....", "........"],
  pause: ["........", ".gg.gg..", ".gg.gg..", ".gg.gg..", ".gg.gg..", ".gg.gg..", ".gg.gg..", "........"],
  seek: ["........", ".g..g...", ".gg.gg..", ".gggggg.", ".gggggg.", ".gg.gg..", ".g..g...", "........"],
  catchup: ["........", ".wwwwww.", "..gmmg..", "...mm...", "...gg...", "..gmmg..", ".wwwwww.", "........"],
  // Three heads in avatar hues on one velvet sofa: "the whole room".
  everyone: ["............", ".mm..tt..rr.", ".mm..tt..rr.", "............", ".VVVVVVVVVV.", ".VVVVVVVVVV.", "............", "............"],
  you: ["........", "..mmmm..", ".m....m.", ".m....m.", ".kk..kk.", ".kk..kk.", "........", "........"],
};

// Seek playhead: a wood grip with a brass cap and grip ridges. 10×16 with its outline.
function seekHead(state: KeyState | "disabled"): UiFrame {
  const wood = state === "disabled" ? "x" : "w";
  const cap = state === "disabled" ? "X" : state === "hover" ? "c" : state === "press" ? "M" : "m";
  const ridge = state === "disabled" ? "X" : "o";
  const body = [
    `..${cap.repeat(6)}..`,
    `.${cap.repeat(8)}.`,
    `.${wood.repeat(8)}.`,
    `.${wood.repeat(8)}.`,
    `.${wood.repeat(2)}${ridge.repeat(4)}${wood.repeat(2)}.`,
    `.${wood.repeat(8)}.`,
    `.${wood.repeat(2)}${ridge.repeat(4)}${wood.repeat(2)}.`,
    `.${wood.repeat(8)}.`,
    `.${wood.repeat(2)}${ridge.repeat(4)}${wood.repeat(2)}.`,
    `.${wood.repeat(8)}.`,
    `.${wood.repeat(8)}.`,
    `..${wood.repeat(6)}..`,
  ];
  // Pressed sits 1 px lower (it has been pushed down into the track), same frame size.
  const top = state === "press" ? 2 : 1;
  const g = blank(10, 16);
  stamp(g, body, 0, top);
  return { key: `seek/head/${state}`, w: 10, h: 16, img: render(g, ROLES), ax: 5, ay: 8 };
}

// Volume knob: a round mustard ("yours") bead, 10×10 with its outline. Round vs the seek head's tall grip.
function volumeKnob(state: KeyState | "disabled"): UiFrame {
  const b = state === "disabled" ? "x" : state === "hover" ? "c" : state === "press" ? "P" : "m";
  const rows = ["..bbbb..", ".bbbbbb.", "bbbbbbbb", "bbbbbbbb", "bbbbbbbb", "bbbbbbbb", ".bbbbbb.", "..bbbb.."].map((r) => r.replace(/b/g, b));
  const g = blank(10, 10);
  stamp(g, rows, 1, 1);
  return { key: `volume/knob/${state}`, w: 10, h: 10, img: render(g, ROLES), ax: 5, ay: 5 };
}

// Catching-up hourglass: a flat 16×16 sticker (wood posts, glow glass, mustard sand) in 4 frames:
// sand on top, sand running, sand below, then the glass turns on its side before it starts again.
const HOURGLASS: readonly (readonly string[])[] = [
  [
    "WWWWWWWWWW",
    ".WSSSSSSW.",
    ".WSSSSSSW.",
    ".WGSSSSGW.",
    ".W.GSSG.W.",
    ".W..GG..W.",
    ".W..GG..W.",
    ".W.GGGG.W.",
    ".WGGGGGGW.",
    ".WGGGGGGW.",
    ".WGGGGGGW.",
    "WWWWWWWWWW",
  ],
  [
    "WWWWWWWWWW",
    ".WGGGGGGW.",
    ".WGGGGGGW.",
    ".WGSSSSGW.",
    ".W.GSSG.W.",
    ".W..SG..W.",
    ".W..SG..W.",
    ".W.GSGG.W.",
    ".WGGSGGGW.",
    ".WGSSSSGW.",
    ".WSSSSSSW.",
    "WWWWWWWWWW",
  ],
  [
    "WWWWWWWWWW",
    ".WGGGGGGW.",
    ".WGGGGGGW.",
    ".WGGGGGGW.",
    ".W.GGGG.W.",
    ".W..GG..W.",
    ".W..GG..W.",
    ".W.GSSG.W.",
    ".WGSSSSGW.",
    ".WSSSSSSW.",
    ".WSSSSSSW.",
    "WWWWWWWWWW",
  ],
];

function transpose(rows: readonly string[]): string[] {
  const w = rows[0]?.length ?? 0;
  return Array.from({ length: w }, (_, x) => rows.map((r) => r.charAt(x)).join(""));
}

function hourglass(n: number): UiFrame {
  const src = n < 3 ? HOURGLASS[n] : transpose(HOURGLASS[2] ?? []);
  if (!src) throw new Error(`no hourglass frame ${String(n)}`);
  const w = src[0]?.length ?? 0;
  const g: Grid = blank(16, 16);
  // Bottom-aligned on row 14 (outline on row 15), centred, like the emote stickers.
  stamp(g, src, Math.floor((16 - w) / 2), 15 - src.length);
  return { key: `catchup/${String(n)}`, w: 16, h: 16, img: render(g, ROLES), ax: 8, ay: 15 };
}


export function buildPlaybackFrames(): UiFrame[] {
  const out: UiFrame[] = [];
  for (const kind of ["shared", "self"] as const) for (const s of ["idle", "hover", "press"] as const) out.push(key(kind, s));
  out.push(
    // Slices are 4 deep: the 2 px chamfer's inner ring reaches column/row 3, so a 3 px slice would stretch it.
    well("seek/track", 12, 10, "night", all(4)),
    well("seek/track-disabled", 12, 10, "charcoal", all(4)),
    fill("seek/fill", 6, "glow"),
    well("volume/track", 10, 8, "night", all(4)),
    fill("volume/fill", 4, "mustard"),
    well("readout/0", 10, 10, "night", all(4)),
    selfPanel(),
    chip("shared"),
    chip("self"),
    systemLine(),
  );
  for (const s of ["idle", "hover", "press", "disabled"] as const) out.push(seekHead(s), volumeKnob(s));
  for (const [name, rows] of Object.entries(ICONS)) out.push(art(`icon/${name}`, rows, 8, 8));
  // Disabled keys dim their icon too: cream → cream shade (the disabled-text token), colour → charcoal.
  for (const name of OFF_ICONS) {
    const rows = ICONS[name];
    if (rows) out.push(art(`icon/${name}-off`, rows.map((r) => r.replace(/c/g, "C").replace(/[mrk]/g, "x")), 8, 8));
  }
  for (const [name, rows] of Object.entries(GLYPHS)) out.push(art(`glyph/${name}`, rows, 4, 4));
  for (let n = 0; n < 4; n++) out.push(hourglass(n));
  return out;
}

/** Frame time for `catchup/0..3` (ms). Loops; it never stops while that user is behind. */
export const CATCHUP_FRAME_MS = 320;

const u = (n: number): string => (n === 0 ? "0" : `calc(${String(n)} * var(--ui-px))`);

/** Playback rules appended to `ui/reference.css`. */
export function playbackCss(rects: Readonly<Record<string, { x: number; y: number }>>): string {
  const pos = (n: number): string => {
    const r = rects[`catchup/${String(n)}`];
    if (!r) throw new Error(`missing catchup/${String(n)}`);
    return `--f${String(n)}: ${u(-r.x)} ${u(-r.y)};`;
  };
  const slice = (k: string): string => `url("slices/${k.replace(/\//g, "-")}.png")`;
  const nineRule = (k: string, b: number, side = b): string => {
    const w = b === side ? u(b) : `${u(b)} ${u(side)}`;
    return `border-style: solid; border-color: transparent; border-width: ${w}; border-image: ${slice(k)} ${String(b)} ${String(side)} fill / ${w} stretch;`;
  };
  const src = (k: string): string => `border-image-source: ${slice(k)};`;
  const off = OFF_ICONS.map((n) => {
    const r = rects[`icon/${n}-off`];
    if (!r) throw new Error(`missing icon/${n}-off`);
    return `.ui-button:disabled .ui-icon-${n}, .ui-button.is-disabled .ui-icon-${n} { background-position: ${u(-r.x)} ${u(-r.y)}; }`;
  }).join("\n");
  return `
/* ---- Set (e): synced playback (M1b). Wood = shared (everyone), mustard rim on night = only you, TV glow = the video. ---- */
.ui-transport, .ui-volume, .ui-seek, .ui-vol-track, .ui-readout, .ui-chip, .ui-sysline, .ui-seek-fill, .ui-vol-fill { image-rendering: pixelated; box-sizing: border-box; }

/* Shared transport: sits in a .ui-panel (the TV's wood). Label it with a .ui-chip.shared ("Everyone"). */
.ui-transport { display: flex; align-items: center; gap: ${u(4)}; }
.ui-button.shared { ${src("button/shared/idle")} color: var(--ui-text); }
.ui-button.shared:hover, .ui-button.shared.is-hover { ${src("button/shared/hover")} }
.ui-button.shared:active, .ui-button.shared.is-press { ${src("button/shared/press")} }
/* Personal keys: night face in the mustard "you" rim. */
.ui-button.self { ${src("button/self/idle")} color: var(--ui-accent); }
.ui-button.self:hover, .ui-button.self.is-hover { ${src("button/self/hover")} }
.ui-button.self:active, .ui-button.self.is-press { ${src("button/self/press")} }
.ui-button.shared:disabled, .ui-button.self:disabled, .ui-button.shared.is-disabled, .ui-button.self.is-disabled { ${src("button/primary/disabled")} }
/* Icon-only key (play/pause, mute): exactly one 16 px icon on the face. */
.ui-button.icon { width: ${u(26)}; height: ${u(28)}; min-height: 0; padding: 0 0 ${u(2)}; gap: 0; }
.ui-button.icon:active, .ui-button.icon.is-press { padding: ${u(2)} 0 0; }
.ui-button.icon:disabled, .ui-button.icon.is-disabled { padding: 0 0 ${u(2)}; }
${off}

/* Seek bar. Put the fill and head inside, and set --pos (0..1) on the bar. For a11y, lay a transparent
 * <input type="range"> over it (opacity 0, inset 0) and keep the art as decoration. */
.ui-seek { position: relative; flex: 1; min-width: ${u(40)}; height: ${u(10)}; ${nineRule("seek/track", 4)} }
.ui-seek.is-disabled { ${src("seek/track-disabled")} }
.ui-seek-fill { position: absolute; left: 0; top: ${u(-2)}; height: ${u(6)}; width: calc(100% * var(--pos, 0)); ${nineRule("seek/fill", 1)} border-left-width: 0; border-right-width: 0; }
.ui-seek.is-disabled .ui-seek-fill { display: none; }
.ui-seek-head { position: absolute; top: ${u(-7)}; left: calc(100% * var(--pos, 0) - ${u(5)}); }

/* Time readout: sunken night well, cream tabular digits. */
.ui-readout { ${nineRule("readout/0", 4)} display: inline-flex; align-items: center; padding: 0; color: var(--ui-text); font-variant-numeric: tabular-nums; font-size: 13px; font-weight: 700; line-height: 1; min-height: ${u(14)}; white-space: nowrap; }

/* Personal volume: its own pod, never inside the wood panel. */
.ui-volume { ${nineRule("panel/self", 6)} display: inline-flex; align-items: center; gap: ${u(4)}; padding: 0 ${u(2)}; color: var(--ui-accent); }
.ui-vol-track { position: relative; width: ${u(40)}; height: ${u(8)}; ${nineRule("volume/track", 4)} }
.ui-vol-fill { position: absolute; left: 0; top: ${u(-2)}; height: ${u(4)}; width: calc(100% * var(--vol, 1)); ${nineRule("volume/fill", 1)} border-left-width: 0; border-right-width: 0; }
.ui-vol-knob { position: absolute; top: ${u(-5)}; left: calc(100% * var(--vol, 1) - ${u(5)}); }
.ui-volume.is-muted .ui-vol-fill, .ui-vol-track.is-disabled .ui-vol-fill { display: none; }

/* Chips: who a control affects. Always paired with a glyph/icon, so it never relies on colour. */
.ui-chip { ${nineRule("chip/shared", 4)} display: inline-flex; align-items: center; gap: ${u(2)}; padding: 0 ${u(1)}; color: var(--ui-text); font-size: 11px; font-weight: 700; line-height: 1; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
.ui-room .ui-readout { font-size: 11px; }
.ui-room .ui-chip { font-size: 9px; }
.ui-chip.self { ${src("chip/self")} color: var(--ui-accent); }

/* Chat system line ("Ana paused"): dark strip + glow bar + glyph. User chat stays in cream bubbles over avatars. */
.ui-sysline { border-style: solid; border-color: transparent; border-width: ${u(4)} ${u(4)} ${u(4)} ${u(5)}; border-image: ${slice("chat/system")} 4 4 4 5 fill / ${u(4)} ${u(4)} ${u(4)} ${u(5)} stretch; display: flex; align-items: center; gap: ${u(2)}; margin: 0; padding: 0 ${u(1)}; width: fit-content; color: var(--ui-muted); font-size: 12px; font-weight: 500; line-height: 1.2; }
.ui-sysline b { color: var(--ui-glow); font-weight: 700; }
.ui-sysline time { color: var(--ui-text); font-variant-numeric: tabular-nums; font-weight: 700; }

/* Catching up: the hourglass sticker hangs off the left end of that user's name tag; the room keeps playing.
 * Frames catchup/0..3 at ${String(CATCHUP_FRAME_MS)} ms (the CSS below steps through them). */
.ui-catchup { ${[0, 1, 2, 3].map(pos).join(" ")} width: ${u(16)}; height: ${u(16)}; background-position: var(--f0); animation: ui-catchup ${String(CATCHUP_FRAME_MS * 4)}ms steps(1) infinite; }
@keyframes ui-catchup { 0% { background-position: var(--f0); } 25% { background-position: var(--f1); } 50% { background-position: var(--f2); } 75% { background-position: var(--f3); } }
/* The tag must already be positioned (it is, in the room). The sticker overlaps the tag's left end by 3 art px. */
.ui-tag.catching { color: var(--ui-muted); font-style: italic; }
.ui-tag.catching .ui-catchup { position: absolute; right: 100%; top: 50%; translate: ${u(3)} -50%; }
@media (prefers-reduced-motion: reduce) { .ui-catchup { animation: none; } }
`;
}
