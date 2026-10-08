// Set (i) (OME-416), M5 rooms you own + emotes: the create-room form's invite-only switch, the "your rooms" list row and its
// close-for-good confirm, the invite-paste slot, the "room closed" (4004) and "invite required" states, and the emote picker.
// Same palette, plum outline and top-left light as sets (c)/(e)/(f)/(h). Every motif keeps one meaning:
//   moon          = closed / closing: lights out. The hanger on a closed room's door, the close key, the "closes if nobody visits" note.
//   keyhole       = you need a key (an invite) to get in. Light under the door says people are inside.
//   key + bolt    = invite only. The switch's knob carries the door (anyone) or the key (invite only), and slides like a bolt.
//   mustard rim   = only you (sets e/f/h): "your rooms" rows, the emote key and its picker.
//   rust key      = the one irreversible action (close a room for good), only ever on the confirm step, with the moon and words.
// No new colours: still the 67.
import { EMOTES, type EmoteDef } from "./motion";
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import { blank, render, stamp, type Grid, type RoleMap } from "./sprite";
import { all, lit, nine, slab, type UiFrame } from "./ui";

const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const O = OUTLINE;

const ROLES: RoleMap = {
  // Flat highlight, like the key icons of sets (e)/(h): crisp on night and wood faces at 1×.
  i: { ramp: "cream", tone: 0 },
  C: { ramp: "cream", tone: 2 },
  y: { ramp: "mustard", tone: 0 },
  Y: { ramp: "mustard", tone: 1 },
  // Auto-shaded surfaces.
  c: { ramp: "cream", hi: true },
  m: { ramp: "mustard", hi: true },
  M: { ramp: "mustard", tone: 2 },
  w: { ramp: "wood", hi: true },
  W: { ramp: "wood", tone: 2 },
  d: { ramp: "wood", hi: true, group: "d" },
  D: { ramp: "wood", tone: 2, group: "d" },
  x: { ramp: "charcoal", hi: true },
  X: { ramp: "charcoal", tone: 2 },
  n: { ramp: "night", tone: 1 },
  N: { ramp: "night", tone: 2 },
  k: { ramp: "night", tone: 0 },
  // Room-only roles for the two state vignettes.
  a: { ramp: "wall", hi: true },
  A: { ramp: "wall", tone: 2 },
  L: { ramp: "wall", tone: 0 },
  Q: { ramp: "hairDark", tone: 0 },
  F: { ramp: "floor", hi: true },
  P: { ramp: "floor", tone: 2 },
  G: { ramp: "floor", tone: 2, group: "G" },
  v: { ramp: "velvet", hi: true },
  V: { ramp: "velvet", tone: 2 },
  o: { ramp: "outline", tone: 1 },
};

function grid(keyName: string, g: Grid, roles: RoleMap, ax: number, ay: number): UiFrame {
  return { key: keyName, w: g[0]?.length ?? 0, h: g.length, img: render(g, roles), ax, ay };
}

function art(keyName: string, rows: readonly string[], ax?: number, ay?: number): UiFrame {
  const w = rows[0]?.length ?? 0, h = rows.length;
  rows.forEach((r, i) => { if (r.length !== w) throw new Error(`${keyName}: row ${String(i)} is ${String(r.length)} wide, not ${String(w)}`); });
  const g = blank(w, h);
  stamp(g, rows, 0, 0);
  return grid(keyName, g, ROLES, ax ?? w / 2, ay ?? h / 2);
}

// ------------------------------------------------------------------ keys and rows (9-slices)

/** Close-for-good key: set (c)'s chunky key in rust. Only on the confirm step, always with icon/closed and the words. */
function dangerKey(state: "idle" | "hover" | "press"): UiFrame {
  const W = 16, H = 20;
  const img = slab(W, H, 2, (d, e) => {
    if (d === 0) return O;
    if (state === "press") {
      if (d === 1 && e === "t") return O;
      if ((d === 1 && e === "l") || (d === 2 && e === "t")) return c("rust", 2);
      return c("rust", 1);
    }
    if (e === "b" && d <= 2) return c("rust", 2);
    if (d === 1 && e === "r") return c("rust", 2);
    if (d === 1 && lit(e)) return state === "hover" ? c("cream", 0) : c("rust", 0);
    return state === "hover" ? c("rust", 0) : c("rust", 1);
  });
  return nine(`button/danger/${state}`, W, H, img, all(5));
}

/** A personal key that's resting (your emotes are cooling down): set (f)'s `button/shared/cool` recipe on the night face,
 *  a step darker with a charcoal lip, so it reads "not yet", not "off". */
function selfCool(): UiFrame {
  const W = 16, H = 20;
  const img = slab(W, H, 2, (d, e) => {
    if (d === 0) return O;
    if (e === "b" && d <= 2) return c("charcoal", 2);
    if (d === 1 && e === "r") return c("charcoal", 2);
    if (d === 1 && lit(e)) return c("mustard", 2);
    return c("night", 2);
  });
  return nine("button/self/cool", W, H, img, all(5));
}

/** "Your rooms" row: set (f)'s room card (dusk glass in a wood rim) with the mustard "only you" line inside the rim. */
function mineCard(state: "idle" | "hover" | "confirm"): UiFrame {
  const W = 18;
  const img = slab(W, W, 2, (d, e) => {
    if (d === 0) return O;
    if (d <= 2) {
      if (d === 1 && lit(e)) return state === "hover" ? c("cream", 0) : c("wood", 0);
      return lit(e) ? c("wood", 1) : c("wood", 2);
    }
    if (d === 3) return state === "confirm" ? c("rust", lit(e) ? 0 : 2) : c("mustard", lit(e) ? 0 : 2);
    if (d === 4) return O;
    return state === "confirm" ? c("charcoal", 2) : c("night", 1);
  });
  return nine(`card/mine/${state}`, W, W, img, all(7));
}

/** Invite-paste slot: set (h)'s ticket silhouette as an empty, sunken night card (plum shadow top-left, lit lip bottom-right),
 *  a cream-shade edge and the "admit" star ghosted on the stub. Focus swaps the edge for mustard (set c's focus colour). */
export const SLOT = { w: 34, h: 20, left: 17, right: 6, top: 4, bottom: 4 } as const;
function ticketSlot(state: "idle" | "focus"): UiFrame {
  const { w: W, h: H } = SLOT;
  const perf = 11;
  const inside = (x: number, y: number): boolean => {
    if (x < 1 || y < 1 || y > H - 2 || x > W - 2) return false;
    if (Math.hypot(x + 0.5 - (perf + 0.5), y < H / 2 ? y - 0.5 : y - (H - 1.5)) < 2.6) return false;
    return Math.hypot(x + 0.5 - (W - 1), y + 0.5 - H / 2) >= 3.1;
  };
  const edge = state === "focus" ? c("mustard", 0) : c("cream", 2);
  const img = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inside(x, y)) {
        if (inside(x + 1, y) || inside(x - 1, y) || inside(x, y + 1) || inside(x, y - 1)) img[y * W + x] = O;
        continue;
      }
      const rim = !inside(x + 1, y) || !inside(x - 1, y) || !inside(x, y + 1) || !inside(x, y - 1);
      if (rim) { img[y * W + x] = edge; continue; }
      // Sunken: the row/column just inside the rim is plum on the top-left, the night highlight on the bottom-right.
      if (!inside(x, y - 2) || !inside(x - 2, y)) img[y * W + x] = O;
      else if (!inside(x, y + 2) || !inside(x + 2, y)) img[y * W + x] = c("night", 0);
      else img[y * W + x] = c("night", 2);
    }
  }
  for (let y = 4; y < H - 4; y += 2) img[y * W + perf] = c("night", 0);
  for (const [x, y] of [[5, 7], [5, 8], [5, 11], [5, 12], [3, 9], [3, 10], [4, 9], [4, 10], [6, 9], [6, 10], [7, 9], [7, 10], [5, 9], [5, 10]] as const) img[y * W + x] = c("night", 0);
  return { key: `ticket/slot-${state}`, w: W, h: H, img, ax: 0, ay: 0, borders: { left: SLOT.left, top: SLOT.top, right: SLOT.right, bottom: SLOT.bottom }, slice: true, fixedHeight: true };
}

/** Emote picker tray: your picker, so the night face in the mustard "only you" rim, like the emote key it opens from. */
function emoteTray(): UiFrame {
  const W = 16;
  const img = slab(W, W, 3, (d, e) => {
    if (d === 0) return O;
    if (d === 1) return c("mustard", lit(e) ? 0 : 2);
    if (d === 2) return O;
    return c("night", 1);
  });
  return nine("emotes/tray", W, W, img, all(6));
}

/** Tray tail, 16×6: a 2:1 stair down to the emote key (like the chat bubble's), the mustard rim and plum outline carried through.
 *  Rows 0-2 overlap the tray's bottom rim (its inner plum line, mustard line, outer plum line) and open it, so tail and tray are one shape. */
const TAIL: readonly string[] = [
  "..nnnnnnnnnnnn..",
  "..MnnnnnnnnnnM..",
  "..MMnnnnnnnnMM..",
  "..OOMMnnnnMMOO..",
  "....OOMMMMOO....",
  "......OOOO......",
];
function emoteTail(): UiFrame {
  const TW = 16, TH = TAIL.length;
  const img = new Uint8Array(TW * TH);
  TAIL.forEach((row, y) => { for (let x = 0; x < TW; x++) { const ch = row[x]; if (ch === "n") img[y * TW + x] = c("night", 1); else if (ch === "M") img[y * TW + x] = c("mustard", 2); else if (ch === "O") img[y * TW + x] = O; } });
  return { key: "emotes/tail", w: TW, h: TH, img, ax: TW / 2, ay: 0, slice: true };
}

/** Emote cell inside the tray. idle = flat (the sticker floats on the tray), hover = a sunken well with a cream lit edge,
 *  press = the well with the mustard rim (sent), cool = a charcoal well (you're emoting too fast; the key shows the timer). */
function emoteSlot(state: "idle" | "hover" | "press" | "cool"): UiFrame {
  const W = 12;
  const img = slab(W, W, 2, (d, e) => {
    if (state === "idle") return c("night", 1);
    if (d === 0) return state === "press" ? c("mustard", 0) : state === "hover" ? (lit(e) ? O : c("cream", 0)) : O;
    if (d === 1) return lit(e) ? O : state === "cool" ? c("charcoal", 1) : c("night", 0);
    return state === "cool" ? c("charcoal", 2) : c("night", 2);
  });
  return nine(`emotes/slot/${state}`, W, W, img, all(4));
}

/** A 2×4 tile of 1-bit dither (plum on every other pixel, staggered): dims the stage behind a state card without alpha. */
function scrim(): UiFrame {
  const img = new Uint8Array([O, 0, 0, O, O, 0, 0, O]);
  return { key: "scrim/0", w: 2, h: 4, img, ax: 0, ay: 0, slice: true };
}

// ------------------------------------------------------------------ the invite-only switch (fixed sprites, page chrome)

/** 32×16: a sunken night track and a 16×16 wood knob that slides like a door bolt. Left + door = anyone can come in;
 *  right + key = invite only. The other side's glyph is ghosted in the track, so both options always show (and the state never
 *  rests on colour). hover = the knob's cream lit edge (set c). off = charcoal knob, cream-shade glyph (set c's disabled). */
const KNOB_GLYPH = {
  // A door ajar: wood leaf, warm lamplight in the gap.
  open: ["..dddddd..", "..dyyddd..", "..dyyddd..", "..dyyddd..", "..dyyddd..", "..dyydmd..", "..dyyddd..", "..dyyddd..", "..dyyddd..", "..dddddd.."],
  // The set (h) brass key, laid along the bolt.
  key: ["..........", "..........", ".mmm......", "m...m.....", "m...mmmmmm", "m...m..m.m", ".mmm...m.m", "..........", "..........", ".........."],
} as const;
const GHOST = {
  open: ["kkkk", "k.kk", "k.kk", "k.kk", "k.kk", "kkkk"],
  key: ["kk....", "kkkkkk", "kk..k."],
} as const;
function toggle(on: boolean, state: "idle" | "hover" | "off"): UiFrame {
  const W = 32, H = 16;
  const img = slab(W, H, 3, (d, e) => {
    if (d === 0) return O;
    if (d === 1) return lit(e) ? O : c("night", 0);
    return c("night", 2);
  });
  // Ghost of the other option, in the track.
  const g = blank(W, H);
  if (on) stamp(g, GHOST.open, 6, 5);
  else stamp(g, GHOST.key, 21, 6);
  const knobX = on ? 16 : 0;
  const ramp: RampName = state === "off" ? "charcoal" : "wood";
  const knob = slab(16, 16, 2, (d, e) => {
    if (d === 0) return O;
    if (e === "b" && d <= 2) return c(ramp, 2);
    if (d === 1 && e === "r") return c(ramp, 2);
    if (d === 1 && lit(e)) return state === "hover" ? c("cream", 0) : c(ramp, 0);
    return c(ramp, 1);
  });
  const glyph = blank(16, 16);
  stamp(glyph, on ? KNOB_GLYPH.key : KNOB_GLYPH.open, 3, 2);
  const glyphImg = render(glyph, state === "off" ? { ...ROLES, d: { ramp: "cream", tone: 2 }, y: { ramp: "cream", tone: 2 }, m: { ramp: "cream", tone: 2 } } : ROLES);
  const ghostImg = render(g, ROLES);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gv = ghostImg[y * W + x] ?? 0;
      if (gv !== 0 && gv !== O) img[y * W + x] = gv;
      const kx = x - knobX;
      if (kx < 0 || kx >= 16) continue;
      const kv = knob[y * 16 + kx] ?? 0;
      if (kv !== 0) img[y * W + x] = kv;
      const gl = glyphImg[y * 16 + kx] ?? 0;
      if (gl !== 0 && kv !== 0 && y < 13) img[y * W + x] = gl;
    }
  }
  const key = state === "off" ? `switch/${on ? "private" : "public"}/off` : `switch/${on ? "private" : "public"}/${state}`;
  return { key, w: W, h: H, img, ax: 0, ay: 0 };
}

// ------------------------------------------------------------------ the two state vignettes (page chrome, 2×)

/** 72×64 front-on doorway: violet wallpaper over wainscoting, a door with a fanlight, a sconce, a doormat on the honey planks.
 *  closed = lights out: the wall in shade, the fanlight shows night and two stars, the sconce is off, no light under the door,
 *           and a cream hanger with a mustard crescent moon hangs on the knob.
 *  invite = someone's home: the wall lit, a warm fanlight and a lit sconce, lamplight under the door, a brass lock plate with
 *           an empty keyhole, and a dashed ghost ticket beside it ("you need a ticket"). */
const SCENE = { w: 72, h: 64 } as const;
function vignette(kind: "closed" | "invite"): UiFrame {
  const { w: W, h: H } = SCENE;
  const g = blank(W, H);
  const dark = kind === "closed";
  const rect = (x: number, y: number, w: number, h: number, ch: string): void => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const row = g[yy]; if (row && xx >= 0 && xx < W) row[xx] = ch; }
  };
  const put = (x: number, y: number, ch: string): void => { rect(x, y, 1, 1, ch); };
  // Wall + wallpaper lozenges.
  rect(1, 1, W - 2, 46, dark ? "A" : "a");
  for (let y = 4; y < 38; y += 6) for (let x = 4 + (Math.floor((y - 4) / 6) % 2) * 4; x < W - 2; x += 8) { put(x, y, dark ? "Q" : "L"); put(x - 1, y + 1, dark ? "Q" : "L"); put(x + 1, y + 1, dark ? "Q" : "L"); put(x, y + 2, dark ? "Q" : "L"); }
  // Wainscot: a rail, then panels.
  rect(1, 38, W - 2, 2, dark ? "W" : "w");
  rect(1, 40, W - 2, 7, dark ? "W" : "w");
  for (let x = 5; x < W - 4; x += 10) { rect(x, 41, 7, 1, "o"); rect(x, 42, 1, 4, "o"); }
  rect(1, 40, W - 2, 1, "o");
  // Floor: honey planks with 2:1 seams, then the outline bottom.
  rect(1, 47, W - 2, 16, dark ? "G" : "F");
  rect(1, 47, W - 2, 1, "o");
  for (let s = -40; s < W; s += 14) for (let y = 48; y < 63; y++) { const x = s + (y - 48) * 2; put(x, y, dark ? "Q" : "P"); put(x + 1, y, dark ? "Q" : "P"); }
  // Door frame, door, fanlight.
  const dx = 24, dw = 24;
  rect(dx - 3, 6, dw + 6, 41, dark ? "W" : "w");
  rect(dx - 1, 7, dw + 2, 1, "o");
  rect(dx - 1, 7, 1, 40, "o");
  rect(dx + dw, 7, 1, 40, "o");
  rect(dx, 8, dw, 6, dark ? "n" : "y");
  if (dark) { put(dx + 5, 10, "i"); put(dx + 16, 9, "i"); put(dx + 11, 12, "C"); }
  else for (let x = dx + 2; x < dx + dw; x += 5) rect(x, 8, 1, 6, "Y");
  rect(dx, 14, dw, 1, "o");
  rect(dx, 15, dw, 32, dark ? "D" : "d");
  // Two raised panels.
  for (const [py, ph] of [[18, 11], [32, 11]] as const) {
    rect(dx + 4, py, dw - 8, ph, dark ? "Q" : "D");
    rect(dx + 5, py + 1, dw - 10, ph - 2, dark ? "D" : "d");
  }
  // Knob.
  rect(dx + dw - 5, 30, 2, 2, "m");
  if (dark) {
    // Lights out: no light under the door (a plum sill), and the moon hanger on the knob.
    rect(dx, 46, dw, 1, "o");
    put(dx + dw - 5, 32, "o");
    put(dx + dw - 6, 33, "o"); put(dx + dw - 3, 33, "o");
    rect(dx + dw - 10, 34, 10, 11, "c");
    // Crescent moon: a mustard disc with a bite out of its upper right.
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const inMoon = Math.hypot(x - 3, y - 3) < 3.3, bite = Math.hypot(x - 5, y - 1.6) < 2.6;
      if (inMoon && !bite) put(dx + dw - 8 + x, 36 + y, "m");
    }
  } else {
    // Lamplight under the door, spilling a little onto the floor.
    rect(dx, 46, dw, 1, "y");
    rect(dx + 2, 47, dw - 4, 1, "y");
    for (let x = dx + 4; x < dx + dw - 4; x += 3) put(x, 48, "y");
    // Brass lock plate with an empty keyhole (no key: you need an invite).
    rect(dx + dw - 6, 33, 4, 8, "m");
    put(dx + dw - 5, 35, "o"); put(dx + dw - 4, 35, "o");
    put(dx + dw - 5, 36, "o"); put(dx + dw - 4, 36, "o");
    put(dx + dw - 5, 37, "o"); put(dx + dw - 4, 38, "o");
    put(dx + dw - 5, 38, "o");
  }
  // Sconce (left): a wood bracket and a globe, lit or off.
  rect(9, 22, 4, 2, dark ? "W" : "w");
  rect(10, 16, 2, 6, dark ? "W" : "w");
  for (let y = 0; y < 7; y++) for (let x = 0; x < 8; x++) if (Math.hypot(x - 3.5, y - 3) < 3.6) put(7 + x, 9 + y, dark ? "x" : y < 4 && x < 5 ? "i" : "c");
  if (!dark) { put(5, 10, "Y"); put(17, 10, "Y"); put(4, 13, "Y"); put(18, 13, "Y"); }
  // Doormat.
  rect(dx + 1, 53, dw - 2, 5, dark ? "V" : "v");
  rect(dx + 1, 53, dw - 2, 1, "o");
  rect(dx + 1, 58, dw - 2, 1, "o");
  for (let x = dx + 3; x < dx + dw - 2; x += 4) put(x, 55, dark ? "Q" : "m");
  if (!dark) {
    // The ghost ticket you'd need: a dashed cream-shade outline of set (h)'s ticket, its stub towards the keyhole.
    const tx = 54, ty = 25, tw = 14, th = 9;
    for (let x = tx; x < tx + tw; x++) { if ((x - tx) % 3 !== 2) { put(x, ty, "C"); put(x, ty + th - 1, "C"); } }
    for (let y = ty; y < ty + th; y++) { if ((y - ty) % 3 !== 2) { put(tx, y, "C"); put(tx + tw - 1, y, "C"); } }
    for (let y = ty + 2; y < ty + th - 2; y += 2) put(tx + 4, y, "C");
    put(tx + 2, ty + 4, "C");
  }
  // Plum outline around the whole vignette.
  rect(0, 0, W, 1, "o"); rect(0, H - 1, W, 1, "o"); rect(0, 0, 1, H, "o"); rect(W - 1, 0, 1, H, "o");
  return grid(`scene/${kind}`, g, ROLES, W / 2, H);
}

// ------------------------------------------------------------------ icons, glyphs, door thumbnails

const ICONS: Record<string, readonly string[]> = {
  // Close room / room closed: a door hanger (hole and slit at the top) with a crescent moon. Lights out.
  closed: [
    "................",
    ".....cccccc.....",
    "....cccccccc....",
    "....ccc..ccc....",
    "....ccc..ccc....",
    "....cccccccc....",
    "....c.cccccc....",
    "....cccccccc....",
    "....cccmmmcc....",
    "....ccmmcccc....",
    "....ccmmcccc....",
    "....ccmmcccc....",
    "....cccmmmcc....",
    "....cccccccc....",
    "................",
    "................",
  ],
  // The emote key: a round face drawn in cream line (not a filled sticker, so it can't be mistaken for the laugh emote).
  emote: [
    "................",
    ".....iiiiii.....",
    "...ii......ii...",
    "..i..........i..",
    "..i..........i..",
    ".i...ii..ii...i.",
    ".i...ii..ii...i.",
    ".i............i.",
    ".i............i.",
    ".i..i......i..i.",
    "..i..i....i..i..",
    "..i...iiii...i..",
    "...ii......ii...",
    ".....iiiiii.....",
    "................",
    "................",
  ],
};

const GLYPHS: Record<string, readonly string[]> = {
  // Closes if nobody visits: a small mustard crescent.
  moon: ["........", "..yyy...", ".yy.....", ".y......", ".y......", ".yy.....", "..yyy...", "........"],
  // Anyone can come in: a tiny open door.
  open: ["........", ".dddd...", ".dyyd...", ".dyyd...", ".dyyd...", ".dyyd...", ".dddd...", "........"],
};

// Door thumbnails, 16×24, like `door/open` / `door/full` / `door/private` (anchor bottom centre).
const DOORS: Record<string, readonly string[]> = {
  // Closed: dark wood, a plum sill (no light under the door) and the moon hanger on the knob.
  closed: [
    "................",
    "..WWWWWWWWWWWW..",
    "..WWWWWWWWWWWW..",
    "..WWQQQQQQQQWW..",
    "..WWQWWWWWWQWW..",
    "..WWQWWWWWWQWW..",
    "..WWQWWWWWWQWW..",
    "..WWQQQQQQQQWW..",
    "..WWWWWWWWWWWW..",
    "..WWWWWWWmWWWW..",
    "..WWWWWWoWoWWW..",
    "..WWWWWcccccWW..",
    "..WWWWWcmmccWW..",
    "..WWWWWcmcccWW..",
    "..WWWWWcmmccWW..",
    "..WWWWWcccccWW..",
    "..WWWWWWWWWWWW..",
    "..WWQQQQQQQQWW..",
    "..WWQWWWWWWQWW..",
    "..WWQQQQQQQQWW..",
    "..WWWWWWWWWWWW..",
    "..oooooooooooo..",
    "................",
    "................",
  ],
  // Locked: shut, a brass plate with an empty keyhole, and lamplight under the door (someone's in).
  locked: [
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
    "..wwwwwwwmmmww..",
    "..wwwwwwwmomww..",
    "..wwwwwwwmomww..",
    "..wwwwwwwmmmww..",
    "..wwwwwwwwwwww..",
    "..wwwwwwwwwwww..",
    "..wwwwwwwwwwww..",
    "..wwWWWWWWWWww..",
    "..wwWwwwwwwWww..",
    "..wwWWWWWWWWww..",
    "..wwwwwwwwwwww..",
    "...yyyyyyyyyy...",
    "................",
    "................",
  ],
};

/** The wave as a picker icon (the motion atlas has the gesture, not a sticker): an open blush palm with two cream motion ticks,
 *  drawn like the emote stickers (one base tone + auto shade, plum outline, no highlight band). */
const WAVE: EmoteDef = {
  id: "wave",
  label: "Wave",
  roles: { h: { ramp: "blush" }, i: { ramp: "cream", tone: 0, group: "i" } },
  pop: [],
  art: [
    ".....h.h....",
    "...h.h.h....",
    "...h.h.h.h..",
    "i..h.h.h.h..",
    "i..hhhhhhh..",
    "...hhhhhhh.h",
    "i..hhhhhhhhh",
    "i..hhhhhhhh.",
    "....hhhhhh..",
    "....hhhhh...",
  ],
  accent: [],
};

/** Picker cell icon: the emote's settled frame, centred in 16×16, rendered with its own roles exactly as in the motion atlas. */
function pick(e: EmoteDef): UiFrame {
  const g = blank(16, 16);
  const w = Math.max(...e.art.map((r) => r.length));
  stamp(g, e.art, Math.floor((16 - w) / 2), Math.floor((16 - e.art.length) / 2));
  return grid(`emote-pick/${e.id}`, g, e.roles, 8, 8);
}

/** Picker separator between the emotes and the wave (a gesture, not a sticker): a 2 px groove, plum then the night highlight. */
function sep(): UiFrame {
  const H = 14;
  const img = new Uint8Array(2 * H);
  for (let y = 1; y < H - 1; y++) { img[y * 2] = O; img[y * 2 + 1] = c("night", 0); }
  return { key: "emotes/sep", w: 2, h: H, img, ax: 1, ay: H / 2 };
}

/** Emote ids in picker order: the five stickers, then the wave. Keys 1-6 pick them. */
export const PICKER = [...EMOTES.map((e) => e.id), WAVE.id] as const;

export function buildRoomsFrames(): UiFrame[] {
  const out: UiFrame[] = [];
  for (const s of ["idle", "hover", "press"] as const) out.push(dangerKey(s));
  out.push(selfCool());
  for (const s of ["idle", "hover", "confirm"] as const) out.push(mineCard(s));
  out.push(ticketSlot("idle"), ticketSlot("focus"), emoteTray(), emoteTail(), sep(), scrim());
  for (const s of ["idle", "hover", "press", "cool"] as const) out.push(emoteSlot(s));
  for (const on of [false, true]) for (const s of ["idle", "hover", "off"] as const) out.push(toggle(on, s));
  for (const [n, rows] of Object.entries(ICONS)) out.push(art(`icon/${n}`, rows, 8, 8));
  for (const [n, rows] of Object.entries(GLYPHS)) out.push(art(`glyph/${n}`, rows, 4, 4));
  for (const [n, rows] of Object.entries(DOORS)) out.push(art(`door/${n}`, rows, 8, 24));
  for (const e of [...EMOTES, WAVE]) out.push(pick(e));
  return out;
}

/** The two state vignettes ship as standalone PNGs (`ui/scenes/<name>.png`), not in the eager sheet: only the closed / invite-required
 *  pages show them, and a CSS background only fetches when a rule matches. Keeps `ui.png` at 256×256. */
export function buildRoomsScenes(): UiFrame[] {
  return [vignette("closed"), vignette("invite")];
}

const u = (n: number): string => (n === 0 ? "0" : `calc(${String(n)} * var(--ui-px))`);

/** Set (i) rules appended to `ui/reference.css`. */
export function roomsCss(rects: Readonly<Record<string, { x: number; y: number; w: number; h: number }>>): string {
  const slice = (k: string): string => `url("slices/${k.replace(/\//g, "-")}.png")`;
  const nineRule = (k: string, b: number): string =>
    `border-style: solid; border-color: transparent; border-width: ${u(b)}; border-image: ${slice(k)} ${String(b)} fill / ${u(b)} stretch;`;
  const src = (k: string): string => `border-image-source: ${slice(k)};`;
  const kebab = (k: string): string => k.replace(/\//g, "-");
  const sprite = (k: string): string => {
    const r = rects[k];
    if (!r) throw new Error(`missing ${k}`);
    return `.ui-${kebab(k)} { width: ${u(r.w)}; height: ${u(r.h)}; background-position: ${u(-r.x)} ${u(-r.y)}; }`;
  };
  const pos = (k: string): string => {
    const r = rects[k];
    if (!r) throw new Error(`missing ${k}`);
    return `background-position: ${u(-r.x)} ${u(-r.y)};`;
  };
  const sk = `${String(SLOT.top)} ${String(SLOT.right)} ${String(SLOT.bottom)} ${String(SLOT.left)}`;
  const skw = `${u(SLOT.top)} ${u(SLOT.right)} ${u(SLOT.bottom)} ${u(SLOT.left)}`;
  return `
/* ---- Set (i) (OME-416): rooms you own + emotes. Moon = closed / closing (lights out). Keyhole = you need an invite.
 * Door/key switch = who can come in. Mustard rim = only you (your rooms, your emote picker). The rust key is the one
 * irreversible action (close a room for good), only on the confirm step, always with the moon icon and the words. */
.ui-switch, .ui-mine, .ui-slot-ticket, .ui-emotes, .ui-emote, .ui-scrim, .ui-scene { image-rendering: pixelated; box-sizing: border-box; }
${["emote-pick/heart", "emote-pick/laugh", "emote-pick/question", "emote-pick/exclaim", "emote-pick/clap", "emote-pick/wave", "emotes/sep"].map(sprite).join("\n")}

/* Invite-only switch: <button class="ui-sprite ui-switch" role="switch" aria-checked="false|true"> labelled "Invite only".
 * Off = the knob on the left showing the open door (anyone can find it on the room list); on = the knob slid right showing the key.
 * The other option is ghosted in the track, so both are always visible. Say the state in words next to it too. */
.ui-switch { width: ${u(32)}; height: ${u(16)}; padding: 0; border: 0; cursor: pointer; ${pos("switch/public/idle")} }
.ui-switch:hover, .ui-switch.is-hover { ${pos("switch/public/hover")} }
.ui-switch[aria-checked="true"] { ${pos("switch/private/idle")} }
.ui-switch[aria-checked="true"]:hover, .ui-switch[aria-checked="true"].is-hover { ${pos("switch/private/hover")} }
.ui-switch:disabled { ${pos("switch/public/off")} cursor: default; }
.ui-switch[aria-checked="true"]:disabled { ${pos("switch/private/off")} }
.ui-switch:focus-visible { outline: var(--ui-px) solid var(--ui-text); outline-offset: var(--ui-px); }

/* Close a room for good (confirm step only): .ui-button.danger + icon/closed + "Close room". Cream text on rust. */
.ui-button.danger { ${src("button/danger/idle")} color: var(--ui-text); }
.ui-button.danger:hover, .ui-button.danger.is-hover { ${src("button/danger/hover")} }
.ui-button.danger:active, .ui-button.danger.is-press { ${src("button/danger/press")} }
/* Your emote key resting after a burst: aria-disabled="true", icon swaps to the set (f) .ui-wait dial over the retry-after. */
.ui-button.self.is-cooling { ${src("button/self/cool")} cursor: default; padding: 0 0 ${u(2)}; }

/* "Your rooms" row: the room card with the mustard "only you" line. door/<open|private> thumb, title, a meta line
 * (glyph/moon + "Closes in 9 days if nobody visits" when it's within 3 days of the GC sweep), then Enter / copy invite / close keys.
 * .is-confirm turns the line rust and the glass charcoal while it asks "Close <title> for good?". */
.ui-mine { ${nineRule("card/mine/idle", 7)} display: flex; align-items: center; gap: ${u(4)}; padding: 0 ${u(1)}; color: var(--ui-text); }
.ui-mine:hover, .ui-mine.is-hover, .ui-mine:focus-within { ${src("card/mine/hover")} }
.ui-mine.is-confirm { ${src("card/mine/confirm")} }

/* Paste an invite (the invite-required page): an empty ticket-shaped slot, ${String(SLOT.h)} art px tall. Focus = mustard edge. */
.ui-slot-ticket { border-style: solid; border-color: transparent; border-width: ${skw}; border-image: ${slice("ticket/slot-idle")} ${sk} fill / ${skw} stretch; height: ${u(SLOT.h)}; background: none; color: var(--ui-text); font: 600 13px/1 ui-monospace, monospace; padding: 0 ${u(1)}; outline: none; min-width: 0; }
.ui-slot-ticket::placeholder { color: var(--ui-muted); opacity: 1; }
.ui-slot-ticket:focus-visible, .ui-slot-ticket.is-focus { ${src("ticket/slot-focus")} }
.ui-slot-ticket[aria-invalid="true"] { ${src("ticket/expired")} color: var(--ui-panel); }

/* Room closed (4004) / invite required: a panel with the scene/<closed|invite> vignette, a heading and one primary way out.
 * Mid-session (the host closed the room while you watched) lay .ui-scrim over the stage first: 1-bit dither, no alpha. */
.ui-scene { display: block; width: ${u(SCENE.w)}; height: ${u(SCENE.h)}; background: none no-repeat 0 0 / 100% 100%; }
.ui-scene-closed { background-image: url("scenes/closed.png"); }
.ui-scene-invite { background-image: url("scenes/invite.png"); }
.ui-scrim { background: ${slice("scrim/0")} 0 0 / ${u(2)} ${u(4)}; }

/* Emote picker: <div class="ui-emotes" role="menu"> above the emote key (.ui-button.self + icon/emote). Night tray, mustard rim,
 * a tail down to the key (set --ui-tail-x to the key's centre, from the tray's padding edge). Each <button class="ui-emote"
 * role="menuitem" aria-keyshortcuts="1".."6"> holds .ui-emote-pick-<id>; say the shortcut in its title, not on the cell.
 * The wave sits after .ui-sprite.ui-emotes-sep: it's your avatar's gesture (works seated too), not a sticker. */
.ui-emotes { ${nineRule("emotes/tray", 6)} position: relative; display: inline-flex; align-items: center; gap: ${u(1)}; padding: 0; }
.ui-emotes::after { content: ""; position: absolute; left: var(--ui-tail-x, 50%); top: calc(100% + ${u(3)}); width: ${u(16)}; height: ${u(6)}; translate: -50% 0; background: ${slice("emotes/tail")} 0 0 / 100% 100%; }
.ui-emote { ${nineRule("emotes/slot/idle", 4)} position: relative; display: grid; place-items: center; width: ${u(24)}; height: ${u(24)}; padding: 0; background: none; cursor: pointer; }
.ui-emote:hover, .ui-emote.is-hover, .ui-emote:focus-visible { ${src("emotes/slot/hover")} outline: none; }
.ui-emote:active, .ui-emote.is-press { ${src("emotes/slot/press")} }
.ui-emote[aria-disabled="true"] { ${src("emotes/slot/cool")} cursor: default; }
`;
}
