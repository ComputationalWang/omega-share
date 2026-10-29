// Builds the shipped sprite sheets + atlases and the (non-shipped) previews.
// Run: bun assets/src/build.ts
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { AVATARS, BACK_DIRS, CELL, FLOOR, FRONT_DIRS, SEAT_HEIGHT, composeFrame, composeMotion, viewOf, type Dir, type Motion, type Pose } from "./avatars";
import {
  BREATHE,
  BREATHE_MS,
  CHEER_FRAMES,
  CHEER_MS,
  CHEER_SEQUENCE,
  YAWN_FRAMES,
  YAWN_SEQUENCE,
  WATCH_SEQUENCES,
  WATCH_STATES,
  watchMotion,
  cheerMotion,
  reachMotion,
  REACH_FRAMES,
  REACH_MS,
  REACH_SEQUENCE,
  yawnMotion,
  EMOTES,
  EMOTE_CELL,
  EMOTE_FRAMES,
  EMOTE_SEQUENCE,
  WALK_FRAMES,
  WALK_FRAME_MS,
  WALK_TILES_PER_CYCLE,
  WALK8_FRAMES,
  WALK8_FRAME_MS,
  WAVE_FRAMES,
  WAVE_MS,
  WAVE_SEQUENCE,
  waveMotion,
  walkMotion,
  walk8Motion,
  type EmoteDef,
} from "./motion";
import { OUTLINE, PALETTE, RAMPS, colorIndex } from "./palette";
import { encodeIndexedApng, encodeIndexedPng, type RGBA } from "./png";
import { HAIR_PALETTE, hairSheet, hairsTable, lookRemap } from "./hairs";
import { recolourSheet, recoloursTable, wallRecolourSheet } from "./recolours";
import { applyRemap, contactSheet, tintsTable } from "./tints";
import { CATALOGUE_V2, CATALOGUE_V4, CATALOGUE_V5, CATALOGUE_V6, CATALOGUE_V7, THUMB_BOX, V7_COLOURS, buildFurniture, buildThumbs, type FurnDir, type PieceMeta } from "./furniture";
import { SEAT_DIRS, TILE, TV_SCREEN, WALL_H, buildPanelShell, buildRoomFrames, defaultLayout, type RoomFrame } from "./room";
import { blank, blit, render, stamp, upscale, type Grid } from "./sprite";
import { buildUiFrames, referenceCss, type Borders, type UiFrame } from "./ui";
import { CATCHUP_FRAME_MS, buildPlaybackFrames, playbackCss } from "./playback";
import { buildTvFrames, tvCss } from "./tv";
import { ONAIR_FRAME_MS, RESYNC_FRAME_MS, buildLiveFrames, liveCss } from "./live";
import { DOTS_FRAME_MS, POPUP_ICONS, WAIT_FRAMES, buildSafetyFrames, safetyCss } from "./safety";
import { buildOwnerFrames, ownerCss } from "./owner";
import { buildRoomsFrames, buildRoomsScenes, roomsCss } from "./rooms";
import { buildModerationFrames, buildModerationScenes, moderationCss } from "./moderation";
import { buildQueueFrames, queueCss } from "./queue";
import { buildFullscreenFrames, buildFullscreenScenes, fullscreenCss, STRIP_AGES } from "./fullscreen";
import { buildResponsiveScenes } from "./responsive";
import { buildStoreIcons, buildToolbarIcons, renderFoundIcon, renderScreenOff } from "./store";
import { buildPanels, buildShareCard, buildSiteIcons, encodeIco, type SiteSources } from "./site";
import { buildPopupVignettes } from "./popup";
import { POPUP_KIT_SLICES, POPUP_KIT_SPRITES, brightDots, chevronFrame, popupKitCss } from "./popupkit";
import { BUBBLES, buildChatFloatFrames, chatFloatCss, wheelMeta } from "./chatfloat";
import { SHEET as REACT_SHEET, buildReactionFrames, layout as reactLayout, momentsCss, reactionAnims } from "./reactions";
import { PRESETS, THUMB, THUMB_SCALE, buildRoomThumbs, presetThumb } from "./presets";
import { HALLOWEEN } from "./halloween";
import { CHRISTMAS } from "./christmas";
import { EASTER } from "./easter";
import { SINTERKLAAS } from "./sinterklaas";
import { VALENTINES } from "./valentines";
import { allAvatarFrames, buildHatFrames, type HatFrame, type ThemeDef } from "./theme";
import { ACCESSORIES, BARE } from "./accessories";
import { BREATH_FRAMES, BREATH_MS, LIE_ANCHORS, LIE_CELL, LIE_DIRS, LIE_FLOOR, LIE_STYLES, SLEEP_FLOOR, floorOf, lieGrid, type LieStyle } from "./lying";
import { BEND_FLOOR, DUNGEON_CELL, DUNGEON_DIRS, THRUST_FLOOR, THRUST_FRAMES, THRUST_MS, THRUST_OFFSET, THRUST_SEQUENCE, bendGrid, thrustGrid } from "./dungeon";
import * as v from "valibot";
import { FURNITURE, RoomLayoutInputSchema, footprintCells, type RoomLayout } from "@omega/shared";

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
        // Since ADR 0012 the player is page chrome above the stage (framed by ui tvframe/*); tv/0 is the corner console and
        // `screen` is its projector's lit 16:9 gate, relative to the tv/0 anchor. Decorative: never put the iframe here.
        tv: { frame: "tv/0", screen: TV_SCREEN },
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
interface SceneHooks {
  /** Drawn after the walls and the console, before anything on the floor (wall decor, background effect). */
  walls?: (draw: (key: string, x: number, y: number) => void, cellCenter: (c: number, r: number) => { x: number; y: number }) => void;
  /** Extra sprites, drawn right after the avatar sprite with the same key at the same floor point (hats). */
  over?: (key: string) => string | undefined;
  extra?: ReadonlyMap<string, RoomFrame>;
}

function buildRoomScene(frames: readonly RoomFrame[], avatars: Map<string, Uint8Array>, layout: ReturnType<typeof defaultLayout>): void {
  const { img, W, H } = composeRoomScene(frames, avatars, layout);
  writeFileSync(join(ROOT, "preview", "room@1x.png"), encodeIndexedPng(W, H, img, PALETTE));
  // A stand-in video frame at the player's max size (560×315, ADR 0012), for preview/ui.html's TV mock-ups.
  const vid = new Uint8Array(560 * 315);
  fakeVideo(vid, 560, 0, 0, 560, 315);
  writeFileSync(join(ROOT, "preview", "tv-video@1x.png"), encodeIndexedPng(560, 315, vid, PALETTE));
  writeFileSync(join(ROOT, "preview", "room@2x.png"), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), PALETTE));
}

function composeRoomScene(frames: readonly RoomFrame[], avatars: Map<string, Uint8Array>, layout: ReturnType<typeof defaultLayout>, hooks: SceneHooks = {}): { img: Uint8Array; W: number; H: number } {
  const W = 960, H = 600, ORIGIN_X = W / 2, ORIGIN_Y = 220;
  const cellCenter = (c: number, r: number): { x: number; y: number } => ({ x: ORIGIN_X + (c - r) * 32, y: ORIGIN_Y + (c + r + 1) * 16 });
  // Mirrors layout.ts SEAT_CELLS / STANDING; seats face the TV.
  const SEAT_CELLS: readonly (readonly [number, number])[] = [[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]];
  const img = new Uint8Array(W * H).fill(colorIndex("night", 2));
  const byKey = new Map(frames.map((f) => [f.key, f]));
  const draw = (key: string, x: number, y: number): void => {
    const f = byKey.get(key) ?? hooks.extra?.get(key);
    if (f) {
      blitAt(img, W, H, f.img, f.w, f.h, x - f.ax, y - f.ay);
      return;
    }
    const a = avatars.get(key);
    if (!a) throw new Error(`missing ${key}`);
    blitAt(img, W, H, a, CELL.w, CELL.h, x - FLOOR.x, y - FLOOR.y);
    const over = hooks.over?.(key);
    if (over !== undefined) draw(over, x, y);
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
  hooks.walls?.(draw, cellCenter);
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
  return { img, W, H };
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
function buildUi(avatarImages: Map<string, Uint8Array>, furniture: readonly RoomFrame[]): UiFrame[] {
  const print = (dir: string): RoomFrame => {
    const f = furniture.find((x) => x.key === `furniture/frame/dusk/${dir}/back`);
    if (!f) throw new Error(`missing print ${dir}`);
    return f;
  };
  const owner = buildOwnerFrames(print("se"), print("sw"), [...buildThumbs(), ...buildRoomThumbs()]);
  // Set (h): the owner's edit kit (grid, markers, handles, tray thumbnails, swatches) is its own lazy atlas, ui/edit.png:
  // only a room owner who presses "Edit room" loads it. Everything any member sees (door, host/key glyphs, invite icons) stays in ui.png.
  const editKit = owner.filter((f) => EDIT_KIT.test(f.key));
  const frames = [...buildUiFrames(AVATARS.map((a) => a.id), avatarImages, CELL.w), ...buildPlaybackFrames(), ...buildLiveFrames(), ...buildTvFrames(), ...buildSafetyFrames(), ...owner.filter((f) => !EDIT_KIT.test(f.key)), ...buildRoomsFrames(), ...buildModerationFrames(), ...buildQueueFrames(), ...buildFullscreenFrames(), ...buildChatFloatFrames()];
  registerKeys("ui", frames.map((f) => f.key));
  const byKey = new Map(frames.map((f) => [f.key, f]));
  if (byKey.size !== frames.length) throw new Error("duplicate ui key");
  for (const f of frames) if (f.borders) assertStretchable(f.key, f.img, f.w, f.h, f.borders, f.fixedHeight === true);
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
        // M2 (OME-120): the LIVE pill's lamp blinks glyph/onair/0..1 at this frame time (loop); resync/0..2 is one-shot.
        onairFrameMs: ONAIR_FRAME_MS,
        resyncFrameMs: RESYNC_FRAME_MS,
        // Set (f) (OME-193): wait/0..N-1 is a one-shot drain over the server's retry-after (frame = floor(elapsed / total * N));
        // glyph/dots/0..2 loops while reconnecting.
        waitFrames: WAIT_FRAMES,
        dotsFrameMs: DOTS_FRAME_MS,
        // Set (k) (OME-541): full-screen strip line ages in ms (fresh → settled → faded → gone) and the one dither frame between.
        stripAges: STRIP_AGES,
        // Set (l) (OME-644, M8): floating bubbles (ms, stage px; the stacking rule is in assets/README.md § Set (l)) and the emote wheel's geometry.
        bubbles: BUBBLES,
        wheel: wheelMeta(),
      },
    },
  };
  writeFileSync(join(dir, "ui.json"), JSON.stringify(atlas, null, 1) + "\n");
  const rects = Object.fromEntries(Object.entries(atlasFrames).map(([k, f]) => [k, f.frame]));
  const borders: Record<string, Borders> = {};
  for (const f of frames) if (f.borders) borders[f.key] = f.borders;
  const edit = writeAtlas(dir, "edit", editKit, "ui");
  writeFileSync(join(dir, "reference.css"), referenceCss(rects, { w: sheetW, h: sheetH }, uiTokens(), borders) + playbackCss(rects) + tvCss() + liveCss(rects) + safetyCss(rects) + ownerCss(edit.rects, edit.size, THUMB_BOX) + roomsCss(rects) + moderationCss() + queueCss(rects) + fullscreenCss() + chatFloatCss(rects));
  // Set (f): the extension popup is plain HTML, so its key icon ships as two standalone files (drawn 1× and 2×, not upscaled).
  mkdirSync(join(dir, "popup"), { recursive: true });
  for (const [file, k] of Object.entries(POPUP_ICONS)) {
    const f = byKey.get(k);
    if (!f) throw new Error(`missing ${k}`);
    const small = compactPalette(f.img);
    writeFileSync(join(dir, "popup", `${file}.png`), encodeIndexedPng(f.w, f.h, small.pixels, small.palette));
  }
  // OME-842: the popup's three state vignettes (nothing found, can't read this tab, server away), 48×40 + 2×, capped at 3 KB together.
  let popupStates = 0;
  for (const f of buildPopupVignettes()) {
    const small = compactPalette(f.img);
    const png = encodeIndexedPng(f.w, f.h, small.pixels, small.palette);
    popupStates += png.length;
    writeFileSync(join(dir, "popup", f.file), png);
  }
  if (popupStates > 3072) throw new Error(`popup state vignettes ${String(popupStates)} B > 3072`);
  console.log(`popup state vignettes (OME-842): ${String(popupStates)} B of 3072`);
  // OME-1041: the popup's own sprite cut (kit.png) and stylesheet (kit.css); its 9-slices are the existing ui/slices files.
  const kitFrames = [...POPUP_KIT_SPRITES.map((k) => { const f = byKey.get(k); if (!f) throw new Error(`missing ${k}`); return k.startsWith("glyph/dots/") ? { ...f, img: brightDots(f.img) } : f; }), chevronFrame()];
  const kit = pack(kitFrames, 64);
  const kitSheet = new Uint8Array(kit.w * kit.h);
  for (const p of kit.placed) blit(kitSheet, kit.w, p.img, p.w, p.h, p.x, p.y);
  const kitSmall = compactPalette(kitSheet);
  writeFileSync(join(dir, "popup", "kit.png"), encodeIndexedPng(kit.w, kit.h, kitSmall.pixels, kitSmall.palette));
  writeFileSync(join(dir, "popup", "kit.css"), popupKitCss(Object.fromEntries(kit.placed.map((p) => [p.key, { x: p.x, y: p.y, w: p.w, h: p.h }])), { w: kit.w, h: kit.h }, { ...uiTokens(), hint: RAMPS.cream[1] }));
  for (const s of POPUP_KIT_SLICES) if (!existsSync(join(dir, "slices", `${s}.png`))) throw new Error(`popup kit: no slice ${s}`);
  // Set (i): the closed / invite-required vignettes are standalone PNGs, fetched only by the pages that show them.
  mkdirSync(join(dir, "scenes"), { recursive: true });
  const scenes = [...buildRoomsScenes(), ...buildModerationScenes(), ...buildFullscreenScenes(), ...buildResponsiveScenes()];
  registerKeys("ui", scenes.map((f) => f.key));
  for (const f of scenes) {
    const small = compactPalette(f.img);
    writeFileSync(join(dir, "scenes", `${f.key.slice("scene/".length)}.png`), encodeIndexedPng(f.w, f.h, small.pixels, small.palette));
  }
  const bg = colorIndex("wall", 1);
  const big = upscale(sheet, sheetW, sheetH, 4).map((v) => (v === 0 ? bg : v));
  writeFileSync(join(ROOT, "preview", "ui-sheet@4x.png"), encodeIndexedPng(sheetW * 4, sheetH * 4, big, PALETTE));
  return [...frames, ...editKit];
}

const EDIT_KIT = /^(edit|place|handle|thumb|swatch)\//;

/** A plain Pixi/TexturePacker atlas (`<name>.png` + `<name>.json`) for a lazy sub-set; returns frame rects for the CSS. */
function writeAtlas(dir: string, name: string, frames: readonly UiFrame[], set: string): { rects: Record<string, { x: number; y: number; w: number; h: number }>; size: { w: number; h: number } } {
  registerKeys(set, frames.map((f) => f.key));
  const { placed, w, h } = pack(frames, 256);
  const sheet = new Uint8Array(w * h);
  const out: Record<string, Frame> = {};
  for (const p of placed.sort((a, b) => a.key.localeCompare(b.key))) {
    blit(sheet, w, p.img, p.w, p.h, p.x, p.y);
    out[p.key] = {
      frame: { x: p.x, y: p.y, w: p.w, h: p.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: p.w, h: p.h },
      sourceSize: { w: p.w, h: p.h },
      anchor: { x: p.ax / p.w, y: p.ay / p.h },
    };
  }
  writeFileSync(join(dir, `${name}.png`), encodeIndexedPng(w, h, sheet, PALETTE));
  const atlas = { frames: out, meta: { app: "omega-share assets/src/build.ts", version: "1", image: `${name}.png`, format: "RGBA8888", size: { w, h }, scale: "1", omega: { license: "CC-BY-SA-4.0", roomScale: 1, uiScale: 2 } } };
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(atlas, null, 1) + "\n");
  return { rects: Object.fromEntries(Object.entries(out).map(([k, f]) => [k, f.frame])), size: { w, h } };
}

/** A 9-slice may only stretch flat colour: every column of the top/bottom/centre bands between the side
 *  slices must be identical, and every row of the left/right/centre bands between the top and bottom slices too.
 *  Catches a chamfer that pokes past its slice (it would smear into a visible band when stretched). */
function assertStretchable(key: string, img: Uint8Array, w: number, h: number, b: Borders, fixedHeight: boolean): void {
  const px = (x: number, y: number): number => img[y * w + x] ?? -1;
  for (let y = 0; y < h; y++) {
    for (let x = b.left + 1; x < w - b.right; x++) {
      if (px(x, y) !== px(b.left, y)) throw new Error(`${key}: column ${String(x)} differs from ${String(b.left)} at row ${String(y)}; widen the side slices`);
    }
  }
  // A fixed-height slice only stretches sideways: its centre column must still be flat, its side slices needn't be.
  for (let x = fixedHeight ? b.left : 0; x < (fixedHeight ? w - b.right : w); x++) {
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
    // Row 2i+1, cols 16–31 (the free half, right of the emote icons): the smooth walk's in-betweens, dirs × frames 1, 3, 5, 7.
    // Even frames of `walk8/*` name the 4-frame cycle's own keys, so a tier switch mid-stride shows the same pixels.
    col = 16;
    for (const dir of DIRS) {
      const keys: string[] = [];
      for (let k = 0; k < WALK8_FRAMES; k++) {
        if (k % 2 === 0) {
          keys.push(`walk/${a.id}/${dir}/${String(k / 2)}`);
          continue;
        }
        const key = `walk8/${a.id}/${dir}/${String(k)}`;
        cell(key, avatarCell(a, "idle", dir, walk8Motion(viewOf(dir), k, a.holds === true)), 1);
        keys.push(key);
      }
      anims[`walk8/${a.id}/${dir}`] = { frames: keys, ms: keys.map(() => WALK8_FRAME_MS), loop: true };
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
        walk8: { frameMs: WALK8_FRAME_MS, frames: WALK8_FRAMES, tilesPerCycle: WALK_TILES_PER_CYCLE, stepPx: { x: TILE.w / 2 / WALK8_FRAMES, y: TILE.h / 2 / WALK8_FRAMES } },
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

// ---------------------------------------------------------------- set (p): expressions (OME-1104, lazy)

/** Set (p): cheer and yawn/doze, 2 frames × pose × dir per avatar, in `avatars/expressions.png` + `.json`. motion.png is full, so
 *  this is a second lazy sheet with motion.json's schema: one row per avatar, cheer then yawn, each poses × dirs × frames. */
function buildExpressions(base: Map<string, Uint8Array>): void {
  // One more row under the four: reach (OME-1697), standing only, avatar i in columns 8i–8i+7. Not rounded up to 512, because the web
  // keeps one tinted copy of this sheet per look in use.
  const sheetW = 1024, sheetH = (AVATARS.length + 1) * CELL.h;
  const sheet = new Uint8Array(sheetW * sheetH);
  const frames: Record<string, Frame> = {};
  const images = new Map<string, { img: Uint8Array; w: number; h: number }>();
  const anims: Record<string, Anim> = {};
  const motionFor = (id: "cheer" | "yawn", a: (typeof AVATARS)[number], pose: Pose, dir: Dir, n: number): Motion =>
    id === "cheer" ? cheerMotion(viewOf(dir), pose, n, a.holds === true) : yawnMotion(viewOf(dir), n, a.holds === true);
  AVATARS.forEach((a, i) => {
    let col = 0;
    for (const id of ["cheer", "yawn"] as const) {
      for (const pose of POSES) {
        for (const dir of DIRS) {
          const keys: string[] = [];
          for (let n = 0; n < (id === "cheer" ? CHEER_FRAMES : YAWN_FRAMES); n++) {
            const key = `${id}/${a.id}/${pose}/${dir}/${String(n)}`;
            if (frames[key]) throw new Error(`duplicate expression key ${key}`);
            const img = render(composeMotion(a, pose, dir, motionFor(id, a, pose, dir, n)), a.roles);
            assertInside(key, img, CELL.w, CELL.h);
            const x = col * CELL.w, y = i * CELL.h;
            blit(sheet, sheetW, img, CELL.w, CELL.h, x, y);
            frames[key] = {
              frame: { x, y, w: CELL.w, h: CELL.h },
              rotated: false,
              trimmed: false,
              spriteSourceSize: { x: 0, y: 0, w: CELL.w, h: CELL.h },
              sourceSize: { w: CELL.w, h: CELL.h },
              anchor: { x: FLOOR.x / CELL.w, y: FLOOR.y / CELL.h },
            };
            images.set(key, { img, w: CELL.w, h: CELL.h });
            keys.push(key);
            col++;
          }
          const name = `${id}/${a.id}/${pose}/${dir}`;
          anims[name] = id === "cheer"
            ? { frames: CHEER_SEQUENCE.map((n) => keys[n] ?? ""), ms: CHEER_SEQUENCE.map(() => CHEER_MS), loop: false }
            : { frames: YAWN_SEQUENCE.map(([n]) => keys[n] ?? ""), ms: YAWN_SEQUENCE.map(([, ms]) => ms), loop: false };
        }
      }
    }
    DIRS.forEach((dir, d) => {
      const keys: string[] = [];
      for (let n = 0; n < REACH_FRAMES; n++) {
        const key = `reach/${a.id}/idle/${dir}/${String(n)}`;
        const img = render(composeMotion(a, "idle", dir, reachMotion(viewOf(dir), n)), a.roles);
        assertInside(key, img, CELL.w, CELL.h);
        const x = (i * DIRS.length * REACH_FRAMES + d * REACH_FRAMES + n) * CELL.w, y = AVATARS.length * CELL.h;
        blit(sheet, sheetW, img, CELL.w, CELL.h, x, y);
        frames[key] = {
          frame: { x, y, w: CELL.w, h: CELL.h },
          rotated: false,
          trimmed: false,
          spriteSourceSize: { x: 0, y: 0, w: CELL.w, h: CELL.h },
          sourceSize: { w: CELL.w, h: CELL.h },
          anchor: { x: FLOOR.x / CELL.w, y: FLOOR.y / CELL.h },
        };
        images.set(key, { img, w: CELL.w, h: CELL.h });
        keys.push(key);
      }
      anims[`reach/${a.id}/idle/${dir}`] = { frames: REACH_SEQUENCE.map((n) => keys[n] ?? ""), ms: REACH_SEQUENCE.map(() => REACH_MS), loop: false };
    });
  });
  registerKeys("expressions", Object.keys(frames));
  const dir = join(ROOT, "avatars");
  writeFileSync(join(dir, "expressions.png"), encodeIndexedPng(sheetW, sheetH, sheet, PALETTE));
  const animations: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(anims)) animations[k] = v.frames;
  const atlas = {
    frames,
    animations,
    meta: {
      app: "omega-share assets/src/build.ts",
      version: "1",
      image: "expressions.png",
      format: "RGBA8888",
      size: { w: sheetW, h: sheetH },
      scale: "1",
      omega: {
        license: "CC-BY-SA-4.0",
        tile: TILE,
        cell: CELL,
        floorPoint: FLOOR,
        gestures: [{ id: "cheer", label: "Cheer" }, { id: "yawn", label: "Yawn" }],
        anims,
      },
    },
  };
  writeFileSync(join(dir, "expressions.json"), JSON.stringify(atlas, null, 1) + "\n");
  const all = new Map<string, { img: Uint8Array; w: number; h: number }>(images);
  for (const [k, img] of base) all.set(k, { img, w: CELL.w, h: CELL.h });
  // Strip: per avatar a cheer row and a yawn row, each the base pose then frames 0 and 1, poses × (se, ne) (sw/nw are their mirrors).
  const rows = AVATARS.flatMap((a) => (["cheer", "yawn"] as const).map((id) =>
    POSES.flatMap((p) => DIRS.flatMap((d) => [`${a.id}/${p}/${d}/0`, `${id}/${a.id}/${p}/${d}/0`, `${id}/${a.id}/${p}/${d}/1`, ""]))));
  strip("expressions-strip@4x.png", 32, rows, all, CELL.w, CELL.h, true);
  // Reach: per avatar the base pose then frames 0 and 1, in se sw ne nw.
  strip("reach-strip@4x.png", 16, AVATARS.map((a) => DIRS.flatMap((d) => [`${a.id}/idle/${d}/0`, `reach/${a.id}/idle/${d}/0`, `reach/${a.id}/idle/${d}/1`, ""])), all, CELL.w, CELL.h, true);
  buildExpressionScene(all);
}

/** `expressions-scene@1x/2x.png`: the room's floor at 1×, every avatar twice (standing, and seated in an armchair), in two panels:
 *  frame 0 of each expression on the left, frame 1 on the right. Top row cheers, bottom row yawns/dozes. */
function buildExpressionScene(sprites: Sprites): void {
  const room = new Map(buildRoomFrames().map((f) => [f.key, f]));
  const PW = 330, PH = 196, W = PW * 2 + 6, H = PH * 2 + 6;
  const img = new Uint8Array(W * H).fill(OUTLINE);
  const facing: readonly Dir[] = ["se", "sw", "ne", "nw"];
  for (let panel = 0; panel < 4; panel++) {
    const n = panel % 2, id = panel < 2 ? "cheer" : "yawn";
    const ox = n * (PW + 6), oy = Math.floor(panel / 2) * (PH + 6);
    for (let y = 0; y < PH; y++) img.fill(colorIndex("night", 2), (oy + y) * W + ox, (oy + y) * W + ox + PW);
    const cc = (c: number, r: number): { x: number; y: number } => ({ x: ox + PW / 2 + (c - r) * 32, y: oy + 4 + (c + r + 1) * 16 });
    const draw = (key: string, p: { x: number; y: number }, fx: number, fy: number): void => {
      const f = room.get(key) ?? (() => { const s = sprites.get(key); if (!s) throw new Error(`missing ${key}`); return { ...s, ax: fx, ay: fy }; })();
      blitAt(img, W, H, f.img, f.w, f.h, p.x - f.ax, p.y - f.ay);
    };
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) draw((c + r) % 3 === 0 ? "floor/1" : "floor/0", cc(c, r), 0, 0);
    // Standing on the far diagonal, seated in armchairs on the near one; each avatar faces a different way.
    const items: { y: number; x: number; draw: () => void }[] = [];
    AVATARS.forEach((a, i) => {
      const d = facing[i] ?? "se";
      const sd = facing[(i + 1) % 4] ?? "se";
      const sp = cc(i, 3 - i), st = cc(i + 2, 5 - i);
      items.push({ ...sp, draw: () => { draw(`${id}/${a.id}/idle/${d}/${String(n)}`, sp, FLOOR.x, FLOOR.y); } });
      items.push({ ...st, draw: () => {
        draw(`armchair/${sd}/back`, st, 0, 0);
        draw(`${id}/${a.id}/sit/${sd}/${String(n)}`, st, FLOOR.x, FLOOR.y);
        draw(`armchair/${sd}/front`, st, 0, 0);
      } });
    });
    items.sort((p, q) => p.y - q.y || p.x - q.x);
    for (const it of items) it.draw();
  }
  writeFileSync(join(ROOT, "preview", "expressions-scene@1x.png"), encodeIndexedPng(W, H, img, PALETTE));
  writeFileSync(join(ROOT, "preview", "expressions-scene@2x.png"), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), PALETTE));
}

// ---------------------------------------------------------------- watching poses (OME-1640, lazy)

/** Seated from behind (ne, nw) for the theatre: `watch/base` plus a laugh shake and a gasp lean, in `avatars/watching.png` + `.json`
 *  (expressions.json's schema). One row per avatar: per dir, base 0, laugh 0–1, gasp 0–1. */
function buildWatching(base: Map<string, Uint8Array>, furniture: { pieces: readonly PieceMeta[]; all: FurnSprites }): void {
  const perRow = BACK_DIRS.length * WATCH_STATES.reduce((n, s) => n + s.frames, 0);
  const sheetW = pow2(perRow * CELL.w), sheetH = pow2(AVATARS.length * CELL.h);
  const sheet = new Uint8Array(sheetW * sheetH);
  const frames: Record<string, Frame> = {};
  const images = new Map<string, Uint8Array>();
  const anims: Record<string, Anim> = {};
  AVATARS.forEach((a, i) => {
    let col = 0;
    for (const dir of BACK_DIRS) {
      for (const st of WATCH_STATES) {
        const keys: string[] = [];
        for (let n = 0; n < st.frames; n++) {
          const key = `watch/${st.id}/${a.id}/${dir}/${String(n)}`;
          const img = render(composeMotion(a, "sit", dir, watchMotion(st.id, n, a.holds === true)), a.roles);
          assertInside(key, img, CELL.w, CELL.h);
          const x = col * CELL.w, y = i * CELL.h;
          blit(sheet, sheetW, img, CELL.w, CELL.h, x, y);
          frames[key] = {
            frame: { x, y, w: CELL.w, h: CELL.h },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: CELL.w, h: CELL.h },
            sourceSize: { w: CELL.w, h: CELL.h },
            anchor: { x: FLOOR.x / CELL.w, y: FLOOR.y / CELL.h },
          };
          images.set(key, img);
          keys.push(key);
          col++;
        }
        if (st.id === "base") continue;
        const seq = WATCH_SEQUENCES[st.id];
        anims[`watch/${st.id}/${a.id}/${dir}`] = { frames: seq.map(([n]) => keys[n] ?? ""), ms: seq.map(([, ms]) => ms), loop: false };
      }
    }
  });
  registerKeys("watching", Object.keys(frames));
  const dir = join(ROOT, "avatars");
  writeFileSync(join(dir, "watching.png"), encodeIndexedPng(sheetW, sheetH, sheet, PALETTE));
  const animations: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(anims)) animations[k] = v.frames;
  const atlas = {
    frames,
    animations,
    meta: {
      app: "omega-share assets/src/build.ts",
      version: "1",
      image: "watching.png",
      format: "RGBA8888",
      size: { w: sheetW, h: sheetH },
      scale: "1",
      omega: {
        license: "CC-BY-SA-4.0",
        tile: TILE,
        cell: CELL,
        floorPoint: FLOOR,
        states: WATCH_STATES.map((s) => ({ id: s.id, frames: s.frames })),
        anims,
      },
    },
  };
  writeFileSync(join(dir, "watching.json"), JSON.stringify(atlas, null, 1) + "\n");
  // Strip: per avatar, the plain seated back (sit/<dir>/0) then base, laugh 0–1, gasp 0–1, for ne and nw.
  const all = new Map<string, { img: Uint8Array; w: number; h: number }>();
  for (const [k, img] of [...base, ...images]) all.set(k, { img, w: CELL.w, h: CELL.h });
  const rows = AVATARS.map((a) => BACK_DIRS.flatMap((d) => [`${a.id}/sit/${d}/0`, ...WATCH_STATES.flatMap((s) => Array.from({ length: s.frames }, (_, n) => `watch/${s.id}/${a.id}/${d}/${String(n)}`)), ""]));
  strip("watching-strip@4x.png", 32, rows, all, CELL.w, CELL.h, true);
  buildWatchingTheatre(images, furniture);
}

/** `watching-theatre@1x/2x.png`: the theatre set with three raised rows of 4 on each side (every row holds all 4 avatars, in a
 *  different order). 3 × 2 panels, one per frame: base, laugh 0, laugh 1 / gasp 0, gasp 1, and a mixed house (front row laughing,
 *  middle row gasping, back row plain). */
function buildWatchingTheatre(images: ReadonlyMap<string, Uint8Array>, furniture: { pieces: readonly PieceMeta[]; all: FurnSprites }): void {
  const orders = [["juno", "pip", "mo", "kiki"], ["mo", "kiki", "juno", "pip"], ["kiki", "juno", "pip", "mo"]];
  const tiers = ["floor", "step", "high"] as const;
  const frames = WATCH_STATES.flatMap((s) => Array.from({ length: s.frames }, (_, n) => `${s.id}/${String(n)}`));
  // Per panel, the frame each tier (front, middle, back) shows.
  const panels = [...frames.map((f) => [f, f, f]), ["laugh/1", "gasp/1", "base/0"]];
  // Crop to the seating block: the screen down to the front aisle light.
  const crop = { x: 236, y: 70, w: 488, h: 380 }, cols = 3, G = 4;
  const W = cols * crop.w + (cols - 1) * G, H = 2 * crop.h + G;
  const out = new Uint8Array(W * H).fill(OUTLINE);
  panels.forEach((tierFrames, pi) => {
    const all: FurnSprites = new Map(furniture.all);
    const alias = (t: number, id: string): string => `${String(pi)}.${String(t)}:${id}`;
    tierFrames.forEach((f, t) => {
      for (const a of AVATARS) for (const d of BACK_DIRS) {
        const [state = "", n = ""] = f.split("/");
        const img = images.get(`watch/${state}/${a.id}/${d}/${n}`);
        if (!img) throw new Error(`missing watch frame ${f} for ${a.id}/${d}`);
        all.set(`${alias(t, a.id)}/sit/${d}/0`, { img, w: CELL.w, h: CELL.h, ax: FLOOR.x, ay: FLOOR.y });
      }
    });
    const carpet = (col: number, row: number): Placement => ({ id: "carpet", colour: "navy", dir: "se", col, row });
    const placements: Placement[] = [
      { id: "bigscreen", colour: "charcoal", dir: "se", col: 0, row: 0 },
      { id: "curtain", colour: "velvet", dir: "sw", col: 2, row: 0 },
      { id: "curtain", colour: "velvet", dir: "se", col: 0, row: 2 },
      ...[1, 3, 5, 7].flatMap((c) => [1, 3, 5, 7].map((r) => carpet(c, r))),
      ...[5, 6, 7, 8].map((k): Placement => ({ id: "aislelight", colour: "warm", dir: "nw", col: k, row: k })),
    ];
    tiers.forEach((colour, t) => {
      const who = (orders[t] ?? []).map((id) => alias(t, id));
      placements.push({ id: "theatrerow", colour, dir: "ne", col: 1, row: 5 + t, sitters: who.slice(0, 2) });
      placements.push({ id: "theatrerow", colour, dir: "ne", col: 3, row: 5 + t, sitters: who.slice(2) });
      placements.push({ id: "theatrerow", colour, dir: "nw", col: 5 + t, row: 1, sitters: who.slice(0, 2) });
      placements.push({ id: "theatrerow", colour, dir: "nw", col: 5 + t, row: 3, sitters: who.slice(2) });
    });
    const room = composeFurnitureRoom(furniture.pieces, all, { rug: false, tv: false, placements, standing: [] });
    const ox = (pi % cols) * (crop.w + G), oy = Math.floor(pi / cols) * (crop.h + G);
    for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) out[(oy + y) * W + ox + x] = room.img[(crop.y + y) * room.W + crop.x + x] ?? 0;
  });
  writeFileSync(join(ROOT, "preview", "watching-theatre@1x.png"), encodeIndexedPng(W, H, out, PALETTE));
  writeFileSync(join(ROOT, "preview", "watching-theatre@2x.png"), encodeIndexedPng(W * 2, H * 2, upscale(out, W, H, 2), PALETTE));
  // `watching-rows@3x.png`: the same six panels cut to the seats only, 2 across, so each reaction can be read sitter by sitter.
  const rows = { x: 14, y: 212, w: 460, h: 128 }, RW = 2 * rows.w + G, RH = 3 * rows.h + 2 * G;
  const cut = new Uint8Array(RW * RH).fill(OUTLINE);
  panels.forEach((_, pi) => {
    const sx = (pi % cols) * (crop.w + G) + rows.x, sy = Math.floor(pi / cols) * (crop.h + G) + rows.y;
    const ox = (pi % 2) * (rows.w + G), oy = Math.floor(pi / 2) * (rows.h + G);
    for (let y = 0; y < rows.h; y++) cut.set(out.subarray((sy + y) * W + sx, (sy + y) * W + sx + rows.w), (oy + y) * RW + ox);
  });
  writeFileSync(join(ROOT, "preview", "watching-rows@3x.png"), encodeIndexedPng(RW * 3, RH * 3, upscale(cut, RW, RH, 3), PALETTE));
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
  // Smooth tier: one row per avatar × dir pair, the 8 frames of each dir side by side (in-betweens on the odd columns).
  const walk8Rows = AVATARS.flatMap((a) => [DIRS.slice(0, 2), DIRS.slice(2)].map((ds) => ds.flatMap((d) => Array.from({ length: WALK8_FRAMES }, (_, k) => (k % 2 === 0 ? `walk/${a.id}/${d}/${String(k / 2)}` : `walk8/${a.id}/${d}/${String(k)}`)))));
  strip("walk8-strip@4x.png", 16, walk8Rows, sprites, CELL.w, CELL.h, true);
  const idleRows = AVATARS.map((a) => POSES.flatMap((p) => DIRS.flatMap((d) => [`${a.id}/${p}/${d}/0`, `breathe/${a.id}/${p}/${d}/1`])));
  strip("breathe-strip@4x.png", 16, idleRows, sprites, CELL.w, CELL.h, true);
  const icons = EMOTES.flatMap((e) => [0, 1, 2].map((n) => `emote/${e.id}/${String(n)}`));
  const waveRows = AVATARS.map((a) => POSES.flatMap((p) => DIRS.flatMap((d) => [0, 1].map((n) => `wave/${a.id}/${p}/${d}/${String(n)}`))));
  strip("emote-strip@4x.png", 16, [icons, ...waveRows], sprites, CELL.w, CELL.h, true);
  buildMotionScene(sprites);
  buildWalkTiers(sprites);
}

/** Set (l) (M8): the two walk tiers side by side, 2×. Top row Basic (4 frames × 150 ms, the sprite steps (8, 4) px per frame),
 *  bottom row Smooth (8 frames × 75 ms, (4, 2) px per frame; in the app it's interpolated every display frame). Each avatar walks two
 *  tiles in its own direction and loops. APNG at 75 ms per shot (the Basic row holds each frame for two shots). */
function buildWalkTiers(sprites: Sprites): void {
  const CW = 120, CH = 104, W = CW * AVATARS.length, H = CH * 2, S = 2;
  const STEP: Readonly<Record<Dir, readonly [number, number]>> = { se: [1, 1], sw: [-1, 1], ne: [1, -1], nw: [-1, -1] };
  const shots: Uint8Array[] = [];
  for (let k = 0; k < 2 * WALK8_FRAMES; k++) {
    const img = new Uint8Array(W * H).fill(colorIndex("wall", 1));
    AVATARS.forEach((a, i) => {
      const dir = DIRS[i] ?? "se";
      const [dx, dy] = STEP[dir];
      for (const smooth of [false, true]) {
        const ox = i * CW, oy = smooth ? CH : 0;
        const sx = ox + CW / 2 - dx * 32, sy = oy + 80 - dy * 16;
        for (let t = 0; t <= 2; t++) floorMark(img, W, sx + dx * 32 * t, sy + dy * 16 * t);
        const n = smooth ? k : Math.floor(k / 2);
        const key = smooth
          ? (n % 2 === 0 ? `walk/${a.id}/${dir}/${String((n % WALK8_FRAMES) / 2)}` : `walk8/${a.id}/${dir}/${String(n % WALK8_FRAMES)}`)
          : `walk/${a.id}/${dir}/${String(n % WALK_FRAMES)}`;
        const px = smooth ? 4 : 8, py = smooth ? 2 : 4;
        const s = sprites.get(key);
        if (!s) throw new Error(`missing ${key}`);
        blitAt(img, W, H, s.img, s.w, s.h, sx + dx * px * n - FLOOR.x, sy + dy * py * n - FLOOR.y);
      }
    });
    shots.push(upscale(img, W, H, S));
  }
  writeFileSync(join(ROOT, "preview", "walk-tiers@2x.apng"), encodeIndexedApng(W * S, H * S, shots, shots.map(() => WALK8_FRAME_MS), PALETTE));
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

// ---------------------------------------------------------------- set (g): furniture catalogue (M4/M5, lazy)

interface FurnItem { key: string; x: number; y: number; sx: number; sy: number; layer: number }
/** One placed catalogue piece: its layers and sitters, all sorted at the piece's sort point (manifest `sortByDir`). */
function placePiece(meta: PieceMeta, colour: string, dir: FurnDir, ax: number, ay: number, sitters: readonly string[] = []): FurnItem[] {
  const sort = meta.sortByDir[dir] ?? { x: 0, y: 0 };
  const sx = ax + sort.x, sy = ay + sort.y;
  const base = `furniture/${meta.id}/${colour}/${dir}`;
  const lift = meta.seatLiftByColour?.[colour] ?? 0;
  const out: FurnItem[] = [{ key: `${base}/back`, x: ax, y: ay, sx, sy, layer: 2 }];
  (meta.seatsByDir?.[dir] ?? []).forEach((seat, i) => {
    const who = sitters[i];
    if (who === undefined || who === "") return; // "" = a free seat before a taken one
    out.push({ key: `${who}/sit/${seat.dir}/0`, x: ax + (seat.col - seat.row) * 32, y: ay + (seat.col + seat.row) * 16 - lift, sx, sy, layer: 3 });
  });
  if (meta.layersByDir[dir]?.includes("front") === true) out.push({ key: `${base}/front`, x: ax, y: ay, sx, sy, layer: 4 });
  return out;
}

function buildFurnitureSet(roomFrames: readonly RoomFrame[], avatars: Map<string, Uint8Array>): { frames: RoomFrame[]; pieces: PieceMeta[]; all: FurnSprites } {
  const { frames, pieces } = buildFurniture();
  registerKeys("furniture", frames.map((f) => f.key));
  const seen = new Set<string>();
  for (const f of frames) {
    if (seen.has(f.key)) throw new Error(`duplicate furniture key ${f.key}`);
    seen.add(f.key);
  }
  // Catalogue v2 and batch 6 are their own lazy sheets with the same schema, so rooms that only use v1 pieces don't download them.
  const shell = buildPanelShell();
  // OME-1977: v7 also takes single colours of older kinds (V7_COLOURS), so a sheet is picked per id and colour.
  const sheetOf = (id: string, colour: string): string =>
    CATALOGUE_V7.has(id) || V7_COLOURS.has(`${id}/${colour}`) ? "furniture-v7" : CATALOGUE_V6.has(id) ? "furniture-v6" : CATALOGUE_V5.has(id) ? "furniture-v5" : CATALOGUE_V4.has(id) ? "furniture-v4" : CATALOGUE_V2.has(id) ? "furniture-v2" : "furniture";
  for (const [name, maxW] of [["furniture", 1024], ["furniture-v2", 512], ["furniture-v4", 256], ["furniture-v5", 256], ["furniture-v6", 256], ["furniture-v7", 512]] as const) {
    const mine = pieces.map((p) => ({ ...p, colours: p.colours.filter((c) => sheetOf(p.id, c) === name) })).filter((p) => p.colours.length > 0);
    const sheetFrames = frames.filter((f) => { const [, id = "", colour = ""] = f.key.split("/"); return sheetOf(id, colour) === name; });
    writeFurnitureAtlas(name, name === "furniture-v7" ? [...sheetFrames, ...shell] : sheetFrames, mine, maxW, name !== "furniture" && name !== "furniture-v2");
  }
  const all = new Map<string, { img: Uint8Array; w: number; h: number; ax: number; ay: number }>();
  for (const f of [...roomFrames, ...frames, ...shell]) all.set(f.key, f);
  for (const [k, a] of avatars) all.set(k, { img: a, w: CELL.w, h: CELL.h, ax: FLOOR.x, ay: FLOOR.y });
  buildFurnitureSheet(pieces, all);
  buildFurnitureRoom(pieces, all, "furniture-room", showroom());
  buildFurnitureRoom(pieces, all, "furniture-layout", sampleLayout());
  buildFurnitureRoom(pieces, all, "furniture-v2-room", showroomV2());
  buildFurnitureRoom(pieces, all, "furniture-v3-room", showroomV3());
  buildFurnitureRoom(pieces, all, "furniture-door-room", showroomDoors());
  buildFurnitureRoom(pieces, all, "furniture-v4-room", showroomV4());
  buildSeatContact(pieces, all, V2_SEATS, "furniture-v2-seats@2x.png");
  buildSeatContact(pieces, all, V4_SEATS, "furniture-v4-seats@2x.png");
  buildFurnitureRoom(pieces, all, "theatre-room", theatreRoom());
  buildSeatContact(pieces, all, ["theatrerow"], "theatre-seats@2x.png");
  buildDungeon(pieces, all);
  buildLying(pieces, all);
  return { frames, pieces, all };
}

/** `furniture/<name>.png` + `.json` (PixiJS v8 atlas, `meta.omega.pieces`) and its `preview/<name>-atlas@2x.png`. */
function writeFurnitureAtlas(name: string, frames: readonly RoomFrame[], pieces: readonly PieceMeta[], maxW: number, dedupe = false): void {
  // With `dedupe`, identical frames (a loop's frame that equals the idle one, say) share one rect: same pixels, size and anchor.
  // shortcut: off for v1/v2, whose shipped packing it would reshuffle; turn it on there at their next repack.
  const firstOf = new Map<string, RoomFrame>();
  const alias = new Map<string, string>();
  for (const f of frames) {
    const sig = `${String(f.w)}x${String(f.h)}@${String(f.ax)},${String(f.ay)}:${Buffer.from(f.img).toString("base64")}`;
    const first = firstOf.get(sig);
    if (first && dedupe) alias.set(f.key, first.key);
    else firstOf.set(dedupe ? sig : f.key, f);
  }
  const { placed: packed, w: sheetW, h: sheetH } = pack([...firstOf.values()], maxW);
  const at = new Map(packed.map((p) => [p.key, p]));
  const placed = [...packed, ...[...alias].flatMap(([key, to]) => { const p = at.get(to); return p ? [{ ...p, key }] : []; })];
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
  const dir = join(ROOT, "furniture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.png`), encodeIndexedPng(sheetW, sheetH, sheet, PALETTE));
  // Pixi's own `animations`: one "in use" loop per piece, colour and dir (frame time in `meta.omega.pieces[].use.ms`).
  const animations: Record<string, string[]> = {};
  for (const p of pieces) {
    for (const colour of p.use ? p.colours : []) {
      for (const d of p.dirs) animations[`furniture/${p.id}/${colour}/use/${d}`] = Array.from({ length: p.use?.frames ?? 0 }, (_, n) => `furniture/${p.id}/${colour}/use/${d}/${String(n)}`);
    }
    for (const colour of p.walk ? p.colours : []) {
      for (const d of p.dirs) animations[`furniture/${p.id}/${colour}/walk/${d}`] = Array.from({ length: p.walk?.frames ?? 0 }, (_, n) => `furniture/${p.id}/${colour}/walk/${d}/${String(n)}`);
    }
  }
  const atlas = {
    frames: atlasFrames,
    ...(Object.keys(animations).length > 0 ? { animations } : {}),
    meta: {
      app: "omega-share assets/src/build.ts",
      version: "1",
      image: `${name}.png`,
      format: "RGBA8888",
      size: { w: sheetW, h: sheetH },
      scale: "1",
      omega: {
        license: "CC-BY-SA-4.0",
        tile: TILE,
        seatHeight: SEAT_HEIGHT,
        key: "furniture/<id>/<colour>/<dir>/<back|front>",
        ...(Object.keys(animations).length > 0 ? { useKey: "furniture/<id>/<colour>/use/<dir>/<n>" } : {}),
        ...(pieces.some((p) => p.open === true) ? { openKey: "furniture/<id>/<colour>/open/<dir>" } : {}),
        ...(pieces.some((p) => p.cut === true) ? { cutKey: "furniture/<id>/<colour>/cut/<dir>" } : {}),
        ...(pieces.some((p) => p.covers) ? { coverKey: "furniture/<id>/<colour>/cover/<dir>/<sleeper>" } : {}),
        // OME-1519: frame time in `pieces[].walk.ms`, the avatars' Basic walk clock (`avatars/motion.json` meta.omega.walk.frameMs).
        ...(pieces.some((p) => p.walk) ? { walkKey: "furniture/<id>/<colour>/walk/<dir>/<n>", sitKey: "furniture/<id>/<colour>/sit/<dir>", bedKey: "furniture/<id>/<colour>/bed/<dir>" } : {}),
        layers: { floor: 0, wall: 1, back: 2, avatar: 3, front: 4 },
        pieces,
      },
    },
  };
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(atlas, null, 1) + "\n");
  const bg = colorIndex("wall", 1);
  const big = upscale(sheet, sheetW, sheetH, 2).map((v) => (v === 0 ? bg : v));
  writeFileSync(join(ROOT, "preview", `${name}-atlas@2x.png`), encodeIndexedPng(sheetW * 2, sheetH * 2, big, PALETTE));
}

type FurnSprites = Map<string, { img: Uint8Array; w: number; h: number; ax: number; ay: number }>;
function drawSprite(img: Uint8Array, W: number, H: number, all: FurnSprites, key: string, x: number, y: number): void {
  const f = all.get(key);
  if (!f) throw new Error(`missing ${key}`);
  blitAt(img, W, H, f.img, f.w, f.h, x - f.ax, y - f.ay);
}

/** Every frame of the catalogue: one row per piece and colour, one column per dir, on floor tiles (wall pieces on a wall). */
function buildFurnitureSheet(pieces: readonly PieceMeta[], all: FurnSprites): void {
  const W = 1000;
  const rows: { meta: PieceMeta; colour: string }[] = [];
  for (const m of pieces) for (const c of m.colours) rows.push({ meta: m, colour: c });
  // Row height from what each row draws: the tallest frame above its anchor (or a wall), the deepest below.
  const rowsH: number[] = [];
  const tops: number[] = [];
  for (const r of rows) {
    let up = 16, down = 16;
    for (const d of r.meta.dirs) {
      for (const layer of r.meta.layersByDir[d] ?? []) {
        const f = all.get(`furniture/${r.meta.id}/${r.colour}/${d}/${layer}`);
        if (f) { up = Math.max(up, f.ay); down = Math.max(down, f.h - f.ay); }
      }
      const fp = r.meta.footprintByDir[d] ?? { cols: 1, rows: 1 };
      down = Math.max(down, (fp.cols + fp.rows - 1) * 16);
    }
    if (r.meta.mount === "wall") up = Math.max(up, 120);
    if (r.meta.seatsByDir) up = Math.max(up, 52);
    tops.push(up + 6);
    rowsH.push(up + down + 12);
  }
  const H = rowsH.reduce((a, b) => a + b, 0) + 20;
  const img = new Uint8Array(W * H).fill(colorIndex("night", 2));
  const who = ["juno", "pip", "mo", "kiki"];
  let y0 = 10, n = 0;
  rows.forEach((r, ri) => {
    const rh = rowsH[ri] ?? 100;
    const ay = y0 + (tops[ri] ?? 60);
    r.meta.dirs.forEach((d, di) => {
      const ax = 90 + di * 240;
      const fp = r.meta.footprintByDir[d] ?? { cols: 1, rows: 1 };
      if (r.meta.mount === "wall") {
        drawSprite(img, W, H, all, "floor/0", ax, ay);
        // Only the wall's lower part fits the row: draw it clipped to the row.
        const wall = all.get(d === "sw" ? "wall/r/plain" : "wall/l/plain");
        if (wall) blitClipped(img, W, H, wall, ax, ay, y0);
      } else {
        for (let c = 0; c < Math.max(fp.cols, 1); c++) for (let rr = 0; rr < Math.max(fp.rows, 1); rr++) drawSprite(img, W, H, all, `floor/${String((c + rr) % 2)}`, ax + (c - rr) * 32, ay + (c + rr) * 16);
      }
      const sitters = [who[n % 4] ?? "juno", who[(n + 1) % 4] ?? "pip"];
      n++;
      // Seats appear twice: empty, then occupied, so the cushion and the sitter's fit can both be checked.
      const items = placePiece(r.meta, r.colour, d, ax, ay, r.meta.seatsByDir ? sitters : []);
      items.sort((a, b) => a.sy - b.sy || a.sx - b.sx || a.layer - b.layer);
      for (const it of items) drawSprite(img, W, H, all, it.key, it.x, it.y);
    });
    y0 += rh;
  });
  writeFileSync(join(ROOT, "preview", "furniture-sheet@2x.png"), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), PALETTE));
}

function blitClipped(img: Uint8Array, W: number, H: number, f: { img: Uint8Array; w: number; h: number; ax: number; ay: number }, x: number, y: number, minY: number): void {
  for (let yy = 0; yy < f.h; yy++) {
    const py = y - f.ay + yy;
    if (py < minY || py >= H) continue;
    for (let xx = 0; xx < f.w; xx++) {
      const v = f.img[yy * f.w + xx] ?? 0;
      const px = x - f.ax + xx;
      if (v !== 0 && px >= 0 && px < W) img[py * W + px] = v;
    }
  }
}

interface Placement {
  id: string;
  colour: string;
  dir: FurnDir;
  col: number;
  row: number;
  sitters?: string[];
  /** Set (h): the piece is in the owner's hand, not placed yet. */
  ghost?: boolean;
  /** Draws "in use" frame n in place of `back` (a floor piece someone stands on: the teleport pad, OME-1546). */
  use?: number;
  /** OME-1424: draw the piece's open frame instead of `back`. */
  open?: boolean;
  /** OME-1959: draw the piece's cut-down stub instead of `back`. */
  cut?: boolean;
}
const cellAt = (c: number, r: number): { x: number; y: number } => ({ x: 480 + (c - r) * 32, y: 220 + (c + r + 1) * 16 });

/** Showroom: the current room (default floor, walls, console) holding at least one of every piece, both facings shown. */
function showroom(): { placements: Placement[]; standing: [string, number, number][] } {
  return {
    placements: [
      { id: "bookshelf", colour: "wood", dir: "sw", col: 2, row: 0 },
      { id: "bookshelf", colour: "wood", dir: "se", col: 0, row: 2 },
      { id: "frame", colour: "dusk", dir: "sw", col: 7, row: 0 },
      { id: "frame", colour: "tide", dir: "se", col: 0, row: 7 },
      { id: "rug", colour: "teal", dir: "nw", col: 8, row: 1 },
      { id: "rug", colour: "lilac", dir: "ne", col: 1, row: 8 },
      { id: "sofa", colour: "velvet", dir: "ne", col: 2, row: 5, sitters: ["juno", "kiki"] },
      { id: "couch", colour: "cream", dir: "nw", col: 5, row: 2, sitters: ["mo"] },
      { id: "wingback", colour: "ginger", dir: "ne", col: 4, row: 6, sitters: ["pip"] },
      { id: "beanbag", colour: "blush", dir: "nw", col: 6, row: 5, sitters: ["kiki"] },
      { id: "beanbag", colour: "navy", dir: "ne", col: 3, row: 7 },
      { id: "sidetable", colour: "wood", dir: "sw", col: 4, row: 5 },
      { id: "arclamp", colour: "brass", dir: "se", col: 1, row: 4 },
      { id: "arclamp", colour: "brass", dir: "sw", col: 4, row: 1 },
      { id: "monstera", colour: "rust", dir: "se", col: 0, row: 9 },
      { id: "monstera", colour: "teal", dir: "sw", col: 9, row: 0 },
      { id: "popcorn", colour: "rust", dir: "sw", col: 8, row: 5 },
      { id: "popcorn", colour: "rust", dir: "se", col: 5, row: 8 },
      { id: "sofa", colour: "navy", dir: "sw", col: 7, row: 7 },
      { id: "couch", colour: "olive", dir: "se", col: 9, row: 6 },
    ],
    standing: [["juno/idle/se/0", 6, 9]],
  };
}

/** Catalogue v2 (OME-1103): its seats get a contact sheet, its pieces a room of their own. */
const V2_SEATS: readonly string[] = ["floorcushion", "bench", "pouf"];
const V4_SEATS: readonly string[] = ["hammock", "stool"];

/** Theatre set v2 (OME-1639): the big screen between two curtains, two tiers of rows on carpet (front on the floor, back one
 *  riser up), aisle lights down the middle and a full house. */
function theatreRoom(): RoomPlan {
  const carpet = (col: number, row: number): Placement => ({ id: "carpet", colour: "navy", dir: "se", col, row });
  const light = (col: number, row: number, dir: FurnDir): Placement => ({ id: "aislelight", colour: "warm", dir, col, row });
  return {
    rug: false,
    tv: false,
    placements: [
      { id: "bigscreen", colour: "charcoal", dir: "se", col: 0, row: 0 },
      { id: "curtain", colour: "velvet", dir: "sw", col: 2, row: 0 },
      { id: "curtain", colour: "velvet", dir: "se", col: 0, row: 2 },
      carpet(1, 1), carpet(3, 1), carpet(5, 1), carpet(1, 3), carpet(3, 3), carpet(5, 3), carpet(1, 5), carpet(3, 5),
      light(5, 5, "nw"), light(6, 6, "nw"), light(7, 7, "nw"), light(8, 8, "nw"),
      { id: "theatrerow", colour: "floor", dir: "ne", col: 1, row: 4, sitters: ["juno", "pip"] },
      { id: "theatrerow", colour: "floor", dir: "nw", col: 4, row: 1, sitters: ["mo", "kiki"] },
      { id: "theatrerow", colour: "step", dir: "ne", col: 2, row: 5, sitters: ["kiki", "mo"] },
      { id: "theatrerow", colour: "step", dir: "nw", col: 5, row: 2, sitters: ["pip", "juno"] },
      { id: "popcorn", colour: "rust", dir: "se", col: 0, row: 8 },
      { id: "monstera", colour: "teal", dir: "sw", col: 9, row: 0 },
    ],
    standing: [["juno/idle/sw/0", 7, 8]],
  };
}

/** `furniture-v2-seats@2x.png`: one row per v2 seat piece × colour × avatar, one column per facing (ne nw se sw); a 2-seat piece holds
 *  the same avatar on both seats, so every avatar is checked on every seat in every facing. Empty seats lead each piece's block. */
function buildSeatContact(pieces: readonly PieceMeta[], all: FurnSprites, ids: readonly string[], name: string): void {
  const who = ["", "juno", "pip", "mo", "kiki"];
  const rows: { meta: PieceMeta; colour: string; sitter: string }[] = [];
  for (const id of ids) {
    const meta = pieces.find((p) => p.id === id);
    if (!meta) throw new Error(`no piece ${id}`);
    for (const colour of meta.colours) for (const sitter of who) if (sitter !== "" || colour === meta.colours[0]) rows.push({ meta, colour, sitter });
  }
  const CW = 150, RH = 92, W = CW * 4 + 40, H = rows.length * RH + 20;
  const img = new Uint8Array(W * H).fill(colorIndex("night", 2));
  rows.forEach((r, ri) => {
    const ay = 10 + ri * RH + 66;
    (["ne", "nw", "se", "sw"] as const).forEach((d, di) => {
      if (!r.meta.dirs.includes(d)) return;
      const ax = 50 + r.meta.dirs.filter((x) => (["ne", "nw", "se", "sw"] as const).indexOf(x) < di).length * CW;
      const fp = r.meta.footprintByDir[d] ?? { cols: 1, rows: 1 };
      for (let c = 0; c < fp.cols; c++) for (let rr = 0; rr < fp.rows; rr++) drawSprite(img, W, H, all, `floor/${String((c + rr) % 2)}`, ax + (c - rr) * 32, ay + (c + rr) * 16);
      const seats = r.meta.seatsByDir?.[d] ?? [];
      const items = placePiece(r.meta, r.colour, d, ax, ay, r.sitter === "" ? [] : seats.map(() => r.sitter));
      items.sort((a, b) => a.sy - b.sy || a.sx - b.sx || a.layer - b.layer);
      for (const it of items) drawSprite(img, W, H, all, it.key, it.x, it.y);
    });
  });
  writeFileSync(join(ROOT, "preview", name), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), PALETTE));
}

/** The v2 pieces in the current room, with a few v1 pieces for scale: a listening corner, a reading nook and a lit wall. */
function showroomV2(): { placements: Placement[]; standing: [string, number, number][] } {
  return {
    placements: [
      { id: "garland", colour: "warm", dir: "sw", col: 1, row: 0 },
      { id: "garland", colour: "warm", dir: "sw", col: 2, row: 0 },
      { id: "garland", colour: "warm", dir: "sw", col: 3, row: 0 },
      { id: "garland", colour: "party", dir: "se", col: 0, row: 1 },
      { id: "garland", colour: "party", dir: "se", col: 0, row: 2 },
      { id: "garland", colour: "party", dir: "se", col: 0, row: 3 },
      { id: "wallshelf", colour: "wood", dir: "sw", col: 7, row: 0 },
      { id: "wallshelf", colour: "wood", dir: "se", col: 0, row: 7 },
      { id: "frame", colour: "dusk", dir: "sw", col: 4, row: 0 },
      { id: "turntable", colour: "wood", dir: "sw", col: 7, row: 0 },
      { id: "speaker", colour: "wood", dir: "sw", col: 6, row: 0 },
      { id: "speaker", colour: "teal", dir: "sw", col: 8, row: 0 },
      { id: "turntable", colour: "wood", dir: "se", col: 0, row: 7 },
      { id: "cat", colour: "ginger", dir: "se", col: 0, row: 8 },
      { id: "rug", colour: "teal", dir: "nw", col: 8, row: 3 },
      { id: "bench", colour: "teal", dir: "ne", col: 2, row: 5, sitters: ["juno", "kiki"] },
      { id: "bench", colour: "pink", dir: "nw", col: 5, row: 2, sitters: ["", "mo"] },
      { id: "floorcushion", colour: "mustard", dir: "ne", col: 4, row: 6, sitters: ["pip"] },
      { id: "floorcushion", colour: "teal", dir: "nw", col: 6, row: 4 },
      { id: "floorcushion", colour: "mustard", dir: "sw", col: 8, row: 6, sitters: ["kiki"] },
      { id: "floorcushion", colour: "teal", dir: "se", col: 5, row: 8, sitters: ["juno"] },
      { id: "cat", colour: "charcoal", dir: "sw", col: 9, row: 5 },
      { id: "sidetable", colour: "wood", dir: "sw", col: 4, row: 4 },
      { id: "monstera", colour: "teal", dir: "sw", col: 9, row: 0 },
    ],
    standing: [["mo/idle/se/0", 6, 8]],
  };
}

/** Catalogue v3 (OME-1348): the six new pieces in both facings, poufs taken and free, around a coffee table. */
function showroomV3(): { placements: Placement[]; standing: [string, number, number][] } {
  return {
    placements: [
      { id: "neonsign", colour: "pink", dir: "sw", col: 2, row: 0 },
      { id: "neonsign", colour: "teal", dir: "se", col: 0, row: 2 },
      { id: "wallclock", colour: "brass", dir: "sw", col: 4, row: 0 },
      { id: "wallclock", colour: "brass", dir: "se", col: 0, row: 4 },
      { id: "garland", colour: "warm", dir: "sw", col: 7, row: 0 },
      { id: "arcade", colour: "night", dir: "sw", col: 6, row: 0 },
      { id: "arcade", colour: "night", dir: "se", col: 0, row: 7 },
      { id: "aquarium", colour: "teal", dir: "sw", col: 9, row: 0 },
      { id: "aquarium", colour: "teal", dir: "se", col: 0, row: 9 },
      { id: "coffeetable", colour: "wood", dir: "sw", col: 4, row: 4 },
      { id: "coffeetable", colour: "wood", dir: "se", col: 7, row: 7 },
      { id: "pouf", colour: "rust", dir: "ne", col: 4, row: 5, sitters: ["pip"] },
      { id: "pouf", colour: "lilac", dir: "nw", col: 5, row: 4, sitters: ["kiki"] },
      { id: "pouf", colour: "lilac", dir: "sw", col: 4, row: 3, sitters: ["mo"] },
      { id: "pouf", colour: "rust", dir: "se", col: 3, row: 4, sitters: ["juno"] },
      { id: "pouf", colour: "rust", dir: "sw", col: 7, row: 6 },
      { id: "pouf", colour: "lilac", dir: "se", col: 6, row: 7 },
    ],
    standing: [["mo/idle/se/0", 8, 4]],
  };
}

/** OME-1424: both doors on both walls beside the bookcase, one closed and one open per wall, someone walking through each. */
function showroomDoors(): { placements: Placement[]; standing: [string, number, number][] } {
  return {
    placements: [
      { id: "bookshelf", colour: "wood", dir: "sw", col: 2, row: 0 },
      { id: "door", colour: "wood", dir: "sw", col: 4, row: 0 },
      { id: "door", colour: "painted", dir: "sw", col: 6, row: 0, open: true },
      { id: "frame", colour: "dusk", dir: "sw", col: 8, row: 0 },
      { id: "bookshelf", colour: "wood", dir: "se", col: 0, row: 2 },
      { id: "door", colour: "painted", dir: "se", col: 0, row: 4 },
      { id: "door", colour: "wood", dir: "se", col: 0, row: 6, open: true },
      { id: "monstera", colour: "teal", dir: "se", col: 0, row: 8 },
    ],
    standing: [["kiki/idle/se/0", 6, 1], ["pip/idle/sw/0", 1, 6], ["mo/idle/se/0", 4, 3], ["juno/idle/sw/0", 3, 5]],
  };
}

/** OME-1437: batch 6 in both facings: a bar with stools along one wall, the fireplace and piano on the other, hammocks taken and free. */
function showroomV4(): { placements: Placement[]; standing: [string, number, number][] } {
  return {
    placements: [
      { id: "barcounter", colour: "wood", dir: "sw", col: 1, row: 0 },
      { id: "fireplace", colour: "stone", dir: "sw", col: 4, row: 0 },
      { id: "piano", colour: "wood", dir: "sw", col: 6, row: 0 },
      { id: "stool", colour: "teal", dir: "ne", col: 1, row: 2, sitters: ["kiki"] },
      { id: "stool", colour: "wood", dir: "ne", col: 2, row: 2 },
      { id: "piano", colour: "charcoal", dir: "se", col: 0, row: 3 },
      { id: "fireplace", colour: "stone", dir: "se", col: 0, row: 6 },
      { id: "barcounter", colour: "wood", dir: "se", col: 0, row: 8 },
      { id: "stool", colour: "wood", dir: "sw", col: 5, row: 4, sitters: ["juno"] },
      { id: "stool", colour: "teal", dir: "se", col: 8, row: 3 },
      { id: "hammock", colour: "rust", dir: "sw", col: 3, row: 6, sitters: ["pip", ""] },
      { id: "hammock", colour: "rust", dir: "nw", col: 7, row: 5, sitters: ["", "mo"] },
      { id: "hammock", colour: "rust", dir: "se", col: 6, row: 8 },
      // Teleport pads (OME-1546): mo stands on a lit one; the others wait, one lilac pad lit with nobody on it for comparison.
      { id: "pad", colour: "teal", dir: "se", col: 7, row: 2, use: 0 },
      { id: "pad", colour: "teal", dir: "se", col: 3, row: 2 },
      { id: "pad", colour: "lilac", dir: "se", col: 3, row: 4 },
      { id: "pad", colour: "lilac", dir: "se", col: 8, row: 7, use: 0 },
    ],
    standing: [["mo/idle/sw/0", 7, 2]],
  };
}

/** A sample room: two sofas angled at the screen, snacks between them, beanbags up front, and a reading corner. */
function sampleLayout(): { placements: Placement[]; standing: [string, number, number][] } {
  return {
    placements: [
      { id: "bookshelf", colour: "wood", dir: "se", col: 0, row: 3 },
      { id: "frame", colour: "tide", dir: "se", col: 0, row: 7 },
      { id: "frame", colour: "dusk", dir: "sw", col: 3, row: 0 },
      { id: "frame", colour: "tide", dir: "sw", col: 4, row: 0 },
      { id: "monstera", colour: "teal", dir: "sw", col: 9, row: 0 },
      { id: "rug", colour: "lilac", dir: "ne", col: 0, row: 8 },
      { id: "sofa", colour: "velvet", dir: "ne", col: 2, row: 5, sitters: ["kiki", "juno"] },
      { id: "sofa", colour: "velvet", dir: "nw", col: 5, row: 2, sitters: ["pip"] },
      { id: "sidetable", colour: "wood", dir: "sw", col: 4, row: 4 },
      { id: "beanbag", colour: "blush", dir: "nw", col: 6, row: 5 },
      { id: "beanbag", colour: "navy", dir: "ne", col: 5, row: 6 },
      { id: "wingback", colour: "ginger", dir: "se", col: 1, row: 8, sitters: ["mo"] },
      { id: "arclamp", colour: "brass", dir: "se", col: 0, row: 8 },
      { id: "popcorn", colour: "rust", dir: "sw", col: 8, row: 3 },
      { id: "couch", colour: "olive", dir: "sw", col: 7, row: 8 },
      { id: "monstera", colour: "rust", dir: "se", col: 9, row: 7 },
    ],
    standing: [],
  };
}

type Draw = (key: string, x: number, y: number) => void;
interface RoomHooks {
  /** After the floor layer (rugs), before walls and objects: edit grid, footprint markers. */
  floor?: (draw: Draw) => void;
  /** After walls and the console, before wall-layer pieces: wall-slot markers. */
  wall?: (draw: Draw) => void;
  /** After every object: handles and anything floating above the room. */
  top?: (draw: Draw) => void;
}

interface RoomPlan {
  placements: Placement[];
  /** Sprites sorted at a cell (standing avatars; set (n): room-atlas armchairs with their sitter, lamp, plant), in this order on a tie. */
  standing: [string, number, number][];
  /** Set (n): false draws bare planks where the default room has its big rug. */
  rug?: boolean;
  /** False leaves the corner console out (a layout with the big screen instead, OME-1639). */
  tv?: boolean;
  /** A skinned shell (OME-1977, the v7 panelling): frame keys per floor cell and wall segment instead of the default room's. */
  shell?: { floor: (c: number, r: number) => string; l: (i: number) => string; r: (i: number) => string; corner: string; lEnd: string; rEnd: string };
}

function buildFurnitureRoom(pieces: readonly PieceMeta[], all: FurnSprites, name: string, plan: RoomPlan, hooks: RoomHooks = {}): void {
  const { img, W, H } = composeFurnitureRoom(pieces, all, plan, hooks);
  writeFileSync(join(ROOT, "preview", `${name}@1x.png`), encodeIndexedPng(W, H, img, PALETTE));
  writeFileSync(join(ROOT, "preview", `${name}@2x.png`), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), PALETTE));
}

function composeFurnitureRoom(pieces: readonly PieceMeta[], all: FurnSprites, plan: RoomPlan, hooks: RoomHooks = {}): { img: Uint8Array; W: number; H: number } {
  const W = 960, H = 600;
  const img = new Uint8Array(W * H).fill(colorIndex("night", 2));
  const layout = defaultLayout();
  const draw = (key: string, x: number, y: number): void => { drawSprite(img, W, H, all, key, x, y); };
  // A held piece (set h) is a ghost: every other pixel on a checkerboard, so its footprint marker reads through (Pixi: alpha).
  const ghost = (key: string, x: number, y: number): void => {
    const f = all.get(key);
    if (!f) throw new Error(`missing ${key}`);
    const ox = x - f.ax, oy = y - f.ay;
    for (let yy = 0; yy < f.h; yy++) for (let xx = 0; xx < f.w; xx++) {
      const v = f.img[yy * f.w + xx] ?? 0, px = ox + xx, py = oy + yy;
      if (v !== 0 && (px + py) % 2 === 0 && px >= 0 && py >= 0 && px < W && py < H) img[py * W + px] = v;
    }
  };
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const meta = (id: string): PieceMeta => {
    const m = byId.get(id);
    if (!m) throw new Error(`no piece ${id}`);
    return m;
  };
  const drawLayer = (layer: "floor" | "wall"): void => {
    for (const p of plan.placements.filter((q) => meta(q.id).layer === layer)) {
      const a = cellAt(p.col, p.row);
      const key = p.use === undefined ? `furniture/${p.id}/${p.colour}/${p.dir}/back` : `furniture/${p.id}/${p.colour}/use/${p.dir}/${String(p.use)}`;
      (p.ghost === true ? ghost : draw)(key, a.x, a.y);
    }
  };
  const floorKey = (key: string, c: number, r: number): string => (plan.rug === false && key.startsWith("rug/") ? `floor/${String((c * 3 + r) % 2)}` : key);
  const sh = plan.shell;
  layout.floor.forEach((row, r) => { row.forEach((key, c) => { draw(sh ? sh.floor(c, r) : floorKey(key, c, r), cellAt(c, r).x, cellAt(c, r).y); }); });
  // Edit mode lays the grid and markers on the floor (over rugs) before the walls and console stand on it.
  if (hooks.floor) { drawLayer("floor"); hooks.floor(draw); }
  for (let i = 0; i < 10; i++) {
    draw(sh ? sh.l(i) : layout.walls.l[i] ?? "wall/l/plain", cellAt(0, i).x, cellAt(0, i).y);
    draw(sh ? sh.r(i) : layout.walls.r[i] ?? "wall/r/plain", cellAt(i, 0).x, cellAt(i, 0).y);
  }
  draw(sh?.corner ?? "wall/corner", cellAt(0, 0).x, cellAt(0, 0).y);
  draw(sh?.lEnd ?? "wall/l/end", cellAt(0, 9).x, cellAt(0, 9).y);
  draw(sh?.rEnd ?? "wall/r/end", cellAt(9, 0).x, cellAt(9, 0).y);
  if (plan.tv !== false) draw("tv/0", cellAt(0, 0).x, cellAt(0, 0).y);
  // Floor layer (rugs) and wall layer (frames) go with the static background; everything else is depth-sorted.
  if (!hooks.floor) drawLayer("floor");
  hooks.wall?.(draw);
  drawLayer("wall");
  const items: (FurnItem & { ghost?: boolean })[] = [];
  for (const p of plan.placements.filter((q) => meta(q.id).layer === "object")) {
    const a = cellAt(p.col, p.row);
    const open = p.open === true ? `furniture/${p.id}/${p.colour}/open/${p.dir}` : p.cut === true ? `furniture/${p.id}/${p.colour}/cut/${p.dir}` : p.use !== undefined ? `furniture/${p.id}/${p.colour}/use/${p.dir}/${String(p.use)}` : undefined;
    items.push(...placePiece(meta(p.id), p.colour, p.dir, a.x, a.y, p.sitters ?? []).map((it) => ({ ...it, key: open !== undefined && it.layer === 2 ? open : it.key, ghost: p.ghost === true })));
  }
  for (const [key, c, r] of plan.standing) {
    const a = cellAt(c, r);
    items.push({ key, x: a.x, y: a.y, sx: a.x, sy: a.y, layer: 3 });
  }
  items.sort((a, b) => a.sy - b.sy || a.sx - b.sx || a.layer - b.layer);
  for (const it of items) (it.ghost === true ? ghost : draw)(it.key, it.x, it.y);
  hooks.top?.(draw);
  return { img, W, H };
}

// ---------------------------------------------------------------- Dank Dungeon (OME-1670, lazy)

const DUNGEON_FILES = ["furniture/furniture-v6.png", "furniture/furniture-v6.json", "furniture/furniture-v7.png", "furniture/furniture-v7.json", "avatars/dungeon.png", "avatars/dungeon.json"];
const V6_SEATS: readonly string[] = ["bed", "whirlpool"];

/** The night mood (OME-1502, `apps/web/src/room.css`): rgb(36 48 110 / 0.5) multiplied over the room. Per colour, so a palette. */
const NIGHT_PALETTE: RGBA[] = PALETTE.map((c) => {
  const m = (v: number, t: number): number => Math.round(v * (0.5 + (0.5 * t) / 255));
  return { r: m(c.r, 36), g: m(c.g, 48), b: m(c.b, 110), a: c.a };
});

/** `avatars/dungeon.png` + `.json` (the bend-over / thrust emote, lazy), the v6 showroom and seat contact sheet, and the preset
 *  preview with a pair mid-emote, plain and under the night mood. */
function buildDungeon(pieces: readonly PieceMeta[], all0: FurnSprites): void {
  const { w: CW, h: CH } = DUNGEON_CELL;
  const sheetW = pow2(4 * CW), sheetH = pow2(AVATARS.length * DUNGEON_DIRS.length * CH);
  const sheet = new Uint8Array(sheetW * sheetH);
  const frames: Record<string, Frame> = {};
  const anims: Record<string, Anim> = {};
  const all: FurnSprites = new Map(all0);
  AVATARS.forEach((a, i) => {
    DUNGEON_DIRS.forEach((dir, j) => {
      const y = (i * DUNGEON_DIRS.length + j) * CH;
      const cells: [string, Grid, { x: number; y: number }][] = [
        [`bendover/${a.id}/${dir}/0`, bendGrid(a, dir), BEND_FLOOR],
        ...Array.from({ length: THRUST_FRAMES }, (_, n): [string, Grid, { x: number; y: number }] => [`thrust/${a.id}/${dir}/${String(n)}`, thrustGrid(a, dir, n), THRUST_FLOOR]),
      ];
      cells.forEach(([key, grid, fp], c) => {
        const img = render(grid, a.roles);
        assertInside(key, img, CW, CH);
        blit(sheet, sheetW, img, CW, CH, c * CW, y);
        const ax = dir === "sw" ? CW - 1 - fp.x : fp.x;
        frames[key] = {
          frame: { x: c * CW, y, w: CW, h: CH },
          rotated: false,
          trimmed: false,
          spriteSourceSize: { x: 0, y: 0, w: CW, h: CH },
          sourceSize: { w: CW, h: CH },
          anchor: { x: ax / CW, y: fp.y / CH },
        };
        all.set(key, { img, w: CW, h: CH, ax, ay: fp.y });
      });
      const keys = Array.from({ length: THRUST_FRAMES }, (_, n) => `thrust/${a.id}/${dir}/${String(n)}`);
      anims[`thrust/${a.id}/${dir}`] = { frames: THRUST_SEQUENCE.map((n) => keys[n] ?? ""), ms: THRUST_SEQUENCE.map(() => THRUST_MS), loop: true };
    });
  });
  registerKeys("dungeon", Object.keys(frames));
  writeFileSync(join(ROOT, "avatars", "dungeon.png"), encodeIndexedPng(sheetW, sheetH, sheet, PALETTE));
  const animations: Record<string, string[]> = {};
  for (const [k, an] of Object.entries(anims)) animations[k] = an.frames;
  const atlas = {
    frames,
    animations,
    meta: {
      app: "omega-share assets/src/build.ts",
      version: "1",
      image: "dungeon.png",
      format: "RGBA8888",
      size: { w: sheetW, h: sheetH },
      scale: "1",
      omega: {
        license: "CC-BY-SA-4.0",
        tile: TILE,
        cell: DUNGEON_CELL,
        dirs: DUNGEON_DIRS,
        bendover: { floorPoint: BEND_FLOOR, anchor: "the bender's floor point" },
        thrust: { floorPoint: THRUST_FLOOR, anchor: "the partner's floor point", feetOffset: THRUST_OFFSET, frames: THRUST_FRAMES, sequence: THRUST_SEQUENCE, ms: THRUST_MS, draw: "just behind the partner" },
        anims,
      },
    },
  };
  writeFileSync(join(ROOT, "avatars", "dungeon.json"), JSON.stringify(atlas, null, 1) + "\n");

  // Strip: per avatar and dir, the plain idle then bend over and thrust 0–2; then each pair mid-emote (thrust 0 and 2).
  const strips = new Map<string, { img: Uint8Array; w: number; h: number }>();
  for (const [k, s] of all) if (s.w === CW || s.w === CELL.w) strips.set(k, { img: s.img, w: s.w, h: s.h });
  const pairKey = (b: string, t: string, dir: Dir, n: number): string => {
    const key = `pair/${b}/${t}/${dir}/${String(n)}`;
    const out = new Uint8Array(CW * CH);
    const T = all.get(`thrust/${t}/${dir}/${String(n)}`), B = all.get(`bendover/${b}/${dir}/0`);
    if (!T || !B) throw new Error(`missing pair ${key}`);
    const dx = B.ax - T.ax;
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) { const v = T.img[y * CW + x] ?? 0; if (v && x + dx >= 0 && x + dx < CW) out[y * CW + x + dx] = v; }
    for (let i = 0; i < out.length; i++) if (B.img[i]) out[i] = B.img[i] ?? 0;
    strips.set(key, { img: out, w: CW, h: CH });
    return key;
  };
  const rows = AVATARS.map((a, i) => {
    const t = AVATARS[(i + 1) % AVATARS.length]?.id ?? a.id;
    return DUNGEON_DIRS.flatMap((d) => [`${a.id}/idle/${d}/0`, `bendover/${a.id}/${d}/0`, ...[0, 1, 2].map((n) => `thrust/${a.id}/${d}/${String(n)}`), pairKey(a.id, t, d, 0), pairKey(a.id, t, d, 2)]);
  });
  strip("dungeon-poses@4x.png", 14, rows, strips, CW, CH, false);

  buildFurnitureRoom(pieces, all, "furniture-v6-room", showroomV6());
  buildSeatContact(pieces, all, V6_SEATS, "furniture-v6-seats@2x.png");
  buildFurnitureRoom(pieces, all, "furniture-v7-room", showroomV7());
  buildSeatContact(pieces, all, ["soaktub", "lounger"], "furniture-v7-seats@2x.png");
  // The preset with a full house: every seat taken, plus juno bent over at (5,6) with mo behind her.
  const sit = new Map<string, string[]>([["bed:4,0", ["kiki", "pip"]], ["bed:0,3", ["mo", "juno"]], ["wingback:7,2", ["pip"]], ["wingback:7,4", ["kiki"]], ["whirlpool:2,7", ["juno", "mo"]]]);
  const placements: Placement[] = (PRESETS.find((x) => x.id === "dank-dungeon")?.layout.furniture ?? []).filter((f) => f.kind !== "tv").map((f) => {
    const kind: string = f.kind === "runner" ? "rug" : f.kind;
    const meta = pieces.find((p) => p.id === kind);
    if (!meta) throw new Error(`no piece ${kind}`);
    const colour = meta.colours[f.variant ?? 0] ?? meta.colours[0] ?? "";
    const p: Placement = { id: kind, colour, dir: f.facing, col: f.col, row: f.row };
    const who = sit.get(`${f.kind}:${String(f.col)},${String(f.row)}`);
    if (who) p.sitters = who;
    if (f.kind === "whirlpool") p.use = 0;
    return p;
  });
  const plan: RoomPlan = { placements, standing: [["thrust/mo/se/2", 5, 6], ["bendover/juno/se/0", 5, 6]], rug: false };
  const { img, W, H } = composeFurnitureRoom(pieces, all, plan);
  for (const [name, pal] of [["dungeon-room", PALETTE], ["dungeon-room-night", NIGHT_PALETTE]] as const) {
    writeFileSync(join(ROOT, "preview", `${name}@1x.png`), encodeIndexedPng(W, H, img, pal));
    writeFileSync(join(ROOT, "preview", `${name}@2x.png`), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), pal));
  }
  // OME-1977: the reworked room with every v7 piece, as everyone sees it and as a viewer in the bedroom sees it (cut).
  for (const cut of [false, true]) {
    const two = composeFurnitureRoom(pieces, all, dungeon2Plan(cut));
    for (const [name, pal] of [["dungeon2-room", PALETTE], ["dungeon2-room-night", NIGHT_PALETTE]] as const) {
      const file = `${name}${cut ? "-cut" : ""}`;
      writeFileSync(join(ROOT, "preview", `${file}@1x.png`), encodeIndexedPng(two.W, two.H, two.img, pal));
      writeFileSync(join(ROOT, "preview", `${file}@2x.png`), encodeIndexedPng(two.W * 2, two.H * 2, upscale(two.img, two.W, two.H, 2), pal));
    }
  }
  // OME-1959: the two-compartment grid for the reworked preset, as everyone sees it and as a viewer in the bedroom sees it (cut).
  for (const cut of [false, true]) {
    const two = composeFurnitureRoom(pieces, all, partitionPlan(cut));
    for (const [name, pal] of [["partition-room", PALETTE], ["partition-room-night", NIGHT_PALETTE]] as const) {
      const file = `${name}${cut ? "-cut" : ""}`;
      writeFileSync(join(ROOT, "preview", `${file}@1x.png`), encodeIndexedPng(two.W, two.H, two.img, pal));
      writeFileSync(join(ROOT, "preview", `${file}@2x.png`), encodeIndexedPng(two.W * 2, two.H * 2, upscale(two.img, two.W, two.H, 2), pal));
    }
  }
}

/** Partition row of the reworked Dank Dungeon (OME-1959): row 4, solid except glass at cols 5–8 and the doorway gap at col 1. */
export const PARTITION_ROW = 4;
export const PARTITION_GLASS: readonly number[] = [5, 6, 7, 8];
export const PARTITION_DOOR = 1;

/** The grid for OME-1960: bedroom behind the wall (rows 0–3, the beds line up with the glass), spa in front (rows 5–9). */
function partitionPlan(cut: boolean): RoomPlan {
  const wall: Placement[] = Array.from({ length: 10 }, (_, c) => c)
    .filter((c) => c !== PARTITION_DOOR)
    .map((c) => ({ id: "partition", colour: PARTITION_GLASS.includes(c) ? "glass" : "solid", dir: "sw", col: c, row: PARTITION_ROW, cut }));
  return {
    placements: [
      { id: "bed", colour: "velvet", dir: "nw", col: 2, row: 0, sitters: ["kiki", ""] },
      { id: "bed", colour: "velvet", dir: "nw", col: 4, row: 0, sitters: ["", "mo"] },
      { id: "neonsign", colour: "pink", dir: "se", col: 0, row: 2 },
      { id: "desk", colour: "wood", dir: "sw", col: 7, row: 0 },
      { id: "minibar", colour: "wood", dir: "sw", col: 9, row: 0 },
      { id: "wingback", colour: "ginger", dir: "nw", col: 8, row: 2 },
      ...wall,
      { id: "whirlpool", colour: "teal", dir: "ne", col: 2, row: 7, sitters: ["juno", ""], use: 0 },
      { id: "washbasin", colour: "cream", dir: "se", col: 0, row: 6 },
      { id: "mirror", colour: "brass", dir: "se", col: 0, row: 6 },
      { id: "arclamp", colour: "brass", dir: "se", col: 1, row: 9 },
      { id: "wingback", colour: "ginger", dir: "nw", col: 7, row: 7 },
      { id: "coffeetable", colour: "wood", dir: "sw", col: 7, row: 6 },
      { id: "monstera", colour: "teal", dir: "sw", col: 9, row: 9 },
    ],
    standing: [["pip/idle/se/0", 6, 2]],
    rug: false,
  };
}

/** The reworked Dank Dungeon (OME-1977) on the OME-1959 grid, every piece from v7: panelled shell (oak bedroom behind, smoked spa
 *  in front), the panelled interior wall with its glass and doorway, the flat TV, the bar fridge, the oval rug by the doorway; the
 *  sauna, the cedar tub, the whirlpool, two loungers and the basins under two tall mirrors in the spa. */
function dungeon2Plan(cut: boolean): RoomPlan {
  const wall: Placement[] = Array.from({ length: 10 }, (_, c) => c)
    .filter((c) => c !== PARTITION_DOOR)
    .map((c) => ({ id: "partition", colour: PARTITION_GLASS.includes(c) ? "panelglass" : "panel", dir: "sw", col: c, row: PARTITION_ROW, cut }));
  const side = (r: number): string => (r < PARTITION_ROW ? "oak" : r === PARTITION_ROW ? "split" : "smoke");
  return {
    placements: [
      { id: "tv", colour: "flat", dir: "se", col: 0, row: 0 },
      { id: "bed", colour: "velvet", dir: "nw", col: 2, row: 0, sitters: ["kiki", ""] },
      { id: "bed", colour: "velvet", dir: "nw", col: 4, row: 0 },
      { id: "desk", colour: "wood", dir: "sw", col: 7, row: 0 },
      { id: "minibar", colour: "fridge", dir: "sw", col: 9, row: 0 },
      { id: "wingback", colour: "ginger", dir: "nw", col: 8, row: 2 },
      { id: "neonsign", colour: "pink", dir: "se", col: 0, row: 1 },
      { id: "carpet", colour: "oval", dir: "se", col: 0, row: 2 },
      ...wall,
      { id: "washbasin", colour: "cream", dir: "se", col: 0, row: 5 },
      { id: "mirror", colour: "silver", dir: "se", col: 0, row: 5 },
      { id: "washbasin", colour: "cream", dir: "se", col: 0, row: 6 },
      { id: "mirror", colour: "silver", dir: "se", col: 0, row: 6 },
      { id: "sauna", colour: "cedar", dir: "se", col: 0, row: 8 },
      { id: "soaktub", colour: "cedar", dir: "se", col: 3, row: 6, sitters: ["juno", ""] },
      { id: "whirlpool", colour: "teal", dir: "ne", col: 6, row: 8, use: 0 },
      { id: "lounger", colour: "teak", dir: "nw", col: 8, row: 5, sitters: ["", "mo"] },
      { id: "lounger", colour: "teak", dir: "nw", col: 9, row: 5 },
      { id: "monstera", colour: "teal", dir: "sw", col: 9, row: 9 },
    ],
    standing: [["pip/idle/se/0", 5, 2]],
    rug: false,
    tv: false,
    shell: {
      floor: (c, r) => `floor/${r < PARTITION_ROW ? "carpet" : r === PARTITION_ROW ? "split" : "deck"}/${String((c * 3 + r) % 2)}`,
      l: (i) => `wall/l/${side(i)}`,
      r: () => "wall/r/oak",
      corner: "wall/corner/oak",
      lEnd: "wall/l/end/smoke",
      rEnd: "wall/r/end/oak",
    },
  };
}

/** Every v7 piece and colour in each facing it ships (the lounger in all four), seats taken and free, on the spa skin. */
function showroomV7(): RoomPlan {
  return {
    placements: [
      { id: "sauna", colour: "cedar", dir: "se", col: 0, row: 1 },
      { id: "sauna", colour: "cedar", dir: "sw", col: 6, row: 0 },
      { id: "mirror", colour: "silver", dir: "sw", col: 3, row: 0 },
      { id: "mirror", colour: "silver", dir: "se", col: 0, row: 4 },
      { id: "minibar", colour: "fridge", dir: "sw", col: 4, row: 0 },
      { id: "minibar", colour: "fridge", dir: "se", col: 0, row: 5 },
      { id: "soaktub", colour: "cedar", dir: "se", col: 3, row: 3, sitters: ["kiki", "pip"] },
      { id: "lounger", colour: "teak", dir: "ne", col: 2, row: 7, sitters: ["juno", ""] },
      { id: "lounger", colour: "teak", dir: "nw", col: 7, row: 3 },
      { id: "lounger", colour: "teak", dir: "se", col: 9, row: 3, sitters: ["", "mo"] },
      { id: "lounger", colour: "teak", dir: "sw", col: 6, row: 8 },
      { id: "carpet", colour: "oval", dir: "se", col: 6, row: 5 },
      { id: "tv", colour: "flat", dir: "se", col: 0, row: 0 },
      { id: "partition", colour: "panel", dir: "se", col: 1, row: 7 },
      { id: "partition", colour: "panelglass", dir: "se", col: 1, row: 8 },
      { id: "partition", colour: "panel", dir: "se", col: 1, row: 9, cut: true },
    ],
    standing: [],
    rug: false,
    tv: false,
    shell: { floor: (c, r) => `floor/${r < 3 ? "carpet" : "deck"}/${String((c * 3 + r) % 2)}`, l: () => "wall/l/smoke", r: () => "wall/r/oak", corner: "wall/corner/oak", lEnd: "wall/l/end/smoke", rEnd: "wall/r/end/oak" },
  };
}

/** Every v6 piece in both facings (seats in all four), a few taken. */
function showroomV6(): RoomPlan {
  return {
    placements: [
      { id: "bed", colour: "velvet", dir: "nw", col: 4, row: 0, sitters: ["kiki", ""] },
      { id: "bed", colour: "velvet", dir: "ne", col: 0, row: 3, sitters: ["", "mo"] },
      { id: "bed", colour: "velvet", dir: "se", col: 8, row: 6 },
      { id: "bed", colour: "velvet", dir: "sw", col: 5, row: 8, sitters: ["juno", "pip"] },
      { id: "whirlpool", colour: "teal", dir: "ne", col: 2, row: 7, sitters: ["pip", "kiki"], use: 1 },
      { id: "whirlpool", colour: "teal", dir: "nw", col: 7, row: 2, sitters: ["juno"] },
      { id: "desk", colour: "wood", dir: "sw", col: 3, row: 0 },
      { id: "desk", colour: "wood", dir: "se", col: 0, row: 5 },
      { id: "minibar", colour: "wood", dir: "sw", col: 7, row: 0 },
      { id: "minibar", colour: "wood", dir: "se", col: 4, row: 5 },
      { id: "washbasin", colour: "cream", dir: "se", col: 0, row: 7 },
      { id: "washbasin", colour: "cream", dir: "sw", col: 9, row: 0 },
      { id: "mirror", colour: "brass", dir: "se", col: 0, row: 7 },
      { id: "mirror", colour: "brass", dir: "sw", col: 9, row: 0 },
      { id: "mirror", colour: "brass", dir: "sw", col: 2, row: 0 },
    ],
    standing: [],
    rug: false,
  };
}

// ---------------------------------------------------------------- lying pose (OME-1687, lazy)

const LYING_FILES = ["avatars/lying.png", "avatars/lying.json"];
/** The facings each style ships in: `lie` for the sofas (all four), `curl` for the cat bed (the cat's two), `sleep` for the
 *  queen bed (all four; nw is se's frame and ne is sw's, sharing a rect). */
const LIE_STYLE_DIRS: Record<LieStyle, readonly Dir[]> = { lie: LIE_DIRS, curl: ["se", "sw"], sleep: LIE_DIRS };
const SLEEP_ALIAS: Partial<Record<Dir, Dir>> = { nw: "se", ne: "sw" };

/** `avatars/lying.png` + `.json` (the lying pose: breathing loop × facing × avatar, lazy), and its previews: every facing on the
 *  club sofa, the lounge couch and the cat bed for every avatar (`lying-pieces@2x.png`), the strip (`lying-strip@4x.png`) and
 *  a room with all three taken (`lying-room@1x/2x.png`). */
function buildLying(pieces: readonly PieceMeta[], all0: FurnSprites): void {
  const { w: CW, h: CH } = LIE_CELL;
  const drawn = (st: LieStyle): readonly Dir[] => LIE_STYLE_DIRS[st].filter((d) => st !== "sleep" || !SLEEP_ALIAS[d]);
  const cells = LIE_STYLES.flatMap((st) => drawn(st).flatMap((d) => Array.from({ length: BREATH_FRAMES }, (_, n) => ({ st, d, n }))));
  const sheetW = pow2(cells.length * CW), sheetH = pow2(AVATARS.length * CH);
  const sheet = new Uint8Array(sheetW * sheetH);
  const frames: Record<string, Frame> = {};
  const anims: Record<string, Anim> = {};
  const all: FurnSprites = new Map(all0);
  AVATARS.forEach((a, i) => {
    cells.forEach(({ st, d, n }, c) => {
      const key = `${st}/${a.id}/${d}/${String(n)}`;
      const img = render(lieGrid(a, d, st, n), a.roles);
      assertInside(key, img, CW, CH);
      blit(sheet, sheetW, img, CW, CH, c * CW, i * CH);
      const fl = floorOf(st);
      const ax = d === "sw" || d === "ne" ? CW - 1 - fl.x : fl.x;
      frames[key] = {
        frame: { x: c * CW, y: i * CH, w: CW, h: CH },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: CW, h: CH },
        sourceSize: { w: CW, h: CH },
        anchor: { x: ax / CW, y: fl.y / CH },
      };
      all.set(key, { img, w: CW, h: CH, ax, ay: fl.y });
      if (n === 0) anims[`${st}/${a.id}/${d}`] = { frames: Array.from({ length: BREATH_FRAMES }, (_, m) => `${st}/${a.id}/${d}/${String(m)}`), ms: [...BREATH_MS], loop: true };
    });
    for (const [d, src] of Object.entries(SLEEP_ALIAS)) {
      for (let n = 0; n < BREATH_FRAMES; n++) {
        const f = frames[`sleep/${a.id}/${src}/${String(n)}`], sp = all.get(`sleep/${a.id}/${src}/${String(n)}`);
        if (!f || !sp) throw new Error(`no sleep frame ${a.id}/${src}`);
        frames[`sleep/${a.id}/${d}/${String(n)}`] = f;
        all.set(`sleep/${a.id}/${d}/${String(n)}`, sp);
      }
      anims[`sleep/${a.id}/${d}`] = { frames: Array.from({ length: BREATH_FRAMES }, (_, m) => `sleep/${a.id}/${d}/${String(m)}`), ms: [...BREATH_MS], loop: true };
    }
  });
  registerKeys("lying", Object.keys(frames));
  writeFileSync(join(ROOT, "avatars", "lying.png"), encodeIndexedPng(sheetW, sheetH, sheet, PALETTE));
  const animations: Record<string, string[]> = {};
  for (const [k, an] of Object.entries(anims)) animations[k] = an.frames;
  const atlas = {
    frames,
    animations,
    meta: {
      app: "omega-share assets/src/build.ts",
      version: "1",
      image: "lying.png",
      format: "RGBA8888",
      size: { w: sheetW, h: sheetH },
      scale: "1",
      omega: {
        license: "CC-BY-SA-4.0",
        cell: LIE_CELL,
        floorPoint: LIE_FLOOR,
        sleepFloorPoint: SLEEP_FLOOR,
        dirs: LIE_STYLE_DIRS,
        // Not listed in the eager hairs/tints tables (they stay frozen); the PLTE is the same, so their slots apply as is.
        swaps: "tints.json and hairs.json: same PLTE slots as avatars.png, apply them to this sheet for that avatar's frames",
        hats: "own headwear (Pip beanie, Mo bucket hat) is drawn in; no overlay hat frames: hide theme/accessory hat overlays while lying",
        anims,
        pieces: LIE_ANCHORS,
      },
    },
  };
  writeFileSync(join(ROOT, "avatars", "lying.json"), JSON.stringify(atlas) + "\n");

  // One lier on a piece: back, lier, front, as a sitter would be.
  const meta = (id: string): PieceMeta => {
    const m = pieces.find((p) => p.id === id);
    if (!m) throw new Error(`no piece ${id}`);
    return m;
  };
  const lieOn = (id: string, colour: string, dir: FurnDir, who: string, n: number, x: number, y: number): FurnItem[] => {
    const an = LIE_ANCHORS[id], off = an?.dirs[dir];
    if (!an || !off) throw new Error(`no lie anchor ${id}/${dir}`);
    const m = meta(id);
    const sort = m.sortByDir[dir] ?? { x: 0, y: 0 };
    const sx = x + sort.x, sy = y + sort.y;
    const base = `furniture/${id}/${colour}`;
    const out: FurnItem[] = [
      { key: an.frame === "bed" ? `${base}/bed/${dir}` : `${base}/${dir}/back`, x, y, sx, sy, layer: 2 },
      { key: `${an.style}/${who}/${dir}/${String(n)}`, x: x + off.x, y: y + off.y, sx, sy, layer: 3 },
    ];
    if (m.layersByDir[dir]?.includes("front") === true) out.push({ key: `${base}/${dir}/front`, x, y, sx, sy, layer: 4 });
    return out;
  };

  // Contact sheet: a row per avatar; sofa ne nw se sw, couch ne nw se sw, cat bed se sw. Breath frame 0, then a last row in frame 1.
  const cols: [string, string, FurnDir][] = [
    ...(["ne", "nw", "se", "sw"] as const).map((d): [string, string, FurnDir] => ["sofa", "velvet", d]),
    ...(["ne", "nw", "se", "sw"] as const).map((d): [string, string, FurnDir] => ["couch", "cream", d]),
    ["cat", "ginger", "se"], ["cat", "charcoal", "sw"],
  ];
  const rowsOf: [string, number][] = [...AVATARS.map((a): [string, number] => [a.id, 0]), ["kiki", 1]];
  const PW = 140, RH = 84, W = PW * cols.length + 20, H = rowsOf.length * RH + 20;
  const img = new Uint8Array(W * H).fill(colorIndex("night", 2));
  rowsOf.forEach(([who, n], ri) => {
    cols.forEach(([id, colour, d], ci) => {
      const ax = 10 + ci * PW + 70, ay = 10 + ri * RH + 50;
      const fp = meta(id).footprintByDir[d] ?? { cols: 1, rows: 1 };
      for (let c = 0; c < fp.cols; c++) for (let r = 0; r < fp.rows; r++) drawSprite(img, W, H, all, `floor/${String((c + r) % 2)}`, ax + (c - r) * 32, ay + (c + r) * 16);
      for (const it of lieOn(id, colour, d, who, n, ax, ay)) drawSprite(img, W, H, all, it.key, it.x, it.y);
    });
  });
  writeFileSync(join(ROOT, "preview", "lying-pieces@2x.png"), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), PALETTE));

  // OME-1983: the queen bed in each facing: empty, two sleepers side by side (each under their duvet), two sitters.
  const bedM = meta("bed"), bedA = LIE_ANCHORS["bed"];
  const pairs: [string, string][] = [["juno", "pip"], ["mo", "kiki"], ["kiki", "juno"], ["pip", "mo"]];
  const sleepers = (dir: FurnDir, who: readonly [string, string], n: number, x: number, y: number): { key: string; x: number; y: number }[] => {
    const offs = [bedA?.dirs[dir], bedA?.beside?.[dir]];
    const order = [0, 1].sort((i, j) => (offs[i]?.y ?? 0) - (offs[j]?.y ?? 0));
    return [
      { key: `furniture/bed/velvet/${dir}/back`, x, y },
      ...order.flatMap((i) => {
        const o = offs[i];
        if (!o) throw new Error(`no sleeper ${String(i)} anchor bed/${dir}`);
        return [{ key: `sleep/${who[i] ?? ""}/${dir}/${String(n)}`, x: x + o.x, y: y + o.y }, { key: `furniture/bed/velvet/cover/${dir}/${String(i)}`, x, y }];
      }),
    ];
  };
  {
    const dirs = ["ne", "nw", "se", "sw"] as const;
    const BW = 170, BH = 120, W = BW * dirs.length + 20, H = BH * 3 + 20;
    const img = new Uint8Array(W * H).fill(colorIndex("night", 2));
    dirs.forEach((d, ci) => {
      for (let ri = 0; ri < 3; ri++) {
        const ax = 10 + ci * BW + 85, ay = 10 + ri * BH + 60;
        for (let c = 0; c < 2; c++) for (let r = 0; r < 2; r++) drawSprite(img, W, H, all, `floor/${String((c + r) % 2)}`, ax + (c - r) * 32, ay + (c + r) * 16);
        const pair = pairs[ci] ?? ["juno", "pip"];
        const items = ri === 1 ? sleepers(d, pair, 0, ax, ay) : placePiece(bedM, "velvet", d, ax, ay, ri === 2 ? pair : []);
        for (const it of items) drawSprite(img, W, H, all, it.key, it.x, it.y);
      }
    });
    writeFileSync(join(ROOT, "preview", "queenbed@2x.png"), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), PALETTE));
  }
  // And in a room at 1× / 2×: juno and mo asleep in one, pip and kiki sitting up on the other to watch.
  {
    const at = cellAt(7, 0), sleep = sleepers("nw", ["juno", "mo"], 0, at.x, at.y);
    const bedRoom = composeFurnitureRoom(pieces, all, {
      placements: [
        { id: "bed", colour: "velvet", dir: "ne", col: 0, row: 3, sitters: ["pip", "kiki"] },
        { id: "desk", colour: "wood", dir: "sw", col: 4, row: 0 },
        { id: "wingback", colour: "ginger", dir: "nw", col: 7, row: 5 },
        { id: "monstera", colour: "teal", dir: "sw", col: 9, row: 0 },
      ],
      standing: [],
    }, { top: (draw) => { for (const it of sleep) draw(it.key, it.x, it.y); } });
    writeFileSync(join(ROOT, "preview", "queenbed-room@1x.png"), encodeIndexedPng(bedRoom.W, bedRoom.H, bedRoom.img, PALETTE));
    writeFileSync(join(ROOT, "preview", "queenbed-room@2x.png"), encodeIndexedPng(bedRoom.W * 2, bedRoom.H * 2, upscale(bedRoom.img, bedRoom.W, bedRoom.H, 2), PALETTE));
  }

  const strips = new Map<string, { img: Uint8Array; w: number; h: number }>();
  for (const [k, sp] of all) if (sp.w === CW && sp.h === CH) strips.set(k, { img: sp.img, w: sp.w, h: sp.h });
  strip("lying-strip@4x.png", cells.length, AVATARS.map((a) => cells.map(({ st, d, n }) => `${st}/${a.id}/${d}/${String(n)}`)), strips, CW, CH, false);

  // A lazy evening: pip on the velvet sofa, mo on the olive couch, kiki curled in the cat's bed while the cat wanders, juno sitting.
  const lie: FurnItem[] = [
    ...lieOn("sofa", "velvet", "ne", "pip", 0, cellAt(2, 5).x, cellAt(2, 5).y),
    ...lieOn("couch", "olive", "nw", "mo", 0, cellAt(5, 2).x, cellAt(5, 2).y),
    ...lieOn("cat", "ginger", "se", "kiki", 0, cellAt(7, 6).x, cellAt(7, 6).y),
    ...lieOn("sofa", "navy", "sw", "juno", 1, cellAt(6, 8).x, cellAt(6, 8).y),
  ];
  const plan: RoomPlan = {
    placements: [
      { id: "wingback", colour: "ginger", dir: "ne", col: 4, row: 6 },
      { id: "sidetable", colour: "wood", dir: "sw", col: 4, row: 4 },
      { id: "arclamp", colour: "brass", dir: "se", col: 1, row: 4 },
      { id: "monstera", colour: "teal", dir: "sw", col: 9, row: 0 },
    ],
    standing: [["furniture/cat/ginger/walk/sw/1", 8, 3]],
  };
  const room = composeFurnitureRoom(pieces, all, plan, {
    top: (draw) => {
      lie.sort((p, q) => p.sy - q.sy || p.sx - q.sx || p.layer - q.layer);
      for (const it of lie) draw(it.key, it.x, it.y);
    },
  });
  writeFileSync(join(ROOT, "preview", "lying-room@1x.png"), encodeIndexedPng(room.W, room.H, room.img, PALETTE));
  writeFileSync(join(ROOT, "preview", "lying-room@2x.png"), encodeIndexedPng(room.W * 2, room.H * 2, upscale(room.img, room.W, room.H, 2), PALETTE));
}

// ---------------------------------------------------------------- set (h): owner edit mode in the room (1×, Pixi)

/** `owner-edit@1x/2x.png`: the sample room in edit mode, one of each marker state at once (a real session shows one held piece):
 *  the grid on every floor cell; the velvet sofa picked (mustard ring) with its rotate/remove handles; a navy beanbag held over
 *  free floor (teal ring + dots); a popcorn cart held over the snack table (rust dashed ring + hatching); and two wall slots for a
 *  print (free = teal, taken = rust). Held pieces draw solid here; Pixi shows them at 0.75 alpha. */
function buildOwnerPreviews(set: { pieces: PieceMeta[]; all: FurnSprites }, ui: readonly UiFrame[]): void {
  const all: FurnSprites = new Map(set.all);
  for (const f of ui) all.set(f.key, f);
  const base = sampleLayout();
  const plan = {
    placements: [
      ...base.placements,
      { id: "beanbag", colour: "navy", dir: "se" as const, col: 7, row: 4, ghost: true },
      { id: "popcorn", colour: "rust", dir: "sw" as const, col: 4, row: 4, ghost: true },
      { id: "frame", colour: "tide", dir: "sw" as const, col: 6, row: 0, ghost: true },
    ],
    standing: base.standing,
  };
  const at = (c: number, r: number): { x: number; y: number } => cellAt(c, r);
  buildFurnitureRoom(set.pieces, all, "owner-edit", plan, {
    floor: (draw) => {
      for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) draw("edit/grid", at(c, r).x, at(c, r).y);
      draw("place/sel/2x1", at(2, 5).x, at(2, 5).y);
      draw("place/ok/1x1", at(7, 4).x, at(7, 4).y);
      draw("place/no/1x1", at(4, 4).x, at(4, 4).y);
    },
    wall: (draw) => {
      draw("place/ok/wall-sw", at(6, 0).x, at(6, 0).y);
      draw("place/no/wall-sw", at(4, 0).x, at(4, 0).y);
    },
    top: (draw) => {
      const s = at(2, 5);
      draw("handle/rotate/idle", s.x - 14, s.y - 52);
      draw("handle/remove/hover", s.x + 14, s.y - 52);
    },
  });
}

function slicesFiles(): string[] {
  return readdirSync(join(ROOT, "ui", "slices")).filter((n) => n.endsWith(".png")).sort().map((n) => `ui/slices/${n}`);
}

// ---------------------------------------------------------------- set (n): room presets (M10, OME-906)

/** Thumbnails ship on the landing / create flow: all six together stay under this (OME-906). */
const PRESET_THUMBS_MAX = 40 * 1024;
/** Who sits where in the full-size previews, by seat index (ADR 0021 order); gaps are free seats. */
const PRESET_SITTERS: readonly (string | undefined)[] = ["juno", "pip", undefined, "mo", "kiki", undefined, undefined, undefined];

/** A schema layout as the preview composer's plan: set (g) pieces as placements, room-atlas pieces as cell sprites. */
function presetPlan(layout: RoomLayout): RoomPlan {
  const plan: RoomPlan = { placements: [], standing: [], rug: layout.furniture.some((f) => f.kind === "rug") };
  let seat = 0;
  for (const f of layout.furniture) {
    const spec = FURNITURE[f.kind];
    const sitters = spec.seats ? footprintCells(f).map(() => PRESET_SITTERS[seat++]) : [];
    if (f.kind === "tv" || f.kind === "rug") continue; // the console and the big rug are part of the room shell
    if (f.kind === "lamp" || f.kind === "plant") { plan.standing.push([`${f.kind}/0`, f.col, f.row]); continue; }
    if (f.kind === "armchair") {
      plan.standing.push([`armchair/${f.facing}/back`, f.col, f.row]);
      const who = sitters[0];
      if (who !== undefined) plan.standing.push([`${who}/sit/${f.facing}/0`, f.col, f.row]);
      plan.standing.push([`armchair/${f.facing}/front`, f.col, f.row]);
      continue;
    }
    const id = f.kind === "runner" ? "rug" : f.kind;
    const meta = PIECES_BY_ID.get(id);
    if (!meta) throw new Error(`preset: no catalogue piece ${id}`);
    const placement: Placement = { id, colour: meta.colours[f.variant ?? 0] ?? "", dir: f.facing, col: f.col, row: f.row };
    if (sitters.some((w) => w !== undefined)) placement.sitters = sitters.map((w) => w ?? "");
    plan.placements.push(placement);
  }
  return plan;
}
let PIECES_BY_ID = new Map<string, PieceMeta>();

/** presets/: one layout JSON per preset, presets.json (names, blurbs, files), thumbs/*.png; previews: a 3× thumbnail sheet and
 *  every preset at full size with a few people seated (preview/presets@1x.png). */
function buildPresets(set: { pieces: PieceMeta[]; all: FurnSprites }): void {
  PIECES_BY_ID = new Map(set.pieces.map((m) => [m.id, m]));
  const dir = join(ROOT, "presets");
  mkdirSync(join(dir, "thumbs"), { recursive: true });
  const ids = new Set<string>();
  let bytes = 0;
  const index = PRESETS.map((pr) => {
    if (!/^[a-z-]{1,12}$/.test(pr.id) || ids.has(pr.id)) throw new Error(`preset id ${pr.id}: [a-z-]{1,12}, unique`);
    ids.add(pr.id);
    if (pr.blurb.length > 60) throw new Error(`preset ${pr.id}: blurb over 60 characters`);
    const parsed = v.safeParse(RoomLayoutInputSchema, pr.layout);
    if (!parsed.success) throw new Error(`preset ${pr.id}: ${parsed.issues.map((i) => i.message).join("; ")}`);
    writeFileSync(join(dir, `${pr.id}.json`), JSON.stringify(pr.layout) + "\n");
    const small = compactPalette(presetThumb(pr.layout));
    const png = encodeIndexedPng(THUMB.w, THUMB.h, small.pixels, small.palette);
    writeFileSync(join(dir, "thumbs", `${pr.id}.png`), png);
    bytes += png.length;
    return { id: pr.id, name: pr.name, blurb: pr.blurb, layout: `${pr.id}.json`, thumb: `thumbs/${pr.id}.png` };
  });
  if (bytes > PRESET_THUMBS_MAX) throw new Error(`preset thumbnails are ${String(bytes)} B, over ${String(PRESET_THUMBS_MAX)}`);
  const manifest = { version: 1, license: "CC-BY-SA-4.0", default: "classic", thumb: { ...THUMB, scale: THUMB_SCALE }, presets: index };
  writeFileSync(join(dir, "presets.json"), JSON.stringify(manifest, null, 1) + "\n");
  console.log(`presets (set n): ${String(PRESETS.length)} thumbnails ${String(bytes)} B of ${String(PRESET_THUMBS_MAX)}`);
  // Previews: thumbnails 3 across at 3× on the night page, then the same rooms at full size.
  const G = 4, cols = 3, rows = Math.ceil(PRESETS.length / cols);
  const tw = cols * THUMB.w + (cols + 1) * G, th = rows * THUMB.h + (rows + 1) * G;
  const sheet = new Uint8Array(tw * th).fill(colorIndex("night", 2));
  PRESETS.forEach((pr, i) => {
    const img = presetThumb(pr.layout);
    blitAt(sheet, tw, th, img, THUMB.w, THUMB.h, G + (i % cols) * (THUMB.w + G), G + Math.floor(i / cols) * (THUMB.h + G));
  });
  writeFileSync(join(ROOT, "preview", "presets-thumbs@3x.png"), encodeIndexedPng(tw * 3, th * 3, upscale(sheet, tw, th, 3), PALETTE));
  const CX = 140, CW = 680, CH = 552;
  const fw = cols * CW + (cols + 1) * G, fh = rows * CH + (rows + 1) * G;
  const full = new Uint8Array(fw * fh).fill(OUTLINE);
  PRESETS.forEach((pr, i) => {
    const { img, W } = composeFurnitureRoom(set.pieces, set.all, presetPlan(pr.layout));
    const ox = G + (i % cols) * (CW + G), oy = G + Math.floor(i / cols) * (CH + G);
    for (let y = 0; y < CH; y++) full.set(img.subarray(y * W + CX, y * W + CX + CW), (oy + y) * fw + ox);
  });
  writeFileSync(join(ROOT, "preview", "presets@1x.png"), encodeIndexedPng(fw, fh, full, PALETTE));
}

// ---------------------------------------------------------------- holiday themes (OME-1185, OME-1187, lazy)

const THEMES: readonly ThemeDef[] = [HALLOWEEN, SINTERKLAAS, CHRISTMAS, VALENTINES, EASTER];
const THEME_FILES = THEMES.flatMap((t) => [`themes/${t.id}/${t.id}.png`, `themes/${t.id}/${t.id}.json`]);
const ACCESSORY_FILES = ["accessories/accessories.png", "accessories/accessories.json", "accessories/bare.png", "accessories/bare.json"];

/** `themes/<id>/<id>.png` + `.json`: wall/window decor, effect frames and a hat for every avatar frame (≤ 40 KB per theme).
 *  Hat frames with identical pixels share one rect; each key keeps its own anchor (the avatar's floor point). */
function buildTheme(t: ThemeDef, avatarImages: Map<string, Uint8Array>): void {
  const id = t.id;
  const hats = buildHatFrames(id, t.hat);
  const decor = t.decor();
  const fx = t.effect.frames;
  // Dedupe hat images by pixels.
  const unique = new Map<string, RoomFrame>();
  const rectOf = new Map<string, string>();
  for (const h of hats) {
    const sig = `${String(h.w)}x${String(h.h)}:${Buffer.from(h.img).toString("base64")}`;
    if (!unique.has(sig)) unique.set(sig, { key: `u${String(unique.size)}`, w: h.w, h: h.h, img: h.img, ax: h.ax, ay: h.ay });
    const u = unique.get(sig);
    if (u) rectOf.set(h.key, u.key);
  }
  const packed = pack([...decor.frames, ...fx, ...unique.values()], 256);
  const sheet = new Uint8Array(packed.w * packed.h);
  const at = new Map(packed.placed.map((p) => [p.key, p]));
  for (const p of packed.placed) blit(sheet, packed.w, p.img, p.w, p.h, p.x, p.y);
  const frame = (p: Placed, ax: number, ay: number): Frame => ({
    frame: { x: p.x, y: p.y, w: p.w, h: p.h },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: p.w, h: p.h },
    sourceSize: { w: p.w, h: p.h },
    anchor: { x: ax / p.w, y: ay / p.h },
  });
  const frames: Record<string, Frame> = {};
  for (const f of [...decor.frames, ...fx]) {
    const p = at.get(f.key);
    if (!p) throw new Error(`unpacked ${f.key}`);
    frames[f.key] = frame(p, f.ax, f.ay);
  }
  for (const h of hats) {
    const p = at.get(rectOf.get(h.key) ?? "");
    if (!p) throw new Error(`unpacked ${h.key}`);
    frames[h.key] = frame(p, h.ax, h.ay);
  }
  registerKeys(id, Object.keys(frames));
  const dir = join(ROOT, "themes", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.png`), encodeIndexedPng(packed.w, packed.h, sheet, PALETTE));
  const fxKeys = fx.map((b) => b.key);
  const atlas = {
    frames,
    // A cycling effect (fx, pepernoten) is one Pixi animation; variant effects (snowflakes) are just frames.
    animations: t.effect.ms === undefined ? {} : { [(fxKeys[0] ?? "").replace(/\/0$/, "")]: fxKeys },
    meta: {
      app: "omega-share assets/src/build.ts",
      version: "1",
      image: `${id}.png`,
      format: "RGBA8888",
      size: { w: packed.w, h: packed.h },
      scale: "1",
      omega: {
        license: "CC-BY-SA-4.0",
        theme: id,
        period: t.period,
        decor: decor.meta,
        effect: { frames: fxKeys, ms: t.effect.ms, max: t.effect.max, layer: "behind-avatars", motion: t.effect.motion, facing: t.effect.facing },
        hat: { prefix: `${id}/hat/`, count: hats.length, rects: unique.size, replaces: t.hat.replaces },
        accent: t.accent,
      },
    },
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(atlas, null, 1) + "\n");
  // Previews: the sheet, a hat contact strip, and the classic room dressed for the theme.
  const big = upscale(sheet, packed.w, packed.h, 2).map((v) => (v === 0 ? colorIndex("wall", 1) : v));
  writeFileSync(join(ROOT, "preview", `${id}-sheet@2x.png`), encodeIndexedPng(packed.w * 2, packed.h * 2, big, PALETTE));
  const hatByKey = new Map(hats.map((h) => [h.key.slice(`${id}/hat/`.length), h]));
  const sprites = new Map<string, { img: Uint8Array; w: number; h: number }>();
  const base = new Map<string, Uint8Array>();
  for (const s of allAvatarFrames()) base.set(s.key, avatarImages.get(s.key) ?? render(composeMotion(s.avatar, s.pose, s.dir, s.motion), s.avatar.roles));
  // Contact strip cells are 32×76 (12 px headroom for the hat): base frame, then base + hat overlay drawn at the same floor point.
  const CH = CELL.h + 12;
  const withHat = (key: string, hat: boolean): { img: Uint8Array; w: number; h: number } => {
    const b = base.get(key);
    if (!b) throw new Error(`missing ${key}`);
    const out = new Uint8Array(CELL.w * CH);
    blitAt(out, CELL.w, CH, b, CELL.w, CELL.h, 0, 12);
    const h = hatByKey.get(key);
    if (hat && h) blitAt(out, CELL.w, CH, h.img, h.w, h.h, FLOOR.x - h.ax, FLOOR.y + 12 - h.ay);
    return { img: out, w: CELL.w, h: CH };
  };
  const rows: string[][] = [];
  for (const a of AVATARS) {
    const r1: string[] = [], r2: string[] = [];
    for (const pose of POSES) for (const d of DIRS) {
      const k = `${a.id}/${pose}/${d}/0`;
      sprites.set(`plain:${k}`, withHat(k, false));
      sprites.set(`hat:${k}`, withHat(k, true));
      r1.push(`plain:${k}`, `hat:${k}`);
    }
    for (const k of [`walk/${a.id}/se/1`, `walk8/${a.id}/sw/3`, `wave/${a.id}/idle/se/0`, `wave/${a.id}/sit/nw/1`, `cheer/${a.id}/idle/sw/1`, `cheer/${a.id}/sit/ne/0`, `yawn/${a.id}/idle/se/0`, `yawn/${a.id}/sit/sw/1`, `breathe/${a.id}/sit/nw/1`, `yawn/${a.id}/idle/ne/0`, `${a.id}/idle/se/1`, `walk/${a.id}/nw/3`, `cheer/${a.id}/idle/se/1`, `wave/${a.id}/idle/ne/0`, `yawn/${a.id}/sit/ne/1`, `walk/${a.id}/ne/0`]) {
      sprites.set(`hat:${k}`, withHat(k, true));
      r2.push(`hat:${k}`);
    }
    rows.push(r1, r2);
  }
  strip(`${id}-hats@4x.png`, 16, rows, sprites, CELL.w, CH, true);
  const extra = new Map<string, RoomFrame>([...decor.frames, ...fx, ...hats].map((f) => [f.key, f]));
  const roomFrames = buildRoomFrames();
  const layout = defaultLayout();
  const wallFrame = (on: string): { c: number; r: number }[] => {
    if (on === "wall/corner") return [{ c: 0, r: 0 }];
    if (on === "wall/l/end") return [{ c: 0, r: 9 }];
    if (on === "wall/r/end") return [{ c: 9, r: 0 }];
    if (on === "wall/l") return layout.walls.l.map((_, r) => ({ c: 0, r }));
    if (on === "wall/r") return layout.walls.r.map((_, c) => ({ c, r: 0 }));
    return [...layout.walls.l.flatMap((k, r) => (k === on ? [{ c: 0, r }] : [])), ...layout.walls.r.flatMap((k, c) => (k === on ? [{ c, r: 0 }] : []))];
  };
  const { img, W, H } = composeRoomScene(roomFrames, avatarImages, layout, {
    extra,
    over: (key) => (hatByKey.has(key) ? `${id}/hat/${key}` : undefined),
    walls: (draw, cc) => {
      for (const m of decor.meta) for (const { c, r } of wallFrame(m.on)) { const p = cc(c, r); draw(m.key, p.x, p.y); }
      // Effect sprites (preview positions; the engine animates them).
      for (const [i, x, y] of t.preview) draw(fxKeys[i] ?? "", x, y);
    },
  });
  writeFileSync(join(ROOT, "preview", `${id}-room@1x.png`), encodeIndexedPng(W, H, img, PALETTE));
  writeFileSync(join(ROOT, "preview", `${id}-room@2x.png`), encodeIndexedPng(W * 2, H * 2, upscale(img, W, H, 2), PALETTE));
}

/** `accessories/accessories.png` + `.json` (OME-1388, lazy): four head accessories, each a hat for every avatar frame, built and anchored
 *  exactly like a theme's hat. `meta.omega.accessories[id]` has the theme manifest's `hat` shape, so the web reuses the hat loader. */
function buildAccessories(avatarImages: Map<string, Uint8Array>): void {
  const hats = new Map(ACCESSORIES.map((a) => [a.id, buildHatFrames(a.id, a.hat, a.bare ? BARE : undefined)]));
  const bareImages = buildBare();
  // Hat frames with identical pixels share one rect (per accessory and across them); each key keeps its own anchor.
  const unique = new Map<string, RoomFrame>();
  const rectOf = new Map<string, string>();
  const rects = new Map<string, Set<string>>();
  for (const [id, hs] of hats) {
    const own = new Set<string>();
    for (const h of hs) {
      const sig = `${String(h.w)}x${String(h.h)}:${Buffer.from(h.img).toString("base64")}`;
      if (!unique.has(sig)) unique.set(sig, { key: `u${String(unique.size)}`, w: h.w, h: h.h, img: h.img, ax: h.ax, ay: h.ay });
      const u = unique.get(sig);
      if (u) { rectOf.set(h.key, u.key); own.add(u.key); }
    }
    rects.set(id, own);
  }
  const packed = pack([...unique.values()], 256);
  const sheet = new Uint8Array(packed.w * packed.h);
  const at = new Map(packed.placed.map((p) => [p.key, p]));
  for (const p of packed.placed) blit(sheet, packed.w, p.img, p.w, p.h, p.x, p.y);
  const frames: Record<string, Pick<Frame, "frame" | "anchor">> = {};
  for (const h of [...hats.values()].flat()) {
    const p = at.get(rectOf.get(h.key) ?? "");
    if (!p) throw new Error(`unpacked ${h.key}`);
    // Only what the hat loader reads (atlas-sheet.ts: frame + anchor): 1 664 keys, so every field costs parse time (judge OME-1394 #4).
    frames[h.key] = { frame: { x: p.x, y: p.y, w: p.w, h: p.h }, anchor: { x: h.ax / p.w, y: h.ay / p.h } };
  }
  registerKeys("accessories", Object.keys(frames));
  mkdirSync(join(ROOT, "accessories"), { recursive: true });
  writeFileSync(join(ROOT, "accessories", "accessories.png"), encodeIndexedPng(packed.w, packed.h, sheet, PALETTE));
  const accessories = Object.fromEntries(ACCESSORIES.map((a) => [a.id, { prefix: `${a.id}/hat/`, count: hats.get(a.id)?.length ?? 0, rects: rects.get(a.id)?.size ?? 0, replaces: a.hat.replaces, bare: a.bare }]));
  const atlas = {
    frames,
    animations: {},
    meta: { app: "omega-share assets/src/build.ts", version: "1", image: "accessories.png", format: "RGBA8888", size: { w: packed.w, h: packed.h }, scale: "1", omega: { license: "CC-BY-SA-4.0", accessories } },
  };
  writeFileSync(join(ROOT, "accessories", "accessories.json"), JSON.stringify(atlas) + "\n");
  // Contact sheet: one row per avatar, each accessory in idle (front, back), walk and sit (front, back), on 32×76 cells like the theme strips.
  const big = upscale(sheet, packed.w, packed.h, 2).map((v) => (v === 0 ? colorIndex("wall", 1) : v));
  writeFileSync(join(ROOT, "preview", "accessories-sheet@2x.png"), encodeIndexedPng(packed.w * 2, packed.h * 2, big, PALETTE));
  const CH = CELL.h + 12;
  const byKey = new Map<string, HatFrame>([...hats.values()].flat().map((h) => [h.key, h]));
  const sprites = new Map<string, { img: Uint8Array; w: number; h: number }>();
  const specs = new Map(allAvatarFrames().map((s) => [s.key, s]));
  const baseOf = (k: string): Uint8Array | undefined => {
    const s = specs.get(k);
    return avatarImages.get(k) ?? (s && render(composeMotion(s.avatar, s.pose, s.dir, s.motion), s.avatar.roles));
  };
  const worn = (acc: (typeof ACCESSORIES)[number], k: string): string => {
    const b = (acc.bare ? bareImages.get(k) : undefined) ?? baseOf(k);
    const h = byKey.get(`${acc.id}/hat/${k}`);
    if (!b || !h) throw new Error(`missing ${acc.id} on ${k}`);
    const out = new Uint8Array(CELL.w * CH);
    blitAt(out, CELL.w, CH, b, CELL.w, CELL.h, 0, 12);
    blitAt(out, CELL.w, CH, h.img, h.w, h.h, FLOOR.x - h.ax, FLOOR.y + 12 - h.ay);
    sprites.set(`${acc.id}:${k}`, { img: out, w: CELL.w, h: CH });
    return `${acc.id}:${k}`;
  };
  const poses = (id: string): string[] => [`${id}/idle/se/0`, `${id}/idle/nw/0`, `walk/${id}/sw/1`, `${id}/sit/se/0`, `${id}/sit/ne/0`];
  // One sheet per batch of four, so each stays 20 columns: OME-1388's four, then OME-1530's with a mixed tint × hair row.
  const [first, second] = [ACCESSORIES.slice(0, 4), ACCESSORIES.slice(4)];
  strip("accessories@4x.png", 20, AVATARS.map((a) => first.flatMap((acc) => poses(a.id).map((k) => worn(acc, k)))), sprites, CELL.w, CH, true);
  const rows = AVATARS.map((a) => second.flatMap((acc) => poses(a.id).map((k) => worn(acc, k))));
  // Mixed row: cell n = avatar n % 4 in accessory ⌊n / 5⌋, pose n % 5, hair 1 + n % 5, tint 5 − n % 6 (every cell a non-default look).
  const W = 20 * CELL.w, H = (rows.length + 1) * CH;
  const img = new Uint8Array(W * H).fill(colorIndex("wall", 1));
  const cells: { img: Uint8Array; col: number; row: number }[] = rows.flatMap((r, row) => r.map((key, col) => ({ img: sprites.get(key)?.img ?? new Uint8Array(0), col, row })));
  for (let n = 0; n < 20; n++) {
    const a = AVATARS[n % 4], acc = second[Math.floor(n / 5)];
    if (!a || !acc) throw new Error("mixed row");
    const key = worn(acc, poses(a.id)[n % 5] ?? "");
    cells.push({ img: applyRemap(sprites.get(key)?.img ?? new Uint8Array(0), lookRemap(a, 1 + (n % 5), 5 - (n % 6))), col: n, row: rows.length });
  }
  for (const c of cells) {
    floorMark(img, W, c.col * CELL.w + FLOOR.x, c.row * CH + 12 + FLOOR.y);
    blitAt(img, W, H, c.img, CELL.w, CH, c.col * CELL.w, c.row * CH);
  }
  writeFileSync(join(ROOT, "preview", "accessories-b@4x.png"), encodeIndexedPng(W * 4, H * 4, upscale(img, W, H, 4), HAIR_PALETTE));
}

/** `accessories/bare.png` + `.json` (OME-1409, lazy): Pip and Mo without their beanie / bucket hat, for every avatar frame key, in the
 *  avatar sheets' 32×64 cell and anchor. The web shows `bare/<key>` instead of `<key>` while they wear an accessory with `bare: true`. */
function buildBare(): Map<string, Uint8Array> {
  const images = new Map<string, Uint8Array>();
  const unique = new Map<string, RoomFrame>();
  const rectOf = new Map<string, string>();
  for (const { key, avatar, pose, dir, motion } of allAvatarFrames()) {
    const b = BARE.get(avatar.id);
    if (!b) continue;
    const img = render(composeMotion(b, pose, dir, motion), b.roles);
    assertInsideCell(`bare/${key}`, img);
    images.set(key, img);
    // Identical cells (a back view's blink, for one) share a rect.
    const sig = Buffer.from(img).toString("base64");
    if (!unique.has(sig)) unique.set(sig, { key: `b${String(unique.size)}`, w: CELL.w, h: CELL.h, img, ax: FLOOR.x, ay: FLOOR.y });
    rectOf.set(key, unique.get(sig)?.key ?? "");
  }
  // A gutter-free grid of whole cells, like the avatar sheets (rows line up, so PNG filters compress them better than packed rects).
  const cols = 32, cells = [...unique.values()];
  const packed = { w: cols * CELL.w, h: pow2(Math.ceil(cells.length / cols) * CELL.h), placed: cells.map((c, i) => ({ ...c, x: (i % cols) * CELL.w, y: Math.floor(i / cols) * CELL.h })) };
  const sheet = new Uint8Array(packed.w * packed.h);
  const at = new Map(packed.placed.map((p) => [p.key, p]));
  for (const p of packed.placed) blit(sheet, packed.w, p.img, p.w, p.h, p.x, p.y);
  const frames: Record<string, Pick<Frame, "frame" | "anchor">> = {};
  for (const key of images.keys()) {
    const p = at.get(rectOf.get(key) ?? "");
    if (!p) throw new Error(`unpacked bare/${key}`);
    frames[`bare/${key}`] = { frame: { x: p.x, y: p.y, w: CELL.w, h: CELL.h }, anchor: { x: FLOOR.x / CELL.w, y: FLOOR.y / CELL.h } };
  }
  registerKeys("bare", Object.keys(frames));
  writeFileSync(join(ROOT, "accessories", "bare.png"), encodeIndexedPng(packed.w, packed.h, sheet, PALETTE));
  const bare = { prefix: "bare/", avatars: [...BARE.keys()], accessories: ACCESSORIES.filter((a) => a.bare).map((a) => a.id) };
  const atlas = {
    frames,
    animations: {},
    meta: { app: "omega-share assets/src/build.ts", version: "1", image: "bare.png", format: "RGBA8888", size: { w: packed.w, h: packed.h }, scale: "1", omega: { license: "CC-BY-SA-4.0", bare } },
  };
  writeFileSync(join(ROOT, "accessories", "bare.json"), JSON.stringify(atlas) + "\n");
  return images;
}

/** Movie night (OME-1641, lazy): reaction glyphs + strip minis in `ui/reactions.png|json`, and `ui/moments.css` (strip, recap card, lights-down). */
function buildReactions(): void {
  const frames = buildReactionFrames();
  registerKeys("reactions", frames.map((f) => f.key));
  const at = reactLayout(frames);
  const sheet = new Uint8Array(REACT_SHEET.w * REACT_SHEET.h);
  const out: Record<string, Pick<Frame, "frame" | "anchor">> = {};
  for (const f of frames) {
    const p = at.get(f.key);
    if (!p) throw new Error(`unplaced ${f.key}`);
    if (f.key.startsWith("react/")) assertInside(f.key, f.img, f.w, f.h); // minis are 7 art px + their outline, edge to edge
    blit(sheet, REACT_SHEET.w, f.img, f.w, f.h, p.x, p.y);
    out[f.key] = { frame: { x: p.x, y: p.y, w: f.w, h: f.h }, anchor: { x: f.ax / f.w, y: f.ay / f.h } };
  }
  const small = compactPalette(sheet);
  writeFileSync(join(ROOT, "ui", "reactions.png"), encodeIndexedPng(REACT_SHEET.w, REACT_SHEET.h, small.pixels, small.palette));
  const { animations, omega } = reactionAnims();
  const atlas = { frames: out, animations, meta: { app: "omega-share assets/src/build.ts", version: "1", image: "reactions.png", format: "RGBA8888", size: REACT_SHEET, scale: "1", omega } };
  writeFileSync(join(ROOT, "ui", "reactions.json"), JSON.stringify(atlas) + "\n");
  writeFileSync(join(ROOT, "ui", "moments.css"), momentsCss(at));
  // Preview: the sheet at 4× on the wall shade (not shipped).
  const bg = colorIndex("wall", 1);
  const big = upscale(sheet, REACT_SHEET.w, REACT_SHEET.h, 4).map((v) => (v === 0 ? bg : v));
  writeFileSync(join(ROOT, "preview", "reactions-sheet@4x.png"), encodeIndexedPng(REACT_SHEET.w * 4, REACT_SHEET.h * 4, big, PALETTE));
}

/** One byte basis for the art budget (README § Budget): bytes on the wire, i.e. PNGs as stored and text (JSON, CSS) gzipped at
 *  level 9, for every file under assets/ that ships, eager and lazy. Lazy: motion (set d), furniture (set g), edit kit (set h),
 *  and the closed / invite-required scenes (set i, fetched only by those pages). */
const LAZY = new Set(["avatars/motion.png", "avatars/motion.json", "avatars/expressions.png", "avatars/expressions.json", "avatars/watching.png", "avatars/watching.json", "furniture/furniture.png", "furniture/furniture.json", "furniture/furniture-v2.png", "furniture/furniture-v2.json", "furniture/furniture-v4.png", "furniture/furniture-v4.json", "furniture/furniture-v5.png", "furniture/furniture-v5.json", ...DUNGEON_FILES, ...LYING_FILES, "furniture/recolours.json", "ui/edit.png", "ui/edit.json", "ui/reactions.png", "ui/reactions.json", "ui/moments.css", ...THEME_FILES, ...ACCESSORY_FILES]);

function report(): void {
  const popup = readdirSync(join(ROOT, "ui", "popup")).filter((n) => n.endsWith(".png")).sort().map((n) => `ui/popup/${n}`);
  const scenes = readdirSync(join(ROOT, "ui", "scenes")).filter((n) => n.endsWith(".png")).sort().map((n) => `ui/scenes/${n}`);
  const files = ["avatars/avatars.png", "avatars/avatars.json", "avatars/motion.png", "avatars/motion.json", "avatars/expressions.png", "avatars/expressions.json", "avatars/watching.png", "avatars/watching.json", "room/room.png", "room/room.json", "ui/ui.png", "ui/ui.json", "ui/edit.png", "ui/edit.json", ...slicesFiles(), ...popup, ...scenes, "ui/reference.css", "ui/popup/kit.css", "ui/reactions.png", "ui/reactions.json", "ui/moments.css", "furniture/furniture.png", "furniture/furniture.json", "furniture/furniture-v2.png", "furniture/furniture-v2.json", "furniture/furniture-v4.png", "furniture/furniture-v4.json", "furniture/furniture-v5.png", "furniture/furniture-v5.json", ...DUNGEON_FILES, ...LYING_FILES, "furniture/recolours.json", ...THEME_FILES, ...ACCESSORY_FILES];
  files.push("presets/presets.json", ...PRESETS.flatMap((p) => [`presets/${p.id}.json`, `presets/thumbs/${p.id}.png`]));
  let total = 0, lazy = 0;
  for (const f of files) {
    const buf = readFileSync(join(ROOT, f));
    const text = !f.endsWith(".png");
    const size = text ? gzipSync(buf, { level: 9 }).length : buf.length;
    total += size;
    if (LAZY.has(f) || f.startsWith("ui/scenes/")) lazy += size;
    console.log(`${f}: ${String(buf.length)} B${text ? ` (${String(size)} B gz)` : ""}`);
  }
  console.log(`lazy (sets d, g, h edit kit, i/j scenes): ${String(lazy)} B; eager: ${String(total - lazy)} B`);
  console.log(`art total (png + gz json/css, eager + lazy): ${String(total)} B of 409600 (ADR 0056)`);
  // Set (j): the extension icons ship in the extension package, not the site, so they're reported apart from the art budget.
  const icons = readdirSync(join(ROOT, "store")).filter((n) => /^(icon|found)-\d+\.png$/.test(n)).sort();
  const iconBytes = icons.map((n) => readFileSync(join(ROOT, "store", n)).length);
  console.log(`extension icons (store/${icons.join(", ")}): ${iconBytes.join(" + ")} = ${String(iconBytes.reduce((a, b) => a + b, 0))} B`);
  // OME-1041: what the restyled popup loads from the extension package (all local files, no network).
  const kitPng = readFileSync(join(ROOT, "ui", "popup", "kit.png")).length, kitCss = gzipSync(readFileSync(join(ROOT, "ui", "popup", "kit.css")), { level: 9 }).length;
  const kitSlices = POPUP_KIT_SLICES.reduce((a, n) => a + readFileSync(join(ROOT, "ui", "slices", `${n}.png`)).length, 0);
  console.log(`popup kit (OME-1041): kit.png ${String(kitPng)} B + kit.css ${String(kitCss)} B gz + ${String(POPUP_KIT_SLICES.length)} slices ${String(kitSlices)} B = ${String(kitPng + kitCss + kitSlices)} B`);
  // Set (m): the website's files have their own caps (OME-762), enforced here: each landing panel ≤ 25 KB and all three ≤ 60 KB
  // (the landing's transfer budget is merge-blocking), and the share card < 150 KB.
  const size = (f: string): number => readFileSync(join(ROOT, "site", f)).length;
  const panels = ["how-1-find.png", "how-2-share.png", "how-3-watch.png"].map(size);
  const og = size("og-card.png");
  const siteIcons = ["favicon.ico", "favicon-16.png", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"].map(size);
  if (panels.some((b) => b > 25 * 1024) || panels.reduce((a, b) => a + b, 0) > 60 * 1024) throw new Error(`landing panels over budget: ${panels.join(" + ")} B`);
  if (og >= 150 * 1024) throw new Error(`og-card.png is ${String(og)} B, over 150 KB`);
  console.log(`site (set m): landing panels ${panels.join(" + ")} = ${String(panels.reduce((a, b) => a + b, 0))} B of 61440; og-card ${String(og)} B of 153600; icons ${String(siteIcons.reduce((a, b) => a + b, 0))} B`);
}

/** Set (j): the Chrome Web Store kit's extension icons (drawn per size). The promo tile and screenshots come from preview/store.html. */
function buildStore(): void {
  mkdirSync(join(ROOT, "store"), { recursive: true });
  for (const f of [...buildStoreIcons(), ...buildToolbarIcons()]) {
    const small = compactPalette(f.pixels);
    writeFileSync(join(ROOT, "store", f.file), encodeIndexedPng(f.w, f.h, small.pixels, small.palette));
  }
  // OME-1041: the rejected "found" directions, for preview/popup-kit.html only (A: a flat glow dot; C: the screen off until found).
  mkdirSync(join(ROOT, "preview", "toolbar"), { recursive: true });
  for (const S of [16, 32]) {
    for (const [name, img] of [[`dot-${String(S)}`, renderFoundIcon(S, 0, false, "dot")], [`off-${String(S)}`, renderScreenOff(S, 0)]] as const) {
      const small = compactPalette(img);
      writeFileSync(join(ROOT, "preview", "toolbar", `${name}.png`), encodeIndexedPng(S, S, small.pixels, small.palette));
    }
  }
}

/** Set (m) (M9): the website's icons, share card and "how it works" panels, written to site/. */
function buildSite(src: SiteSources): void {
  mkdirSync(join(ROOT, "site"), { recursive: true });
  const write = (f: { file: string; w: number; h: number; pixels: Uint8Array }): Uint8Array => {
    const small = compactPalette(f.pixels);
    const png = encodeIndexedPng(f.w, f.h, small.pixels, small.palette);
    writeFileSync(join(ROOT, "site", f.file), png);
    return png;
  };
  const icons = new Map(buildSiteIcons().map((f) => [f.file, write(f)]));
  const ico = [16, 32].map((size) => {
    const data = icons.get(`favicon-${String(size)}.png`);
    if (!data) throw new Error(`missing favicon-${String(size)}.png`);
    return { size, data };
  });
  writeFileSync(join(ROOT, "site", "favicon.ico"), encodeIco(ico));
  write(buildShareCard(src));
  for (const p of buildPanels(src)) write(p);
}

/** Shirt tints (OME-1347): the PLTE-swap table and a 4 × 6 contact sheet at 1× and 2×. No sheet bytes change. */
function buildTints(): void {
  writeFileSync(join(ROOT, "avatars", "tints.json"), JSON.stringify(tintsTable(), null, 1) + "\n");
  const c = contactSheet();
  writeFileSync(join(ROOT, "preview", "tints-sheet@1x.png"), encodeIndexedPng(c.w, c.h, c.img, c.palette));
  writeFileSync(join(ROOT, "preview", "tints-sheet@2x.png"), encodeIndexedPng(c.w * 2, c.h * 2, upscale(c.img, c.w, c.h, 2), c.palette));
}

/** Furniture recolours (OME-1462): the PLTE-swap table and a contact sheet of every variant at 1× and 2×. No sheet bytes change. */
function buildRecolours(): void {
  writeFileSync(join(ROOT, "furniture", "recolours.json"), JSON.stringify(recoloursTable(), null, 1) + "\n");
  const c = recolourSheet();
  writeFileSync(join(ROOT, "preview", "recolours-sheet@1x.png"), encodeIndexedPng(c.w, c.h, c.img, c.palette));
  writeFileSync(join(ROOT, "preview", "recolours-sheet@2x.png"), encodeIndexedPng(c.w * 2, c.h * 2, upscale(c.img, c.w, c.h, 2), c.palette));
  const wall = wallRecolourSheet();
  writeFileSync(join(ROOT, "preview", "recolours-wall@1x.png"), encodeIndexedPng(wall.w, wall.h, wall.img, wall.palette));
  writeFileSync(join(ROOT, "preview", "recolours-wall@2x.png"), encodeIndexedPng(wall.w * 2, wall.h * 2, upscale(wall.img, wall.w, wall.h, 2), wall.palette));
}

/** Hair colours (OME-1436): the PLTE-swap table and a 4 × 6 (+ mixed hair × tint row) contact sheet at 1× and 2×. */
function buildHairs(): void {
  writeFileSync(join(ROOT, "avatars", "hairs.json"), JSON.stringify(hairsTable(), null, 1) + "\n");
  const c = hairSheet();
  writeFileSync(join(ROOT, "preview", "hairs-sheet@1x.png"), encodeIndexedPng(c.w, c.h, c.img, c.palette));
  writeFileSync(join(ROOT, "preview", "hairs-sheet@2x.png"), encodeIndexedPng(c.w * 2, c.h * 2, upscale(c.img, c.w, c.h, 2), c.palette));
}

mkdirSync(join(ROOT, "preview"), { recursive: true });
mkdirSync(join(ROOT, "src", "moodboards"), { recursive: true });
const avatarImages = buildAvatars();
buildScene(avatarImages);
buildRoom(avatarImages);
const furnitureSet = buildFurnitureSet(buildRoomFrames(), avatarImages);
const uiFrames = buildUi(avatarImages, furnitureSet.frames);
buildOwnerPreviews(furnitureSet, uiFrames);
buildPresets(furnitureSet);
buildMotion(avatarImages);
buildExpressions(avatarImages);
buildWatching(avatarImages, furnitureSet);
buildTints();
buildHairs();
buildRecolours();
for (const t of THEMES) buildTheme(t, avatarImages);
buildAccessories(avatarImages);
buildReactions();
buildStore();
buildSite({ room: buildRoomFrames(), avatars: avatarImages, ui: uiFrames });
console.log(`palette: ${String(PALETTE.length - 1)} colours`);
report();
