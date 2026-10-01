// Set (h) (OME-276): room owner edit mode, the furniture picker tray, and create-room / private-room invite chrome.
// Same palette, plum outline and top-left light as sets (c)/(e)/(f). Materials keep their meanings:
//   mustard rim on night = only you see / only you can do it (edit mode is the owner's own view: nobody else sees the grid)
//   wood                 = the room's stuff: the tray is a wooden drawer of furniture, the slots are its cubbies
//   teal                 = fits (the `ok` token): a closed ring with a dot pattern
//   rust                 = can't go there (a real "no", like set c's errors): a dashed ring with a hatch, never colour alone
//   ticket               = an invite: cream card stub = valid, a teal stamp = copied, torn and grey = expired
//   key                  = invite only (private). A shut door with the key in it on the room list.
//   little house         = the room's host (owner) next to their name.
// No new colours: still the 67.
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import type { RoomFrame } from "./room";
import { blank, render, stamp, type RoleMap } from "./sprite";
import { all, lit, nine, slab, type Borders, type UiFrame } from "./ui";

const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const O = OUTLINE;
const T = 0;

const ROLES: RoleMap = {
  // Flat highlight (key icons, like set e: crisp on night and wood faces at 1×).
  i: { ramp: "cream", tone: 0 },
  C: { ramp: "cream", tone: 2 },
  y: { ramp: "mustard", tone: 0 },
  Y: { ramp: "mustard", tone: 2 },
  e: { ramp: "teal", tone: 0 },
  E: { ramp: "teal", tone: 2 },
  // Auto-shaded surfaces.
  c: { ramp: "cream", hi: true },
  m: { ramp: "mustard", hi: true },
  w: { ramp: "wood", hi: true },
  W: { ramp: "wood", tone: 2 },
  n: { ramp: "night", hi: true },
  N: { ramp: "night", tone: 2 },
  x: { ramp: "charcoal", hi: true },
  X: { ramp: "charcoal", tone: 2 },
  t: { ramp: "teal", hi: true },
  r: { ramp: "rust", hi: true },
  v: { ramp: "velvet", hi: true },
  g: { ramp: "glow", tone: 0 },
  l: { ramp: "lilac", tone: 0 },
  o: { ramp: "outline", tone: 1 },
};

function art(keyName: string, rows: readonly string[], ax?: number, ay?: number): UiFrame {
  const w = rows[0]?.length ?? 0, h = rows.length;
  rows.forEach((r, i) => { if (r.length !== w) throw new Error(`${keyName}: row ${String(i)} is ${String(r.length)} wide, not ${String(w)}`); });
  const g = blank(w, h);
  stamp(g, rows, 0, 0);
  return { key: keyName, w, h, img: render(g, ROLES), ax: ax ?? w / 2, ay: ay ?? h / 2 };
}

// ------------------------------------------------------------------ edit mode (room scale, 1×, Pixi)

/** Floor cell of a pixel centre (x+½, y+½) relative to an anchor cell's centre: same 2:1 rounding as the room. */
function cellOf(x: number, y: number): [number, number] {
  const sx = x + 0.5, sy = y + 0.5;
  return [Math.floor((sy + sx / 2) / 32 + 0.5), Math.floor((sy - sx / 2) / 32 + 0.5)];
}

/** `edit/grid`: one floor cell's share of the edit grid. Draw it at every floor cell's centre (anchor (32, 16)).
 *  Each pixel belongs to exactly one cell, so neighbours never overdraw: a cell paints its own edge pixels, cream on its
 *  top-left/top-right edges and plum on the lower two. Side by side they make one 2 px groove, lit on top like everything else,
 *  dashed 6 on / 2 off on a screen-x rhythm that lines up across cells. Quiet enough to leave on for a whole edit session. */
function gridCell(): UiFrame {
  const W = 64, H = 32;
  const img = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [cc, rr] = cellOf(x - 32, y - 16);
      if (cc !== 0 || rr !== 0) continue;
      const other = (dx: number, dy: number): boolean => {
        const [a, b] = cellOf(x - 32 + dx, y - 16 + dy);
        return a !== 0 || b !== 0;
      };
      if (x % 8 >= 6) continue;
      if (other(0, -1)) img[y * W + x] = c("cream", 0);
      else if (other(0, 1)) img[y * W + x] = O;
    }
  }
  return { key: "edit/grid", w: W, h: H, img, ax: 32, ay: 16 };
}

type Mark = "ok" | "no" | "sel";

/** Footprint marker for a piece being placed (`ok` / `no`) or picked (`sel`), drawn on the floor layer under the piece,
 *  anchored at the footprint's anchor cell like the furniture itself. State is shape first, colour second:
 *    ok  = closed teal ring + a sparse teal dot field (fits)
 *    no  = dashed rust ring + rust 2:1 hatching (blocked)
 *    sel = closed mustard ring, no fill (the piece you picked: rotate/remove act on it) */
function footprint(state: Mark, cols: number, rows: number): UiFrame {
  const left = 32 * rows, W = 32 * (cols + rows), H = 16 * (cols + rows) + 1;
  const ax = left, ay = 16;
  const img = new Uint8Array(W * H);
  const line = state === "ok" ? c("teal", 0) : state === "no" ? c("rust", 0) : c("mustard", 0);
  // Depth inside the footprint in 2:1 rows (a 1 px step down = 1), from the nearest edge.
  const depth = (x: number, y: number): number => {
    const sx = x - ax + 0.5, sy = y - ay + 0.5;
    const u = (sy + sx / 2) / 32 + 0.5, v = (sy - sx / 2) / 32 + 0.5;
    return Math.min(u, cols - u, v, rows - v) * 32;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = depth(x, y);
      const along = x - ax;
      if (d >= 1.5 && d < 3) {
        if (state === "no" && Math.floor((along + 512) / 6) % 2 === 1) continue;
        img[y * W + x] = line;
      } else if (d >= 5) {
        if (state === "ok" && y % 4 === 0 && (x + (y % 8 === 0 ? 0 : 4)) % 8 < 2) img[y * W + x] = c("teal", 0);
        if (state === "no" && Math.floor(x / 2 + y) % 6 === 0) img[y * W + x] = c("rust", 0);
      }
    }
  }
  plumStroke(img, W, H);
  return { key: `place/${state}/${String(cols)}x${String(rows)}`, w: W, h: H, img, ax, ay };
}

/** 4-connected plum stroke around every painted pixel (inside and out), so marks hold on honey floor, rug and velvet alike. */
function plumStroke(img: Uint8Array, W: number, H: number): void {
  const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H && img[y * W + x] !== T && img[y * W + x] !== O;
  const marks: number[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (img[y * W + x] === T && (on(x + 1, y) || on(x - 1, y) || on(x, y + 1) || on(x, y - 1))) marks.push(y * W + x);
  for (const i of marks) img[i] = O;
}

/** Wall-slot marker for a framed print: a ring 2 px outside the print's own silhouette, so it hugs the 2:1 slant of
 *  whichever wall it hangs on. Same anchor as `furniture/frame/<art>/<dir>/back`. */
function wallMark(state: Exclude<Mark, "sel">, dir: "se" | "sw", frame: RoomFrame): UiFrame {
  const P = 4, W = frame.w + 2 * P, H = frame.h + 2 * P;
  const inside = (x: number, y: number): boolean => {
    const fx = x - P, fy = y - P;
    return fx >= 0 && fy >= 0 && fx < frame.w && fy < frame.h && (frame.img[fy * frame.w + fx] ?? 0) !== 0;
  };
  const dist = (x: number, y: number): number => {
    let best = 9;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (inside(x + dx, y + dy)) best = Math.min(best, Math.max(Math.abs(dx), Math.abs(dy)));
    return best;
  };
  const line = state === "ok" ? c("teal", 0) : c("rust", 0);
  const img = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (dist(x, y) !== 2) continue;
      if (state === "no" && Math.floor((x + y) / 4) % 2 === 1) continue;
      img[y * W + x] = line;
    }
  }
  plumStroke(img, W, H);
  return { key: `place/${state}/wall-${dir}`, w: W, h: H, img, ax: frame.ax + P, ay: frame.ay + P };
}

/** 12×12 handle icons, flat cream on the night disc. */
const HANDLE_ICONS: Record<string, readonly string[]> = {
  // Rotate: a quarter-turn arrow sweeping over a little floor diamond: "turn it on the spot".
  rotate: [
    "............",
    "...iiiii....",
    "..ii...ii...",
    ".ii.....i.i.",
    ".i......iii.",
    ".i.......i..",
    "....ww......",
    "..wwwwww....",
    "wwwwwwwwww..",
    "..wwwwww....",
    "....ww......",
    "............",
  ],
  // Remove: a down arrow into an open box: "pack it back into the tray". Not a bin: nothing is destroyed.
  remove: [
    ".....ii.....",
    ".....ii.....",
    "...iiiiii...",
    "....iiii....",
    ".....ii.....",
    "w..........w",
    ".ww......ww.",
    "..wwwwwwww..",
    "..wwwwwwww..",
    "..wwWWWWww..",
    "..wwwwwwww..",
    "............",
  ],
};

/** Round 20×20 handle that floats beside the picked piece: night disc in the mustard "only you" rim. Hover = cream rim. */
function handle(name: string, state: "idle" | "hover"): UiFrame {
  const S = 20, R = 8.6, cx = 9.5, cy = 9.5;
  const rows: string[] = [];
  for (let y = 0; y < S; y++) {
    let row = "";
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - cx, y - cy);
      row += d > R ? "." : d > R - 2 ? (state === "hover" ? "c" : "m") : "n";
    }
    rows.push(row);
  }
  const g = blank(S, S);
  stamp(g, rows, 0, 0);
  stamp(g, HANDLE_ICONS[name] ?? [], 4, 4);
  // Cream icon pixels are flat; the disc auto-shades (lit top-left, shade bottom-right) like a bead.
  return { key: `handle/${name}/${state}`, w: S, h: S, img: render(g, ROLES), ax: 10, ay: 10 };
}

// ------------------------------------------------------------------ page chrome 9-slices (2× page, 1× in .ui-room)

/** Latched personal key: edit mode is on. Pressed (no lip, face down 2 px) and filled mustard, plum label. */
function selfOn(): UiFrame {
  const W = 16, H = 20;
  const img = slab(W, H, 2, (d, e) => {
    if (d === 0) return O;
    if (d === 1 && e === "t") return O;
    if ((d === 1 && e === "l") || (d === 2 && e === "t")) return c("mustard", 2);
    if (d === 1) return c("mustard", 2);
    return c("mustard", 1);
  });
  return nine("button/self/on", W, H, img, { left: 5, top: 5, right: 5, bottom: 5 });
}

/** Furniture tray: a wooden drawer (the room's wood, planked rim) with a sunken dusk well for the cubbies. */
function tray(): UiFrame {
  const W = 24;
  const img = slab(W, W, 3, (d, e) => {
    if (d === 0 || d === 5) return O;
    if (d <= 4) {
      if (d === 1) return lit(e) ? c("wood", 0) : c("wood", 2);
      if (d === 3) return c("wood", 2); // plank seam
      return lit(e) ? c("wood", 1) : c("wood", 2);
    }
    if (d === 6) return lit(e) ? O : c("night", 1); // sunken: shadow top-left, lit lip bottom-right
    return c("night", 2);
  });
  return nine("tray/0", W, W, img, all(10));
}

/** Tray tab. `on` is the lit wood face whose bottom row runs into the tray rim (it overlaps the rim's outline by 1 art px). */
function tab(state: "idle" | "hover" | "on"): UiFrame {
  const W = 16, H = 14;
  const img = slab(W, H, 2, (d, e) => {
    if (state === "on" && e === "b" && d <= 1) return d === 0 ? c("wood", 1) : c("wood", 1);
    if (d === 0) return O;
    if (state === "on") return d === 1 && lit(e) ? c("wood", 0) : d === 1 && e === "r" ? c("wood", 2) : c("wood", 1);
    if (d === 1) return lit(e) ? (state === "hover" ? c("cream", 0) : c("wood", 1)) : c("wood", 2);
    return c("wood", 2);
  });
  return nine(`tab/${state}`, W, H, img, { left: 5, top: 5, right: 5, bottom: 4 });
}

/** Tray cubby. idle = dusk glass in a wood rim, hover = cream lit edge, held = mustard double rim (it's in your hand),
 *  off = charcoal glass (the room has MAX_FURNITURE pieces: nothing more fits). */
function slot(state: "idle" | "hover" | "held" | "off"): UiFrame {
  const W = 16;
  const img = slab(W, W, 2, (d, e) => {
    if (d === 0) return O;
    if (state === "held" && d <= 2) return lit(e) ? c("mustard", d === 1 ? 0 : 1) : c("mustard", 2);
    if (d <= 2) {
      if (state === "off") return c("wood", 2);
      if (d === 1 && lit(e)) return state === "hover" ? c("cream", 0) : c("wood", 0);
      return lit(e) ? c("wood", 1) : c("wood", 2);
    }
    if (d === 3) return lit(e) ? O : state === "off" ? c("charcoal", 1) : c("night", 0);
    return state === "off" ? c("charcoal", 2) : c("night", 1);
  });
  return nine(`slot/${state}`, W, W, img, all(6));
}

/** "Invite only" pill: night with a cream rim. Pairs with glyph/key, so it never leans on colour (`pill/full` is charcoal + a door). */
function privatePill(): UiFrame {
  const W = 12;
  const img = slab(W, W, 2, (d, e) => {
    if (d === 0) return O;
    if (d === 1) return c("cream", lit(e) ? 1 : 2);
    return c("night", 2);
  });
  return nine("pill/private", W, W, img, all(4));
}

/** Invite ticket field, fixed height (20 art px, never stretched vertically): a cinema ticket. The left stub (in the left
 *  slice) has a perforation and a round bite top and bottom; the right end has a bite in its middle.
 *    idle    = cream card, plum text, a plum "admit" star on the stub
 *    copied  = the same card with a teal check stamped on the stub
 *    expired = cream-shade card, the stub torn off (ragged left edge), no stamp */
export const TICKET = { w: 34, h: 20, left: 15, right: 6, top: 4, bottom: 4 } as const;
function ticket(state: "idle" | "copied" | "expired"): UiFrame {
  const { w: W, h: H } = TICKET;
  const img = new Uint8Array(W * H);
  const body = state === "expired" ? c("cream", 2) : c("cream", 1);
  const hi = state === "expired" ? c("cream", 2) : c("cream", 0);
  const sh = state === "expired" ? c("charcoal", 0) : c("cream", 2);
  const perf = 11;
  const torn = state === "expired";
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (y < 1 || y > H - 2 || x > W - 2) continue;
      // Torn stub: everything left of the perforation is gone; the tear zigzags 1 px either side of it.
      const tearX = perf + 1 + (Math.floor(y / 2) % 2 === 0 ? 0 : 1);
      if (torn ? x < tearX : x < 1) continue;
      // Bites: half-circles top and bottom at the perforation, and one in the middle of the right end.
      if (!torn && Math.hypot(x + 0.5 - (perf + 0.5), y < H / 2 ? y - 0.5 : y - (H - 1.5)) < 2.6) continue;
      if (Math.hypot(x + 0.5 - (W - 1), y + 0.5 - H / 2) < 3.1) continue;
      img[y * W + x] = body;
    }
  }
  // Light: top/left lit, bottom/right shade (inside the silhouette), then the plum outline.
  const filled = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H && img[y * W + x] !== T;
  const out = img.slice();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!filled(x, y)) continue;
      if (!filled(x + 1, y) || !filled(x, y + 1)) out[y * W + x] = sh;
      else if (!filled(x - 1, y) || !filled(x, y - 1)) out[y * W + x] = hi;
    }
  }
  if (!torn) for (let y = 3; y < H - 3; y += 2) out[y * W + perf] = sh; // perforation dashes
  if (state === "idle") {
    // A small plum "admit" star on the stub.
    for (const [x, y] of [[5, 7], [5, 8], [5, 11], [5, 12], [3, 9], [3, 10], [4, 9], [4, 10], [6, 9], [6, 10], [7, 9], [7, 10], [5, 9], [5, 10]] as const) out[y * W + x] = O;
  } else if (state === "copied") {
    // Teal check stamp on the stub.
    for (const [x, y] of [[2, 10], [3, 11], [4, 12], [5, 11], [6, 10], [7, 9], [8, 8], [2, 11], [3, 12], [4, 13], [5, 12], [6, 11], [7, 10], [8, 9]] as const) out[y * W + x] = c("teal", 0);
    for (const [x, y] of [[1, 10], [1, 11], [2, 12], [3, 13], [4, 14], [5, 13], [6, 12], [7, 11], [8, 10], [9, 9], [9, 8], [8, 7], [7, 8], [6, 9], [5, 10], [4, 11], [3, 10], [2, 9]] as const) {
      if (out[y * W + x] !== c("teal", 0)) out[y * W + x] = O;
    }
  }
  plumOutline(out, W, H);
  const borders: Borders = { left: TICKET.left, top: TICKET.top, right: TICKET.right, bottom: TICKET.bottom };
  return { key: `ticket/${state}`, w: W, h: H, img: out, ax: 0, ay: 0, borders, slice: true, fixedHeight: true };
}

function plumOutline(img: Uint8Array, W: number, H: number): void {
  const filled = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H && img[y * W + x] !== T && img[y * W + x] !== O;
  const marks: number[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (img[y * W + x] === T && (filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1))) marks.push(y * W + x);
  for (const i of marks) img[i] = O;
}

// ------------------------------------------------------------------ icons (16×16) and glyphs (8×8)

const ICONS: Record<string, readonly string[]> = {
  // Edit room: four-way "arrange" arrows over a small floor diamond. The owner's key (night face, mustard rim).
  arrange: [
    "................",
    ".......ii.......",
    "......iiii......",
    ".....iiiiii.....",
    ".......ii.......",
    "...i...ii...i...",
    "..ii...ii...ii..",
    ".iiiiiiiiiiiiii.",
    ".iiiiiiiiiiiiii.",
    "..ii...ii...ii..",
    "...i...ii...i...",
    ".......ii.......",
    ".....iiiiii.....",
    "......iiii......",
    ".......ii.......",
    "................",
  ],
  // Create a room: a new wood door with a cream sparkle at its corner.
  create: [
    "................",
    "...........i....",
    "..wwwwwww..i....",
    "..wwwwwww.iiii..",
    "..wWWWWWw..i....",
    "..wWwwwWw..i....",
    "..wWwwwWw.......",
    "..wWWWWWw.......",
    "..wwwwwww.......",
    "..wwwwwmw.......",
    "..wwwwwww.......",
    "..wWWWWWw.......",
    "..wWwwwWw.......",
    "..wWWWWWw.......",
    "..wwwwwww.......",
    "................",
  ],
  // Invite only: a brass key, bow up-left, teeth down-right.
  key: [
    "................",
    "..mmmm..........",
    ".mmmmmm.........",
    ".mm..mm.........",
    ".mm..mm.........",
    ".mmmmmmm........",
    "..mmmmmmm.......",
    "......mmmm......",
    ".......mmmm.....",
    "........mmmm....",
    ".........mmmm...",
    "..........mmmm..",
    "........m..mmm..",
    ".........mmmm...",
    "..........m.....",
    "................",
  ],
  // Copy invite: two tickets, one fanned behind the other.
  copy: [
    "................",
    "......CCCCCCCCC.",
    "......CCCCCCCCC.",
    "......CC.......C",
    ".cccccccccc....C",
    ".cccccccccc...CC",
    ".cc.cccccc..CCC.",
    ".cc.ccccccccCCC.",
    "....ccccccccC...",
    ".cc.cccccc......",
    ".cc.cccccc......",
    ".cccccccccc.....",
    ".cccccccccc.....",
    "................",
    "................",
    "................",
  ],
  // Copied: the ticket with a teal check stamped on it.
  copied: [
    "................",
    "................",
    "................",
    ".cccccccccccc...",
    ".cccccccccce.e..",
    ".cc.ccccccee.ee.",
    ".cc.cccccee.ee..",
    "....eecceeeee...",
    ".cc.eeeeeeec....",
    ".cc.ceeeeecc....",
    ".cccccceeccc....",
    ".cccccccccccc...",
    "................",
    "................",
    "................",
    "................",
  ],
  // Expired: a ticket torn in two, the halves drifting apart, in cream shade.
  expired: [
    "................",
    "................",
    "................",
    ".CCCCC...CCCCCC.",
    ".CCCCCC..CCCCCC.",
    ".CC.CC..CCCCCCC.",
    ".CC.CCC..CCCCCC.",
    "....CC..CCCCCCC.",
    ".CC.CCC..CCCCCC.",
    ".CC.CC..CCCCCCC.",
    ".CCCCCC..CCCCCC.",
    ".CCCCC...CCCCCC.",
    "................",
    "................",
    "................",
    "................",
  ],
};

const GLYPHS: Record<string, readonly string[]> = {
  // The room's host: a little cream house with a wood door.
  host: ["........", "...ii...", "..iiii..", ".iiiiii.", "..iwwi..", "..iwwi..", "..iwwi..", "........"],
  // Invite only: a tiny brass key.
  key: ["........", ".yyy....", ".y.y....", ".yyyyyy.", "....y.y.", "....y.y.", "........", "........"],
  // Copied: a teal check.
  check: ["........", "......e.", ".....ee.", ".e..ee..", ".eeee...", "..ee....", "........", "........"],
  // Pieces in the room (the count beside "12 / 32"): a little wood crate.
  pieces: ["........", ".wwwwww.", ".wWWWWw.", ".wwwwww.", ".wWWWWw.", ".wwwwww.", "........", "........"],
  // Tab glyphs: seats (a chair), decor (a lamp), floor + wall (a rug diamond under a frame).
  "tab-seats": ["........", "..vvvv..", "..vvvv..", ".vvvvvv.", ".vvvvvv.", ".w....w.", "........", "........"],
  "tab-decor": ["........", "..yyyy..", ".yyyyyy.", "...ww...", "...ww...", "..wwww..", "........", "........"],
  "tab-floor": ["........", ".wwwwww.", ".wlllll.", "........", "..llll..", "llllllll", "..llll..", "........"],
};

// 12×8 footprint glyphs for the slot corner: how much floor the piece takes (or "wall").
const FOOTPRINTS: Record<string, readonly string[]> = {
  "1x1": ["............", "............", ".....ii.....", "...iiiiii...", ".....ii.....", "............", "............", "............"],
  "2x1": ["............", "............", ".....iiii...", "...iiiiiiii.", ".iiiiiiii...", "...iiii.....", "............", "............"],
  "3x2": ["............", "...iiiiii...", ".iiiiiiiiii.", "iiiiiiiiiiii", ".iiiiiiiiii.", "...iiiiii...", "............", "............"],
  wall: ["............", "..wwwwwwww..", "..wiiiiiiw..", "..wiiiiiiw..", "..wiiiiiiw..", "..wwwwwwww..", "............", "............"],
};

/** Room-list thumbnail for a private room, 16×24 (like `door/open` / `door/full`): the door is shut and a brass key sits in a
 *  brass lock plate. Full has a cream hanger with heads; private has the key. */
const DOOR_PRIVATE: readonly string[] = [
  "................",
  "..wwwwwwwwwwww..",
  "..wwwwwwwwwwww..",
  "..wwWWWWWWWWww..",
  "..wwWwwwwwwWww..",
  "..wwWwwwwwwWww..",
  "..wwWwwwwwwWww..",
  "..wwWWWWWWWWww..",
  "..wwwwwwwwwwww..",
  "..wwwwwwwwwwww..",
  "..wwwwwwwyyyww..",
  "..wwwwwwwyoyww..",
  "..wwwwwwwyoyww..",
  "..wwwwwwwyyyww..",
  "..wwwwwwwwmwww..",
  "..wwwwwwwmmmww..",
  "..wwwwwwwmwmww..",
  "..wwWWWWWWWWww..",
  "..wwWwwwwwwWww..",
  "..wwWWWWWWWWww..",
  "..wwwwwwwwwwww..",
  "................",
  "................",
  "................",
];

/** Variant swatches, 10×10: one per catalogue colour, the material's own ramp (brass = mustard). Prints get a tiny picture. */
const SWATCH_RAMP: Record<string, RampName> = {
  velvet: "velvet", navy: "navy", cream: "cream", olive: "olive", ginger: "ginger", blush: "blush",
  wood: "wood", brass: "mustard", rust: "rust", teal: "teal", lilac: "lilac",
};
const SWATCH_ART: Record<string, readonly string[]> = {
  // Dusk mountains: night sky, a mustard sun, lilac peaks.
  dusk: ["..........", ".NNNNNNNN.", ".NNNNNyyN.", ".NNNNNyyN.", ".NNlNNNNN.", ".NlllNlNN.", ".llllllll.", ".llllllll.", ".llllllll.", ".........."],
  // Moonlit tide: navy water, a cream sail.
  tide: ["..........", ".NNNNNNNN.", ".NNNiNNNN.", ".NNNiiNNN.", ".NNNiiiNN.", ".NNwwwwNN.", ".gggggggg.", ".NNNNNNNN.", ".NNNNNNNN.", ".........."],
};
function swatch(name: string): UiFrame {
  const ramp = SWATCH_RAMP[name];
  if (!ramp) return art(`swatch/${name}`, SWATCH_ART[name] ?? []);
  const S = 10;
  const img = new Uint8Array(S * S);
  for (let y = 1; y < S - 1; y++) {
    for (let x = 1; x < S - 1; x++) {
      if ((x === 1 || x === S - 2) && (y === 1 || y === S - 2)) continue;
      const edgeLo = x === S - 2 || y === S - 2 || (x === S - 3 && y === S - 3);
      const edgeHi = x === 1 || y === 1 || (x === 2 && y === 2);
      img[y * S + x] = c(ramp, edgeLo ? 2 : edgeHi ? 0 : 1);
    }
  }
  plumOutline(img, S, S);
  return { key: `swatch/${name}`, w: S, h: S, img, ax: 5, ay: 5 };
}
/** The picked swatch: a mustard ring that sits 1 art px outside a swatch (14×14 over the 10×10). */
function swatchRing(): UiFrame {
  const S = 14;
  const img = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.min(x, y, S - 1 - x, S - 1 - y);
      const corner = (x < 2 || x > S - 3) && (y < 2 || y > S - 3);
      if (corner) continue;
      if (d === 0) img[y * S + x] = O;
      else if (d === 1) img[y * S + x] = c("mustard", x + y < S ? 0 : 2);
    }
  }
  return { key: "swatch/ring", w: S, h: S, img, ax: 7, ay: 7 };
}

/** Every catalogue colour, in tray order. */
export const SWATCHES = ["velvet", "navy", "cream", "olive", "ginger", "blush", "wood", "brass", "rust", "teal", "lilac", "dusk", "tide"] as const;

/** Footprints the catalogue uses (`footprintByDir`), each marker state. */
const FOOTPRINT_SIZES: readonly (readonly [number, number])[] = [[1, 1], [2, 1], [1, 2], [3, 2], [2, 3]];

/** Set (h) frames for the UI atlas. `frames` are the print's back layers (`furniture/frame/dusk/<dir>/back`) for the wall markers;
 *  `thumbs` come from furniture.ts (`buildThumbs`). */
export function buildOwnerFrames(printSe: RoomFrame, printSw: RoomFrame, thumbs: readonly RoomFrame[]): UiFrame[] {
  const out: UiFrame[] = [gridCell()];
  for (const st of ["ok", "no", "sel"] as const) for (const [w, h] of FOOTPRINT_SIZES) out.push(footprint(st, w, h));
  for (const st of ["ok", "no"] as const) out.push(wallMark(st, "se", printSe), wallMark(st, "sw", printSw));
  for (const n of Object.keys(HANDLE_ICONS)) for (const s of ["idle", "hover"] as const) out.push(handle(n, s));
  out.push(selfOn(), tray(), tab("idle"), tab("hover"), tab("on"));
  for (const s of ["idle", "hover", "held", "off"] as const) out.push(slot(s));
  out.push(privatePill(), ticket("idle"), ticket("copied"), ticket("expired"));
  for (const [n, rows] of Object.entries(ICONS)) out.push(art(`icon/${n}`, rows, 8, 8));
  for (const [n, rows] of Object.entries(GLYPHS)) out.push(art(`glyph/${n}`, rows, 4, 4));
  for (const [n, rows] of Object.entries(FOOTPRINTS)) out.push(art(`glyph/fp-${n}`, rows, 6, 4));
  out.push(art("door/private", DOOR_PRIVATE, 8, 24));
  for (const s of SWATCHES) out.push(swatch(s));
  out.push(swatchRing());
  for (const t of thumbs) out.push({ ...t });
  return out;
}

const u = (n: number): string => (n === 0 ? "0" : `calc(${String(n)} * var(--ui-px))`);

/** Set (h) rules appended to `ui/reference.css`. */
export function ownerCss(edit: Readonly<Record<string, { x: number; y: number; w: number; h: number }>>, sheet: { w: number; h: number }, thumbBox: { w: number; h: number }): string {
  const slice = (k: string): string => `url("slices/${k.replace(/\//g, "-")}.png")`;
  const nineRule = (k: string, b: number): string =>
    `border-style: solid; border-color: transparent; border-width: ${u(b)}; border-image: ${slice(k)} ${String(b)} fill / ${u(b)} stretch;`;
  const src = (k: string): string => `border-image-source: ${slice(k)};`;
  const kebab = (k: string): string => k.replace(/\//g, "-");
  // Lazy edit kit (ui/edit.png): the tray's thumbnails and swatches as CSS sprites. Same .ui-sprite element, another sheet.
  const lazy = Object.entries(edit).filter(([k]) => /^(thumb|swatch|handle)\//.test(k));
  const lazyRules = lazy.map(([k, r]) => `.ui-${kebab(k)} { width: ${u(r.w)}; height: ${u(r.h)}; background-position: ${u(-r.x)} ${u(-r.y)}; }`).join("\n");
  const lazySel = lazy.map(([k]) => `.ui-${kebab(k)}`).join(", ");
  const tk = `${String(TICKET.top)} ${String(TICKET.right)} ${String(TICKET.bottom)} ${String(TICKET.left)}`;
  const tkw = `${u(TICKET.top)} ${u(TICKET.right)} ${u(TICKET.bottom)} ${u(TICKET.left)}`;
  return `
/* ---- Set (h) (OME-276): room owner edit mode, furniture tray, create room and private-room invites.
 * Mustard rim on night = only you (the owner) see or do this. Wood = the room's furniture. Teal ring + dots = fits;
 * rust dashed ring + hatching = can't go there. Ticket = invite. Key = invite only. Little house = the room's host.
 * The grid, footprint markers and rotate/remove handles live in the room (Pixi, 1×): see assets/README.md. */
.ui-tray, .ui-tab, .ui-slot, .ui-ticket, .ui-pill-private, .ui-swatch { image-rendering: pixelated; box-sizing: border-box; }

/* Lazy sheet: edit.png (+ edit.json for Pixi) holds the owner's edit kit. Load it when "Edit room" is pressed, never for guests. */
${lazySel} { background-image: url("edit.png"); background-size: ${u(sheet.w)} ${u(sheet.h)}; }
${lazyRules}

/* Edit toggle: a personal key (.ui-button.self) with icon/arrange + "Edit room". aria-pressed="true" latches it: a filled mustard
 * face that has lost its lip, plum label ("Done"). Only the owner gets this key. */
.ui-button.self[aria-pressed="true"], .ui-button.self.is-on { ${src("button/self/on")} color: var(--ui-on-primary); padding-top: ${u(2)}; padding-bottom: 0; }

/* Furniture tray: a wooden drawer under the stage. Tabs sit on its top rim (the open tab's bottom row covers the rim's outline). */
.ui-tray { ${nineRule("tray/0", 10)} display: flex; gap: ${u(3)}; padding: ${u(1)}; overflow-x: auto; scrollbar-width: thin; }
.ui-tabs { display: flex; gap: ${u(1)}; padding-left: ${u(6)}; margin-bottom: ${u(-1)}; position: relative; }
.ui-tab { border-style: solid; border-color: transparent; border-width: ${u(5)} ${u(5)} ${u(4)}; border-image: ${slice("tab/idle")} 5 5 4 fill / ${u(5)} ${u(5)} ${u(4)} stretch; display: inline-flex; align-items: center; gap: ${u(2)}; padding: 0 ${u(1)}; min-height: ${u(14)}; background: none; color: var(--ui-muted); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
.ui-tab:hover, .ui-tab.is-hover { ${src("tab/hover")} color: var(--ui-text); }
.ui-tab[aria-selected="true"] { ${src("tab/on")} color: var(--ui-text); }
.ui-tab:focus-visible { outline: var(--ui-px) solid var(--ui-text); outline-offset: var(--ui-px); }

/* Cubby: one catalogue piece. Centre its thumb/<id>/<colour> (≤ ${String(thumbBox.w)}×${String(thumbBox.h)} art px) inside; footprint glyph bottom-left.
 * Pressed (aria-pressed="true") = it's in your hand: mustard double rim. aria-disabled="true" = the room is at MAX_FURNITURE. */
.ui-slot { ${nineRule("slot/idle", 6)} position: relative; display: grid; place-items: center; width: ${u(thumbBox.w + 8)}; height: ${u(thumbBox.h + 10)}; padding: 0; background: none; cursor: grab; flex: none; }
.ui-slot:hover, .ui-slot.is-hover, .ui-slot:focus-visible { ${src("slot/hover")} outline: none; }
.ui-slot[aria-pressed="true"] { ${src("slot/held")} cursor: grabbing; }
.ui-slot[aria-disabled="true"] { ${src("slot/off")} cursor: default; }
.ui-slot .ui-fp { position: absolute; left: ${u(1)}; bottom: ${u(1)}; }
/* Variant swatches under the tray: one 10 px chip per colour (<button class="ui-swatch" role="radio"> holding the swatch sprite and a
 * .ui-sprite.ui-swatch-ring); the picked one shows its mustard ring. */
.ui-swatches { display: flex; gap: ${u(3)}; align-items: center; }
.ui-swatch { position: relative; width: ${u(10)}; height: ${u(10)}; padding: 0; border: 0; background: none; cursor: pointer; }
.ui-swatch > .ui-sprite { display: block; }
.ui-swatch > .ui-swatch-ring { display: none; position: absolute; left: ${u(-2)}; top: ${u(-2)}; }
.ui-swatch[aria-checked="true"] > .ui-swatch-ring { display: block; }
.ui-swatch:focus-visible { outline: var(--ui-px) solid var(--ui-text); outline-offset: ${u(3)}; }

/* Invite link: a cinema ticket, fixed ${String(TICKET.h)} art px tall. The link text sits on the card in plum; the stub is decoration.
 * .is-copied stamps a teal check on the stub (pair it with "Copied" on the key, glyph/check); .is-expired tears the stub off and greys it. */
.ui-ticket { border-style: solid; border-color: transparent; border-width: ${tkw}; border-image: ${slice("ticket/idle")} ${tk} fill / ${tkw} stretch; height: ${u(TICKET.h)}; display: flex; align-items: center; padding: 0 ${u(1)}; color: var(--ui-bubble-text); font: 600 13px/1 ui-monospace, monospace; white-space: nowrap; overflow: hidden; min-width: 0; }
.ui-ticket > span { overflow: hidden; text-overflow: ellipsis; }
.ui-ticket.is-copied { ${src("ticket/copied")} }
.ui-ticket.is-expired { ${src("ticket/expired")} color: var(--ui-panel); text-decoration: line-through; }
.ui-room .ui-ticket { font-size: 10px; }

/* Private room: "Invite only" pill (glyph/key + words), cream rim on night. */
.ui-pill-private { ${nineRule("pill/private", 4)} display: inline-flex; align-items: center; gap: ${u(2)}; padding: 0 ${u(1)}; color: var(--ui-text); font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; line-height: 1; white-space: nowrap; }
.ui-room .ui-pill-private { font-size: 9px; }
/* The host's name tag carries glyph/host before the name. */
.ui-tag .ui-glyph-host { vertical-align: -1px; margin-right: ${u(1)}; }
`;
}
