// Halloween theme (OME-1185): wall decor for the classic room, a moonlit window view, bat flap frames and a witch hat for
// every avatar frame. Everything uses the Dusk Lounge palette, the plum outline and top-left light (see STYLE.md § Holiday themes).
import { AVATARS, BACK_DIRS, CELL, FLOOR, FRONT_DIRS, composeMotion, viewOf, type AvatarDef, type Dir, type Motion, type Pose } from "./avatars";
import { BREATHE, CHEER_FRAMES, WALK8_FRAMES, WALK_FRAMES, WAVE_FRAMES, YAWN_FRAMES, cheerMotion, walk8Motion, walkMotion, waveMotion, yawnMotion } from "./motion";
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import { WALL_H, type RoomFrame } from "./room";
import { blank, render, stamp, type Grid, type RoleMap } from "./sprite";

const POSES: readonly Pose[] = ["idle", "sit"];
const DIRS: readonly Dir[] = [...FRONT_DIRS, ...BACK_DIRS];

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
  const px = new Map<string, string>();
  const put = (x: number, y: number, ch: string): void => void px.set(`${String(x)},${String(y)}`, ch);
  const span = (y: number, x0: number, x1: number, ch: string): void => {
    for (let x = x0; x <= x1; x++) put(x, y, ch);
  };
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
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of px.keys()) {
    const [xs, ys] = k.split(",");
    const x = Number(xs), y = Number(ys);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const rows: string[] = [];
  for (let y = y0; y <= y1; y++) {
    let r = "";
    for (let x = x0; x <= x1; x++) r += px.get(`${String(x)},${String(y)}`) ?? ".";
    rows.push(r);
  }
  return { x: x0, y: y0, rows };
}

/** The avatar with its own headwear taken off (Pip's beanie, Mo's bucket hat) and the witch hat on. Hair stays. */
export function hatted(a: AvatarDef): AvatarDef {
  const fit = HAT_FITS[a.id];
  if (!fit) throw new Error(`no hat fit for ${a.id}`);
  for (const k of Object.keys(HAT_ROLES)) if (a.roles[k]) throw new Error(`hat role ${k} clashes with ${a.id}`);
  const overlays = a.overlays.flatMap((ov) => {
    if (ov.on !== "head") return [ov];
    // Pip: the beanie (P pom, A knit) goes; its ribbed band becomes the hair it was hiding.
    if (a.id === "pip" && ov.rows.some((r) => r.includes("P"))) return [{ ...ov, rows: ov.rows.map((r) => r.replace(/[PA]/g, ".").replace(/b/g, "H")) }];
    // Mo: the bucket hat (olive A, cream band a) goes; his short hair and beard stay.
    if (a.id === "mo" && ov.rows.some((r) => r.includes("a"))) return [];
    return [ov];
  });
  const hats = (["front", "back"] as const).map((view) => ({ on: "head" as const, view, ...hatRows(fit, view) }));
  return { ...a, roles: { ...a.roles, ...HAT_ROLES }, overlays: [...overlays, ...hats] };
}

/** Every avatar frame the shipped sheets carry (avatars, motion, expressions), with how to compose it. */
export interface AvatarFrameSpec {
  key: string;
  avatar: AvatarDef;
  pose: Pose;
  dir: Dir;
  motion: Motion;
}

export function allAvatarFrames(): AvatarFrameSpec[] {
  const out: AvatarFrameSpec[] = [];
  for (const a of AVATARS) {
    const holds = a.holds === true;
    const add = (key: string, pose: Pose, dir: Dir, motion: Motion): void => void out.push({ key, avatar: a, pose, dir, motion });
    for (const pose of POSES) {
      for (const dir of DIRS) {
        const v = viewOf(dir);
        for (const n of [0, 1]) add(`${a.id}/${pose}/${dir}/${String(n)}`, pose, dir, { blink: n === 1 && v === "front" });
        add(`breathe/${a.id}/${pose}/${dir}/1`, pose, dir, BREATHE);
        for (let n = 0; n < WAVE_FRAMES; n++) add(`wave/${a.id}/${pose}/${dir}/${String(n)}`, pose, dir, waveMotion(v, n));
        for (let n = 0; n < CHEER_FRAMES; n++) add(`cheer/${a.id}/${pose}/${dir}/${String(n)}`, pose, dir, cheerMotion(v, pose, n, holds));
        for (let n = 0; n < YAWN_FRAMES; n++) add(`yawn/${a.id}/${pose}/${dir}/${String(n)}`, pose, dir, yawnMotion(v, n, holds));
      }
    }
    for (const dir of DIRS) {
      const v = viewOf(dir);
      for (let n = 0; n < WALK_FRAMES; n++) add(`walk/${a.id}/${dir}/${String(n)}`, "idle", dir, walkMotion(v, n, holds));
      for (let k = 1; k < WALK8_FRAMES; k += 2) add(`walk8/${a.id}/${dir}/${String(k)}`, "idle", dir, walk8Motion(v, k, holds));
    }
  }
  return out;
}

export interface HatFrame {
  /** `halloween/hat/<avatar frame key>`. */
  key: string;
  img: Uint8Array;
  w: number;
  h: number;
  /** Floor point of the avatar cell, relative to this image (so it can sit outside it). */
  ax: number;
  ay: number;
  /** The full hatted avatar cell (preview / checks). */
  full: Uint8Array;
}

/** Per avatar frame: the pixels that change when the witch hat goes on (hat, hair under it, re-shaded edges), cropped. Drawn over the avatar
 *  sprite at the same floor point, it gives exactly the hatted frame. Throws if the old headwear would peek out (an overlay can't erase). */
export function buildHatFrames(): HatFrame[] {
  const hattedById = new Map(AVATARS.map((a) => [a.id, hatted(a)]));
  return allAvatarFrames().map(({ key, avatar, pose, dir, motion }) => {
    const h = hattedById.get(avatar.id);
    if (!h) throw new Error(`no hatted ${avatar.id}`);
    const before = render(composeMotion(avatar, pose, dir, motion), avatar.roles);
    // The hat may rise above the 64 px cell, so compose it in a taller canvas: shift both down by PAD.
    const PAD = 12;
    const tall = (g: Grid): Grid => [...blank(CELL.w, PAD), ...g];
    const after = render(tall(composeMotion(h, pose, dir, motion)), h.roles);
    const W: number = CELL.w, H: number = CELL.h + PAD;
    const diff = new Uint8Array(W * H);
    const misses: string[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const b = y >= PAD ? (before[(y - PAD) * W + x] ?? 0) : 0;
        const a = after[y * W + x] ?? 0;
        if (a === b) continue;
        if (a === 0) misses.push(`${String(x)},${String(y - PAD)}`);
        diff[y * W + x] = a;
      }
    }
    if (misses.length > 0) throw new Error(`hat on ${key} leaves old pixels showing at ${misses.slice(0, 8).join(" ")}`);
    let x0: number = W, y0: number = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if ((diff[y * W + x] ?? 0) === 0) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (x1 < 0) throw new Error(`hat on ${key} changes nothing`);
    if (x0 === 0 || x1 === W - 1 || y0 === 0) throw new Error(`hat on ${key} touches the canvas border`);
    const w = x1 - x0 + 1, hh = y1 - y0 + 1;
    const img = new Uint8Array(w * hh);
    for (let y = 0; y < hh; y++) img.set(diff.subarray((y0 + y) * W + x0, (y0 + y) * W + x0 + w), y * w);
    return { key: `halloween/hat/${key}`, img, w, h: hh, ax: FLOOR.x - x0, ay: FLOOR.y + PAD - y0, full: after.subarray(PAD * W) };
  });
}

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

type Paint = readonly [RampName, Tone] | null;
const hash = (a: number, b: number): number => {
  let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};

/** Rasterise paint on a wall plane into a frame anchored at the wall cell's floor point. `face` "l": the left wall's
 *  face (u = −8, s = v, faces SE); "r": the right wall's face (v = −8, s = u, faces SW). Unpainted pixels stay transparent. */
function wallDecal(key: string, face: "l" | "r", s0: number, s1: number, z0: number, z1: number, paint: (s: number, z: number) => Paint): RoomFrame {
  // Screen bbox of the plane rectangle (project: x = 2(u − v), y = u + v − z).
  const corners = [[s0, z0], [s0, z1], [s1, z0], [s1, z1]].map(([s = 0, z = 0]) => {
    const u = face === "l" ? -8 : s, v = face === "l" ? s : -8;
    return { x: 2 * (u - v), y: u + v - z };
  });
  const minX = Math.floor(Math.min(...corners.map((c) => c.x))), maxX = Math.ceil(Math.max(...corners.map((c) => c.x)));
  const minY = Math.floor(Math.min(...corners.map((c) => c.y))), maxY = Math.ceil(Math.max(...corners.map((c) => c.y)));
  const w = maxX - minX, h = maxY - minY;
  const img = new Uint8Array(w * h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = minX + px + 0.5, y = minY + py + 0.5;
      // Invert the projection on the plane.
      const s = face === "l" ? -8 - x / 2 : x / 2 - 8;
      const z = (face === "l" ? -8 + s : s - 8) - y;
      if (s < s0 || s >= s1 || z < z0 || z >= z1) continue;
      const p = paint(s, z);
      if (p) img[py * w + px] = colorIndex(p[0], p[1]);
    }
  }
  return trim({ key, w, h, img, ax: -minX, ay: -minY });
}

function trim(f: RoomFrame): RoomFrame {
  let x0 = f.w, y0 = f.h, x1 = -1, y1 = -1;
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    if ((f.img[y * f.w + x] ?? 0) === 0) continue;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (x1 < 0) throw new Error(`${f.key} is empty`);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const img = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) img.set(f.img.subarray((y0 + y) * f.w + x0, (y0 + y) * f.w + x0 + w), y * w);
  return { key: f.key, w, h, img, ax: f.ax - x0, ay: f.ay - y0 };
}

/** The window's glass (inside the frame, room.ts windowPaint: w −12..12, z 84..168, 1.5 px frame, 3 px top/bottom rails,
 *  a centre mullion and a transom at z 138–141). The view keeps those wood bars, so the overlay is only the panes. */
const WIN = { x0: -12, x1: 12, z0: 84, z1: 168 } as const;
function windowBar(w: number, z: number): boolean {
  return w < WIN.x0 + 1.5 || w >= WIN.x1 - 1.5 || z < WIN.z0 + 3 || z >= WIN.z1 - 3 || Math.abs(w) < 0.75 || (z >= 138 && z < 141);
}

/** Moonlit view: a huge harvest moon over a hill, a crooked house with one lit window and a bare tree. */
function moonPaint(w: number, z: number): Paint {
  if (windowBar(w, z)) return null;
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

function gridFrame(key: string, rows: readonly string[], roles: RoleMap, ax: number, ay: number): RoomFrame {
  const w = Math.max(...rows.map((r) => r.length)) + 2, h = rows.length + 2;
  const g = blank(w, h);
  stamp(g, rows, 1, 1);
  return { key, w, h, img: render(g, roles), ax: ax + 1, ay: ay + 1 };
}

/** Place a role-grid prop standing on the left wall's sill, in the coordinate frame of wall cell (0,row): s along the wall (v), sill top z 84. */
function onSill(key: string, rows: readonly string[], s: number): RoomFrame {
  const f = gridFrame(key, rows, PUMPKIN_ROLES, 0, 0);
  // Bottom centre of the pumpkin sits at (u −7, v s, z 84): a pixel forward of the wall face, on the sill.
  const p = { x: 2 * (-7 - s), y: -7 + s - 84 };
  const w = Math.max(...rows.map((r) => r.length));
  return { ...f, ax: Math.round(w / 2) + 1 - p.x, ay: rows.length + 1 - p.y };
}

export interface DecorMeta {
  key: string;
  /** Which wall frame the decal belongs to; place it at that wall frame's cell floor point (the same anchor). */
  on: "wall/l/window0" | "wall/l/window1" | "wall/corner" | "wall/l/end" | "wall/r/end";
}

/** Decor frames and where each attaches. Anchors are the wall cell's floor point, like the walls themselves. */
export function buildDecorFrames(): { frames: RoomFrame[]; meta: DecorMeta[] } {
  const frames: RoomFrame[] = [];
  const meta: DecorMeta[] = [];
  const add = (f: RoomFrame, on: DecorMeta["on"]): void => {
    frames.push(f);
    meta.push({ key: f.key, on });
  };
  // Window view: one panel per wall segment (window0 holds w < 0, window1 w ≥ 0; w = s − 8 on window0, s + 8 on window1).
  add(wallDecal("halloween/window/0", "l", -8, 8, WIN.z0, WIN.z1, (s, z) => (s - 8 < 0 ? moonPaint(s - 8, z) : null)), "wall/l/window0");
  add(wallDecal("halloween/window/1", "l", -8, 8, WIN.z0, WIN.z1, (s, z) => (s + 8 >= 0 ? moonPaint(s + 8, z) : null)), "wall/l/window1");
  // Jack-o'-lanterns on the sill: a big one and a small one on window0, a mid one at the far end of window1 (sill runs w −14..14).
  add(onSill("halloween/pumpkin/big", PUMPKINS["big"] ?? [], -1), "wall/l/window0");
  add(onSill("halloween/pumpkin/small", PUMPKINS["small"] ?? [], 6), "wall/l/window0");
  add(onSill("halloween/pumpkin/mid", PUMPKINS["mid"] ?? [], 1), "wall/l/window1");
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

export { OUTLINE };
