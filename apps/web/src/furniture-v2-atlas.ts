// Catalogue v2 furniture atlas (assets/furniture/furniture-v2, CC BY-SA 4.0, OME-1103). Its own chunk, like set (g)'s:
// stage.ts imports it only when a layout uses a v2 piece, so v1-only rooms never fetch it (OME-1113).
import * as v from "valibot";
import json from "../../../assets/furniture/furniture-v2.json";
import pngUrl from "../../../assets/furniture/furniture-v2.png?url";
import { loadSheet, once } from "./atlas-sheet";
import { FurnitureManifestSchema } from "./furniture";
import type { FurnitureAtlas } from "./furniture-atlas";

export const loadFurnitureV2Atlas = once(async (): Promise<FurnitureAtlas> => {
  const manifest = v.parse(FurnitureManifestSchema, json);
  return { manifest, ...(await loadSheet(manifest.frames, pngUrl)) };
});
