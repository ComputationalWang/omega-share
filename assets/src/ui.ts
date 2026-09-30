// Set (c): UI chrome. 9-slice panels, buttons, fields, chat bubble, name tag, seat cursor,
// icons, status lamps, avatar portraits and the wordmark. Same palette, same plum outline,
// same top-left light as the avatars and the room.
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import type { RoomFrame } from "./room";
import { blank, render, stamp, type RoleMap } from "./sprite";

export interface Borders {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface UiFrame extends RoomFrame {
  /** 9-slice insets (PixiJS `borders`, CSS `border-image-slice`). */
  borders?: Borders;
  /** Also written as a standalone PNG in `ui/slices/` for CSS `border-image`. */
  slice?: boolean;
  /** Drawn at exactly its middle-band height (never stretched vertically), so its side slices may carry detail. */
  fixedHeight?: boolean;
}

const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const O = OUTLINE;
const T = 0; // transparent

export type Edge = "t" | "b" | "l" | "r";

/** Depth of (x, y) inside a w×h rect with chamfered corners (r px), and the nearest edge.
 *  Diagonal rings are 2 px wide per row, so they step cleanly like the room's 2:1 edges. */
function ring(w: number, h: number, r: number, x: number, y: number): { d: number; edge: Edge } | null {
  const cand: [number, Edge][] = [
    [y, "t"],
    [h - 1 - y, "b"],
    [x, "l"],
    [w - 1 - x, "r"],
    [Math.floor((x + y - r) / 2), "t"],
    [Math.floor((w - 1 - x + y - r) / 2), "t"],
    [Math.floor((x + h - 1 - y - r) / 2), "b"],
    [Math.floor((w - 1 - x + h - 1 - y - r) / 2), "b"],
  ];
  let best: [number, Edge] = [Infinity, "t"];
  for (const k of cand) if (k[0] < best[0]) best = k;
  return best[0] < 0 ? null : { d: best[0], edge: best[1] };
}

type Paint = (d: number, edge: Edge) => number;

export function slab(w: number, h: number, r: number, paint: Paint): Uint8Array {
  const img = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = ring(w, h, r, x, y);
      if (k) img[y * w + x] = paint(k.d, k.edge);
    }
  }
  return img;
}

export const lit = (e: Edge): boolean => e === "t" || e === "l";
export const all = (n: number): Borders => ({ left: n, top: n, right: n, bottom: n });

export function nine(key: string, w: number, h: number, img: Uint8Array, borders: Borders): UiFrame {
  return { key, w, h, img, ax: 0, ay: 0, borders, slice: true };
}

// --- Panel: warm wood frame (like the TV), plum inner line, dusk-charcoal fill, brass pins.
function panel(): UiFrame {
  const W = 24;
  const img = slab(W, W, 3, (d, e) => {
    if (d === 0 || d === 4) return O;
    if (d <= 3) return lit(e) ? c("wood", d === 1 ? 0 : 1) : c("wood", d === 1 ? 1 : 2);
    return c("charcoal", 2);
  });
  for (const [x, y] of [[4, 4], [W - 5, 4], [4, W - 5], [W - 5, W - 5]] as const) img[y * W + x] = c("mustard", y < 12 ? 0 : 1);
  return nine("panel/0", W, W, img, all(8));
}

// --- Buttons: a chunky key with a 2 px lip. Pressed drops the face by losing the lip.
type BtnState = "idle" | "hover" | "press" | "disabled";
function button(kind: "primary" | "secondary", state: BtnState): UiFrame {
  const ramp: RampName = state === "disabled" ? "charcoal" : kind === "primary" ? "mustard" : "navy";
  const W = 16, H = 20;
  const img = slab(W, H, 2, (d, e) => {
    if (d === 0) return O;
    if (state === "press") {
      if (d === 1 && e === "t") return O;
      if ((d === 1 && e === "l") || (d === 2 && e === "t")) return c(ramp, 2);
      return c(ramp, 1);
    }
    if (e === "b" && d <= 2) return c(ramp, 2);
    if (d === 1 && e === "r") return c(ramp, 2);
    if (d === 1 && lit(e)) return state === "hover" ? c("cream", 0) : c(ramp, 0);
    return state === "hover" ? c(ramp, 0) : c(ramp, 1);
  });
  return nine(`button/${kind}/${state}`, W, H, img, { left: 5, top: 5, right: 5, bottom: 5 });
}

// --- Text field: inset (shadow top-left, lit lip bottom-right) plus an outer focus/invalid ring.
function input(state: "idle" | "focus" | "invalid"): UiFrame {
  const W = 18;
  const ringCol = state === "idle" ? T : state === "focus" ? c("mustard", 0) : c("rust", 0);
  const img = slab(W, W, 3, (d, e) => {
    if (d === 0) return ringCol;
    if (d === 1) return O;
    if (d === 2) return lit(e) ? O : c("night", 0);
    return c("night", 2);
  });
  return nine(`input/${state}`, W, W, img, all(6));
}

// --- Chat bubble: cream card, shaded bottom lip; the tail is a separate piece so it can centre.
function bubble(): UiFrame[] {
  const W = 16;
  const img = slab(W, W, 3, (d, e) => {
    if (d === 0) return O;
    if (d === 1 && e === "b") return c("cream", 2);
    if (d === 1 && e === "r") return c("cream", 1);
    return c("cream", 0);
  });
  // Tail: 14×5, steps 2 px per row (2:1). Row 0 overlaps the bubble's lip and stays clear;
  // row 1 overlaps its outline and opens it, so the tail reads as part of the card.
  const TW = 14, TH = 5;
  const tail = new Uint8Array(TW * TH);
  for (let y = 1; y < TH; y++) {
    const hw = 7 - 2 * (y - 1);
    for (let x = 0; x < TW; x++) {
      const dx = x < 7 ? 6 - x : x - 7;
      if (dx < hw) tail[y * TW + x] = dx >= hw - 2 ? O : c("cream", 2);
    }
  }
  return [nine("bubble/0", W, W, img, all(6)), { key: "bubble/tail", w: TW, h: TH, img: tail, ax: TW / 2, ay: 2, slice: true }];
}

// --- Name tag: small dark pill; `self` gets a mustard inner rim.
function tag(self: boolean): UiFrame {
  const W = 12;
  const img = slab(W, W, 2, (d, e) => {
    if (d === 0) return O;
    if (d === 1) return self ? c("mustard", e === "b" || e === "r" ? 2 : 0) : c("charcoal", e === "t" ? 1 : 2);
    return c("charcoal", 2);
  });
  return nine(self ? "tag/self" : "tag/0", W, W, img, all(4));
}

// --- Avatar picker frame: a little dusk window; selected gets a mustard double rim.
function picker(state: "idle" | "hover" | "selected"): UiFrame {
  const W = 20;
  const img = slab(W, W, 3, (d, e) => {
    if (d === 0) return O;
    if (state === "selected" && d <= 2) return lit(e) ? c("mustard", d === 1 ? 0 : 1) : c("mustard", 2);
    if (d === 1) return state === "hover" ? c("cream", lit(e) ? 0 : 2) : c("night", lit(e) ? 0 : 2);
    return c("night", state === "idle" ? 1 : 0);
  });
  return nine(`picker/${state}`, W, W, img, all(7));
}

// --- Seat cursor: a 2 px band on the 2:1 tile diamond, plum-stroked on both sides so it reads on the honey
// floor, the gold rug and the velvet chairs alike. The state is carried by the line pattern as well as the
// colour: free = four corner brackets, mine = a closed ring, taken = a dashed ring.
function cursor(state: "free" | "mine" | "taken"): UiFrame {
  const W = 64, H = 33;
  const line = state === "free" ? c("cream", 0) : state === "mine" ? c("mustard", 0) : c("rust", 0);
  const img = new Uint8Array(W * H);
  const on = (x: number, y: number): boolean => {
    const dx = Math.abs(x + 0.5 - 32);
    const d = dx / 2 + Math.abs(y + 0.5 - 16);
    if (d > 15.25 || d <= 13.75) return false;
    if (state === "free") return dx > 19 || dx < 13; // long arms, 6 px gaps: as much ink as the ring, still clearly open
    if (state === "taken") return Math.floor(dx / 6) % 2 === 0;
    return true;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (on(x, y)) img[y * W + x] = line;
  // Plum stroke all round the band (4-connected), inside and out.
  const lit = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H && img[y * W + x] === line;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (img[y * W + x] !== T) continue;
      if (lit(x + 1, y) || lit(x - 1, y) || lit(x, y + 1) || lit(x, y - 1)) img[y * W + x] = O;
    }
  }
  return { key: `cursor/${state}`, w: W, h: H, img, ax: 32, ay: 16, slice: true };
}

// --- Role-grid art (auto shade + auto outline, exactly like the avatars).
const ROLES: RoleMap = {
  c: { ramp: "cream", hi: true },
  C: { ramp: "cream", tone: 2 },
  m: { ramp: "mustard", hi: true },
  M: { ramp: "mustard", tone: 0, group: "m" },
  t: { ramp: "teal", hi: true },
  l: { ramp: "lilac", hi: true },
  V: { ramp: "velvet", hi: true },
  a: { ramp: "velvet" },
  s: { ramp: "velvet", tone: 0 },
  w: { ramp: "wood", hi: true },
  g: { ramp: "glow", hi: true },
  k: { ramp: "night", tone: 1 },
  x: { ramp: "charcoal", tone: 1 },
  o: { ramp: "outline", tone: 1 },
  r: { ramp: "rust", hi: true },
  n: { ramp: "navy", hi: true },
  // Wordmark: face + extrusion.
  F: { ramp: "mustard", hi: true },
  f: { ramp: "rust", tone: 2 },
  E: { ramp: "cream", hi: true },
  e: { ramp: "cream", tone: 2 },
  H: { ramp: "teal", hi: true },
  h: { ramp: "teal", tone: 2 },
};

function art(key: string, rows: readonly string[], ax = 0, ay = 0): UiFrame {
  const w = rows[0]?.length ?? 0;
  const g = blank(w, rows.length);
  stamp(g, rows, 0, 0);
  return { key, w, h: rows.length, img: render(g, ROLES), ax, ay };
}

const ICONS: Record<string, readonly string[]> = {
  send: [
    "................",
    ".cc.............",
    ".cccc...........",
    "..cccccc........",
    "..cccccccc......",
    "...ccccccccc....",
    "...cccccccccccc.",
    "...CCCCCCCCCCCC.",
    "...CCCCCCCCC....",
    "..CCCCCCCC......",
    "..CCCCCC........",
    ".CCCC...........",
    ".CC.............",
    "................",
    "................",
    "................",
  ],
  chat: [
    "................",
    "................",
    "..cccccccccccc..",
    ".cccccccccccccc.",
    ".cccccccccccccc.",
    ".ccxxccxxccxxcc.",
    ".ccxxccxxccxxcc.",
    ".cccccccccccccc.",
    ".cccccccccccccc.",
    "..cccccccccccc..",
    "...ccc..........",
    "...cc...........",
    "...c............",
    "................",
    "................",
    "................",
  ],
  seat: [
    "................",
    "................",
    "...VVVVVVVVVV...",
    "..VVVVVVVVVVVV..",
    "..VVVVVVVVVVVV..",
    "..VVVVVVVVVVVV..",
    ".aa.VVVVVVVV.aa.",
    ".aa.VVVVVVVV.aa.",
    ".aa.ssssssss.aa.",
    ".aa.ssssssss.aa.",
    ".aaaaaaaaaaaaaa.",
    ".aaaaaaaaaaaaaa.",
    "..ww........ww..",
    "..ww........ww..",
    "................",
    "................",
  ],
  leave: [
    "................",
    "........wwwwww..",
    "........wwwwww..",
    "...t....wwwwww..",
    "..tt....wwwwww..",
    ".tttttt.wwwwww..",
    ".tttttt.wwwMww..",
    "..tt....wwwMww..",
    "...t....wwwwww..",
    "........wwwwww..",
    "........wwwwww..",
    "........wwwwww..",
    "........wwwwww..",
    "................",
    "................",
    "................",
  ],
  people: [
    "................",
    "................",
    ".........llll...",
    "........llllll..",
    "........llllll..",
    "....tt...llll...",
    "...tttt.........",
    "..tttttt.llllll.",
    "..tttttt.lllllll",
    "...tttt..lllllll",
    "................",
    ".tttttttt.......",
    "tttttttttt......",
    "tttttttttt......",
    "................",
    "................",
  ],
  share: [
    "................",
    ".........mmmmm..",
    "..........mmmm..",
    ".........mmmmm..",
    "........mmm.mm..",
    ".......mmm...m..",
    "..nnn.mmm.......",
    "..nn.mmm........",
    "..nn..m.........",
    "..nn........nn..",
    "..nn........nn..",
    "..nnnnnnnnnnnn..",
    "..nnnnnnnnnnnn..",
    "................",
    "................",
    "................",
  ],
  close: [
    "................",
    "................",
    "..cc........cc..",
    "..ccc......ccc..",
    "...ccc....ccc...",
    "....ccc..ccc....",
    ".....cccccc.....",
    "......cccc......",
    "......cccc......",
    ".....cccccc.....",
    "....ccc..ccc....",
    "...ccc....ccc...",
    "..ccc......ccc..",
    "..cc........cc..",
    "................",
    "................",
  ],
  warn: [
    "................",
    ".......mm.......",
    "......mmmm......",
    "......mmmm......",
    ".....mmoomm.....",
    ".....mmoomm.....",
    "....mmmoommm....",
    "....mmmoommm....",
    "...mmmmoommmm...",
    "...mmmmmmmmmm...",
    "..mmmmmoommmmm..",
    "..mmmmmoommmmm..",
    ".mmmmmmmmmmmmmm.",
    ".mmmmmmmmmmmmmm.",
    "................",
    "................",
  ],
  tv: [
    "................",
    "................",
    ".wwwwwwwwwwwwww.",
    ".wggggggggggggw.",
    ".wggggggggggggw.",
    ".wgggggkggggggw.",
    ".wgggggkkgggggw.",
    ".wgggggkkkggggw.",
    ".wgggggkkgggggw.",
    ".wgggggkggggggw.",
    ".wggggggggggggw.",
    ".wwwwwwwwwwwwww.",
    "......wwww......",
    "...wwwwwwwwww...",
    "................",
    "................",
  ],
};

const DOT = ["........", "..LLLL..", ".LWLLLL.", ".LLLLLL.", ".LLLLLL.", ".LLLLLL.", "..LLLL..", "........"];
function dot(name: string, ramp: RampName): UiFrame {
  const g = blank(8, 8);
  stamp(g, DOT, 0, 0);
  return { key: `dot/${name}`, w: 8, h: 8, img: render(g, { L: { ramp, hi: true }, W: { ramp: "cream", tone: 0, group: "L" } }), ax: 4, ay: 4 };
}

// --- Wordmark "omega-share": chunky 2 px strokes, 1 px letter gaps, a 2 px extrusion below.
// Rows: 3 ascender, 7 x-height, 3 descender (13). Lower-case only.
const GLYPHS: Record<string, readonly string[]> = {
  o: ["", "", "", ".XXXX.", "XX..XX", "XX..XX", "XX..XX", "XX..XX", "XX..XX", ".XXXX."],
  m: ["", "", "", "XXXXXXXXX.", "XX..XX..XX", "XX..XX..XX", "XX..XX..XX", "XX..XX..XX", "XX..XX..XX", "XX..XX..XX"],
  e: ["", "", "", ".XXXX.", "XX..XX", "XXXXXX", "XX....", "XX....", "XX..XX", ".XXXX."],
  g: ["", "", "", ".XXXXX", "XX..XX", "XX..XX", "XX..XX", "XX..XX", ".XXXXX", "....XX", "....XX", "XX..XX", ".XXXX."],
  a: ["", "", "", ".XXXX.", "....XX", ".XXXXX", "XX..XX", "XX..XX", "XX..XX", ".XXXXX"],
  s: ["", "", "", ".XXXXX", "XX....", "XX....", ".XXXX.", "....XX", "....XX", "XXXXX."],
  h: ["XX....", "XX....", "XX....", "XXXXX.", "XX..XX", "XX..XX", "XX..XX", "XX..XX", "XX..XX", "XX..XX"],
  r: ["", "", "", "XX.XXX", "XXX...", "XX....", "XX....", "XX....", "XX....", "XX...."],
  "-": ["", "", "", "", "", "XXXX", "XXXX"],
};

function logo(): UiFrame {
  const word = ["o", "m", "e", "g", "a", "-", "s", "h", "a", "r", "e"] as const;
  const widths = word.map((ch) => GLYPHS[ch]?.find((r) => r.length > 0)?.length ?? 0);
  const H = 13 + 2 + 2; // glyph rows + extrusion + outline margin
  const W = widths.reduce((a, b) => a + b, 0) + (word.length - 1) + 2;
  const g = blank(W, H);
  const faces = (ch: string, i: number): [string, string] => (ch === "-" ? ["H", "h"] : i < 5 ? ["F", "f"] : ["E", "e"]);
  for (const pass of [1, 0] as const) {
    let x = 1;
    word.forEach((ch, i) => {
      const rows = GLYPHS[ch] ?? [];
      const [face, ext] = faces(ch, i);
      for (let dy = pass === 1 ? 2 : 0; dy >= (pass === 1 ? 1 : 0); dy--) {
        const role = pass === 1 ? ext : face;
        stamp(g, rows.map((r) => r.replace(/X/g, role)), x, 1 + dy);
      }
      x += (widths[i] ?? 0) + 1;
    });
  }
  return { key: "logo/0", w: W, h: H, img: render(g, ROLES), ax: 0, ay: 0 };
}

/** Head-and-shoulders crops (32×32) of each avatar's idle/se/0 frame. Rows 14–45 of the cell hold every
 *  hat top and the shoulders, so all four share one eye line. Place bottom-aligned in a picker frame. */
function portraits(ids: readonly string[], avatars: ReadonlyMap<string, Uint8Array>, cellW: number): UiFrame[] {
  const TOP = 14, PH = 32;
  return ids.map((id) => {
    const src = avatars.get(`${id}/idle/se/0`);
    if (!src) throw new Error(`missing ${id}/idle/se/0`);
    if (src.subarray(0, TOP * cellW).some((v) => v !== 0)) throw new Error(`${id} pokes above the portrait crop`);
    return { key: `portrait/${id}`, w: cellW, h: PH, img: src.slice(TOP * cellW, (TOP + PH) * cellW), ax: cellW / 2, ay: PH };
  });
}

export function buildUiFrames(avatarIds: readonly string[], avatars: ReadonlyMap<string, Uint8Array>, cellW: number): UiFrame[] {
  const out: UiFrame[] = [panel()];
  for (const kind of ["primary", "secondary"] as const) {
    for (const s of ["idle", "hover", "press", "disabled"] as const) if (kind === "primary" || s !== "disabled") out.push(button(kind, s));
  }
  for (const s of ["idle", "focus", "invalid"] as const) out.push(input(s));
  out.push(...bubble(), tag(false), tag(true));
  for (const s of ["idle", "hover", "selected"] as const) out.push(picker(s));
  for (const s of ["free", "mine", "taken"] as const) out.push(cursor(s));
  for (const [name, rows] of Object.entries(ICONS)) out.push(art(`icon/${name}`, rows, 8, 8));
  out.push(dot("online", "teal"), dot("connecting", "mustard"), dot("offline", "rust"));
  out.push(logo(), ...portraits(avatarIds, avatars, cellW));
  return out;
}


interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const px = (n: number): string => `${String(n)}px`;
const kebab = (key: string): string => key.replace(/\//g, "-");
/** Art pixels → CSS length that follows the chrome scale (`--ui-px`). */
const u = (n: number): string => (n === 0 ? "0" : `calc(${String(n)} * var(--ui-px))`);
/** Atlas keys that CSS draws as plain sprites from ui.png (the rest are 9-slices in ui/slices/). */
const SPRITE_KEY = /^(icon|dot|portrait|logo|glyph|catchup|resync|wait|door|seek\/head|volume\/knob)\//;

/** `ui/reference.css`: the design spec for the DOM chrome, generated so sprite offsets never drift.
 *  9-slices scale with `--ui-px` (2px in page chrome, 1px inside the room stage); sprites are baked at 2×. */
export function referenceCss(rects: Readonly<Record<string, Rect>>, sheet: { w: number; h: number }, tokens: Readonly<Record<string, string>>, borders: Readonly<Record<string, Borders>>): string {
  const b = (key: string): number => borders[key]?.top ?? 0;
  const slice = (key: string): string => `url("slices/${kebab(key)}.png")`;
  const nineRule = (key: string): string =>
    `border-style: solid; border-color: transparent; border-width: calc(${String(b(key))} * var(--ui-px)); border-image: ${slice(key)} ${String(b(key))} fill / calc(${String(b(key))} * var(--ui-px)) stretch;`;
  const src = (key: string): string => `border-image-source: ${slice(key)};`;
  const tok = Object.entries(tokens).map(([k, v]) => `  --ui-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${v};`).join("\n");
  const sprites = Object.entries(rects)
    .filter(([k]) => SPRITE_KEY.test(k))
    .map(([k, r]) => `.ui-${kebab(k)} { width: ${u(r.w)}; height: ${u(r.h)}; background-position: ${u(-r.x)} ${u(-r.y)}; }`)
    .join("\n");
  const tail = rects["bubble/tail"] ?? { x: 0, y: 0, w: 14, h: 5 };
  const cur = rects["cursor/free"] ?? { x: 0, y: 0, w: 64, h: 33 };
  return `/* omega-share UI chrome: reference styles. GENERATED by assets/src/build.ts; do not edit by hand.
 * This is the design spec, not app code: apps/web ports what it needs. URLs are relative to assets/ui/.
 * Art: CC BY-SA 4.0 (assets/LICENSE). Every image is pixel art: keep image-rendering: pixelated. */
:root {
${tok}
  --ui-px: 2px; /* one art pixel in page chrome */
}
.ui-room { --ui-px: 1px; } /* inside the 960×600 stage the chrome matches the room's 1× art */

.ui-panel, .ui-button, .ui-input, .ui-bubble, .ui-tag, .ui-picker, .ui-sprite, .ui-bubble::after, .ui-seat-cursor { image-rendering: pixelated; box-sizing: border-box; }

/* Panel: wood frame, brass pins, dusk fill. */
.ui-panel { ${nineRule("panel/0")} color: var(--ui-text); padding: calc(4 * var(--ui-px)); }

/* Buttons: face sits 2 art px above its lip; pressed loses the lip, so the label drops with it. */
.ui-button { ${nineRule("button/primary/idle")} min-height: calc(20 * var(--ui-px)); padding: 0 calc(3 * var(--ui-px)) calc(2 * var(--ui-px)); display: inline-flex; align-items: center; justify-content: center; gap: calc(3 * var(--ui-px)); background: none; color: var(--ui-on-primary); font-weight: 700; cursor: pointer; }
.ui-button:hover, .ui-button.is-hover { ${src("button/primary/hover")} }
.ui-button:active, .ui-button.is-press { ${src("button/primary/press")} padding-top: calc(2 * var(--ui-px)); padding-bottom: 0; }
.ui-button:disabled, .ui-button.is-disabled { ${src("button/primary/disabled")} color: var(--ui-disabled-text); cursor: default; padding-top: 0; padding-bottom: calc(2 * var(--ui-px)); }
.ui-button.secondary { ${src("button/secondary/idle")} color: var(--ui-text); }
.ui-button.secondary:hover, .ui-button.secondary.is-hover { ${src("button/secondary/hover")} }
.ui-button.secondary:active, .ui-button.secondary.is-press { ${src("button/secondary/press")} }
.ui-button.secondary:disabled { ${src("button/primary/disabled")} color: var(--ui-disabled-text); }
.ui-button:focus-visible { outline: var(--ui-px) solid var(--ui-text); outline-offset: var(--ui-px); }

/* Text field: inset well; the outer ring is the focus indicator (mustard) or the error state (rust). */
.ui-input { ${nineRule("input/idle")} background: none; color: var(--ui-text); padding: 0 calc(1 * var(--ui-px)); min-height: calc(18 * var(--ui-px)); outline: none; }
.ui-input::placeholder { color: var(--ui-muted); opacity: 1; }
.ui-input:focus-visible, .ui-input.is-focus { ${src("input/focus")} }
.ui-input[aria-invalid="true"] { ${src("input/invalid")} }

/* Chat bubble + centred tail (the tail's top 2 rows overlap the bubble's lip and outline). */
.ui-bubble { ${nineRule("bubble/0")} position: relative; color: var(--ui-bubble-text); padding: 0 calc(1 * var(--ui-px)); }
.ui-bubble::after { content: ""; position: absolute; left: 50%; top: calc(100% + ${String(b("bubble/0") - 2)} * var(--ui-px)); width: calc(${String(tail.w)} * var(--ui-px)); height: calc(${String(tail.h)} * var(--ui-px)); translate: -50% 0; background: ${slice("bubble/tail")} 0 0 / 100% 100%; }

/* Name tag; .self marks you. */
.ui-tag { ${nineRule("tag/0")} color: var(--ui-text); padding: 0 calc(1 * var(--ui-px)); font-size: 11px; line-height: 1; white-space: nowrap; }
.ui-tag.self { ${src("tag/self")} color: var(--ui-accent); }

/* Avatar picker tile (put a .ui-portrait-* inside, bottom-aligned). */
.ui-picker { ${nineRule("picker/idle")} display: grid; place-items: end center; padding: 0; background: none; cursor: pointer; }
.ui-picker:hover, .ui-picker.is-hover { ${src("picker/hover")} }
.ui-picker[aria-checked="true"] { ${src("picker/selected")} }

/* Seat cursor, room scale (1×). Centre it on the seat tile: its anchor is (32, 16). */
.ui-seat-cursor { width: ${px(cur.w)}; height: ${px(cur.h)}; margin: -16px 0 0 -32px; background: ${slice("cursor/free")}; }
.ui-seat-cursor.mine { background-image: ${slice("cursor/mine")}; }
.ui-seat-cursor.taken { background-image: ${slice("cursor/taken")}; }

/* Sprites from ui.png, scaled by --ui-px like the 9-slices (2× in page chrome, 1× in .ui-room): icons (16 art px), status dots,
 * portraits, wordmark, playback glyphs, seek head, volume knob and the catching-up hourglass. */
.ui-sprite { display: inline-block; flex: none; background: url("ui.png") no-repeat; background-size: ${u(sheet.w)} ${u(sheet.h)}; }
${sprites}
`;
}
