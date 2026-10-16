// Halloween theme (OME-1185): wall decor for the classic room, a moonlit window view, bat flap frames and a witch hat for
// every avatar frame. Everything uses the Dusk Lounge palette, the plum outline and top-left light (see STYLE.md § Holiday themes).
import { WALL_H, type RoomFrame } from "./room";
import { blank, render, stamp, type RoleMap } from "./sprite";
import { hash, onSill, pad, wallDecal, windowPanels, type DecorMeta, type HatDef, type Paint, type ThemeDef } from "./theme";

// ---------------------------------------------------------------- witch hat

/** Hat roles. Letters are free in every avatar's role map (checked in `hatted`). */
const HAT_ROLES: RoleMap = {
  K: { ramp: "charcoal", hi: true, group: "K" },
  V: { ramp: "charcoal", hi: true, group: "V" },
  N: { ramp: "ginger", hi: true, group: "N" },
  U: { ramp: "mustard", tone: 0 },
  // A stitched patch on the crown: one darn, so the hat looks loved rather than bought.
  J: { ramp: "lilac", tone: 2 },
};

/** How the hat sits on one avatar, in head-template px (head origin = top-left of the 16 px head). */
export interface HatFit {
  /** Brim row (its widest row). */
  brimY: number;
  /** Centre column of the crown. */
  cx: number;
  /** Brim half-width (widest row). */
  brim: number;
  /** Crown half-width at the band. */
  base: number;
  /** Crown height above the band. */
  height: number;
}

/** Big hair lifts the hat (Juno's puff); a hat that replaced headwear sits where that headwear sat and is wide enough to hide it. */
export const HAT_FITS: Readonly<Record<string, HatFit>> = {
  juno: { brimY: -3, cx: 8, brim: 12, base: 6, height: 15 },
  pip: { brimY: 1, cx: 8, brim: 11, base: 9, height: 15 },
  mo: { brimY: 3, cx: 8, brim: 13, base: 9, height: 15 },
  kiki: { brimY: -1, cx: 8, brim: 11, base: 5, height: 14 },
};

/** The hat as role rows relative to the head origin, facing SE (front) or NE (back). The tip folds toward the back of the head. */
export function hatRows(fit: HatFit, view: "front" | "back"): { x: number; y: number; rows: string[] } {
  const { put, span, rows } = pad();
  const { brimY, cx, brim, base, height } = fit;
  // Crown: a cone that narrows and leans back, then a crooked tip that droops.
  const bandTop = brimY - 3;
  for (let k = 1; k <= height; k++) {
    const t = k / height;
    const half = Math.max(0, Math.round(base * Math.pow(1 - t, 0.85)));
    const lean = Math.round(3 * Math.pow(t, 2.2));
    const c = cx - lean;
    span(bandTop - k + 1, c - half, c + half, "K");
  }
  const tipY = bandTop - height + 1;
  const tipX = cx - 3;
  put(tipX - 1, tipY + 1, "K");
  put(tipX - 2, tipY + 2, "K");
  put(tipX - 2, tipY + 3, "K");
  // Band (2 rows) and brim (a flat lens: narrow top, wide middle, slightly narrower underside).
  span(brimY - 1, cx - brim + 2, cx + brim - 2, "V");
  span(brimY, cx - brim, cx + brim, "V");
  span(brimY + 1, cx - brim + 1, cx + brim - 1, "V");
  span(bandTop + 1, cx - base, cx + base, "N");
  span(bandTop + 2, cx - base, cx + base, "N");
  if (view === "front") {
    // Buckle toward the face (the face is template-right), and a darned patch on the crown's shaded side.
    const bx = cx + Math.max(1, base - 4);
    span(bandTop + 1, bx, bx + 2, "U");
    put(bx, bandTop + 2, "U");
    put(bx + 2, bandTop + 2, "U");
    const py = bandTop - Math.round(height * 0.35);
    put(cx + 1, py, "J");
    put(cx + 2, py, "J");
    put(cx + 1, py - 1, "J");
  }
  return rows();
}

export const WITCH_HAT: HatDef = {
  roles: HAT_ROLES,
  replaces: true,
  rows: (id, view) => {
    const fit = HAT_FITS[id];
    if (!fit) throw new Error(`no hat fit for ${id}`);
    return hatRows(fit, view);
  },
};

// ---------------------------------------------------------------- bats

const BAT_ROLES: RoleMap = {
  D: { ramp: "charcoal", hi: true, group: "D" },
  w: { ramp: "charcoal", tone: 2, group: "D" },
  e: { ramp: "mustard", tone: 0, group: "D" },
};

/** Four flap frames, facing right (the engine mirrors with scale.x = -1 to fly left): up, mid, down, mid. 16×16 cells, anchor = centre. */
const BAT_GRIDS: readonly (readonly string[])[] = [
  [
    "................",
    "..w..........w..",
    "..ww........ww..",
    "..wwww.DD.wwww..",
    "...wwwwDDwwww...",
    "....wwDDDeww....",
    ".......DD.......",
    ".......D........",
  ],
  [
    "................",
    "................",
    "................",
    ".......DD.......",
    ".wwwwwwDDwwwwww.",
    "..ww.wwDDDewwww.",
    ".......DD...w...",
    ".......D........",
  ],
  [
    "................",
    "................",
    "................",
    ".......DD.......",
    "....wwwDDwww....",
    "...wwwwDDDewww..",
    "..wwww.DD..www..",
    "..ww...D....ww..",
    "..w..........w..",
  ],
  [
    "................",
    "................",
    "................",
    ".......DD.......",
    ".wwwwwwDDwwwwww.",
    "..ww.wwDDDewwww.",
    ".......DD...w...",
    ".......D........",
  ],
];

export function buildBatFrames(): RoomFrame[] {
  return BAT_GRIDS.map((rows, i) => {
    const g = blank(16, 16);
    stamp(g, rows, 0, 4);
    return { key: `halloween/bat/${String(i)}`, w: 16, h: 16, img: render(g, BAT_ROLES), ax: 8, ay: 8 };
  });
}

// ---------------------------------------------------------------- room decor (wall / window overlays)

/** Moonlit view: a huge harvest moon over a hill, a crooked house with one lit window and a bare tree. */
function moonPaint(w: number, z: number): Paint {
  const d = (Math.floor(w * 2) + Math.floor(z)) % 2 === 0;
  // Bare tree on the left: trunk and three crooked branches.
  const tw = w + 8;
  if (z < 122 && Math.abs(tw + (z - 96) * 0.06) < 1.1) return ["outline", 1];
  const branch = (bx: number, bz: number, dx: number, dz: number, len: number): boolean => {
    for (let t = 0; t <= len; t += 0.25) if (Math.abs(w - (bx + dx * t)) < 0.6 && Math.abs(z - (bz + dz * t)) < 0.8) return true;
    return false;
  };
  if (branch(-8.8, 110, -0.5, 1, 9) || branch(-7.6, 116, 0.6, 1, 10) || branch(-8.4, 104, -0.7, 0.6, 5) || branch(-4.6, 124, 0.9, 0.5, 4)) return ["outline", 1];
  // Hill (dark, a few grass tufts) with the house on its crest.
  const hill = 92 + 6 * Math.cos((w - 3) / 7);
  const hx = w - 1;
  if (hx >= -3 && hx < 3.5 && z >= hill - 1 && z < hill + 8) {
    if (Math.abs(hx - 1.5) < 0.8 && z >= hill + 2 && z < hill + 4) return ["mustard", 0]; // lit window
    return ["night", 2];
  }
  const roof = hill + 8 + (3.5 - Math.abs(hx - 0.25)) * 0.9;
  if (hx >= -4 && hx < 4.5 && z >= hill + 7 && z < roof) return ["night", 2];
  if (hx >= 2 && hx < 3 && z >= roof - 1 && z < roof + 2.5) return ["night", 2]; // chimney
  if (z < hill) return hash(Math.floor(w * 2), Math.floor(z)) % 23 === 0 ? ["olive", 2] : ["night", 2];
  // Moon: big, cream, with a few craters and a bat silhouette in front.
  const mw = w - 2.5, mz = z - 128;
  const r2 = mw * mw * 4 + mz * mz;
  if (r2 < 290) {
    const crater = (cw: number, cz: number, rr: number): boolean => (mw - cw) ** 2 * 4 + (mz - cz) ** 2 < rr;
    if (crater(-2, 6, 6) || crater(3, -4, 10) || crater(-3.5, -6, 4)) return ["cream", 2];
    if (r2 > 230) return ["cream", mw > 0 || mz < 0 ? 2 : 1];
    return ["cream", mw * 2 + mz > 6 ? 0 : 1];
  }
  // Moon halo (flat, then one dithered ring), then a flat night sky with stars.
  if (r2 < 400) return ["navy", 1];
  if (r2 < 560 && d) return ["navy", 1];
  if (hash(Math.floor(w * 2), Math.floor(z)) % 47 === 0) return ["glow", 0];
  return ["night", 1];
}

/** Cobweb on a wall face, hanging from a top corner. `a` runs along the wall from the corner, `b` down from the crown. */
function webPaint(a: number, b: number, size: number): Paint {
  if (a < 0 || b < 0) return null;
  const r = Math.hypot(a * 1.6, b);
  if (r > size) return null;
  const ang = Math.atan2(b, a * 1.6); // 0 along the crown, π/2 straight down the corner
  // Radial threads.
  for (let k = 1; k < 5; k++) {
    const t = (k / 5) * (Math.PI / 2);
    if (Math.abs(ang - t) * r < 0.55) return ["cream", 1];
  }
  // Sagging rings between them.
  for (const ring of [size * 0.35, size * 0.62, size * 0.9]) {
    const seg = (Math.PI / 2) / 5;
    const local = (ang % seg) / seg; // 0..1 across one gap
    const sag = Math.sin(local * Math.PI) * ring * 0.08;
    if (Math.abs(r - ring + sag) < 0.5) return ["cream", 2];
  }
  return null;
}

/** Jack-o'-lantern, carved face toward the room (template-right), lit from inside. Three sizes. */
const PUMPKIN_ROLES: RoleMap = {
  O: { ramp: "ginger", hi: true, group: "O" },
  o: { ramp: "ginger", tone: 2, group: "O" },
  g: { ramp: "olive", hi: true },
  y: { ramp: "mustard", tone: 0, group: "O" },
  Y: { ramp: "mustard", tone: 1, group: "O" },
};
const PUMPKINS: Readonly<Record<string, readonly string[]>> = {
  big: [
    "......gg......",
    ".....gg.......",
    "..OOOoOOoOOO..",
    ".OOOOoOOoOOOO.",
    "OOOOoOyOoOOyOO",
    "OOOOoOyyoOOyyO",
    "OOOOoOOOoOOOOO",
    "OOOOoOyYyYyYoO",
    "OOOOoOOyYyYyOO",
    ".OOOoOOOoOOOO.",
    "..OOOoOOoOOO..",
  ],
  mid: [
    "....gg....",
    "....g.....",
    "..OOoOOO..",
    ".OOOoyOOy.",
    "OOOOoOOOOO",
    "OOOOoyYyYO",
    ".OOOoOOOO.",
    "..OOoOOO..",
  ],
  small: [
    "...g...",
    ".OOoOO.",
    "OOoyOyO",
    "OOoOOOO",
    "OOoyYyO",
    ".OOoOO.",
  ],
};

/** Decor frames and where each attaches. Anchors are the wall cell's floor point, like the walls themselves. */
export function buildDecorFrames(): { frames: RoomFrame[]; meta: DecorMeta[] } {
  const frames: RoomFrame[] = [];
  const meta: DecorMeta[] = [];
  const add = (f: RoomFrame, on: DecorMeta["on"]): void => {
    frames.push(f);
    meta.push({ key: f.key, on });
  };
  // Window view: one panel per wall segment (window0 holds w < 0, window1 w ≥ 0; w = s − 8 on window0, s + 8 on window1).
  for (const p of windowPanels("halloween", moonPaint)) add(p.frame, p.on);
  // Jack-o'-lanterns on the sill: a big one and a small one on window0, a mid one at the far end of window1 (sill runs w −14..14).
  add(onSill("halloween/pumpkin/big", PUMPKINS["big"] ?? [], PUMPKIN_ROLES, -1), "wall/l/window0");
  add(onSill("halloween/pumpkin/small", PUMPKINS["small"] ?? [], PUMPKIN_ROLES, 6), "wall/l/window0");
  add(onSill("halloween/pumpkin/mid", PUMPKINS["mid"] ?? [], PUMPKIN_ROLES, 1), "wall/l/window1");
  // Cobwebs: the back corner (both walls), and the top of each open wall end.
  const CROWN = WALL_H - 5;
  add(wallDecal("halloween/web/corner-l", "l", -8, 8, CROWN - 30, CROWN, (s, z) => webPaint(s + 8, CROWN - z, 22)), "wall/corner");
  add(wallDecal("halloween/web/corner-r", "r", -8, 8, CROWN - 30, CROWN, (s, z) => webPaint(s + 8, CROWN - z, 22) ?? spider(s + 8, CROWN - z)), "wall/corner");
  add(wallDecal("halloween/web/l-end", "l", -8, 8, CROWN - 24, CROWN, (s, z) => webPaint(8 - s, CROWN - z, 16)), "wall/l/end");
  add(wallDecal("halloween/web/r-end", "r", -8, 8, CROWN - 24, CROWN, (s, z) => webPaint(8 - s, CROWN - z, 16)), "wall/r/end");
  return { frames, meta };
}

/** A little spider dangling on a thread below the corner web. */
function spider(a: number, b: number): Paint {
  if (Math.abs(a - 5) < 0.3 && b > 6 && b < 26) return ["cream", 2];
  const sa = a - 5, sb = b - 28;
  if (sa * sa * 2.6 + sb * sb < 5) return ["outline", 1];
  if (Math.abs(sb) < 2.4 && Math.abs(sa) < 2.4 && Math.abs(Math.abs(sb) - Math.abs(sa) * 0.4) < 0.5) return ["outline", 1];
  return null;
}


export const HALLOWEEN: ThemeDef = {
  id: "halloween",
  period: { from: "10-24", to: "11-01" },
  hat: WITCH_HAT,
  decor: buildDecorFrames,
  effect: { frames: buildBatFrames(), ms: 90, max: 6, motion: "fly", facing: "right" },
  preview: [[0, 330, 150], [2, 372, 132], [1, 560, 110], [3, 610, 160], [0, 700, 128]],
};
