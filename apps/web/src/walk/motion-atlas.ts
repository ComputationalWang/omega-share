// Set (a) avatars + set (d) motion sheets (assets/avatars, CC BY-SA 4.0). Its own chunk: room-view.ts imports it once
// the room has people in it (after join), so first paint and TTI never pay for it (ADR 0010).
import { ImageSource, Rectangle, Texture } from "pixi.js";
import avatarsJson from "../../../../assets/avatars/avatars.json";
import avatarsPng from "../../../../assets/avatars/avatars.png?url";
import motionJson from "../../../../assets/avatars/motion.json";
import motionPng from "../../../../assets/avatars/motion.png?url";
import { parseMotion, type MotionFrames } from "./motion";

export interface MotionAtlas {
  readonly frames: MotionFrames;
  /** The frame's texture with its anchor, made on first use. */
  texture(key: string): Texture | undefined;
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

async function source(url: string): Promise<ImageSource> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return new ImageSource({ resource: img, scaleMode: "nearest" });
}

async function load(): Promise<MotionAtlas> {
  const frames = parseMotion(motionJson, avatarsJson);
  const [motionSrc, avatarsSrc] = await Promise.all([source(motionPng), source(avatarsPng)]);
  const sheets = [
    { rects: frames.sheets.motion, src: motionSrc },
    { rects: frames.sheets.avatars, src: avatarsSrc },
  ];
  const cache = new Map<string, Texture>();
  return {
    frames,
    texture(key) {
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
    },
  };
}
