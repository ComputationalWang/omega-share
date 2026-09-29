// Builds the shipped sprite sheets + atlases and the (non-shipped) previews.
// Run: bun assets/src/build.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { AVATARS, BACK_DIRS, CELL, FLOOR, FRONT_DIRS, SEAT_HEIGHT, composeFrame, type Dir, type Pose } from "./avatars";
import { PALETTE, RAMPS, colorIndex } from "./palette";
import { encodeIndexedPng, type RGBA } from "./png";
import { TILE, TV_SCREEN, WALL_H, buildRoomFrames, defaultLayout, type RoomFrame } from "./room";
import { blit, render, upscale } from "./sprite";

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
        tv: { frame: "tv/0", screen: TV_SCREEN },
        seats: [{ frame: "armchair", dirs: ["ne", "nw"] }],
        layout,
      },
    },
  };
  writeFileSync(join(dir, "room.json"), JSON.stringify(atlas, null, 1) + "\n");
  const bg = colorIndex("wall", 1);
  const big = upscale(sheet, sheetW, sheetH, 2).map((v) => (v === 0 ? bg : v));
  writeFileSync(join(ROOT, "preview", "room-sheet@2x.png"), encodeIndexedPng(sheetW * 2, sheetH * 2, big, PALETTE));
  buildRoomScene(frames, avatarImages, layout);
}

/** The whole room exactly as the web lays it out (apps/web/src/layout.ts), with people in it. */
function buildRoomScene(frames: readonly RoomFrame[], avatars: Map<string, Uint8Array>, layout: ReturnType<typeof defaultLayout>): void {
  const W = 960, H = 600, ORIGIN_X = W / 2, ORIGIN_Y = 220;
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
  for (const pr of layout.props) items.push({ key: pr.frame, ...cellCenter(pr.col, pr.row), layer: 3 });
  items.push({ key: "pip/idle/sw/0", ...cellCenter(4, 9), layer: 3 });
  items.push({ key: "kiki/idle/nw/0", ...cellCenter(8, 5), layer: 3 });
  items.push({ key: "juno/idle/se/1", ...cellCenter(9, 6), layer: 3 });
  items.sort((a, b) => a.y - b.y || a.x - b.x || a.layer - b.layer);
  for (const it of items) draw(it.key, it.x, it.y);
  writeFileSync(join(ROOT, "preview", "room@1x.png"), encodeIndexedPng(W, H, img, PALETTE));
  writeFileSync(join(ROOT, "preview", "room@2x.png"), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), PALETTE));
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

function report(): void {
  let total = 0;
  for (const f of ["avatars/avatars.png", "avatars/avatars.json", "room/room.png", "room/room.json"]) {
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
console.log(`palette: ${String(PALETTE.length - 1)} colours`);
report();
