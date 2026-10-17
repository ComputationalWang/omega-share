// Set (a) avatars + set (d) motion + set (p) expressions sheets (assets/avatars, CC BY-SA 4.0). Its own chunk: room-view.ts imports it once
// the room has people in it (after join), so first paint and TTI never pay for it (ADR 0010).
import { ImageSource, Rectangle, Texture } from "pixi.js";
import { TINT_COUNT } from "@omega/shared";
import avatarsJson from "../../../../assets/avatars/avatars.json";
import avatarsPng from "../../../../assets/avatars/avatars.png?url";
import expressionsJson from "../../../../assets/avatars/expressions.json";
import expressionsPng from "../../../../assets/avatars/expressions.png?url";
import motionJson from "../../../../assets/avatars/motion.json";
import motionPng from "../../../../assets/avatars/motion.png?url";
import tintsJson from "../../../../assets/avatars/tints.json";
import { parseMotion, type FrameRects, type MotionFrames } from "./motion";
import { AVATAR_IDS, parseTints, retintPng } from "./tint";

export interface MotionAtlas {
  readonly frames: MotionFrames;
  /** The frame's texture with its anchor, made on first use; `avatar`'s frame in shirt `tint` once `loadTint` resolved. */
  texture(key: string, avatar?: number, tint?: number): Texture | undefined;
  /** Whether `texture` gives `avatar`'s frames in `tint` yet (tint 0 always). */
  ready(avatar: number, tint: number): boolean;
  /** Makes `avatar`'s sheets in shirt `tint` (ADR 0053), once; a failed load is forgotten so a later call can retry. */
  loadTint(avatar: number, tint: number): Promise<void>;
}

let loading: Promise<MotionAtlas> | null = null;

/** Loads once; a failed load is forgotten so a later call can retry. */
export function loadMotionAtlas(): Promise<MotionAtlas> {
  loading ??= load().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

async function source(img: HTMLImageElement | ImageBitmap): Promise<ImageSource> {
  if (img instanceof HTMLImageElement) await img.decode();
  return new ImageSource({ resource: img, scaleMode: "nearest" });
}

function image(url: string): HTMLImageElement {
  const img = new Image();
  img.src = url;
  return img;
}

interface Sheet {
  readonly rects: FrameRects;
  readonly src: ImageSource;
}

/** One set of sheets (the shipped one, or an avatar's tint): textures made on first use. */
function textures(sheets: readonly Sheet[]): (key: string) => Texture | undefined {
  const cache = new Map<string, Texture>();
  return (key) => {
    let t = cache.get(key);
    if (t !== undefined) return t;
    for (const { rects, src } of sheets) {
      const f = rects[key];
      if (f === undefined) continue;
      const { x, y, w, h } = f.frame;
      t = new Texture({ source: src, frame: new Rectangle(x, y, w, h), defaultAnchor: f.anchor });
      cache.set(key, t);
      return t;
    }
    return undefined;
  };
}

async function load(): Promise<MotionAtlas> {
  const frames = parseMotion(motionJson, avatarsJson, expressionsJson);
  const tints = parseTints(tintsJson, AVATAR_IDS);
  const urls = [motionPng, avatarsPng, expressionsPng] as const;
  const rects = [frames.sheets.motion, frames.sheets.avatars, frames.sheets.expressions] as const;
  const srcs = await Promise.all(urls.map((u) => source(image(u))));
  const base = textures(srcs.map((src, i) => ({ rects: rects[i] ?? {}, src })));
  // Per avatar × tint (index avatar * TINT_COUNT + tint): numeric, so the draw path allocates nothing.
  // shortcut: a tint copies the three whole sheets (~3.5 MB decoded); crop to the avatar's own frames if rooms get big.
  const tinted: ((key: string) => Texture | undefined)[] = [];
  const loading = new Map<number, Promise<void>>();
  let bytes: Promise<Uint8Array[]> | null = null;
  const sheetBytes = (): Promise<Uint8Array[]> =>
    (bytes ??= Promise.all(urls.map(async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer()))).catch((e: unknown) => {
      bytes = null;
      throw e;
    }));
  return {
    frames,
    texture(key, avatar = 0, tint = 0) {
      return (tint === 0 ? undefined : tinted[avatar * TINT_COUNT + tint]?.(key)) ?? base(key);
    },
    ready: (avatar, tint) => tint === 0 || tinted[avatar * TINT_COUNT + tint] !== undefined,
    loadTint(avatar, tint) {
      const i = avatar * TINT_COUNT + tint;
      const a = tints[avatar];
      const ramp = a?.tints[tint];
      if (tint === 0 || tinted[i] !== undefined || a === undefined || ramp === undefined) return Promise.resolve();
      let p = loading.get(i);
      if (p === undefined) {
        p = sheetBytes()
          .then((all) => Promise.all(all.map(async (png) => source(await createImageBitmap(new Blob([retintPng(png, a.slots, ramp.colors)], { type: "image/png" }))))))
          .then((s) => {
            tinted[i] = textures(s.map((src, n) => ({ rects: rects[n] ?? {}, src })));
          })
          .finally(() => loading.delete(i));
        loading.set(i, p);
      }
      return p;
    },
  };
}
