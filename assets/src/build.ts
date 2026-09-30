// Builds the shipped sprite sheets + atlases and the (non-shipped) previews.
// Run: bun assets/src/build.ts
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { AVATARS, BACK_DIRS, CELL, FLOOR, FRONT_DIRS, SEAT_HEIGHT, composeFrame, composeMotion, viewOf, type Dir, type Motion, type Pose } from "./avatars";
import {
  BREATHE,
  BREATHE_MS,
  EMOTES,
  EMOTE_CELL,
  EMOTE_FRAMES,
  EMOTE_SEQUENCE,
  WALK_FRAMES,
  WALK_FRAME_MS,
  WALK_TILES_PER_CYCLE,
  WAVE_FRAMES,
  WAVE_MS,
  WAVE_SEQUENCE,
  waveMotion,
  walkMotion,
  type EmoteDef,
} from "./motion";
import { OUTLINE, PALETTE, RAMPS, colorIndex } from "./palette";
import { encodeIndexedApng, encodeIndexedPng, type RGBA } from "./png";
import { SEAT_DIRS, STAGE_ORIGIN, TILE, TV_CONTROLS, TV_SCREEN, WALL_H, buildRoomFrames, defaultLayout, type RoomFrame } from "./room";
import { blank, blit, render, stamp, upscale, type Grid } from "./sprite";
import { buildUiFrames, referenceCss, type Borders } from "./ui";
import { CATCHUP_FRAME_MS, buildPlaybackFrames, playbackCss } from "./playback";
import { buildTvFrames, tvCss } from "./tv";

const ROOT = join(import.meta.dir, "..");
const POSES: readonly Pose[] = ["idle", "sit"];
const DIRS: readonly Dir[] = [...FRONT_DIRS, ...BACK_DIRS];

interface Frame {
  frame: { x: number; y: number; w: number; h: number };
  rotated: false;
  trimmed: false;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  anchor: { x: number; y: number };
}

/** Sprites (outline included) must not touch the cell border, so nothing bleeds between frames. */
function assertInsideCell(key: string, img: Uint8Array): void {
  for (let y = 0; y < CELL.h; y++) {
    for (let x = 0; x < CELL.w; x++) {
      const border = x === 0 || y === 0 || x === CELL.w - 1 || y === CELL.h - 1;
      if (border && img[y * CELL.w + x] !== 0) throw new Error(`${key} touches the cell border at ${String(x)},${String(y)}`);
    }
  }
}

function frameImage(avatarIdx: number, pose: Pose, dir: Dir, n: number): Uint8Array {
  const a = AVATARS[avatarIdx];
  if (!a) throw new Error(`no avatar ${String(avatarIdx)}`);
  return render(composeFrame(a, pose, dir, n === 1), a.roles);
}

function buildAvatars(): Map<string, Uint8Array> {
  // Per avatar row: front dirs get an open + blink cell; back dirs one cell whose /1 key
  // points at the same rect (no eyes to blink from behind), so the blink ticker needs no case.
  const cellsPerRow = POSES.length * (FRONT_DIRS.length * 2 + BACK_DIRS.length);
  const sheetW = pow2(cellsPerRow * CELL.w);
  const sheetH = pow2(AVATARS.length * CELL.h);
  const sheet = new Uint8Array(sheetW * sheetH);
  const frames: Record<string, Frame> = {};
  const animations: Record<string, string[]> = {};
  const images = new Map<string, Uint8Array>();
  const frameAt = (x: number, y: number): Frame => ({
    frame: { x, y, w: CELL.w, h: CELL.h },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: CELL.w, h: CELL.h },
    sourceSize: { w: CELL.w, h: CELL.h },
    anchor: { x: FLOOR.x / CELL.w, y: FLOOR.y / CELL.h },
  });
  AVATARS.forEach((a, row) => {
    let col = 0;
    for (const pose of POSES) {
      for (const dir of DIRS) {
        const back = BACK_DIRS.includes(dir);
        const anim: string[] = [];
        for (const n of [0, 1]) {
          const key = `${a.id}/${pose}/${dir}/${String(n)}`;
          anim.push(key);
          if (back && n === 1) {
            const k0 = `${a.id}/${pose}/${dir}/0`;
            const f0 = frames[k0];
            const i0 = images.get(k0);
            if (!f0 || !i0) throw new Error(`missing ${k0}`);
            frames[key] = f0;
            images.set(key, i0);
            continue;
          }
          const img = frameImage(row, pose, dir, n);
          assertInsideCell(key, img);
          images.set(key, img);
          const x = col * CELL.w;
          const y = row * CELL.h;
          blit(sheet, sheetW, img, CELL.w, CELL.h, x, y);
          frames[key] = frameAt(x, y);
          col++;
        }
        animations[`${a.id}/${pose}/${dir}`] = anim;
      }
    }
  });
  registerKeys("avatars", Object.keys(frames));
  const dir = join(ROOT, "avatars");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "avatars.png"), encodeIndexedPng(sheetW, sheetH, sheet, PALETTE));
  const atlas = {
    frames,
    animations,
    meta: {
      app: "omega-share assets/src/build.ts",
      version: "1",
      image: "avatars.png",
      format: "RGBA8888",
      size: { w: sheetW, h: sheetH },
      scale: "1",
      omega: {
        license: "CC-BY-SA-4.0",
        tile: TILE,
        cell: CELL,
        floorPoint: FLOOR,
        seatHeight: SEAT_HEIGHT,
        poses: POSES,
        dirs: DIRS,
        blink: { frame: 1, durationMs: 120, intervalMs: [3000, 6000] },
        avatars: AVATARS.map((a) => ({ id: a.id, label: a.label, blurb: a.blurb, colors: { main: RAMPS[a.swatch][1], dark: RAMPS[a.swatch][2] } })),
      },
    },
  };
  writeFileSync(join(dir, "avatars.json"), JSON.stringify(atlas, null, 1) + "\n");
  // Sheet preview at 4× on a mid-tone so outlines are visible.
  const bg = colorIndex("wall", 1);
  const big = upscale(sheet, sheetW, sheetH, 4).map((v) => (v === 0 ? bg : v));
  writeFileSync(join(ROOT, "preview", "avatars-sheet@4x.png"), encodeIndexedPng(sheetW * 4, sheetH * 4, big, PALETTE));
  return images;
}

/** A small floor scene with every avatar idle and seated, at 1× (and 2× upscaled). */
function buildScene(images: Map<string, Uint8Array>): void {
  const W = 448;
  const H = 240;
  const img = new Uint8Array(W * H).fill(colorIndex("wall", 2));
  const origin = { x: W / 2, y: 40 }; // screen position of tile (0,0)'s top corner
  const tileCenter = (tx: number, ty: number): { x: number; y: number } => ({
    x: origin.x + (tx - ty) * (TILE.w / 2),
    y: origin.y + (tx + ty) * (TILE.h / 2) + TILE.h / 2,
  });
  const N = 5;
  for (let ty = 0; ty < N; ty++) {
    for (let tx = 0; tx < N; tx++) {
      const c = tileCenter(tx, ty);
      const tone = (tx + ty) % 2 === 0 ? 1 : 0;
      for (let y = 0; y < TILE.h; y++) {
        // 2:1 diamond: row half-width grows 2 px per row.
        const half = y < TILE.h / 2 ? (y + 1) * 2 : (TILE.h - y) * 2;
        for (let x = -half; x < half; x++) {
          const px = c.x + x;
          const py = c.y - TILE.h / 2 + y;
          if (px < 0 || py < 0 || px >= W || py >= H) continue;
          const edge = x === -half || x === half - 1;
          img[py * W + px] = edge ? colorIndex("floor", 2) : colorIndex("floor", tone === 1 ? 1 : 0);
        }
      }
    }
  }
  // Seat marks: a flat cushion 8 px above the floor so sit frames can be checked for alignment.
  const place = (key: string, tx: number, ty: number, seat: boolean): void => {
    const sprite = images.get(key);
    if (!sprite) throw new Error(`missing ${key}`);
    const c = tileCenter(tx, ty);
    if (seat) {
      for (let y = -SEAT_HEIGHT - 3; y <= 0; y++) {
        const hw = y <= -SEAT_HEIGHT ? 12 - (y + SEAT_HEIGHT + 3) * 0 : 3;
        for (let x = -hw; x < hw; x++) {
          const px = c.x + x;
          const py = c.y + y;
          img[py * W + px] = y <= -SEAT_HEIGHT ? colorIndex("wood", y === -SEAT_HEIGHT ? 2 : 1) : colorIndex("wood", 2);
        }
      }
    }
    const ox = c.x - FLOOR.x;
    const oy = c.y - FLOOR.y;
    for (let y = 0; y < CELL.h; y++) {
      for (let x = 0; x < CELL.w; x++) {
        const v = sprite[y * CELL.w + x] ?? 0;
        const px = ox + x;
        const py = oy + y;
        if (v !== 0 && px >= 0 && py >= 0 && px < W && py < H) img[py * W + px] = v;
      }
    }
  };
  // Back to front (by tile depth tx+ty).
  const placements: [string, number, number, boolean][] = [];
  AVATARS.forEach((a, i) => {
    placements.push([`${a.id}/idle/${i % 2 === 0 ? "se" : "sw"}/0`, i, 0, false]);
    placements.push([`${a.id}/sit/${i % 2 === 0 ? "sw" : "se"}/0`, i, 2, true]);
    placements.push([`${a.id}/idle/${i % 2 === 0 ? "sw" : "se"}/1`, i, 4, false]);
  });
  placements.sort((p, q) => p[1] + p[2] - (q[1] + q[2]));
  for (const [k, tx, ty, s] of placements) place(k, tx, ty, s);
  writeFileSync(join(ROOT, "preview", "scene@1x.png"), encodeIndexedPng(W, H, img, PALETTE));
  writeFileSync(join(ROOT, "preview", "scene@2x.png"), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), PALETTE));
  buildMoodboards(img, W, H);
}

// --- Style exploration: the same scene under three directions (palette + outline treatment).
function toHsl(c: RGBA): [number, number, number] {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl(h: number, s: number, l: number): RGBA {
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return { r: f(0), g: f(8), b: f(4), a: 255 };
}
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function buildMoodboards(img: Uint8Array, w: number, h: number): void {
  const outline = colorIndex("outline", 1);
  const variants: Record<string, (c: RGBA, i: number) => RGBA> = {
    // A: loud, saturated, pure-black 1 px outline, flat bright floor.
    "a-candy-arcade": (c, i) => {
      if (i === outline) return { r: 0, g: 0, b: 0, a: 255 };
      const [hh, ss, ll] = toHsl(c);
      return fromHsl(hh, clamp01(ss * 1.45 + 0.1), clamp01(ll * 1.05 + 0.03));
    },
    // B (chosen): warm dusk, plum outline, top-left light. The shipped palette.
    "b-dusk-lounge": (c) => c,
    // C: pastel, low contrast, no dark outline (outline becomes a soft lavender).
    "c-pastel-daydream": (c, i) => {
      if (i === outline) return { r: 170, g: 150, b: 190, a: 255 };
      const [hh, ss, ll] = toHsl(c);
      return fromHsl(hh, clamp01(ss * 0.55), clamp01(ll * 0.55 + 0.42));
    },
  };
  for (const [name, fn] of Object.entries(variants)) {
    const pal = PALETTE.map((c, i) => (i === 0 ? c : fn(c, i)));
    writeFileSync(join(ROOT, "src", "moodboards", `${name}.png`), encodeIndexedPng(w * 2, h * 2, upscale(img, w, h, 2), pal));
  }
}

const pow2 = (n: number): number => 2 ** Math.ceil(Math.log2(n));

/** Pixi v8 caches frame textures globally by key, so keys and ids must be unique across sets. */
const keyOwner = new Map<string, string>();
function registerKeys(set: string, keys: readonly string[]): void {
  for (const key of keys) {
    const id = key.split("/")[0] ?? key;
    const owner = keyOwner.get(id);
    if (owner !== undefined && owner !== set) throw new Error(`frame id "${id}" is used by both ${owner} and ${set}`);
    keyOwner.set(id, set);
  }
}

interface Placed extends RoomFrame {
  x: number;
  y: number;
}
/** Skyline packer: tallest first, each frame goes where it rests lowest (then leftmost),
 *  with a 1 px transparent gutter; the sheet height rounds up to a power of two. */
function pack(frames: readonly RoomFrame[], sheetW: number): { placed: Placed[]; w: number; h: number } {
  const order = [...frames].sort((a, b) => b.h - a.h || b.w - a.w || a.key.localeCompare(b.key));
  const sky = new Array<number>(sheetW).fill(0);
  const placed: Placed[] = [];
  for (const f of order) {
    const fw = Math.min(f.w + 1, sheetW);
    if (f.w > sheetW) throw new Error(`${f.key} wider than the sheet`);
    let bestX = -1;
    let bestY = Infinity;
    for (let x = 0; x + f.w <= sheetW; x++) {
      let y = 0;
      for (let i = x; i < Math.min(x + fw, sheetW); i++) y = Math.max(y, sky[i] ?? 0);
      if (y < bestY) {
        bestY = y;
        bestX = x;
      }
    }
    placed.push({ ...f, x: bestX, y: bestY });
    for (let i = bestX; i < Math.min(bestX + fw, sheetW); i++) sky[i] = bestY + f.h + 1;
  }
  return { placed, w: sheetW, h: pow2(Math.max(...placed.map((p) => p.y + p.h))) };
}

function buildRoom(avatarImages: Map<string, Uint8Array>): void {
  const frames = buildRoomFrames();
  registerKeys("room", frames.map((f) => f.key));
  const seen = new Set<string>();
  for (const f of frames) {
    if (seen.has(f.key)) throw new Error(`duplicate room key ${f.key}`);
    seen.add(f.key);
  }
  const { placed, w: sheetW, h: sheetH } = pack(frames, 512);
  const sheet = new Uint8Array(sheetW * sheetH);
  const atlasFrames: Record<string, Frame> = {};
  for (const p of placed.sort((a, b) => a.key.localeCompare(b.key))) {
    blit(sheet, sheetW, p.img, p.w, p.h, p.x, p.y);
    atlasFrames[p.key] = {
      frame: { x: p.x, y: p.y, w: p.w, h: p.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: p.w, h: p.h },
      sourceSize: { w: p.w, h: p.h },
      anchor: { x: p.ax / p.w, y: p.ay / p.h },
    };
  }
  const layout = defaultLayout();
  const dir = join(ROOT, "room");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "room.png"), encodeIndexedPng(sheetW, sheetH, sheet, PALETTE));
  const atlas = {
    frames: atlasFrames,
    meta: {
      app: "omega-share assets/src/build.ts",
      version: "1",
      image: "room.png",
      format: "RGBA8888",
      size: { w: sheetW, h: sheetH },
      scale: "1",
      omega: {
        license: "CC-BY-SA-4.0",
        tile: TILE,
        seatHeight: SEAT_HEIGHT,
        wallHeight: WALL_H,
        layers: { floor: 0, wall: 1, back: 2, avatar: 3, front: 4 },
        // screen = the iframe rect, controls = the transport slot under it; both relative to the tv/0 anchor.
        // stageOrigin = the layout.ts ORIGIN_X/Y this art is drawn for (bezel top at y 7, slot clear of back-row tags).
        tv: { frame: "tv/0", screen: TV_SCREEN, controls: TV_CONTROLS, stageOrigin: STAGE_ORIGIN },
        seats: [{ frame: "armchair", dirs: SEAT_DIRS }],
        layout,
      },
    },
  };
  writeFileSync(join(dir, "room.json"), JSON.stringify(atlas, null, 1) + "\n");
  const bg = colorIndex("wall", 1);
  const big = upscale(sheet, sheetW, sheetH, 2).map((v) => (v === 0 ? bg : v));
  writeFileSync(join(ROOT, "preview", "room-sheet@2x.png"), encodeIndexedPng(sheetW * 2, sheetH * 2, big, PALETTE));
  buildRoomScene(frames, avatarImages, layout);
  buildSeatsPreview(frames, avatarImages);
}

/** The whole room exactly as the web lays it out (apps/web/src/layout.ts), with people in it. */
function buildRoomScene(frames: readonly RoomFrame[], avatars: Map<string, Uint8Array>, layout: ReturnType<typeof defaultLayout>): void {
  const W = 960, H = 600, ORIGIN_X = STAGE_ORIGIN.x, ORIGIN_Y = STAGE_ORIGIN.y;
  const cellCenter = (c: number, r: number): { x: number; y: number } => ({ x: ORIGIN_X + (c - r) * 32, y: ORIGIN_Y + (c + r + 1) * 16 });
  // Mirrors layout.ts SEAT_CELLS / STANDING; seats face the TV.
  const SEAT_CELLS: readonly (readonly [number, number])[] = [[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]];
  const img = new Uint8Array(W * H).fill(colorIndex("night", 2));
  const byKey = new Map(frames.map((f) => [f.key, f]));
  const draw = (key: string, x: number, y: number): void => {
    const f = byKey.get(key);
    if (f) {
      blitAt(img, W, H, f.img, f.w, f.h, x - f.ax, y - f.ay);
      return;
    }
    const a = avatars.get(key);
    if (!a) throw new Error(`missing ${key}`);
    blitAt(img, W, H, a, CELL.w, CELL.h, x - FLOOR.x, y - FLOOR.y);
  };
  layout.floor.forEach((row, r) => {
    row.forEach((key, c) => {
      const p = cellCenter(c, r);
      draw(key, p.x, p.y);
    });
  });
  for (let i = 0; i < 10; i++) {
    const l = cellCenter(0, i), rr = cellCenter(i, 0);
    draw(layout.walls.l[i] ?? "wall/l/plain", l.x, l.y);
    draw(layout.walls.r[i] ?? "wall/r/plain", rr.x, rr.y);
  }
  const c00 = cellCenter(0, 0);
  draw("wall/corner", c00.x, c00.y);
  const l9 = cellCenter(0, 9), r9 = cellCenter(9, 0);
  draw("wall/l/end", l9.x, l9.y);
  draw("wall/r/end", r9.x, r9.y);
  draw("tv/0", c00.x, c00.y);
  // A frame of "video" in the screen rect (preview only; the web puts the iframe here).
  fakeVideo(img, W, c00.x + TV_SCREEN.x, c00.y + TV_SCREEN.y, TV_SCREEN.w, TV_SCREEN.h);
  // Depth-sorted items: (floorY, floorX, layer).
  const items: { key: string; x: number; y: number; layer: number }[] = [];
  const sitters = ["juno", "pip", "mo", "kiki", "mo", "juno"];
  SEAT_CELLS.forEach(([c, r], i) => {
    const p = cellCenter(c, r);
    const d = c < r ? "ne" : "nw";
    items.push({ key: `armchair/${d}/back`, ...p, layer: 2 });
    const who = sitters[i];
    if (who !== undefined) items.push({ key: `${who}/sit/${d}/0`, ...p, layer: 3 });
    items.push({ key: `armchair/${d}/front`, ...p, layer: 4 });
  });
  // Preview only (not in layout.ts): two camera-facing chairs, so the se/sw sprites are checked in the room.
  for (const [c, r, d, who] of [[1, 8, "sw", "pip"], [8, 1, "se", "mo"]] as const) {
    const p = cellCenter(c, r);
    items.push({ key: `armchair/${d}/back`, ...p, layer: 2 }, { key: `${who}/sit/${d}/0`, ...p, layer: 3 }, { key: `armchair/${d}/front`, ...p, layer: 4 });
  }
  for (const pr of layout.props) items.push({ key: pr.frame, ...cellCenter(pr.col, pr.row), layer: 3 });
  items.push({ key: "pip/idle/sw/0", ...cellCenter(4, 9), layer: 3 });
  items.push({ key: "kiki/idle/nw/0", ...cellCenter(8, 5), layer: 3 });
  items.push({ key: "juno/idle/se/1", ...cellCenter(9, 6), layer: 3 });
  items.sort((a, b) => a.y - b.y || a.x - b.x || a.layer - b.layer);
  for (const it of items) draw(it.key, it.x, it.y);
  writeFileSync(join(ROOT, "preview", "room@1x.png"), encodeIndexedPng(W, H, img, PALETTE));
  writeFileSync(join(ROOT, "preview", "room@2x.png"), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), PALETTE));
}

/** Every armchair facing, empty and with a sitter, on a strip of floor (preview only, 4×). */
function buildSeatsPreview(frames: readonly RoomFrame[], avatars: Map<string, Uint8Array>): void {
  const W = 320, H = 136;
  const img = new Uint8Array(W * H).fill(colorIndex("wall", 2));
  const byKey = new Map(frames.map((f) => [f.key, f]));
  const floor = byKey.get("floor/0");
  const sitters = ["juno", "pip", "mo", "kiki"];
  SEAT_DIRS.forEach((d, i) => {
    for (const [row, who] of [[0, undefined], [1, sitters[i]]] as const) {
      const x = 40 + i * 80, y = 52 + row * 64;
      if (floor) blitAt(img, W, H, floor.img, floor.w, floor.h, x - floor.ax, y - floor.ay);
      const back = byKey.get(`armchair/${d}/back`), front = byKey.get(`armchair/${d}/front`);
      if (!back || !front) throw new Error(`missing armchair/${d}`);
      blitAt(img, W, H, back.img, back.w, back.h, x - back.ax, y - back.ay);
      const a = who === undefined ? undefined : avatars.get(`${who}/sit/${d}/0`);
      if (a) blitAt(img, W, H, a, CELL.w, CELL.h, x - FLOOR.x, y - FLOOR.y);
      blitAt(img, W, H, front.img, front.w, front.h, x - front.ax, y - front.ay);
    }
  });
  writeFileSync(join(ROOT, "preview", "seats@4x.png"), encodeIndexedPng(W * 4, H * 4, upscale(img, W, H, 4), PALETTE));
}

function blitAt(dst: Uint8Array, dw: number, dh: number, src: Uint8Array, sw: number, sh: number, ox: number, oy: number): void {
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const v = src[y * sw + x] ?? 0;
      const px = ox + x, py = oy + y;
      if (v !== 0 && px >= 0 && py >= 0 && px < dw && py < dh) dst[py * dw + px] = v;
    }
  }
}

/** Preview-only stand-in for a playing video: a sunset over the sea. */
function fakeVideo(img: Uint8Array, W: number, x0: number, y0: number, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y / h;
      const d = (x + y) % 2 === 0;
      const sun = (x - w * 0.62) ** 2 + ((y - h * 0.55) * 1.1) ** 2 < 26 ** 2;
      let c: number;
      if (t < 0.56) {
        if (sun) c = colorIndex("mustard", y < h * 0.45 ? 0 : 1);
        else c = t < 0.2 ? colorIndex("lilac", 1) : t < 0.3 ? colorIndex(d ? "lilac" : "pink", 0) : t < 0.45 ? colorIndex("pink", 0) : colorIndex(d ? "pink" : "mustard", 0);
      } else {
        const glint = Math.abs(x - w * 0.62) < 30 - (t - 0.56) * 40 && (y + (x >> 3)) % 3 === 0;
        c = glint ? colorIndex("mustard", 0) : t < 0.7 ? colorIndex("teal", 0) : colorIndex(d && t < 0.8 ? "teal" : "navy", t < 0.8 ? 1 : 0);
      }
      img[(y0 + y) * W + x0 + x] = c;
    }
  }
}

/** Per avatar and pose: floor point minus the highest opaque row over every dir, plus a 2 px gap. */
function tagLiftByAvatar(images: Map<string, Uint8Array>): Record<string, Record<Pose, number>> {
  const out: Record<string, Record<Pose, number>> = {};
  for (const a of AVATARS) {
    const lift = (pose: Pose): number => {
      let top: number = CELL.h;
      for (const d of [...FRONT_DIRS, ...BACK_DIRS]) {
        const img = images.get(`${a.id}/${pose}/${d}/0`);
        if (!img) throw new Error(`missing ${a.id}/${pose}/${d}/0`);
        const i = img.findIndex((v) => v !== 0);
        if (i >= 0) top = Math.min(top, Math.floor(i / CELL.w));
      }
      return FLOOR.y - top + 2;
    };
    out[a.id] = { idle: lift("idle"), sit: lift("sit") };
  }
  return out;
}

/** Set (c): UI chrome atlas, plus each 9-slice/cursor as its own PNG for CSS `border-image`. */
function buildUi(avatarImages: Map<string, Uint8Array>): void {
  const frames = [...buildUiFrames(AVATARS.map((a) => a.id), avatarImages, CELL.w), ...buildPlaybackFrames(), ...buildTvFrames()];
  registerKeys("ui", frames.map((f) => f.key));
  const byKey = new Map(frames.map((f) => [f.key, f]));
  if (byKey.size !== frames.length) throw new Error("duplicate ui key");
  for (const f of frames) if (f.borders) assertStretchable(f.key, f.img, f.w, f.h, f.borders);
  const { placed, w: sheetW, h: sheetH } = pack(frames, 256);
  const sheet = new Uint8Array(sheetW * sheetH);
  const atlasFrames: Record<string, Frame & { borders?: Borders }> = {};
  const dir = join(ROOT, "ui");
  mkdirSync(join(dir, "slices"), { recursive: true });
  for (const p of placed.sort((a, b) => a.key.localeCompare(b.key))) {
    const f = byKey.get(p.key);
    if (!f) throw new Error(`lost ${p.key}`);
    blit(sheet, sheetW, p.img, p.w, p.h, p.x, p.y);
    atlasFrames[p.key] = {
      frame: { x: p.x, y: p.y, w: p.w, h: p.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: p.w, h: p.h },
      sourceSize: { w: p.w, h: p.h },
      anchor: { x: p.ax / p.w, y: p.ay / p.h },
      ...(f.borders ? { borders: f.borders } : {}),
    };
    if (f.slice === true) {
      const small = compactPalette(p.img);
      writeFileSync(join(dir, "slices", `${p.key.replace(/\//g, "-")}.png`), encodeIndexedPng(p.w, p.h, small.pixels, small.palette));
    }
  }
  writeFileSync(join(dir, "ui.png"), encodeIndexedPng(sheetW, sheetH, sheet, PALETTE));
  const atlas = {
    frames: atlasFrames,
    meta: {
      app: "omega-share assets/src/build.ts",
      version: "1",
      image: "ui.png",
      format: "RGBA8888",
      size: { w: sheetW, h: sheetH },
      scale: "1",
      omega: {
        license: "CC-BY-SA-4.0",
        uiScale: 2,
        roomScale: 1,
        // Name tags sit bottom-centre at (floor x, floor y − tagLift): 2 px over the tallest avatar (Pip's pom-pom).
        tagLift: { idle: 48, sit: 46 },
        // Optional per-head lift (2 px over that avatar's own top pixel), so tags hug each head.
        tagLiftByAvatar: tagLiftByAvatar(avatarImages),
        tokens: uiTokens(),
        // Set (e): the catching-up hourglass loops catchup/0..3 at this frame time.
        catchupFrameMs: CATCHUP_FRAME_MS,
      },
    },
  };
  writeFileSync(join(dir, "ui.json"), JSON.stringify(atlas, null, 1) + "\n");
  const rects = Object.fromEntries(Object.entries(atlasFrames).map(([k, f]) => [k, f.frame]));
  const borders: Record<string, Borders> = {};
  for (const f of frames) if (f.borders) borders[f.key] = f.borders;
  writeFileSync(join(dir, "reference.css"), referenceCss(rects, { w: sheetW, h: sheetH }, uiTokens(), borders) + playbackCss(rects) + tvCss());
  const bg = colorIndex("wall", 1);
  const big = upscale(sheet, sheetW, sheetH, 4).map((v) => (v === 0 ? bg : v));
  writeFileSync(join(ROOT, "preview", "ui-sheet@4x.png"), encodeIndexedPng(sheetW * 4, sheetH * 4, big, PALETTE));
}

/** A 9-slice may only stretch flat colour: every column of the top/bottom/centre bands between the side
 *  slices must be identical, and every row of the left/right/centre bands between the top and bottom slices too.
 *  Catches a chamfer that pokes past its slice (it would smear into a visible band when stretched). */
function assertStretchable(key: string, img: Uint8Array, w: number, h: number, b: Borders): void {
  const px = (x: number, y: number): number => img[y * w + x] ?? -1;
  for (let y = 0; y < h; y++) {
    for (let x = b.left + 1; x < w - b.right; x++) {
      if (px(x, y) !== px(b.left, y)) throw new Error(`${key}: column ${String(x)} differs from ${String(b.left)} at row ${String(y)}; widen the side slices`);
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = b.top + 1; y < h - b.bottom; y++) {
      if (px(x, y) !== px(x, b.top)) throw new Error(`${key}: row ${String(y)} differs from ${String(b.top)} at column ${String(x)}; widen the top/bottom slices`);
    }
  }
}

/** Re-index a tiny image to just the colours it uses (index 0 stays transparent); saves ~200 B of PLTE per file. */
function compactPalette(img: Uint8Array): { pixels: Uint8Array; palette: RGBA[] } {
  const map = new Map<number, number>([[0, 0]]);
  const palette: RGBA[] = [PALETTE[0] ?? { r: 0, g: 0, b: 0, a: 0 }];
  const pixels = img.map((v) => {
    let i = map.get(v);
    if (i === undefined) {
      i = palette.length;
      map.set(v, i);
      const col = PALETTE[v];
      if (!col) throw new Error(`index ${String(v)} not in palette`);
      palette.push(col);
    }
    return i;
  });
  return { pixels, palette };
}

/** Colour tokens for DOM text and flat fills; `ui/reference.css` mirrors these. */
function uiTokens(): Record<string, string> {
  return {
    page: RAMPS.outline[1],
    panel: RAMPS.charcoal[2],
    field: RAMPS.night[2],
    text: RAMPS.cream[0],
    muted: RAMPS.lilac[0],
    onPrimary: RAMPS.outline[1],
    accent: RAMPS.mustard[1],
    error: RAMPS.blush[0],
    ok: RAMPS.teal[0],
    bubbleText: RAMPS.outline[1],
    disabledText: RAMPS.cream[2],
    glow: RAMPS.glow[0],
  };
}

/** Emote icon as a role grid: bottom-aligned on row 13 (outline on 14), centred. */
function emoteGrid(e: EmoteDef, n: number): Grid {
  const g = blank(EMOTE_CELL.w, EMOTE_CELL.h);
  const rows = [e.pop, e.art, e.accent][n] ?? e.art;
  const w = Math.max(...rows.map((r) => r.length));
  stamp(g, rows, Math.floor((EMOTE_CELL.w - w) / 2), 14 - rows.length);
  return g;
}

function assertInside(key: string, img: Uint8Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (border && img[y * w + x] !== 0) throw new Error(`${key} touches the cell border at ${String(x)},${String(y)}`);
    }
  }
}

interface Anim {
  frames: string[];
  ms: number[];
  loop: boolean;
}

/** Set (d): walk cycles, breathing, the wave and emote icons, in `avatars/motion.png` + `motion.json`. */
function buildMotion(base: Map<string, Uint8Array>): void {
  const sheetW = 1024;
  const sheetH = pow2(AVATARS.length * 2 * CELL.h);
  const sheet = new Uint8Array(sheetW * sheetH);
  const frames: Record<string, Frame> = {};
  const images = new Map<string, { img: Uint8Array; w: number; h: number }>();
  const anims: Record<string, Anim> = {};
  const put = (key: string, img: Uint8Array, w: number, h: number, x: number, y: number, anchor: { x: number; y: number }): void => {
    if (frames[key]) throw new Error(`duplicate motion key ${key}`);
    assertInside(key, img, w, h);
    blit(sheet, sheetW, img, w, h, x, y);
    frames[key] = {
      frame: { x, y, w, h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w, h },
      sourceSize: { w, h },
      anchor: { x: anchor.x / w, y: anchor.y / h },
    };
    images.set(key, { img, w, h });
  };
  const avatarCell = (a: (typeof AVATARS)[number], pose: Pose, dir: Dir, m: Motion): Uint8Array => render(composeMotion(a, pose, dir, m), a.roles);
  AVATARS.forEach((a, i) => {
    let col = 0;
    const cell = (key: string, img: Uint8Array, row: number): void => {
      put(key, img, CELL.w, CELL.h, col * CELL.w, (i * 2 + row) * CELL.h, FLOOR);
      col++;
    };
    // Row 2i: walk (dirs × 4 frames), then the wave (poses × dirs × 2 frames).
    for (const dir of DIRS) {
      const keys: string[] = [];
      for (let n = 0; n < WALK_FRAMES; n++) {
        const key = `walk/${a.id}/${dir}/${String(n)}`;
        cell(key, avatarCell(a, "idle", dir, walkMotion(viewOf(dir), n, a.holds === true)), 0);
        keys.push(key);
      }
      anims[`walk/${a.id}/${dir}`] = { frames: keys, ms: keys.map(() => WALK_FRAME_MS), loop: true };
    }
    for (const pose of POSES) {
      for (const dir of DIRS) {
        const keys: string[] = [];
        for (let n = 0; n < WAVE_FRAMES; n++) {
          const key = `wave/${a.id}/${pose}/${dir}/${String(n)}`;
          cell(key, avatarCell(a, pose, dir, waveMotion(viewOf(dir), n)), 0);
          keys.push(key);
        }
        const seq = WAVE_SEQUENCE.map((n) => keys[n] ?? "");
        anims[`wave/${a.id}/${pose}/${dir}`] = { frames: seq, ms: seq.map(() => WAVE_MS), loop: false };
      }
    }
    // Row 2i+1: the breathing-out frame per pose × dir (breathing in is the set (a) /0 frame).
    col = 0;
    for (const pose of POSES) {
      for (const dir of DIRS) {
        const key = `breathe/${a.id}/${pose}/${dir}/1`;
        cell(key, avatarCell(a, pose, dir, BREATHE), 1);
        anims[`breathe/${a.id}/${pose}/${dir}`] = { frames: [`${a.id}/${pose}/${dir}/0`, key], ms: [...BREATHE_MS], loop: true };
      }
    }
  });
  // Emote icons: after the breathe cells on Juno's second row.
  const ex0 = DIRS.length * POSES.length * CELL.w;
  const ey0 = CELL.h;
  EMOTES.forEach((e, i) => {
    const keys: string[] = [];
    for (let n = 0; n < EMOTE_FRAMES; n++) {
      const key = `emote/${e.id}/${String(n)}`;
      const x = ex0 + (i * EMOTE_FRAMES + n) * EMOTE_CELL.w;
      put(key, render(emoteGrid(e, n), e.roles), EMOTE_CELL.w, EMOTE_CELL.h, x, ey0, { x: EMOTE_CELL.w / 2, y: EMOTE_CELL.h });
      keys.push(key);
    }
    anims[`emote/${e.id}`] = { frames: EMOTE_SEQUENCE.map(([n]) => keys[n] ?? ""), ms: EMOTE_SEQUENCE.map(([, ms]) => ms), loop: false };
  });
  registerKeys("motion", Object.keys(frames));
  const dir = join(ROOT, "avatars");
  writeFileSync(join(dir, "motion.png"), encodeIndexedPng(sheetW, sheetH, sheet, PALETTE));
  // Pixi's own `animations` can only list this sheet's frames, so breathe (which starts on a set (a) frame) is in meta only.
  const animations: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(anims)) if (v.frames.every((f) => frames[f])) animations[k] = v.frames;
  const atlas = {
    frames,
    animations,
    meta: {
      app: "omega-share assets/src/build.ts",
      version: "1",
      image: "motion.png",
      format: "RGBA8888",
      size: { w: sheetW, h: sheetH },
      scale: "1",
      omega: {
        license: "CC-BY-SA-4.0",
        tile: TILE,
        cell: CELL,
        floorPoint: FLOOR,
        emoteCell: EMOTE_CELL,
        walk: { frameMs: WALK_FRAME_MS, tilesPerCycle: WALK_TILES_PER_CYCLE, stepPx: { x: TILE.w / 2 / WALK_FRAMES, y: TILE.h / 2 / WALK_FRAMES } },
        emotes: EMOTES.map((e) => ({ id: e.id, label: e.label })),
        gestures: [{ id: "wave", label: "Wave" }],
        anims,
      },
    },
  };
  writeFileSync(join(dir, "motion.json"), JSON.stringify(atlas, null, 1) + "\n");
  const all = new Map<string, { img: Uint8Array; w: number; h: number }>(images);
  for (const [k, img] of base) all.set(k, { img, w: CELL.w, h: CELL.h });
  buildMotionPreviews(all);
}

type Sprites = ReadonlyMap<string, { img: Uint8Array; w: number; h: number }>;

/** A small honey diamond under each floor point, so planted feet can be checked at a glance. */
function floorMark(img: Uint8Array, W: number, cx: number, cy: number): void {
  for (let y = -8; y < 8; y++) {
    const half = y < 0 ? (y + 9) * 2 : (8 - y) * 2;
    for (let x = -half; x < half; x++) img[(cy + y) * W + cx + x] = colorIndex("floor", x === -half || x === half - 1 ? 2 : 1);
  }
}

function strip(name: string, cols: number, rows: readonly (readonly string[])[], sprites: Sprites, cw: number, ch: number, mark: boolean): void {
  const W = cols * cw, H = rows.length * ch;
  const img = new Uint8Array(W * H).fill(colorIndex("wall", 1));
  rows.forEach((row, r) => {
    row.forEach((key, c) => {
      if (key === "") return;
      const s = sprites.get(key);
      if (!s) throw new Error(`missing ${key}`);
      const ox = c * cw + Math.floor((cw - s.w) / 2), oy = r * ch + (ch - s.h);
      if (mark && s.h === CELL.h) floorMark(img, W, ox + FLOOR.x, oy + FLOOR.y);
      blitAt(img, W, H, s.img, s.w, s.h, ox, oy);
    });
  });
  writeFileSync(join(ROOT, "preview", name), encodeIndexedPng(W * 4, H * 4, upscale(img, W, H, 4), PALETTE));
}

function buildMotionPreviews(sprites: Sprites): void {
  const walkRows = AVATARS.map((a) => DIRS.flatMap((d) => [0, 1, 2, 3].map((n) => `walk/${a.id}/${d}/${String(n)}`)));
  strip("walk-strip@4x.png", 16, walkRows, sprites, CELL.w, CELL.h, true);
  const idleRows = AVATARS.map((a) => POSES.flatMap((p) => DIRS.flatMap((d) => [`${a.id}/${p}/${d}/0`, `breathe/${a.id}/${p}/${d}/1`])));
  strip("breathe-strip@4x.png", 16, idleRows, sprites, CELL.w, CELL.h, true);
  const icons = EMOTES.flatMap((e) => [0, 1, 2].map((n) => `emote/${e.id}/${String(n)}`));
  const waveRows = AVATARS.map((a) => POSES.flatMap((p) => DIRS.flatMap((d) => [0, 1].map((n) => `wave/${a.id}/${p}/${d}/${String(n)}`))));
  strip("emote-strip@4x.png", 16, [icons, ...waveRows], sprites, CELL.w, CELL.h, true);
  buildMotionScene(sprites);
}

/** Timeline scene at 1×: two walkers, two sitters, emotes over name-tag plates. Frame strip + APNG. */
function buildMotionScene(sprites: Sprites): void {
  const room = new Map(buildRoomFrames().map((f) => [f.key, f]));
  const W = 400, H = 232;
  const cc = (c: number, r: number): { x: number; y: number } => ({ x: 200 + (c - r) * 32, y: 24 + (c + r + 1) * 16 });
  const lifts = tagLiftByAvatar(new Map([...sprites].filter(([k]) => /^[a-z]+\/(idle|sit)\//.test(k)).map(([k, v]) => [k, v.img])));
  const STEP_MS = WALK_FRAME_MS;
  const sx = TILE.w / 2 / WALK_FRAMES, sy = TILE.h / 2 / WALK_FRAMES;
  const emoteAt = (t: number, start: number): number | null => {
    let acc = start;
    for (const [n, ms] of EMOTE_SEQUENCE) {
      if (t >= acc && t < acc + ms) return n;
      acc += ms;
    }
    return null;
  };
  const breathing = (t: number, phase: number): boolean => (t + phase) % (BREATHE_MS[0] + BREATHE_MS[1]) >= BREATHE_MS[0];
  interface Actor {
    id: string;
    key: (t: number) => string;
    pos: (t: number) => { x: number; y: number };
    pose: Pose;
    seat?: Dir;
    emotes: readonly (readonly [string, number])[];
  }
  const LOOP = 16; // walk frames before a walker wraps (4 tiles)
  const walker = (id: string, dir: Dir, c0: number, r0: number, dx: number, dy: number, emotes: Actor["emotes"]): Actor => ({
    id,
    pose: "idle",
    key: (t) => `walk/${id}/${dir}/${String(Math.floor(t / STEP_MS) % WALK_FRAMES)}`,
    pos: (t) => {
      const k = Math.floor(t / STEP_MS) % LOOP, p = cc(c0, r0);
      return { x: p.x + dx * sx * k, y: p.y + dy * sy * k };
    },
    emotes,
  });
  const sitter = (id: string, dir: Dir, c: number, r: number, phase: number, waveAt: number, emotes: Actor["emotes"]): Actor => ({
    id,
    pose: "sit",
    seat: dir,
    key: (t) => {
      const w = Math.floor((t - waveAt) / WAVE_MS);
      const n = WAVE_SEQUENCE[w];
      if (t >= waveAt && n !== undefined) return `wave/${id}/sit/${dir}/${String(n)}`;
      return breathing(t, phase) ? `breathe/${id}/sit/${dir}/1` : `${id}/sit/${dir}/0`;
    },
    pos: () => cc(c, r),
    emotes,
  });
  const actors: Actor[] = [
    walker("juno", "se", 1, 2, 1, 1, [["exclaim", 450], ["clap", 2800]]),
    walker("pip", "nw", 5, 0, -1, -1, [["question", 300]]),
    sitter("kiki", "ne", 1, 4, 800, 99999, [["heart", 150], ["clap", 2600]]),
    sitter("mo", "se", 4, 4, 0, 0, [["laugh", 1100]]),
  ];
  const render1 = (t: number): Uint8Array => {
    const img = new Uint8Array(W * H).fill(colorIndex("night", 2));
    const drawRoom = (key: string, x: number, y: number): void => {
      const f = room.get(key);
      if (!f) throw new Error(`missing ${key}`);
      blitAt(img, W, H, f.img, f.w, f.h, x - f.ax, y - f.ay);
    };
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
      const p = cc(c, r);
      drawRoom((c + r) % 3 === 0 ? "floor/1" : "floor/0", p.x, p.y);
    }
    const items: { y: number; x: number; layer: number; draw: () => void }[] = [];
    for (const a of actors) {
      const p = a.pos(t);
      if (a.seat) {
        const d = a.seat;
        items.push({ ...p, layer: 2, draw: () => { drawRoom(`armchair/${d}/back`, p.x, p.y); } });
        items.push({ ...p, layer: 4, draw: () => { drawRoom(`armchair/${d}/front`, p.x, p.y); } });
      }
      const s = sprites.get(a.key(t));
      if (!s) throw new Error(`missing ${a.key(t)}`);
      items.push({ ...p, layer: 3, draw: () => { blitAt(img, W, H, s.img, s.w, s.h, p.x - FLOOR.x, p.y - FLOOR.y); } });
    }
    items.sort((a, b) => a.y - b.y || a.x - b.x || a.layer - b.layer);
    for (const it of items) it.draw();
    // Overlay layer: name-tag plates (stand-ins for the DOM/Pixi tags) and emotes just above them.
    for (const a of actors) {
      const p = a.pos(t);
      const lift = lifts[a.id]?.[a.pose] ?? 48;
      const tagW = 24, tagH = 9, tx = p.x - tagW / 2, ty = p.y - lift - tagH;
      for (let y = 0; y < tagH; y++) for (let x = 0; x < tagW; x++) {
        const edge = x === 0 || y === 0 || x === tagW - 1 || y === tagH - 1;
        const text = y >= 3 && y <= 5 && x >= 4 && x < tagW - 4 && (x * 7 + y * 3) % 5 !== 0;
        img[(ty + y) * W + tx + x] = edge || text ? OUTLINE : colorIndex("cream", 0);
      }
      for (const [id, start] of a.emotes) {
        const n = emoteAt(t, start);
        if (n === null) continue;
        const e = sprites.get(`emote/${id}/${String(n)}`);
        if (e) blitAt(img, W, H, e.img, e.w, e.h, p.x - e.w / 2, ty - 1 - e.h);
      }
    }
    return img;
  };
  const N = 32;
  const shots = Array.from({ length: N }, (_, k) => render1(k * STEP_MS));
  writeFileSync(join(ROOT, "preview", "motion-scene@1x.apng"), encodeIndexedApng(W, H, shots, shots.map(() => STEP_MS), PALETTE));
  // Frame strip: the first 8 steps (0–1050 ms), 4 across, with a 4 px gutter.
  const G = 4, SW = 4 * W + 3 * G, SH = 2 * H + G;
  const out = new Uint8Array(SW * SH).fill(OUTLINE);
  shots.slice(0, 8).forEach((s, k) => {
    const ox = (k % 4) * (W + G), oy = Math.floor(k / 4) * (H + G);
    for (let y = 0; y < H; y++) out.set(s.subarray(y * W, (y + 1) * W), (oy + y) * SW + ox);
  });
  writeFileSync(join(ROOT, "preview", "motion-scene@1x.png"), encodeIndexedPng(SW, SH, out, PALETTE));
}

function slicesFiles(): string[] {
  return readdirSync(join(ROOT, "ui", "slices")).filter((n) => n.endsWith(".png")).sort().map((n) => `ui/slices/${n}`);
}

function report(): void {
  let total = 0;
  for (const f of ["avatars/avatars.png", "avatars/avatars.json", "avatars/motion.png", "avatars/motion.json", "room/room.png", "room/room.json", "ui/ui.png", "ui/ui.json", ...slicesFiles()]) {
    const buf = readFileSync(join(ROOT, f));
    const size = f.endsWith(".png") ? buf.length : gzipSync(buf, { level: 9 }).length;
    total += size;
    console.log(`${f}: ${String(buf.length)} B${f.endsWith(".json") ? ` (${String(size)} B gz)` : ""}`);
  }
  console.log(`art total (png + gz json): ${String(total)} B of 307200`);
}

mkdirSync(join(ROOT, "preview"), { recursive: true });
mkdirSync(join(ROOT, "src", "moodboards"), { recursive: true });
const avatarImages = buildAvatars();
buildScene(avatarImages);
buildRoom(avatarImages);
buildUi(avatarImages);
buildMotion(avatarImages);
console.log(`palette: ${String(PALETTE.length - 1)} colours`);
report();
