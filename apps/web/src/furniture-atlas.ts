// Set (g) furniture atlas (assets/furniture, CC BY-SA 4.0). Its own chunk: room.ts imports it only when a layout uses a
// set (g) piece, so the default room never fetches the sheet (assets/README.md "Furniture atlas").
import * as v from "valibot";
import { ImageSource, Rectangle, Texture } from "pixi.js";
import json from "../../../assets/furniture/furniture.json";
import pngUrl from "../../../assets/furniture/furniture.png?url";
import { FurnitureManifestSchema, type FurnitureManifest } from "./furniture";

export interface FurnitureAtlas {
  readonly manifest: FurnitureManifest;
  /** The frame's texture with its anchor, made on first use. */
  texture(key: string): Texture | undefined;
}

let loading: Promise<FurnitureAtlas> | null = null;

/** Loads once; a failed load is forgotten so the next layout change can retry. */
export function loadFurnitureAtlas(): Promise<FurnitureAtlas> {
  loading ??= load().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

async function load(): Promise<FurnitureAtlas> {
  const manifest = v.parse(FurnitureManifestSchema, json);
  const img = new Image();
  img.src = pngUrl;
  await img.decode();
  const source = new ImageSource({ resource: img, scaleMode: "nearest" });
  const cache = new Map<string, Texture>();
  return {
    manifest,
    texture(key) {
      let t = cache.get(key);
      const f = manifest.frames[key];
      if (t === undefined && f !== undefined) {
        const { x, y, w, h } = f.frame;
        t = new Texture({ source, frame: new Rectangle(x, y, w, h), defaultAnchor: f.anchor });
        cache.set(key, t);
      }
      return t;
    },
  };
}
