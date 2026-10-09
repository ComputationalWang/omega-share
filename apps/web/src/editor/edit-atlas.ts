// Set (h) owner edit kit (assets/ui/edit.png + edit.json, CC BY-SA 4.0): the grid and footprint markers the editor draws in the
// room. Part of the lazy editor chunk, so only an owner who presses "Edit room" ever fetches it (assets/README.md "Set (h)").
import * as v from "valibot";
import { ImageSource, Rectangle, Texture } from "pixi.js";
import json from "../../../../assets/ui/edit.json";
import pngUrl from "../../../../assets/ui/edit.png?url";

const XY = v.object({ x: v.number(), y: v.number() });
const EditAtlasSchema = v.object({
  frames: v.record(v.string(), v.object({ frame: v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() }), anchor: XY })),
});

export interface EditAtlas {
  /** The frame's texture with its anchor, made on first use. */
  texture(key: string): Texture | undefined;
}

let loading: Promise<EditAtlas> | null = null;

/** Loads once; a failed load is forgotten so the next "Edit room" retries. */
export function loadEditAtlas(): Promise<EditAtlas> {
  loading ??= load().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

async function load(): Promise<EditAtlas> {
  const { frames } = v.parse(EditAtlasSchema, json);
  const img = new Image();
  img.src = pngUrl;
  await img.decode();
  const source = new ImageSource({ resource: img, scaleMode: "nearest" });
  const cache = new Map<string, Texture>();
  return {
    texture(key) {
      let t = cache.get(key);
      const f = frames[key];
      if (t === undefined && f !== undefined) {
        const { x, y, w, h } = f.frame;
        t = new Texture({ source, frame: new Rectangle(x, y, w, h), defaultAnchor: f.anchor });
        cache.set(key, t);
      }
      return t;
    },
  };
}
