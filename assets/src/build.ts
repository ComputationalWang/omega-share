// Builds the shipped sprite sheets + atlases and the (non-shipped) previews.
// Run: bun assets/src/build.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AVATARS, CELL, FLOOR, SEAT_HEIGHT, composeFrame, type Dir, type Pose } from "./avatars";
import { PALETTE, RAMPS, colorIndex } from "./palette";
import { encodeIndexedPng, type RGBA } from "./png";
import { blit, render, upscale } from "./sprite";

const ROOT = join(import.meta.dir, "..");
const TILE = { w: 64, h: 32 } as const;
const POSES: readonly Pose[] = ["idle", "sit"];
const DIRS: readonly Dir[] = ["se", "sw"];

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
  const cols = POSES.length * DIRS.length * 2;
  const sheetW = cols * CELL.w;
  const sheetH = AVATARS.length * CELL.h;
  const sheet = new Uint8Array(sheetW * sheetH);
  const frames: Record<string, Frame> = {};
  const animations: Record<string, string[]> = {};
  const images = new Map<string, Uint8Array>();
  AVATARS.forEach((a, row) => {
    let col = 0;
    for (const pose of POSES) {
      for (const dir of DIRS) {
        const anim: string[] = [];
        for (const n of [0, 1]) {
          const key = `${a.id}/${pose}/${dir}/${String(n)}`;
          const img = frameImage(row, pose, dir, n);
          assertInsideCell(key, img);
          images.set(key, img);
          const x = col * CELL.w;
          const y = row * CELL.h;
          blit(sheet, sheetW, img, CELL.w, CELL.h, x, y);
          frames[key] = {
            frame: { x, y, w: CELL.w, h: CELL.h },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: CELL.w, h: CELL.h },
            sourceSize: { w: CELL.w, h: CELL.h },
            anchor: { x: FLOOR.x / CELL.w, y: FLOOR.y / CELL.h },
          };
          anim.push(key);
          col++;
        }
        animations[`${a.id}/${pose}/${dir}`] = anim;
      }
    }
  });
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

mkdirSync(join(ROOT, "preview"), { recursive: true });
mkdirSync(join(ROOT, "src", "moodboards"), { recursive: true });
buildScene(buildAvatars());
console.log(`palette: ${String(PALETTE.length - 1)} colours`);
