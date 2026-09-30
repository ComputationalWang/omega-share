// Set (f), M3 safety states (OME-193): the limits people will hit, drawn so they read as "wait a moment", never as an alarm.
// Same palette, plum outline and top-left light as sets (c)/(e). No rust and no warn icon anywhere in this set: rust means
// "on air" (M2) or a real error (set c), and none of these are errors. Each motif has exactly one job:
//   snail        = "too fast": the slow-down chip and the rate-limit system line. Nothing else.
//   round arrow  = your share didn't go through, try again.
//   timer dial   = how long to wait. Its cream wedge drains clockwise from 12 o'clock; the only moving part of a cooldown.
//   mug          = the room paused your connection (flood/policy): take a breather.
//   mustard bar  = a line only you see (set e's "you" colour), e.g. your share didn't go through. Glow bars stay the room's news.
//   plug         = the network dropped; it reconnects by itself.
//   door + tag   = the room is full; its door is shut with a hanger on the knob.
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import { blank, render, stamp, type RoleMap } from "./sprite";
import { all, lit, nine, slab, type UiFrame } from "./ui";

const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const O = OUTLINE;

/** A shared wood key that's resting: still wood (it's still everyone's key), but a ramp step darker all over and
 *  with its lip in charcoal, so it reads as "not yet", not as "off" (disabled is charcoal all over). */
function coolKey(): UiFrame {
  const W = 16, H = 20;
  const img = slab(W, H, 2, (d, e) => {
    if (d === 0) return O;
    if (e === "b" && d <= 2) return c("charcoal", 2);
    if (d === 1 && e === "r") return c("charcoal", 2);
    if (d === 1 && lit(e)) return c("wood", 1);
    return c("wood", 2);
  });
  return nine("button/shared/cool", W, H, img, all(5));
}

/** Chat system line for things only you see: set (e)'s strip with the glow bar swapped for the mustard "you" bar. */
function selfLine(): UiFrame {
  const W = 14, H = 12;
  const img = slab(W, H, 2, (d, e) => {
    if (d === 0) return O;
    if (e === "l" && d <= 2) return c("mustard", d === 1 ? 0 : 2);
    if (d === 1) return e === "t" ? c("charcoal", 1) : c("charcoal", 2);
    return c("charcoal", 2);
  });
  return nine("chat/system-self", W, H, img, { left: 5, top: 4, right: 4, bottom: 4 });
}

/** Room-list card: a small dusk window in a wood rim (like the picker). `full` dims both: shade rim, charcoal glass. */
function card(state: "idle" | "hover" | "full"): UiFrame {
  const W = 16;
  const img = slab(W, W, 2, (d, e) => {
    if (d === 0 || d === 3) return O;
    if (d <= 2) {
      if (state === "full") return c("wood", 2);
      if (d === 1 && lit(e)) return state === "hover" ? c("cream", 0) : c("wood", 0);
      return lit(e) ? c("wood", 1) : c("wood", 2);
    }
    return state === "full" ? c("charcoal", 2) : c("night", 1);
  });
  return nine(`card/room/${state}`, W, W, img, all(6));
}

/** "Full" pill: charcoal with a cream rim and cream text. Calm on purpose: a full room isn't a problem. */
function fullPill(): UiFrame {
  const W = 12;
  const img = slab(W, W, 2, (d, e) => {
    if (d === 0) return O;
    if (d === 1) return c("cream", lit(e) ? 1 : 2);
    return c("charcoal", 2);
  });
  return nine("pill/full", W, W, img, all(4));
}

const ROLES: RoleMap = {
  // Flat highlight, like set (e)'s key icons (crisp on the keys at 1×).
  i: { ramp: "cream", tone: 0 },
  C: { ramp: "cream", tone: 2 },
  y: { ramp: "mustard", tone: 0 },
  Y: { ramp: "mustard", tone: 1 },
  // Auto-shaded surfaces (base + shade edge, highlight band where flagged).
  c: { ramp: "cream", hi: true },
  m: { ramp: "mustard", hi: true },
  M: { ramp: "mustard", tone: 2 },
  w: { ramp: "wood", hi: true },
  W: { ramp: "wood", tone: 2 },
  n: { ramp: "night" },
  x: { ramp: "charcoal", hi: true },
  X: { ramp: "charcoal", tone: 0 },
  g: { ramp: "glow", tone: 0 },
  t: { ramp: "teal", tone: 0 },
  r: { ramp: "rust", tone: 0 },
  o: { ramp: "outline", tone: 1 },
};

function art(keyName: string, rows: readonly string[], ax?: number, ay?: number): UiFrame {
  const w = rows[0]?.length ?? 0, h = rows.length;
  const g = blank(w, h);
  stamp(g, rows, 0, 0);
  return { key: keyName, w, h, img: render(g, ROLES), ax: ax ?? w / 2, ay: ay ?? h / 2 };
}

/** Timer, 16×16: `wait/0` is full, each later frame has one more eighth spent, clockwise from 12 o'clock.
 *  A filled dial, not a thin ring: remaining = a cream wedge, spent = plum, so each frame drops a whole slice of cream and
 *  the middle frames (half-way, most of the way) read apart at 1× by area. No colour needed on wood, night or white. */
export const WAIT_FRAMES = 8;
function waitRing(n: number): UiFrame {
  const S = 16, cx = 7.5, cy = 7.5;
  const rows: string[] = [];
  for (let y = 0; y < S; y++) {
    let row = "";
    for (let x = 0; x < S; x++) {
      const dx = x - cx, dy = y - cy;
      if (Math.hypot(dx, dy) > 6.1) {
        row += ".";
        continue;
      }
      // Angle clockwise from 12 o'clock, in eighths.
      const a = (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI);
      const eighth = Math.floor((a / (2 * Math.PI)) * WAIT_FRAMES);
      row += eighth < n ? "o" : "i";
    }
    rows.push(row);
  }
  return art(`wait/${String(n)}`, rows);
}

// 12×8 one-line glyphs (10×6 art + outline), same size as `glyph/everyone`.
const WIDE_GLYPHS: Record<string, readonly string[]> = {
  // A snail heading right: a round mustard shell with one plum curl, a cream foot and a raised head on one bold eye stalk. "Take it slow."
  snail: [
    "............",
    "..yyyy....i.",
    ".yyYYYM...c.",
    ".yYooYM..cc.",
    ".yYYoYM.ccc.",
    ".YooMMM.ccc.",
    ".cccccccccc.",
    "............",
  ],
  // Loader for "reconnecting": three cream dots, one lifted in turn.
  "dots/0": ["............", "............", ".ii.........", ".ii..CC..CC.", ".....CC..CC.", "............", "............", "............"],
  "dots/1": ["............", "............", ".....ii.....", ".CC..ii..CC.", ".CC......CC.", "............", "............", "............"],
  "dots/2": ["............", "............", ".........ii.", ".CC..CC..ii.", ".CC..CC.....", "............", "............", "............"],
};

// 8×8 glyphs (6×6 art + outline).
const GLYPHS: Record<string, readonly string[]> = {
  // Round arrow, mustard: "your share, try again". Arrowhead at the top right, going clockwise.
  retry: ["........", "..yyy.y.", ".y...yy.", ".y..yyy.", ".y......", ".y...y..", "..yyy...", "........"],
  // Paused lamp for the top bar: a pale cream-shade lamp with two plum pause bars (a shape, not a colour: set c lamps are plain discs). "The room paused your connection", not "broken".
  "dot/paused": ["........", "..CCCC..", ".CoCCoC.", ".CoCCoC.", ".CoCCoC.", ".CoCCoC.", "..CCCC..", "........"],
};

// 16×16 icons.
const ICONS: Record<string, readonly string[]> = {
  // Try again: one bold round mustard arrow, clockwise, with a wide gap at the top right so it can't close into a ring.
  // Nothing inside it (a clock face there read as a target at 1×). The popup's 1× key icon.
  retry: [
    "................",
    "........y.......",
    ".....yyyYy......",
    "....yyYYYYy.....",
    "...yYY..YY......",
    "..yyY...Y.......",
    "..yY............",
    "..yY........YM..",
    "..yY........YM..",
    "..yY........YM..",
    "..yyY......YMM..",
    "...yYY....YYM...",
    "....YYYYYYMM....",
    ".....MMMMMM.....",
    "................",
    "................",
  ],
  // Normal disconnect: a mustard plug pulled a little way out of its cream wall socket (the prongs line up with its holes), cable trailing. It'll plug back in.
  unplugged: [
    "................",
    "................",
    "................",
    ".CCCC...........",
    ".CCCC.....mmmm..",
    ".CCoC...iimmmmm.",
    ".CCCC.....mmmm..",
    ".CCCC.....mmmm..",
    ".CCoC...iimmmmm.",
    ".CCCC.....mmmm..",
    ".CCCC.......ww..",
    ".............ww.",
    "..............w.",
    "................",
    "................",
    "................",
  ],
  // Closed by the server (flood/policy): a cream mug with the paused lamp's two plum bars on it and steam curling up.
  // "Take a breather": its own motif, so the snail only ever means "too fast". Resting, not broken.
  resting: [
    "................",
    "......i...i.....",
    "......i...i.....",
    ".....i...i......",
    ".....i...i......",
    "................",
    "..cccccccccc....",
    "..cWWWWWWWWc....",
    "..cccccccccccc..",
    "..cccoccoccc..c.",
    "..cccoccoccc..c.",
    "..cccoccocccccc.",
    "..cccccccccc....",
    "...cccccccc.....",
    "................",
    "................",
  ],
};

// Room-list door thumbnails, 16×24 (bottom-aligned, anchor bottom centre).
const DOORS: Record<string, readonly string[]> = {
  // Open: the door swung in, warm lamplight in the gap, a little light on the floor.
  open: [
    "................",
    "..wwwwwwwwwwww..",
    "..wyyyyyywwwww..",
    "..wyyyyyywWWww..",
    "..wyyyyyywWWww..",
    "..wyyyyyywwwww..",
    "..wyyyyyywwwww..",
    "..wyyyyyywWWww..",
    "..wyyyyyywWWww..",
    "..wyyyyyywwwww..",
    "..wyyyyyywwwww..",
    "..wyyyyyywwmww..",
    "..wyyyyyywwwww..",
    "..wyyyyyywWWww..",
    "..wyyyyyywWWww..",
    "..wyyyyyywwwww..",
    "..wyyyyyywWWww..",
    "..wyyyyyywWWww..",
    "..wyyyyyywwwww..",
    "..wyyyyyywwwww..",
    "..wwwwwwwwwwww..",
    ".yyyyyyy........",
    "................",
    "................",
  ],
  // Full: the door is shut, and a cream hanger on the knob carries three little heads: "everyone's in".
  full: [
    "................",
    "..wwwwwwwwwwww..",
    "..wwwwwwwwwwww..",
    "..wwWWWWWWWWww..",
    "..wwWwwwwwwWww..",
    "..wwWwwwwwwWww..",
    "..wwWwwwwwwWww..",
    "..wwWWWWWWWWww..",
    "..wwwwwwwwwwww..",
    "..wwwwwwwmwwww..",
    "..wwwwwwwowwww..",
    "..wwwwwwoCowww..",
    "..wwwwwcccccww..",
    "..wwwwwcmctcww..",
    "..wwwwwcccccww..",
    "..wwwwwcrcccww..",
    "..wwwwwcccccww..",
    "..wwWWWWWWWWww..",
    "..wwWwwwwwwWww..",
    "..wwWWWWWWWWww..",
    "..wwwwwwwwwwww..",
    "................",
    "................",
    "................",
  ],
};

/** The same round arrow drawn at 32×32 for the popup's 2× (hi-dpi) key icon: not an upscale, a shaded 4 px stroke
 *  with a real arrowhead, and the same gap at the top right. */
const RETRY_2X: readonly string[] = [
  "................................",
  "................................",
  "................m...............",
  "................mm..............",
  "...........mmmmmmmm.............",
  ".........mmmmmmmmmmm............",
  "........mmmmmmmmmmmm............",
  ".......mmmmmmmmmmmm.............",
  "......mmmmmmm...mm..............",
  ".....mmmmmm.....m...............",
  "................................",
  "....mmmmm...............mmmm....",
  "....mmmmm..............mmmmm....",
  "....mmmm................mmmm....",
  "....mmmm................mmmm....",
  "....mmmm................mmmm....",
  "....mmmm................mmmm....",
  "....mmmm................mmmm....",
  "....mmmm................mmmm....",
  "....mmmmm..............mmmmm....",
  "....mmmmm..............mmmmm....",
  ".....mmmmm............mmmmm.....",
  ".....mmmmmm..........mmmmmm.....",
  "......mmmmmmm......mmmmmmm......",
  ".......mmmmmmmmmmmmmmmmmm.......",
  "........mmmmmmmmmmmmmmmm........",
  ".........mmmmmmmmmmmmmm.........",
  "...........mmmmmmmmmm...........",
  "................................",
  "................................",
  "................................",
  "................................",
];

export function buildSafetyFrames(): UiFrame[] {
  const out: UiFrame[] = [coolKey(), selfLine(), card("idle"), card("hover"), card("full"), fullPill()];
  for (let n = 0; n < WAIT_FRAMES; n++) out.push(waitRing(n));
  for (const [name, rows] of Object.entries(WIDE_GLYPHS)) out.push(art(`glyph/${name}`, rows));
  for (const [name, rows] of Object.entries(GLYPHS)) out.push(art(name.startsWith("dot/") ? name : `glyph/${name}`, rows));
  for (const [name, rows] of Object.entries(ICONS)) out.push(art(`icon/${name}`, rows));
  out.push(art("icon/retry-2x", RETRY_2X));
  for (const [name, rows] of Object.entries(DOORS)) out.push(art(`door/${name}`, rows, 8, 24));
  return out;
}

/** Reconnecting dots (`glyph/dots/0..2`), ms per frame, loop. */
export const DOTS_FRAME_MS = 240;

/** Standalone PNGs for the extension popup (plain HTML, no sprite sheet): `ui/popup/<name>.png`. */
export const POPUP_ICONS = { "retry-16": "icon/retry", "retry-32": "icon/retry-2x" } as const;

const u = (n: number): string => (n === 0 ? "0" : `calc(${String(n)} * var(--ui-px))`);

/** Set (f) rules appended to `ui/reference.css`. */
export function safetyCss(rects: Readonly<Record<string, { x: number; y: number }>>): string {
  const at = (k: string): string => {
    const r = rects[k];
    if (!r) throw new Error(`missing ${k}`);
    return `${u(-r.x)} ${u(-r.y)}`;
  };
  const slice = (k: string): string => `url("slices/${k.replace(/\//g, "-")}.png")`;
  const nineRule = (k: string, b: number): string =>
    `border-style: solid; border-color: transparent; border-width: ${u(b)}; border-image: ${slice(k)} ${String(b)} fill / ${u(b)} stretch;`;
  const src = (k: string): string => `border-image-source: ${slice(k)};`;
  const waitVars = Array.from({ length: WAIT_FRAMES }, (_, n) => `--w${String(n)}: ${at(`wait/${String(n)}`)};`).join(" ");
  const waitKeys = Array.from({ length: WAIT_FRAMES }, (_, n) => `${String((n * 100) / WAIT_FRAMES)}% { background-position: var(--w${String(n)}); }`).join(" ");
  const dotVars = [0, 1, 2].map((n) => `--d${String(n)}: ${at(`glyph/dots/${String(n)}`)};`).join(" ");
  return `
/* ---- Set (f) (OME-193): M3 safety states. Friendly waits, never alarms: no rust, no warn icon.
 * Snail = too fast. Round arrow = try your share again. Timer dial = how long to wait. Mustard bar = only you see this.
 * Plug = network dropped. Mug = the room paused you, take a breather. Shut door = room full. */

/* Slow down: a rate-limited shared key rests (darker wood, charcoal lip) and its icon becomes the timer dial, which drains once
 * over --cool (the server's retry-after). Use aria-disabled="true" (not disabled) so it keeps focus and its label, e.g.
 * "Pause for everyone: available again in 3 seconds". Remove .is-cooling when the dial is empty. */
.ui-button.shared.is-cooling { ${src("button/shared/cool")} cursor: default; padding: 0 0 ${u(2)}; }
.ui-wait { ${waitVars} width: ${u(16)}; height: ${u(16)}; background-position: var(--w0); animation: ui-wait var(--cool, 3s) steps(1) 1 both; }
@keyframes ui-wait { ${waitKeys} 100% { background-position: var(--w${String(WAIT_FRAMES - 1)}); } }
/* The slow-down chip is a .ui-chip.self (it only slows you): glyph/snail + "Slow down". Put it where .ui-live-note / the seek's
 * left end would be, and drop it with the dial. */

/* A line only you see (e.g. your share didn't go through): the system strip with the mustard "you" bar. */
.ui-sysline.self { border-image-source: ${slice("chat/system-self")}; }
.ui-sysline.self b { color: var(--ui-accent); }

/* Connection. Normal drop: dot/connecting + "Reconnecting" + the dots loader, no button (it retries by itself).
 * Closed by the server (flood/policy): dot/paused + icon/resting in a panel notice, and a primary "Rejoin" key that waits out
 * the server's delay ("Rejoin in 20 s") before it lights up. Different lamp, icon, motion and action, and neither is rust.
 * While it waits the key is .is-waiting with aria-disabled="true": the charcoal disabled face but full cream text (9:1, not the
 * disabled text's floor), because the countdown is something to read, not a dead control. */
.ui-button.is-waiting { ${src("button/primary/disabled")} color: var(--ui-text); cursor: default; padding-top: 0; padding-bottom: ${u(2)}; }
.ui-dots { ${dotVars} width: ${u(12)}; height: ${u(8)}; background-position: var(--d0); animation: ui-dots ${String(DOTS_FRAME_MS * 3)}ms steps(1) infinite; }
@keyframes ui-dots { 0% { background-position: var(--d0); } 33.333% { background-position: var(--d1); } 66.667% { background-position: var(--d2); } }

/* Room-list card: dusk glass in a wood rim, door thumbnail on the left. .is-full dims it and shuts the door. */
.ui-card { ${nineRule("card/room/idle", 6)} display: flex; align-items: center; gap: ${u(4)}; padding: ${u(1)} ${u(2)}; color: var(--ui-text); image-rendering: pixelated; box-sizing: border-box; }
a.ui-card:hover, a.ui-card:focus-visible, .ui-card.is-hover { ${src("card/room/hover")} outline: none; }
.ui-card.is-full { ${src("card/room/full")} color: var(--ui-muted); }
.ui-pill-full { ${nineRule("pill/full", 4)} display: inline-flex; align-items: center; padding: 0 ${u(1)}; color: var(--ui-text); font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; line-height: 1; white-space: nowrap; image-rendering: pixelated; box-sizing: border-box; }
.ui-room .ui-pill-full { font-size: 9px; }
@media (prefers-reduced-motion: reduce) { .ui-dots { animation: none; } .ui-wait { animation: none; background-position: var(--w0); } }
`;
}
