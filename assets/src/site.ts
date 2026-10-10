// Set (m) (OME-762, M9): the website's own art. Three groups, all palette-only, 1-bit alpha, plum outline, top-left light:
//  · Site icons: the same wood-TV mark as the extension (src/store.ts), drawn natively per size, so the tab and the toolbar
//    show one product. Opaque variants (apple-touch, maskable) sit on the dusk wallpaper from the room's walls.
//  · Share card (OG image): the real room, its back corner centred, with a big TV standing on the corner console. The TV is
//    playing the title card ("omega-share" + "watch together"), and all four avatars watch it from their armchairs. Every word
//    and every face sits in the centre 630 px, so a square crop keeps the name and the room.
//  · "How it works" panels: three framed vignettes, no lettering (the landing's own text says the step): a page whose video the
//    extension found, the popup sharing it through a door, and the room watching it.
import { CELL, FLOOR } from "./avatars";
import { addOutline } from "./iso";
import { colorIndex, type RampName, type Tone } from "./palette";
import { bezelPaint, defaultLayout, type RoomFrame } from "./room";
import { blank, render, stamp, type Grid, type RoleMap } from "./sprite";
import { renderIcon } from "./store";

export interface SiteImage { file: string; w: number; h: number; pixels: Uint8Array }

const ci = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const O = (): number => ci("outline", 1);

/** A palette-index canvas with the few drawing ops the set needs. */
class Canvas {
  readonly px: Uint8Array;
  constructor(readonly w: number, readonly h: number, fill = 0) {
    this.px = new Uint8Array(w * h).fill(fill);
  }
  set(x: number, y: number, v: number): void {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = v;
  }
  get(x: number, y: number): number {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? (this.px[y * this.w + x] ?? 0) : 0;
  }
  rect(x: number, y: number, w: number, h: number, v: number): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, v);
  }
  /** Copy a sprite's opaque pixels with its top-left at (x, y). */
  blit(img: Uint8Array, w: number, h: number, x: number, y: number): void {
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const v = img[yy * w + xx] ?? 0;
      if (v !== 0) this.set(x + xx, y + yy, v);
    }
  }
  /** Copy another canvas at integer scale k. */
  blitScaled(src: Canvas, x: number, y: number, k: number): void {
    for (let yy = 0; yy < src.h * k; yy++) for (let xx = 0; xx < src.w * k; xx++) {
      const v = src.get(Math.floor(xx / k), Math.floor(yy / k));
      if (v !== 0) this.set(x + xx, y + yy, v);
    }
  }
  upscale(k: number): Uint8Array {
    const out = new Uint8Array(this.w * k * this.h * k);
    for (let y = 0; y < this.h * k; y++) for (let x = 0; x < this.w * k; x++) out[y * this.w * k + x] = this.px[Math.floor(y / k) * this.w + Math.floor(x / k)] ?? 0;
    return out;
  }
}

export interface SiteSources {
  room: readonly RoomFrame[];
  avatars: ReadonlyMap<string, Uint8Array>;
  /** Set (c) and later UI frames (`logo/0`, `icon/share`, …). */
  ui: readonly RoomFrame[];
}

function uiFrame(src: SiteSources, key: string): RoomFrame {
  const f = src.ui.find((u) => u.key === key);
  if (!f) throw new Error(`missing ${key}`);
  return f;
}

// ------------------------------------------------------------------ shared painters

/** The room's dusk wallpaper (wall shade with lit lozenges every 8 px, offset per row), used behind opaque icons. */
function wallpaper(c: Canvas, x0: number, y0: number, w: number, h: number, step = 8): void {
  c.rect(x0, y0, w, h, ci("wall", 2));
  for (let y = y0 + 2; y < y0 + h; y += step) {
    const off = (Math.floor((y - y0 - 2) / step) % 2) * (step / 2);
    for (let x = x0 + 2 + off; x < x0 + w; x += step) {
      c.set(x, y, ci("wall", 1));
      c.set(x - 1, y + 1, ci("wall", 1));
      c.set(x + 1, y + 1, ci("wall", 1));
      c.set(x, y + 2, ci("wall", 1));
    }
  }
}

/** The stand-in video everywhere in the set: dusk over the sea, flat bands (like the store icon), sun with a glitter path. */
function sunset(c: Canvas, x0: number, y0: number, w: number, h: number, sun = true, title = false): void {
  // The title card keeps the top 57% night for its lettering, so its dusk bands, sun and horizon sit lower.
  const horizon = y0 + Math.round(h * (title ? 0.71 : 0.58));
  const sx = x0 + Math.round(w * 0.64), sr = Math.max(2, Math.round(h * (title ? 0.11 : 0.16)));
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const f = (y - y0) / h;
    let v: number;
    if (y < horizon) {
      if (title) {
        // Title card: night sky high up (the lettering sits there), then the same dusk bands to the horizon.
        v = f < 0.53 ? ci("night", 2) : f < 0.58 ? ci("night", 1) : f < 0.61 ? ci("lilac", 2) : f < 0.65 ? ci("lilac", 1) : ci("pink", 0);
        if (f >= 0.5 && f < 0.53 && (x + y) % 2 === 0) v = ci("night", 1);
        if (f >= 0.56 && f < 0.58 && (x + y) % 2 === 0) v = ci("lilac", 2);
        if (f >= 0.68 && (x + y) % 2 === 0) v = ci("ginger", 0);
        if (f < 0.5 && (x * 7 + y * 13) % 89 === 0) v = ci("cream", 0);
      } else {
        v = f < 0.2 ? ci("lilac", 1) : f < 0.3 ? ci("lilac", 0) : f < 0.46 ? ci("pink", 0) : ci("ginger", 0);
        if (f >= 0.27 && f < 0.3 && (x + y) % 2 === 0) v = ci("lilac", 1);
        if (f >= 0.43 && f < 0.46 && (x + y) % 2 === 0) v = ci("pink", 0);
      }
      if (sun && Math.hypot(x + 0.5 - sx, y + 0.5 - horizon) < sr) v = ci("mustard", y < horizon - sr / 2 ? 0 : 1);
    } else {
      const g = (y - horizon) / (y0 + h - horizon);
      v = g < 0.3 ? ci("teal", 0) : g < 0.62 ? ci("teal", 1) : ci("navy", 0);
      if (g >= 0.27 && g < 0.33 && (x + y) % 2 === 0) v = ci("teal", 1);
      const reach = sr * 1.4 * (1 - g * 0.6);
      if (sun && (y - horizon) % 2 === 0 && Math.abs(x + 0.5 - sx) < reach && (x + (y >> 1)) % 3 !== 0) v = ci("mustard", 0);
    }
    c.set(x, y, v);
  }
}

/** A free-standing wood TV (the TV frame's bezel recipe) around a screen rect, on two short feet. */
function tv(c: Canvas, s: { x: number; y: number; w: number; h: number }, feet = 3): void {
  const B = { side: 6, top: 6, bottom: 8 };
  const x0 = s.x - B.side, y0 = s.y - B.top, W = s.w + 2 * B.side, H = s.h + B.top + B.bottom;
  const tmp = new Uint8Array((W + 2) * (H + 2 + feet));
  const TW = W + 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = bezelPaint(x, y, { x: B.side, y: B.top, w: s.w, h: s.h });
    if (p) tmp[(y + 1) * TW + x + 1] = ci(p[0], p[1]);
  }
  // Feet: two wood blocks under the cabinet, shade on the right.
  for (const fx of [Math.round(W * 0.18), Math.round(W * 0.82) - 4]) for (let y = 0; y < feet; y++) for (let x = 0; x < 4; x++) tmp[(H + 1 + y) * TW + fx + 1 + x] = ci("wood", x === 3 ? 2 : 1);
  addOutline(tmp, TW, H + 2 + feet);
  // addOutline also rings the transparent screen hole; the screen fill below paints over that ring, so the charcoal lip stays the edge.
  c.blit(tmp, TW, H + 2 + feet, x0 - 1, y0 - 1);
  c.rect(s.x, s.y, s.w, s.h, ci("night", 2));
}

// ------------------------------------------------------------------ the tagline face (5×7, 1 px strokes, lowercase)

const FACE: Readonly<Record<string, readonly string[]>> = {
  a: ["", "", ".XXX.", "....X", ".XXXX", "X...X", ".XXXX"],
  c: ["", "", ".XXXX", "X....", "X....", "X....", ".XXXX"],
  e: ["", "", ".XXX.", "X...X", "XXXXX", "X....", ".XXXX"],
  g: ["", "", ".XXXX", "X...X", "X...X", "X...X", ".XXXX", "....X", ".XXX."],
  h: ["X....", "X....", "XXXX.", "X...X", "X...X", "X...X", "X...X"],
  o: ["", "", ".XXX.", "X...X", "X...X", "X...X", ".XXX."],
  r: ["", "", "X.XXX", "XX...", "X....", "X....", "X...."],
  t: [".X...", ".X...", "XXXX.", ".X...", ".X...", ".X...", "..XX."],
  w: ["", "", "X...X", "X...X", "X.X.X", "X.X.X", ".X.X."],
  " ": ["", "", "", "", "", "", ""],
};

/** Lettering on a role grid with letter `ch`; returns the width used. */
function letter(g: Grid, text: string, x: number, y: number, ch: string): number {
  let cx = x;
  for (const t of text) {
    const rows = FACE[t];
    if (!rows) throw new Error(`no glyph for "${t}"`);
    stamp(g, rows.map((r) => r.replace(/X/g, ch)), cx, y);
    cx += t === " " ? 4 : 6;
  }
  return cx - x - 1;
}

function textWidth(text: string): number {
  let w = 0;
  for (const t of text) w += t === " " ? 4 : 6;
  return w - 1;
}

// ------------------------------------------------------------------ the room (OG card + panel 3)

interface Seat { c: number; r: number; who: string; dir?: "ne" | "nw" }

/** The room's back corner with the console, a TV standing on it, and people in armchairs facing it.
 *  `corner` = screen position of tile (0,0)'s top corner. Returns the TV's screen rect. */
function roomCorner(c: Canvas, src: SiteSources, corner: { x: number; y: number }, seats: readonly Seat[], screen: { w: number; h: number; lift: number }, extras: (draw: (key: string, col: number, row: number) => void) => void = () => undefined): { x: number; y: number; w: number; h: number } {
  const byKey = new Map(src.room.map((f) => [f.key, f]));
  const cell = (col: number, row: number): { x: number; y: number } => ({ x: corner.x + (col - row) * 32, y: corner.y + (col + row + 1) * 16 });
  const draw = (key: string, x: number, y: number): void => {
    const f = byKey.get(key);
    if (f) { c.blit(f.img, f.w, f.h, x - f.ax, y - f.ay); return; }
    const a = src.avatars.get(key);
    if (!a) throw new Error(`missing ${key}`);
    c.blit(a, CELL.w, CELL.h, x - FLOOR.x, y - FLOOR.y);
  };
  const layout = defaultLayout();
  layout.floor.forEach((row, r) => { row.forEach((key, col) => { const p = cell(col, r); draw(key, p.x, p.y); }); });
  for (let i = 0; i < 10; i++) {
    const l = cell(0, i), rr = cell(i, 0);
    draw(layout.walls.l[i] ?? "wall/l/plain", l.x, l.y);
    draw(layout.walls.r[i] ?? "wall/r/plain", rr.x, rr.y);
  }
  const c00 = cell(0, 0);
  draw("wall/corner", c00.x, c00.y);
  draw("tv/0", c00.x, c00.y);
  // The TV faces straight out of the corner, which in this projection is straight at the camera, so it is drawn flat.
  const s = { x: c00.x - Math.floor(screen.w / 2), y: c00.y - screen.lift - screen.h, w: screen.w, h: screen.h };
  tv(c, s);
  const items: { key: string; x: number; y: number; layer: number }[] = [];
  for (const st of seats) {
    const p = cell(st.c, st.r);
    const d = st.dir ?? (st.c < st.r ? "ne" : "nw");
    items.push({ key: `armchair/${d}/back`, ...p, layer: 2 }, { key: `${st.who}/sit/${d}/0`, ...p, layer: 3 }, { key: `armchair/${d}/front`, ...p, layer: 4 });
  }
  for (const pr of layout.props) items.push({ key: pr.frame, ...cell(pr.col, pr.row), layer: 3 });
  extras((key, col, row) => { items.push({ key, ...cell(col, row), layer: 3 }); });
  items.sort((a, b) => a.y - b.y || a.x - b.x || a.layer - b.layer);
  for (const it of items) draw(it.key, it.x, it.y);
  return s;
}

// ------------------------------------------------------------------ share card

/** 1200×630: 600×315 art px at 2×. */
function shareCard(src: SiteSources): SiteImage {
  const W = 600, H = 315;
  const c = new Canvas(W, H, ci("night", 2));
  const seats: Seat[] = [
    { c: 2, r: 5, who: "juno" }, { c: 3, r: 4, who: "pip" }, { c: 4, r: 3, who: "mo" }, { c: 5, r: 2, who: "kiki" },
  ];
  const s = roomCorner(c, src, { x: W / 2, y: 150 }, seats, { w: 224, h: 126, lift: 12 });
  sunset(c, s.x, s.y, s.w, s.h, true, true);
  // Title card on the screen: the wordmark at 2× over the sky, the tagline under it.
  const L = uiFrame(src, "logo/0"), k = 2;
  const logo = new Canvas(L.w, L.h);
  logo.blit(L.img, L.w, L.h, 0, 0);
  const lx = s.x + Math.floor((s.w - L.w * k) / 2), ly = s.y + 11;
  c.blitScaled(logo, lx, ly, k);
  const tag = "watch together";
  const tw = textWidth(tag);
  const g = blank(tw + 2, 11);
  letter(g, tag, 1, 1, "C");
  const tagImg = render(g, { C: { ramp: "cream", tone: 0 } });
  const tg = new Canvas(tw + 2, 11);
  tg.blit(tagImg, tw + 2, 11, 0, 0);
  c.blitScaled(tg, s.x + Math.floor((s.w - (tw + 2) * k) / 2), ly + L.h * k + 4, k);
  return { file: "og-card.png", w: W * 2, h: H * 2, pixels: c.upscale(2) };
}

// ------------------------------------------------------------------ icons

/** The opaque icons' backdrop: the wallpaper, then the icon, so its outline still rings the art. */
function onWallpaper(S: number, pad: number, heads: boolean, step: number): Canvas {
  const c = new Canvas(S, S);
  wallpaper(c, 0, 0, S, S, step);
  c.blit(renderIcon(S, pad, heads), S, S, 0, 0);
  return c;
}

function plain(S: number, pad: number, heads = S >= 48): Canvas {
  const c = new Canvas(S, S);
  c.blit(renderIcon(S, pad, heads), S, S, 0, 0);
  return c;
}

/** The biggest art that fits the maskable safe zone: 12 art px of margin puts the farthest pixel corner 200 px from the centre. */
const MASKABLE_PAD = 12;

/** Every opaque pixel corner must lie within 40% of the icon's size from its centre (the W3C maskable safe zone). */
function assertSafeZone(img: Uint8Array, S: number): void {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (!img[y * S + x]) continue;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      if (Math.hypot(x + dx - S / 2, y + dy - S / 2) > S * 0.4) throw new Error(`maskable icon: pixel (${String(x)}, ${String(y)}) is outside the safe zone`);
    }
  }
}

export function buildSiteIcons(): SiteImage[] {
  const out: SiteImage[] = [];
  const add = (file: string, c: Canvas, k: number): void => { out.push({ file, w: c.w * k, h: c.h * k, pixels: k === 1 ? c.px : c.upscale(k) }); };
  add("favicon-16.png", plain(16, 0), 1);
  add("favicon-32.png", plain(32, 0), 1);
  // iOS fills transparency with black and rounds the corners itself, so the touch icon is opaque with 6 art px of margin.
  add("apple-touch-icon.png", onWallpaper(45, 5, true, 8), 4);
  add("icon-192.png", plain(48, 1), 4);
  add("icon-512.png", plain(64, 2), 8);
  // Maskable: full-bleed wallpaper; the art stays inside the centre circle (radius 40% = 204.8 px), checked here.
  assertSafeZone(renderIcon(64, MASKABLE_PAD, true), 64);
  add("icon-maskable-512.png", onWallpaper(64, MASKABLE_PAD, true, 8), 8);
  return out;
}

/** favicon.ico: a PNG-in-ICO container (Vista+, every current browser) holding the 16 and 32 px PNGs as encoded. */
export function encodeIco(pngs: readonly { size: number; data: Uint8Array }[]): Uint8Array {
  const head = 6 + 16 * pngs.length;
  const total = head + pngs.reduce((a, p) => a + p.data.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0, true);
  v.setUint16(2, 1, true);
  v.setUint16(4, pngs.length, true);
  let off = head;
  pngs.forEach((p, i) => {
    const e = 6 + 16 * i;
    v.setUint8(e, p.size >= 256 ? 0 : p.size);
    v.setUint8(e + 1, p.size >= 256 ? 0 : p.size);
    v.setUint16(e + 4, 1, true);
    v.setUint16(e + 6, 32, true);
    v.setUint32(e + 8, p.data.length, true);
    v.setUint32(e + 12, off, true);
    out.set(p.data, off);
    off += p.data.length;
  });
  return out;
}

// ------------------------------------------------------------------ how-it-works panels

/** Panel art size (1×); files ship at 2×. Frame: plum outline, 2 px wood (lit top-left), 1 px charcoal lip. */
export const PANEL = { w: 184, h: 112 } as const;
const IN = { x: 4, y: 4, w: PANEL.w - 8, h: PANEL.h - 8 } as const;

function panelFrame(c: Canvas): void {
  const { w: W, h: H } = PANEL;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const inner = x >= IN.x && x < IN.x + IN.w && y >= IN.y && y < IN.y + IN.h;
    if (inner) continue;
    const lip = x >= IN.x - 1 && x <= IN.x + IN.w && y >= IN.y - 1 && y <= IN.y + IN.h;
    c.set(x, y, lip ? ci("charcoal", 2) : x <= 1 || y <= 1 ? ci("wood", 0) : x >= W - 2 || y >= H - 2 ? ci("wood", 2) : ci("wood", 1));
  }
  // Chamfered corners on the 2:1 stair, then the plum outline.
  for (const [cx, cy, sx, sy] of [[0, 0, 1, 1], [W - 1, 0, -1, 1], [0, H - 1, 1, -1], [W - 1, H - 1, -1, -1]] as const) {
    c.set(cx, cy, 0); c.set(cx + sx, cy, 0); c.set(cx, cy + sy, 0);
  }
  for (let x = 2; x < W - 2; x++) { c.set(x, 0, O()); c.set(x, H - 1, O()); }
  for (let y = 2; y < H - 2; y++) { c.set(0, y, O()); c.set(W - 1, y, O()); }
  for (const [x, y] of [[1, 1], [W - 2, 1], [1, H - 2], [W - 2, H - 2]] as const) c.set(x, y, O());
}

/** Draw a role-grid sprite (auto-shaded + outlined) at (x, y). */
function sprite(c: Canvas, rows: readonly string[], roles: RoleMap, x: number, y: number): void {
  const w = Math.max(...rows.map((r) => r.length)) + 2, h = rows.length + 2;
  const g = blank(w, h);
  stamp(g, rows, 1, 1);
  c.blit(render(g, roles), w, h, x - 1, y - 1);
}

/** A little browser window: navy tab strip, cream address bar, cream page. Returns the page rect and the toolbar icon slot. */
function browser(c: Canvas, x: number, y: number, w: number, h: number): { page: { x: number; y: number; w: number; h: number }; slot: { x: number; y: number } } {
  c.rect(x - 1, y - 1, w + 2, h + 2, O());
  c.rect(x, y, w, 8, ci("navy", 2));
  c.rect(x + 3, y + 2, 30, 6, ci("cream", 1)); // the active tab
  c.rect(x + 3, y + 2, 30, 1, ci("cream", 0));
  c.rect(x + 6, y + 4, 18, 1, ci("charcoal", 0));
  for (const [i, ramp] of [[0, "rust"], [1, "mustard"], [2, "teal"]] as const) c.set(x + w - 10 + i * 3, y + 3, ci(ramp, 1));
  c.rect(x, y + 8, w, 14, ci("cream", 1));
  c.rect(x + 3, y + 11, w - 26, 8, ci("cream", 0));
  c.rect(x + 3, y + 11, w - 26, 1, ci("cream", 2));
  c.rect(x + 3, y + 11, 1, 8, ci("cream", 2));
  c.rect(x + 7, y + 14, 34, 2, ci("cream", 2));
  c.rect(x, y + 22, w, 1, ci("cream", 2));
  c.rect(x, y + 23, w, h - 23, ci("cream", 0));
  return { page: { x, y: y + 23, w, h: h - 23 }, slot: { x: x + w - 20, y: y + 9 } };
}

/** Body text on a page: charcoal-highlight bars of varied length. */
function textLines(c: Canvas, x: number, y: number, w: number, n: number, seed: number): void {
  for (let i = 0; i < n; i++) {
    const len = i === n - 1 ? Math.round(w * 0.55) : w - ((seed * 7 + i * 5) % 9);
    c.rect(x, y + i * 4, len, 2, ci("cream", 2));
  }
}

/** A video thumbnail: the dusk frame in a plum edge. */
function videoCard(c: Canvas, x: number, y: number, w: number, h: number): void {
  c.rect(x - 1, y - 1, w + 2, h + 2, O());
  sunset(c, x, y, w, h);
}

/** Mustard corner brackets around a rect: the "found it" mark (the seat cursor's free state, as flat brackets). */
function brackets(c: Canvas, x: number, y: number, w: number, h: number, gap = 3, arm = 6): void {
  const x0 = x - gap, y0 = y - gap, x1 = x + w + gap - 1, y1 = y + h + gap - 1;
  const m = ci("mustard", 0);
  for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]] as const) {
    for (let i = 0; i < arm; i++) for (let t = 0; t < 2; t++) {
      c.set(cx + sx * i, cy + sy * t, m);
      c.set(cx + sx * t, cy + sy * i, m);
    }
    // plum keyline outside and inside each arm, so it holds on cream and on the video.
    for (let i = -1; i <= arm; i++) {
      c.set(cx + sx * i, cy - sy, O());
      c.set(cx - sx, cy + sy * i, O());
      if (i >= 2) { c.set(cx + sx * i, cy + sy * 2, O()); c.set(cx + sx * 2, cy + sy * i, O()); }
    }
    c.set(cx - sx, cy - sy, O());
    c.set(cx + sx * arm, cy + sy, O());
    c.set(cx + sx, cy + sy * arm, O());
  }
}

/** A four-point sparkle (cream with a mustard heart), used for "found". */
function sparkle(c: Canvas, x: number, y: number, r: number): void {
  const rows: string[] = [];
  for (let dy = -r; dy <= r; dy++) {
    let row = "";
    for (let dx = -r; dx <= r; dx++) row += dx === 0 || dy === 0 ? (Math.abs(dx) + Math.abs(dy) <= 1 ? "m" : Math.abs(dx) + Math.abs(dy) < r ? "c" : ".") : ".";
    rows.push(row);
  }
  sprite(c, rows, { c: { ramp: "cream", tone: 0 }, m: { ramp: "mustard", tone: 0 } }, x - r, y - r);
}

/** Pointer hand (cream, plum outline), fingertip at (x, y). */
function hand(c: Canvas, x: number, y: number): void {
  const rows = [
    "..X......",
    ".XXX.....",
    ".XXX.....",
    ".XXXXXX..",
    ".XXXXXXX.",
    "XXXXXXXXX",
    "XXXXXXXXX",
    "XXXXXXXXX",
    ".XXXXXXX.",
    "..XXXXX..",
    "..XXXXX..",
  ].map((r) => r.replace(/X/g, "h"));
  sprite(c, rows, { h: { ramp: "cream", hi: true } }, x - 2, y);
  // finger joints
  c.set(x + 1, y + 4, ci("cream", 2)); c.set(x + 3, y + 4, ci("cream", 2));
}

/** A play badge: a plum-ringed charcoal pill with a cream triangle, centred on (cx, cy). */
function playBadge(c: Canvas, cx: number, cy: number): void {
  const w = 15, h = 11, x = cx - 7, y = cy - 5;
  c.rect(x, y - 1, w, h + 2, O());
  c.rect(x - 1, y, w + 2, h, O());
  c.rect(x, y, w, h, ci("charcoal", 1));
  c.rect(x, y, w, 1, ci("charcoal", 0));
  for (let i = 0; i < 7; i++) c.rect(x + 6, y + 2 + i, 4 - Math.abs(3 - i), 1, ci("cream", 0));
}

function panelFind(): Canvas {
  const c = new Canvas(PANEL.w, PANEL.h);
  panelFrame(c);
  wallpaper(c, IN.x, IN.y, IN.w, IN.h);
  const bx = IN.x + 8, by = IN.y + 7, bw = IN.w - 16, bh = IN.h - 14;
  const { page, slot } = browser(c, bx, by, bw, bh);
  // The page: a heading, then the video with its text beside it.
  c.rect(page.x + 8, page.y + 5, 52, 3, ci("charcoal", 0));
  const vx = page.x + 10, vy = page.y + 14, vw = 72, vh = 40;
  videoCard(c, vx, vy, vw, vh);
  playBadge(c, vx + Math.floor(vw / 2) - 4, vy + Math.floor(vh / 2) - 5);
  textLines(c, vx + vw + 10, vy + 1, page.w - vw - 30, 7, 1);
  // Found: brackets round the video, and the toolbar icon lit on a mustard ring with a count badge.
  brackets(c, vx, vy, vw, vh);
  const ix = slot.x, iy = slot.y - 1;
  c.rect(ix - 2, iy - 2, 20, 20, O());
  c.rect(ix - 1, iy - 1, 18, 18, ci("mustard", 0));
  c.rect(ix, iy, 16, 16, ci("cream", 0));
  c.blit(renderIcon(16, 0), 16, 16, ix, iy);
  // Badge: a teal dot (the "online" lamp colour) with a cream tick, top-right of the icon.
  sprite(c, [".ttttt.", "ttttttt", "ttttttt", "ttttttt", "ttttttt", ".ttttt."], { t: { ramp: "teal", tone: 1 } }, ix + 12, iy - 4);
  for (const [x, y] of [[ix + 14, iy - 1], [ix + 15, iy], [ix + 16, iy - 1], [ix + 17, iy - 2]] as const) c.set(x, y, ci("cream", 0));
  // A dotted mustard trail from the icon down to the video's corner.
  const ex = vx + vw + 3, ey = vy - 4;
  for (let t = 0.12; t < 0.95; t += 0.09) {
    const x = Math.round(ix + 6 + (ex - (ix + 6)) * t), y = Math.round(iy + 20 + (ey - (iy + 20)) * t + Math.sin(t * Math.PI) * 4);
    c.rect(x, y, 2, 2, ci("mustard", 1));
  }
  sparkle(c, ex, ey, 4);
  return c;
}

/** A key (button/primary press look): mustard face, lit top edge, no lip. */
function key(c: Canvas, x: number, y: number, w: number, h: number): void {
  c.rect(x - 1, y - 1, w + 2, h + 2, O());
  c.rect(x, y, w, h, ci("mustard", 1));
  c.rect(x, y, w, 1, ci("mustard", 0));
  c.rect(x, y, 1, h, ci("mustard", 0));
  c.rect(x, y + h - 1, w, 1, ci("mustard", 2));
  c.rect(x + w - 1, y, 1, h, ci("mustard", 2));
}

function panelShare(src: SiteSources): Canvas {
  const c = new Canvas(PANEL.w, PANEL.h);
  panelFrame(c);
  wallpaper(c, IN.x, IN.y, IN.w, IN.h);
  // Left: the popup card (TV wood rim, night face) hanging from its toolbar icon: the video, a room row, the Share key pressed.
  const px = IN.x + 8, py = IN.y + 22, pw = 74, ph = 74;
  c.blit(renderIcon(16, 0), 16, 16, px + 5, IN.y + 3);
  c.rect(px - 1, py - 1, pw + 2, ph + 2, O());
  c.rect(px, py, pw, ph, ci("wood", 1));
  c.rect(px, py, pw, 1, ci("wood", 0));
  c.rect(px, py, 1, ph, ci("wood", 0));
  c.rect(px, py + ph - 1, pw, 1, ci("wood", 2));
  c.rect(px + pw - 1, py, 1, ph, ci("wood", 2));
  c.rect(px + 2, py + 2, pw - 4, ph - 4, ci("night", 1));
  c.rect(px + 2, py + 2, pw - 4, 1, ci("night", 2));
  // the tail up to the icon
  for (let i = 1; i <= 3; i++) { c.rect(px + 13 - i, py - i, 2 * i + 1, 1, ci("wood", 0)); }
  for (let i = 1; i <= 3; i++) { c.set(px + 12 - i, py - i, O()); c.set(px + 14 + i, py - i, O()); }
  c.rect(px + 10, py - 4, 7, 1, O());
  const vx = px + 6, vy = py + 6, vw = pw - 12, vh = 34;
  videoCard(c, vx, vy, vw, vh);
  // A room row: the people icon's teal, then the room name as a cream bar.
  c.rect(px + 6, py + 45, 5, 5, ci("teal", 0));
  c.rect(px + 6, py + 49, 5, 1, ci("teal", 2));
  c.rect(px + 14, py + 46, 34, 2, ci("cream", 1));
  c.rect(px + 14, py + 49, 20, 1, ci("night", 0));
  const kx = px + 6, ky = py + ph - 24, kw = pw - 12, kh = 18;
  key(c, kx, ky, kw, kh);
  const share = uiFrame(src, "icon/share");
  c.blit(share.img, share.w, share.h, kx + 8, ky + Math.floor((kh - share.h) / 2));
  hand(c, kx + kw - 18, ky + 9);
  // Right: an open door with lamp light inside and a friend waiting in it.
  const dw = 30, dh = 56, dx = IN.x + IN.w - dw - 14, dy = IN.y + IN.h - dh - 10;
  c.rect(dx - 4, dy - 4, dw + 8, dh + 4, O());
  c.rect(dx - 3, dy - 3, dw + 6, dh + 3, ci("wood", 1));
  c.rect(dx - 3, dy - 3, dw + 6, 1, ci("wood", 0));
  c.rect(dx - 3, dy - 3, 1, dh + 3, ci("wood", 0));
  c.rect(dx + dw + 2, dy - 3, 1, dh + 3, ci("wood", 2));
  c.rect(dx - 1, dy - 1, dw + 2, dh + 1, O());
  // Inside: the lamp-lit violet wall over the honey floor.
  c.rect(dx, dy, dw, dh, ci("wall", 0));
  for (let y = dy + 3; y < dy + dh - 14; y += 6) for (let x = dx + 2 + ((y - dy) % 12 === 3 ? 0 : 3); x < dx + dw; x += 6) c.set(x, y, ci("lilac", 0));
  c.rect(dx, dy + dh - 14, dw, 14, ci("floor", 0));
  c.rect(dx, dy + dh - 14, dw, 1, ci("wood", 2));
  for (let y = dy + dh - 13; y < dy + dh; y++) c.set(dx + ((y * 2) % dw), y, ci("floor", 1));
  const kiki = src.avatars.get("kiki/idle/sw/0");
  if (!kiki) throw new Error("missing kiki/idle/sw/0");
  c.blit(kiki, CELL.w, CELL.h, dx + Math.floor(dw / 2) - FLOOR.x + 2, dy + dh - 3 - FLOOR.y);
  // the door leaf, swung open toward us on the left jamb
  c.rect(dx - 10, dy + 1, 8, dh, O());
  c.rect(dx - 9, dy + 2, 6, dh - 2, ci("wood", 2));
  c.rect(dx - 9, dy + 2, 1, dh - 2, ci("wood", 1));
  c.rect(dx - 8, dy + Math.round(dh * 0.55), 2, 2, ci("mustard", 1));
  // Light spilling out over the floor in front of the door.
  for (let y = 0; y < 5; y++) c.rect(dx - 2 - y * 2, dy + dh + 1 + y, dw + 4 + y * 4, 1, (y + 1) % 2 === 0 ? ci("wall", 1) : ci("mustard", 0));
  // The shared video flying into the room: a small card with motion dashes, on a dotted arc.
  const fx = px + pw + 10, fy = IN.y + 18;
  for (let t = 0.0; t <= 1; t += 0.08) {
    const x = Math.round(fx + 10 + (dx + 2 - (fx + 10)) * t), y = Math.round(fy + 18 + (dy + 14 - (fy + 18)) * t - Math.sin(t * Math.PI) * 4);
    if (t > 0.25) c.rect(x, y, 2, 2, ci("mustard", 1));
  }
  videoCard(c, fx + 6, fy, 24, 14);
  for (const [ox, oy, len] of [[0, 3, 6], [-3, 7, 8], [0, 11, 6]] as const) c.rect(fx + ox - len + 3, fy + oy, len, 1, ci("cream", 0));
  return c;
}

function panelWatch(src: SiteSources): Canvas {
  const c = new Canvas(PANEL.w, PANEL.h);
  const room = new Canvas(IN.w, IN.h, ci("night", 2));
  const seats: Seat[] = [{ c: 1, r: 2, who: "juno" }, { c: 2, r: 1, who: "kiki" }, { c: 1, r: 3, who: "pip" }, { c: 3, r: 1, who: "mo" }];
  const s = roomCorner(room, src, { x: Math.floor(IN.w / 2), y: 23 }, seats, { w: 48, h: 27, lift: 3 });
  sunset(room, s.x, s.y, s.w, s.h);
  c.blit(room.px, IN.w, IN.h, IN.x, IN.y);
  panelFrame(c);
  return c;
}

export function buildPanels(src: SiteSources): SiteImage[] {
  return [
    { file: "how-1-find.png", c: panelFind() },
    { file: "how-2-share.png", c: panelShare(src) },
    { file: "how-3-watch.png", c: panelWatch(src) },
  ].map(({ file, c }) => ({ file, w: c.w * 2, h: c.h * 2, pixels: c.upscale(2) }));
}

export function buildShareCard(src: SiteSources): SiteImage {
  return shareCard(src);
}

