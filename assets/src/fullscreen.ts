// Set (k) (OME-541), M7: full screen with a chat strip (desktop and phone), the pop-out chat / room windows and the
// phone watch-only layout. Same palette, plum outline and top-left light as sets (c)/(e)/(f)/(h)/(i)/(j). One meaning per motif:
//   corner brackets = full screen. They are set (c)'s "free seat" brackets: out = make the picture big, in = put it back.
//   mustard         = only you (sets e/f/h/i): full screen, the strip and the pop-outs change only your own view, so their keys are
//                     personal keys and their arrows are mustard. Nobody else's screen moves.
//   the strip       = the TV cabinet's side panel: dusk glass with a wood spine on the picture's side. It stands beside the
//                     player, never over it (ADR 0012: the player is sacred, even in full screen).
//   fading          = a message ages by tone, not by alpha: fresh (cream card) → settled (night card) → faded (words only) → gone.
//                     Each step swaps through set (i)'s 1-bit dither for one frame; with reduced motion it swaps at once.
//   a little window = "in its own window": pop out carries a bubble (chat) or a floor tile (room) out through a wood window frame;
//                     the placeholder left behind shows that window from the room's side, with a ghost of what went through it.
// No new colours: still the 67.
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import { blank, render, stamp, type Grid, type RoleMap } from "./sprite";
import { all, lit, nine, slab, type UiFrame } from "./ui";

const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const O = OUTLINE;

const ROLES: RoleMap = {
  c: { ramp: "cream", hi: true },
  C: { ramp: "cream", tone: 2 },
  m: { ramp: "mustard", hi: true },
  w: { ramp: "wood", hi: true },
  // Window panes and screens: flat tones grouped with the wood, so the frame's auto shade rings the set, not the glass.
  n: { ramp: "night", tone: 2, group: "w" },
  N: { ramp: "night", tone: 1, group: "w" },
  g: { ramp: "glow", tone: 0, group: "w" },
  G: { ramp: "glow", tone: 2, group: "w" },
  k: { ramp: "cream", tone: 0, group: "w" },
  K: { ramp: "cream", tone: 2, group: "w" },
  o: { ramp: "outline", tone: 1, group: "w" },
  f: { ramp: "floor", tone: 0, group: "w" },
  F: { ramp: "floor", tone: 2, group: "w" },
  v: { ramp: "velvet", tone: 1, group: "w" },
  V: { ramp: "velvet", tone: 2, group: "w" },
  y: { ramp: "mustard", tone: 0, group: "w" },
  // Ghosts: flat cream shade dashes on their own (the auto outline still rings each dash).
  h: { ramp: "cream", tone: 2 },
};

// ------------------------------------------------------------------ tiny raster helpers (role letters on a grid)

function put(g: Grid, x: number, y: number, ch: string): void {
  const r = g[y];
  if (r && x >= 0 && x < r.length) r[x] = ch;
}
function fill(g: Grid, x0: number, y0: number, w: number, h: number, ch: string): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(g, x, y, ch);
}
function box(g: Grid, x0: number, y0: number, w: number, h: number, ch: string): void {
  fill(g, x0, y0, w, 1, ch); fill(g, x0, y0 + h - 1, w, 1, ch); fill(g, x0, y0, 1, h, ch); fill(g, x0 + w - 1, y0, 1, h, ch);
}
function frame(key: string, g: Grid, ax: number, ay: number): UiFrame {
  return { key, w: g[0]?.length ?? 0, h: g.length, img: render(g, ROLES), ax, ay };
}

// ------------------------------------------------------------------ icons (16×16, auto shade + outline, like set c)

/** Full screen: set (c)'s seat-cursor corner brackets around a small glow picture. `out` = brackets at the corners (make it big),
 *  `in` = brackets turned inward round a smaller picture (put it back). The bracket arms are 2 px so they hold at 1×. */
function fullscreenIcon(dir: "out" | "in"): UiFrame {
  const g = blank(16, 16);
  if (dir === "out") {
    // A 6×4 picture in a wood bezel, centred.
    box(g, 4, 5, 8, 6, "w"); fill(g, 5, 6, 6, 4, "g"); fill(g, 5, 8, 6, 2, "G");
    for (const [x, y, sx, sy] of [[1, 1, 1, 1], [14, 1, -1, 1], [1, 14, 1, -1], [14, 14, -1, -1]] as const) {
      fill(g, Math.min(x, x + 3 * sx), y, 4, 1, "c"); fill(g, x, Math.min(y, y + 2 * sy), 1, 3, "c");
    }
  } else {
    box(g, 5, 6, 6, 4, "w"); fill(g, 6, 7, 4, 2, "g");
    for (const [x, y, sx, sy] of [[3, 3, -1, -1], [12, 3, 1, -1], [3, 12, -1, 1], [12, 12, 1, 1]] as const) {
      // An L whose corner points at the picture: arm along x away from the centre, arm along y away from the centre.
      fill(g, Math.min(x, x + 2 * sx), y, 3, 1, "c"); fill(g, x, Math.min(y, y + 2 * sy), 1, 3, "c");
    }
  }
  return frame(`icon/fullscreen${dir === "in" ? "-exit" : ""}`, g, 8, 8);
}

/** The strip: a picture with its side panel. `hide` = the panel holds message lines and a mustard arrow pushes it off to the right
 *  (collapse to the input bar). `show` = the panel is empty and the arrow pulls it back in. */
function stripIcon(state: "hide" | "show"): UiFrame {
  const g = blank(16, 16);
  box(g, 1, 1, 14, 9, "w");
  fill(g, 2, 2, 8, 7, "g"); fill(g, 2, 6, 8, 3, "G");
  put(g, 10, 2, "w"); fill(g, 10, 2, 1, 7, "w");
  fill(g, 11, 2, 3, 7, "n");
  if (state === "hide") { fill(g, 11, 3, 3, 1, "k"); fill(g, 11, 5, 2, 1, "k"); fill(g, 11, 7, 3, 1, "K"); }
  // Arrow under the set: shaft 2 px, head 3 rows each side.
  const right = state === "hide";
  const tip = right ? 13 : 2;
  const sx = right ? -1 : 1;
  fill(g, right ? 3 : 5, 12, 8, 2, "m");
  // The head: columns 2, 4, 6 px tall stepping back from the tip, a clean triangle at 1×.
  for (let k = 0; k < 3; k++) fill(g, tip + sx * k, 12 - k, 1, 2 + 2 * k, "m");
  return frame(`icon/strip-${state}`, g, 8, 8);
}

/** A 2 px diagonal mustard arrow on the 1:1 diagonal through the window's open corner. `out` leaves it (head up-right, at the
 *  icon's corner); `back` comes in (head down-left, sitting in the frame's gap, clear of what's in the pane). */
function diagArrow(g: Grid, out: boolean): void {
  if (out) {
    // The shaft stops at the pane's top half, so it never crosses what's in the window.
    for (let y = 4; y <= 8; y++) { put(g, 15 - y, y, "m"); put(g, 16 - y, y, "m"); }
    for (let r = 0; r < 5; r++) fill(g, 10 + r, 1 + r, 5 - r, 1, "m");
  } else {
    for (let y = 1; y <= 4; y++) { put(g, 13 - y, y, "m"); put(g, 14 - y, y, "m"); }
    for (let r = 0; r < 5; r++) fill(g, 7, 8 - r, 5 - r, 1, "m");
  }
}

/** Pop out / bring back: a wood window frame with night glass, open at its top-right corner, and the mustard arrow.
 *  `chat` puts a tiny cream bubble in the pane, `room` a floor tile with a velvet seat, so the two pop-outs read apart. */
function windowIcon(what: "chat" | "room", out: boolean): UiFrame {
  const g = blank(16, 16);
  // Frame: top edge stops short of the corner, right edge starts below it: the gap is where the arrow passes.
  fill(g, 1, 5, 7, 1, "w"); fill(g, 1, 5, 1, 10, "w"); fill(g, 1, 14, 11, 1, "w"); fill(g, 11, 10, 1, 5, "w");
  fill(g, 2, 6, 9, 8, "n"); fill(g, 2, 6, 6, 1, "N");
  if (what === "chat") {
    fill(g, 3, 9, 5, 3, "k"); put(g, 4, 12, "k");
    put(g, 4, 10, "o"); put(g, 6, 10, "o");
  } else {
    // A 2:1 floor tile with a seat on it.
    // A 2:1 floor tile (lit top-left half, shade bottom-right) with a velvet seat on it.
    fill(g, 5, 11, 2, 1, "f"); fill(g, 3, 12, 6, 1, "f"); fill(g, 5, 13, 2, 1, "F"); fill(g, 7, 12, 2, 1, "F");
    fill(g, 4, 9, 3, 2, "v"); put(g, 4, 8, "v");
  }
  diagArrow(g, out);
  return frame(`icon/${what === "chat" ? "popout" : "popout-room"}${out ? "" : "-back"}`, g, 8, 8);
}

// ------------------------------------------------------------------ 9-slices

/** The full-screen strip: dusk glass with the TV cabinet's wood spine on its picture side (left). */
function strip(): UiFrame {
  const W = 16;
  // The spine runs the full height (its columns win over the top/bottom rims), so the left slice stretches cleanly.
  const SPINE = [O, c("wood", 0), c("wood", 1), c("wood", 2), O];
  const img = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const glass = y === 0 || y === W - 1 || x === W - 1 ? O
      : y === 1 ? c("night", 0)
      : y === W - 2 || x === W - 2 ? c("night", 1)
      : c("night", 2);
    img[y * W + x] = SPINE[x] ?? glass;
  }
  return nine("fs/strip", W, W, img, { left: 5, top: 2, right: 2, bottom: 2 });
}

/** A message line in the strip. fresh = cream card (people talking, like the room's bubbles, without the tail);
 *  settled = the same card in night glass with a cream-shade lip, cream words. Faded has no card at all (CSS only). */
function line(state: "fresh" | "settled"): UiFrame {
  const W = 12;
  const img = slab(W, W, 2, (d, e) => {
    if (d === 0) return O;
    if (state === "fresh") return d === 1 ? (lit(e) ? c("cream", 0) : c("cream", 2)) : c("cream", 1);
    return d === 1 ? (lit(e) ? c("night", 0) : c("cream", 2)) : c("night", 1);
  });
  return nine(`fs/line/${state}`, W, W, img, all(4));
}

/** "Your own view" frame round a popped-out window's content: a 2 px mustard rim (set e's panel-self, thinner), so the second
 *  window says "this is yours" the moment it opens on the other monitor. */
function popRim(): UiFrame {
  const W = 14;
  const img = slab(W, W, 2, (d, e) => {
    if (d === 0) return O;
    if (d === 1) return lit(e) ? c("mustard", 0) : c("mustard", 2);
    if (d === 2) return O;
    return c("charcoal", 2);
  });
  return nine("fs/pop", W, W, img, all(6));
}

// ------------------------------------------------------------------ vignettes (lazy, ui/scenes/*.png): what's left in the page

/** 20×22, the room as seen through the room-away window (stamped into its pane). */
const ROOM_PANE = [
  "NNNNNNNNNNNNNNNNNNNN",
  "NNNNNNNNNNNNNNNNNNNN",
  "NNNNNNNNNNNNNNNNNNNN",
  "nnnnnwwwwwwwwwwnnnnn",
  "nnnnnwggggggggwnnnnn",
  "nnnnnwggggggggwnnnnn",
  "nnnnnwgGGGGGGgwnnnnn",
  "nnnnnwwwwwwwwwwnnnnn",
  "nnnnnnnnnwwnnnnnnnnn",
  "nnnnnnnnnffnnnnnnnnn",
  "nnnnnnnffffffnnnnnnn",
  "nnnnnvvvvffvvvvnnnnn",
  "nnnffvvvvffvvvvffnnn",
  "nffffVVVVffVVVVffffn",
  "nnnFFFFFFFFFFFFFFnnn",
  "nnnnnFFFFFFFFFFnnnnn",
  "nnnnnnnFFFFFFnnnnnnn",
  "nnnnnnnnnFFnnnnnnnnn",
  "nnnnnnnnnnnnnnnnnnnn",
  "nnnnnnnnnnnnnnnnnnnn",
  "nnnnnnnnnnnnnnnnnnnn",
  "nnnnnnnnnnnnnnnnnnnn",
];

/** 56×40: the room's wall with a wood-framed window. Through it, on the far side, is what went away (a bubble or the room's floor);
 *  on this side, where it used to hang, a dashed ghost of it. A mustard arrow (only you moved it) points at the window. */
function awayScene(what: "chat" | "room"): UiFrame {
  const W = 56, H = 40;
  const g = blank(W, H);
  // The window, right: frame, sill, cross bar.
  box(g, 30, 4, 24, 26, "w"); box(g, 31, 5, 22, 24, "w");
  // The chat window has a cross bar (two panes, a bubble in each); the room's is one wide pane, so the floor reads whole.
  fill(g, 32, 6, 20, 22, "n"); fill(g, 32, 6, 20, 3, "N"); if (what === "chat") fill(g, 41, 6, 2, 22, "w");
  fill(g, 28, 30, 28, 3, "w");
  if (what === "chat") {
    // Two cream bubbles beyond the glass, one on each pane, with plum dots: the talking carries on over there.
    fill(g, 33, 11, 7, 5, "k"); put(g, 35, 16, "k"); put(g, 34, 13, "o"); put(g, 36, 13, "o"); put(g, 38, 13, "o");
    fill(g, 44, 17, 7, 5, "k"); put(g, 49, 22, "k"); put(g, 46, 19, "o"); put(g, 48, 19, "o");
  } else {
    // The room seen through the one wide pane: the TV's glow on the back wall, a 2:1 honey floor (lit far half, shade near
    // half) and two velvet club chairs facing the glow, backs to us, the way seated viewers are drawn.
    stamp(g, ROOM_PANE, 32, 6);
  }
  // This side: the ghost, dashed cream shade (every other pixel), where the chat or the room used to be.
  const ghost = (x0: number, y0: number, w: number, h: number): void => {
    for (let x = x0; x < x0 + w; x++) { if ((x - x0) % 3 !== 2) { put(g, x, y0, "h"); put(g, x, y0 + h - 1, "h"); } }
    for (let y = y0; y < y0 + h; y++) { if ((y - y0) % 3 !== 2) { put(g, x0, y, "h"); put(g, x0 + w - 1, y, "h"); } }
  };
  if (what === "chat") { ghost(2, 8, 18, 11); put(g, 6, 19, "h"); put(g, 6, 21, "h"); }
  else {
    for (let r = 0; r < 7; r++) { const half = 2 * r + 1; for (const x of [11 - half, 11 + half - 1]) if (r % 3 !== 2) put(g, x, 6 + r, "h"); }
    for (let r = 0; r < 7; r++) { const half = 2 * (6 - r) + 1; for (const x of [11 - half, 11 + half - 1]) if (r % 3 !== 2) put(g, x, 13 + r, "h"); }
  }
  // Mustard arrow from the ghost to the window: shaft 2 px, head 3 columns.
  fill(g, 5, 27, 18, 2, "m");
  for (let k = 0; k < 3; k++) fill(g, 23 + k, 25 + k, 1, 6 - 2 * k, "m");
  return { key: `scene/${what}-away`, w: W, h: H, img: render(g, ROLES), ax: W / 2, ay: H / 2 };
}

export function buildFullscreenFrames(): UiFrame[] {
  return [
    fullscreenIcon("out"), fullscreenIcon("in"),
    stripIcon("hide"), stripIcon("show"),
    windowIcon("chat", true), windowIcon("chat", false), windowIcon("room", true), windowIcon("room", false),
    strip(), line("fresh"), line("settled"), popRim(),
  ];
}

export function buildFullscreenScenes(): UiFrame[] {
  return [awayScene("chat"), awayScene("room")];
}

// ------------------------------------------------------------------ reference CSS

const u = (n: number): string => (n === 0 ? "0" : `calc(${String(n)} * var(--ui-px))`);

/** Message ages, in ms after it arrives (meta for engineering; the CSS below only styles the states). */
export const STRIP_AGES = { settled: 6000, faded: 20000, gone: 45000, ditherMs: 120 } as const;

/** Set (k) rules appended to `ui/reference.css`. */
export function fullscreenCss(): string {
  const slice = (k: string): string => `url("slices/${k.replace(/\//g, "-")}.png")`;
  const nineRule = (k: string, b: readonly [number, number, number, number]): string =>
    `border-style: solid; border-color: transparent; border-width: ${b.map(u).join(" ")}; border-image: ${slice(k)} ${b.join(" ")} fill / ${b.map(u).join(" ")} stretch;`;
  return `
/* ---- Set (k) (OME-541), M7: full screen with a chat strip, pop-out windows, the phone watch-only layout.
 * The player is sacred (ADR 0012) in full screen too: the strip, the band and the phone's chat column stand beside or below the
 * player rect, never over it. Full screen, the strip and pop-outs only change your own view, so their keys are .ui-button.self
 * (night face, mustard rim) with icon/fullscreen(-exit), icon/strip-hide|show, icon/popout(-back), icon/popout-room(-back). */
.ui-fs, .ui-fs-strip, .ui-fs-line, .ui-pop { image-rendering: pixelated; box-sizing: border-box; }

/* The full-screen element is our wrapper (video + strip), never the provider's iframe: <div class="ui-fs" data-strip="open|band">.
 * Fill the screen with the page colour; the player keeps 16:9 and the largest size that leaves the strip (open) or the band
 * (collapsed) clear. Esc always leaves full screen (the browser owns it); a draft in the field survives. */
.ui-fs { position: fixed; inset: 0; background: var(--ui-page); display: grid; grid-template-columns: minmax(0, 1fr) var(--ui-fs-strip-w, 300px); grid-template-rows: minmax(0, 1fr) auto; }
.ui-fs[data-strip="band"] { grid-template-columns: minmax(0, 1fr); }

/* The strip: the TV cabinet's side panel. Head (icon/chat "Chat" · people · strip-hide key), the lines, the input at the foot. */
.ui-fs-strip { ${nineRule("fs/strip", [2, 2, 2, 5])} display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: ${u(3)}; padding: ${u(2)} ${u(3)} ${u(3)} ${u(3)}; color: var(--ui-text); }
.ui-fs-lines { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; justify-content: flex-end; gap: ${u(2)}; overflow: hidden; }

/* A line ages by tone, never by alpha: .ui-fs-line (fresh) → .is-settled (${String(STRIP_AGES.settled / 1000)} s) → .is-faded (${String(STRIP_AGES.faded / 1000)} s) → removed from the strip
 * (${String(STRIP_AGES.gone / 1000)} s; it stays in the log). Each change shows one frame of .is-turning (set i's 1-bit dither over the card, ${String(STRIP_AGES.ditherMs)} ms).
 * Hovering or focusing the strip pins it: no line ages while you read, and older lines come back (.is-faded lines show as settled). */
.ui-fs-line { ${nineRule("fs/line/fresh", [4, 4, 4, 4])} width: fit-content; max-width: 100%; padding: 0 ${u(1)}; color: var(--ui-bubble-text); font-size: 13px; font-weight: 500; line-height: 1.3; overflow-wrap: anywhere; position: relative; }
.ui-fs-line b { font-weight: 700; }
.ui-fs-line.is-settled { border-image-source: ${slice("fs/line/settled")}; color: var(--ui-text); }
.ui-fs-line.is-settled b { color: var(--ui-muted); }
.ui-fs-line.is-faded { border-image-source: none; border-color: transparent; color: var(--ui-muted); }
.ui-fs-line.is-faded b { color: var(--ui-muted); }
.ui-fs-line.is-turning::after { content: ""; position: absolute; inset: calc(-4 * var(--ui-px)); background: ${slice("scrim/0")} 0 0 / ${u(2)} ${u(4)}; }
.ui-fs-strip:hover .ui-fs-line.is-faded, .ui-fs-strip:focus-within .ui-fs-line.is-faded, .ui-fs-strip.is-pinned .ui-fs-line.is-faded { border-image-source: ${slice("fs/line/settled")}; border-color: transparent; color: var(--ui-text); }
@media (prefers-reduced-motion: reduce) { .ui-fs-line.is-turning::after { content: none; } }

/* Collapsed: the strip folds into the band under the picture. The band is the TV shelf (.ui-tv-shelf) at full width:
 * transport left, then the chat field + Send, the unread chip (.ui-chip.self "3 new") on the strip-show key, and the full-screen key. */
.ui-fs-band { display: flex; align-items: center; gap: ${u(4)}; }
.ui-fs-band .ui-input { flex: 1 1 ${u(220)}; min-width: ${u(120)}; font: inherit; font-weight: 500; }

/* Pop-out windows (desktop only): the window's content sits in .ui-pop (a mustard "only you" rim), so it reads as yours on the
 * other monitor. Chat-only: the log + the input. Whole room: the 960×600 stage (Pixi) + the log + the input, no player. */
.ui-pop { ${nineRule("fs/pop", [6, 6, 6, 6])} color: var(--ui-text); }

/* What stays in the page: <div class="ui-panel ui-away"> scene + one line + the bring-back key (.ui-button.self). */
.ui-away { display: grid; justify-items: center; gap: ${u(3)}; text-align: center; }
.ui-away p { margin: 0; font-size: 13px; font-weight: 500; color: var(--ui-muted); }
.ui-scene-chat-away, .ui-scene-room-away { width: ${u(56)}; height: ${u(40)}; background-size: 100% 100%; }
.ui-scene-chat-away { background-image: url("scenes/chat-away.png"); }
.ui-scene-room-away { background-image: url("scenes/room-away.png"); }
`;
}
