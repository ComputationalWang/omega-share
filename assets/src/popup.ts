// OME-842: the extension popup's three empty/error states as small vignettes beside their one line of text. The popup is plain
// HTML on white, so each is a standalone PNG (48×40, plus an exact 2× for HiDPI) with transparent ground and every piece in its own
// 1 px plum outline. Each one has one job:
//   nothing-found = a page with a dashed ghost where a video would be, and the magnifier that looked (dashed = missing, as in
//                   set (i)'s ghost ticket and the not-found scene; charcoal, not cream, so it holds on the cream page).
//   cant-read     = a page whose lines sit behind a brass padlock: the browser keeps this tab to itself.
//   server-away   = the wood TV (the product mark) with a dark screen and its cord pulled out of the wall socket.
import { blank, render, upscale, type Grid, type RoleMap } from "./sprite";

export const POPUP_VIGNETTE = { w: 48, h: 40 } as const;
export const POPUP_STATES = ["nothing-found", "cant-read", "server-away"] as const;
export type PopupState = (typeof POPUP_STATES)[number];

export interface PopupFile { file: string; w: number; h: number; img: Uint8Array }

const ROLES: RoleMap = {
  // Browser: navy tab strip, a cream active tab, a cream page (auto-lit) and its charcoal-free text bars.
  n: { ramp: "navy", tone: 2 },
  t: { ramp: "cream", tone: 1 },
  p: { ramp: "cream", hi: true },
  l: { ramp: "cream", tone: 2 },
  // The ghost's dashes: darker than the text bars, so "a video goes here" doesn't read as more text.
  d: { ramp: "charcoal", tone: 0 },
  // Brass and wood.
  m: { ramp: "mustard", hi: true },
  M: { ramp: "mustard", tone: 2 },
  w: { ramp: "wood", hi: true },
  W: { ramp: "wood", tone: 2 },
  // Glass, screen, shackle, socket.
  g: { ramp: "glow", tone: 0 },
  G: { ramp: "glow", tone: 1 },
  k: { ramp: "night", tone: 2 },
  K: { ramp: "night", tone: 1 },
  x: { ramp: "charcoal", hi: true },
  // A greyed page (one the browser keeps to itself) and its dim lines.
  s: { ramp: "charcoal", hi: true, group: "s" },
  S: { ramp: "charcoal", tone: 2, group: "s" },
  c: { ramp: "cream", hi: true, group: "c" },
  C: { ramp: "cream", tone: 2, group: "c" },
  o: { ramp: "outline", tone: 1 },
};

/** One piece on its own grid the size of the vignette, so render() rings it in plum. */
class Piece {
  readonly g: Grid = blank(POPUP_VIGNETTE.w, POPUP_VIGNETTE.h);
  rect(x: number, y: number, w: number, h: number, ch: string): this {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const row = this.g[yy]; if (row && xx >= 0 && xx < row.length) row[xx] = ch; }
    return this;
  }
  put(x: number, y: number, ch: string): this { return this.rect(x, y, 1, 1, ch); }
  disc(cx: number, cy: number, r: number, ch: string): this {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < r) this.put(x, y, ch);
    return this;
  }
}

/** Later pieces sit on earlier ones, outline and all. */
function compose(pieces: readonly Piece[]): Uint8Array {
  const out = new Uint8Array(POPUP_VIGNETTE.w * POPUP_VIGNETTE.h);
  for (const p of pieces) render(p.g, ROLES).forEach((v, i) => { if (v !== 0) out[i] = v; });
  return out;
}

/** A small browser window: tab strip, one tab, the page. Returns the page's top-left. */
function browser(x: number, y: number, w: number, h: number, page = "p"): { piece: Piece; px: number; py: number } {
  const piece = new Piece().rect(x, y, w, 5, "n").rect(x + 2, y + 1, 12, 4, page === "p" ? "t" : "x").rect(x, y + 5, w, h - 5, page);
  for (const [i, ch] of [[0, "m"], [1, "l"]] as const) piece.put(x + w - 6 + i * 3, y + 2, ch);
  return { piece, px: x, py: y + 5 };
}

function nothingFound(): Uint8Array {
  const { piece: b, px, py } = browser(2, 2, 36, 32);
  b.rect(px + 3, py + 3, 16, 2, "l");
  // The ghost of the video it hoped for: a dashed frame (2 on, 1 off), nothing inside.
  const gx = px + 3, gy = py + 8, gw = 20, gh = 14;
  for (let x = gx; x < gx + gw; x++) if ((x - gx) % 3 !== 2) { b.put(x, gy, "d"); b.put(x, gy + gh - 1, "d"); }
  for (let y = gy; y < gy + gh; y++) if ((y - gy) % 3 !== 2) { b.put(gx, y, "d"); b.put(gx + gw - 1, y, "d"); }
  for (const [dy, len] of [[8, 7], [12, 8], [16, 5]] as const) b.rect(px + 26, py + dy, len, 2, "l");
  // The magnifier that looked: a brass ring with clear glass, a glint, and a wood handle down to the right.
  const lens = new Piece().disc(35, 25.5, 7.5, "m").disc(35, 25.5, 5.2, "g");
  lens.rect(32, 22, 2, 1, "c").put(32, 23, "c");
  for (const [x, y] of [[33, 28], [34, 28], [35, 27], [36, 26], [37, 26], [37, 25]] as const) lens.put(x, y, "G");
  for (let i = 0; i < 5; i++) lens.rect(40 + i, 30 + i, 3, 1, i === 0 ? "M" : "w").put(42 + i, 31 + i, "W");
  return compose([b, lens]);
}

function cantRead(): Uint8Array {
  // A greyed window, wider than nothing-found's, its lines dim: a page the browser keeps to itself.
  const { piece: b, px, py } = browser(2, 2, 44, 32, "s");
  b.rect(px + 4, py + 3, 20, 2, "S");
  for (let i = 0; i < 5; i++) b.rect(px + 4, py + 8 + i * 4, i === 4 ? 22 : 36 - ((i * 7) % 9), 2, "S");
  // Brass padlock over the page: a cream (steel-bright) shackle that holds on the grey, a brass body with a plum keyhole.
  const lock = new Piece();
  const cx = 24, top = 13;
  lock.rect(cx - 6, top + 2, 2, 7, "c").rect(cx + 4, top + 2, 2, 7, "c").rect(cx - 5, top, 10, 2, "c").rect(cx - 4, top - 1, 8, 1, "c");
  lock.rect(cx - 9, top + 8, 18, 14, "m");
  lock.rect(cx - 1, top + 12, 2, 4, "o").rect(cx - 2, top + 12, 4, 2, "o").rect(cx - 1, top + 16, 2, 2, "o");
  lock.rect(cx - 9, top + 21, 18, 1, "M").rect(cx + 8, top + 8, 1, 14, "M");
  return compose([b, lock]);
}

function serverAway(): Uint8Array {
  // The wood TV: cabinet, dark screen with a cream glint, the power lamp off, two feet.
  const tv = new Piece().rect(2, 6, 26, 24, "w").rect(5, 9, 20, 15, "k").rect(6, 10, 18, 13, "K").rect(5, 9, 20, 1, "k");
  tv.rect(7, 11, 3, 1, "c").put(7, 12, "c");
  tv.rect(5, 25, 9, 2, "W").put(23, 26, "x").put(22, 26, "x");
  tv.rect(5, 30, 4, 3, "W").rect(21, 30, 4, 3, "W");
  // Antenna: two charcoal rods from a wood knob.
  const ant = new Piece().rect(13, 4, 4, 2, "w");
  for (let i = 0; i < 3; i++) { ant.put(12 - i, 3 - i, "x"); ant.put(17 + i, 3 - i, "x"); }
  // The cord: out of the back, down to the floor, ending in a big plug held clear of the socket. Brass prongs, 3 px long.
  const cord = new Piece().rect(28, 24, 2, 1, "x").rect(29, 25, 1, 11, "x").rect(29, 35, 3, 1, "x");
  cord.rect(31, 29, 6, 9, "x").rect(37, 31, 3, 2, "m").rect(37, 35, 3, 2, "m");
  // The wall socket: a tall cream plate with two dark slots level with the prongs, 3 px of air between them.
  const socket = new Piece().rect(43, 26, 4, 12, "c").rect(43, 37, 4, 1, "C").rect(43, 31, 1, 2, "k").rect(43, 35, 1, 2, "k");
  return compose([tv, ant, cord, socket]);
}

const DRAW: Record<PopupState, () => Uint8Array> = { "nothing-found": nothingFound, "cant-read": cantRead, "server-away": serverAway };

/** Every popup vignette file: `<state>.png` (48×40) and `<state>@2x.png` (nearest 2×). */
export function buildPopupVignettes(): PopupFile[] {
  const { w, h } = POPUP_VIGNETTE;
  return POPUP_STATES.flatMap((s) => {
    const img = DRAW[s]();
    return [{ file: `${s}.png`, w, h, img }, { file: `${s}@2x.png`, w: w * 2, h: h * 2, img: upscale(img, w, h, 2) }];
  });
}
