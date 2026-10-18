// Holiday themes (OME-1140): the shared machinery behind every theme set. A theme module (halloween.ts, sinterklaas.ts, …) supplies a
// hat, wall/window decor and effect frames; build.ts packs each into themes/<id>/<id>.png + .json. Style rules: STYLE.md § Holiday themes.
import { AVATARS, BACK_DIRS, CELL, FLOOR, FRONT_DIRS, composeMotion, viewOf, type AvatarDef, type Dir, type Motion, type Pose } from "./avatars";
import { BREATHE, CHEER_FRAMES, WALK8_FRAMES, WALK_FRAMES, WAVE_FRAMES, YAWN_FRAMES, cheerMotion, walk8Motion, walkMotion, waveMotion, yawnMotion } from "./motion";
import { colorIndex, type RampName, type Tone } from "./palette";
import type { RoomFrame } from "./room";
import { blank, render, stamp, type Grid, type RoleMap } from "./sprite";

export const POSES: readonly Pose[] = ["idle", "sit"];
export const DIRS: readonly Dir[] = [...FRONT_DIRS, ...BACK_DIRS];

// ---------------------------------------------------------------- hats

/** Role rows relative to the head origin (top-left of the 16 px head), drawn facing SE (front) or NE (back). */
export interface HatRows {
  x: number;
  y: number;
  rows: string[];
}

export interface HatDef {
  /** Hat roles. Letters must be free in every avatar's role map (checked in `hatted`). */
  roles: RoleMap;
  /** Crown hats (witch hat, mitre, Santa hat) replace Pip's beanie and Mo's bucket hat; band accessories (headband, ears) are worn over them. */
  replaces: boolean;
  rows: (avatar: string, view: "front" | "back") => HatRows;
}

/** A sparse pixel pad for drawing hats: put/span in head coordinates, then crop to role rows. */
export function pad(): { put: (x: number, y: number, ch: string) => void; span: (y: number, x0: number, x1: number, ch: string) => void; rows: () => HatRows } {
  const px = new Map<string, string>();
  const put = (x: number, y: number, ch: string): void => void px.set(`${String(Math.round(x))},${String(Math.round(y))}`, ch);
  const span = (y: number, x0: number, x1: number, ch: string): void => {
    for (let x = Math.round(x0); x <= Math.round(x1); x++) put(x, y, ch);
  };
  const rows = (): HatRows => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of px.keys()) {
      const [xs, ys] = k.split(",");
      const x = Number(xs), y = Number(ys);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const out: string[] = [];
    for (let y = y0; y <= y1; y++) {
      let r = "";
      for (let x = x0; x <= x1; x++) r += px.get(`${String(x)},${String(y)}`) ?? ".";
      out.push(r);
    }
    return { x: x0, y: y0, rows: out };
  };
  return { put, span, rows };
}

/** The avatar wearing the hat. A crown hat first takes off the avatar's own headwear (Pip's beanie, Mo's bucket hat); hair stays. */
export function hatted(a: AvatarDef, hat: HatDef): AvatarDef {
  for (const k of Object.keys(hat.roles)) if (a.roles[k]) throw new Error(`hat role ${k} clashes with ${a.id}`);
  const overlays = !hat.replaces
    ? a.overlays
    : a.overlays.flatMap((ov) => {
        if (ov.on !== "head") return [ov];
        // Pip: the beanie (P pom, A knit) goes; its ribbed band becomes the hair it was hiding.
        if (a.id === "pip" && ov.rows.some((r) => r.includes("P"))) return [{ ...ov, rows: ov.rows.map((r) => r.replace(/[PA]/g, ".").replace(/b/g, "H")) }];
        // Mo: the bucket hat (olive A, cream band a) goes; his short hair and beard stay.
        if (a.id === "mo" && ov.rows.some((r) => r.includes("a"))) return [];
        return [ov];
      });
  const hats = (["front", "back"] as const).map((view) => ({ on: "head" as const, view, ...hat.rows(a.id, view) }));
  return { ...a, roles: { ...a.roles, ...hat.roles }, overlays: [...overlays, ...hats] };
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
  /** `<theme>/hat/<avatar frame key>`. */
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

/** Headroom above the 64 px cell for hats that rise above it. */
const PAD = 16;

/** Per avatar frame: the pixels that change when the hat goes on (hat, hair under it, re-shaded edges), cropped. Drawn over the avatar
 *  sprite at the same floor point, it gives exactly the hatted frame. Throws if the old headwear would peek out (an overlay can't erase). */
export function buildHatFrames(theme: string, hat: HatDef, bases: ReadonlyMap<string, AvatarDef> = new Map()): HatFrame[] {
  // `bases` swaps an avatar for another look under the hat (OME-1409: Pip and Mo bare-headed); the overlay is then diffed against that.
  const hattedById = new Map(AVATARS.map((a) => [a.id, hatted(bases.get(a.id) ?? a, hat)]));
  return allAvatarFrames().map(({ key, avatar: own, pose, dir, motion }) => {
    const avatar = bases.get(own.id) ?? own;
    const h = hattedById.get(avatar.id);
    if (!h) throw new Error(`no hatted ${avatar.id}`);
    const before = render(composeMotion(avatar, pose, dir, motion), avatar.roles);
    // The hat may rise above the 64 px cell, so compose it in a taller canvas: shift both down by PAD.
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
    if (misses.length > 0) throw new Error(`${theme} hat on ${key} leaves old pixels showing at ${misses.slice(0, 8).join(" ")}`);
    let x0: number = W, y0: number = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if ((diff[y * W + x] ?? 0) === 0) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (x1 < 0) throw new Error(`${theme} hat on ${key} changes nothing`);
    if (x0 === 0 || x1 === W - 1 || y0 === 0) throw new Error(`${theme} hat on ${key} touches the canvas border`);
    const w = x1 - x0 + 1, hh = y1 - y0 + 1;
    const img = new Uint8Array(w * hh);
    for (let y = 0; y < hh; y++) img.set(diff.subarray((y0 + y) * W + x0, (y0 + y) * W + x0 + w), y * w);
    return { key: `${theme}/hat/${key}`, img, w, h: hh, ax: FLOOR.x - x0, ay: FLOOR.y + PAD - y0, full: after.subarray(PAD * W) };
  });
}

// ---------------------------------------------------------------- room decor (wall / window overlays)

export type Paint = readonly [RampName, Tone] | null;
export const hash = (a: number, b: number): number => {
  let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};

/** Rasterise paint on a wall plane into a frame anchored at the wall cell's floor point. `face` "l": the left wall's
 *  face (u = −8, s = v, faces SE); "r": the right wall's face (v = −8, s = u, faces SW). Unpainted pixels stay transparent. */
export function wallDecal(key: string, face: "l" | "r", s0: number, s1: number, z0: number, z1: number, paint: (s: number, z: number) => Paint): RoomFrame {
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

export function trim(f: RoomFrame): RoomFrame {
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
 *  a centre mullion and a transom at z 138–141). A view keeps those wood bars, so its overlay is only the panes. */
export const WIN = { x0: -12, x1: 12, z0: 84, z1: 168 } as const;
export function windowBar(w: number, z: number): boolean {
  return w < WIN.x0 + 1.5 || w >= WIN.x1 - 1.5 || z < WIN.z0 + 3 || z >= WIN.z1 - 3 || Math.abs(w) < 0.75 || (z >= 138 && z < 141);
}

/** The window view as its two panels, one per wall segment (window0 holds w < 0, window1 w ≥ 0; w = s − 8 on window0, s + 8 on window1). */
export function windowPanels(theme: string, view: (w: number, z: number) => Paint): { frame: RoomFrame; on: DecorOn }[] {
  const glass = (w: number, z: number): Paint => (windowBar(w, z) ? null : view(w, z));
  return [
    { frame: wallDecal(`${theme}/window/0`, "l", -8, 8, WIN.z0, WIN.z1, (s, z) => (s - 8 < 0 ? glass(s - 8, z) : null)), on: "wall/l/window0" },
    { frame: wallDecal(`${theme}/window/1`, "l", -8, 8, WIN.z0, WIN.z1, (s, z) => (s + 8 >= 0 ? glass(s + 8, z) : null)), on: "wall/l/window1" },
  ];
}

export function gridFrame(key: string, rows: readonly string[], roles: RoleMap, ax: number, ay: number): RoomFrame {
  const w = Math.max(...rows.map((r) => r.length)) + 2, h = rows.length + 2;
  const g = blank(w, h);
  stamp(g, rows, 1, 1);
  return { key, w, h, img: render(g, roles), ax: ax + 1, ay: ay + 1 };
}

/** Place a role-grid prop standing on the left wall's window sill, in the coordinate frame of wall cell (0,row): s along the wall (v), sill top z 84. */
export function onSill(key: string, rows: readonly string[], roles: RoleMap, s: number): RoomFrame {
  const f = gridFrame(key, rows, roles, 0, 0);
  // Bottom centre of the prop sits at (u −7, v s, z 84): a pixel forward of the wall face, on the sill.
  const p = { x: Math.round(2 * (-7 - s)), y: Math.round(-7 + s - 84) };
  const w = Math.max(...rows.map((r) => r.length));
  return { ...f, ax: Math.round(w / 2) + 1 - p.x, ay: rows.length + 1 - p.y };
}

/** Hang a role-grid prop flat against a wall face: its top-centre pixel at (s, z) on that wall, a pixel forward of the face.
 *  Upright sprites (stockings, a bow) read better unsheared at this size; the hook point is what follows the plane. */
export function onWall(key: string, rows: readonly string[], roles: RoleMap, face: "l" | "r", s: number, z: number): RoomFrame {
  const f = gridFrame(key, rows, roles, 0, 0);
  const u = face === "l" ? -7 : s, v = face === "l" ? s : -7;
  const p = { x: Math.round(2 * (u - v)), y: Math.round(u + v - z) };
  const w = Math.max(...rows.map((r) => r.length));
  return { ...f, ax: Math.floor(w / 2) + 1 - p.x, ay: 1 - p.y };
}

/** Which wall frame a decal belongs to: place it at that wall frame's cell floor point (the same anchor). `wall/l` and `wall/r`
 *  mean every segment of that wall (a garland repeats along it). */
export type DecorOn = "wall/l/window0" | "wall/l/window1" | "wall/r/poster0" | "wall/r/poster1" | "wall/corner" | "wall/l/end" | "wall/r/end" | "wall/l" | "wall/r";
export interface DecorMeta {
  key: string;
  on: DecorOn;
}

/** A small effect sprite, outlined so it holds on both wall tones. The frame is the rows plus the 1 px outline; anchor = centre. */
export function effectFrame(key: string, rows: readonly string[], roles: RoleMap): RoomFrame {
  const f = gridFrame(key, rows, roles, 0, 0);
  return { ...f, ax: Math.floor(f.w / 2), ay: Math.floor(f.h / 2) };
}

/** Paint an upright (unsheared) pixel motif on a wall plane: `rows` hang with their top-centre at (s0, z0) on the wall.
 *  Letters map through `colors`; "." is transparent. Flat paper motifs (bunting) use this so they read square at 1×. */
export function upright(face: "l" | "r", rows: readonly string[], colors: Readonly<Record<string, Paint>>, s0: number, z0: number): (s: number, z: number) => Paint {
  const w = Math.max(...rows.map((r) => r.length));
  return (s, z) => {
    const ds = s - s0;
    const x = Math.floor((face === "l" ? -2 * ds : 2 * ds) + w / 2), y = Math.floor(ds - (z - z0));
    const ch = rows[y]?.charAt(x) ?? ".";
    return ch === "." || ch === "" ? null : (colors[ch] ?? null);
  };
}

/** A string swag across one wall segment (s −8..8) that sags `sag` below `top`, with motifs hanging from it. Returns the paint. */
export function swag(face: "l" | "r", top: number, sag: number, string: Paint, motifs: readonly { s: number; rows: readonly string[]; colors: Readonly<Record<string, Paint>> }[]): (s: number, z: number) => Paint {
  const at = (s: number): number => top - sag * Math.sin((Math.PI * (s + 8)) / 16);
  const hung = motifs.map((m) => upright(face, m.rows, m.colors, m.s, at(m.s)));
  return (s, z) => {
    for (const p of hung) {
      const c = p(s, z);
      if (c) return c;
    }
    return Math.abs(z - at(s)) < 0.75 ? string : null;
  };
}

export interface ThemeDef {
  id: string;
  /** Local-date period, both ends inclusive: fixed `MM-DD` dates, or days relative to Easter Sunday (Gregorian computus). */
  period: { from: string; to: string } | { easter: { from: number; to: number } };
  hat: HatDef;
  decor: () => { frames: RoomFrame[]; meta: DecorMeta[] };
  effect: {
    frames: RoomFrame[];
    /** Frame time for a flap/spin cycle; absent: the frames are variants, each particle keeps one. */
    ms?: number;
    /** Most particles on screen (plan OME-1140). */
    max: number;
    /** fly: crosses the back wall sideways; fall: drifts down; rise: floats up. */
    motion: "fly" | "fall" | "rise";
    facing?: "right";
  };
  /** Optional tint on the room's lamps and sconces (a palette colour). */
  accent?: { lamps: string };
  /** Preview only: effect sprites in the 960×600 room scene, [frame index, x, y]. */
  preview: readonly (readonly [number, number, number])[];
}
