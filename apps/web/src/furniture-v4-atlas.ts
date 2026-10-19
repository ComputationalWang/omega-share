// Batch 6 furniture atlas (assets/furniture/furniture-v4, CC BY-SA 4.0, OME-1437): hammock, stool, bar counter, piano,
// fireplace. Its own chunk, like v2's: stage.ts imports it only when a layout uses one of them (OME-1439).
import * as v from "valibot";
import json from "../../../assets/furniture/furniture-v4.json";
import pngUrl from "../../../assets/furniture/furniture-v4.png?url";
import { loadSheet, once } from "./atlas-sheet";
import { FurnitureManifestSchema } from "./furniture";
import type { FurnitureAtlas } from "./furniture-atlas";

export const loadFurnitureV4Atlas = once(async (): Promise<FurnitureAtlas> => {
  const manifest = v.parse(FurnitureManifestSchema, json);
  return { manifest, ...(await loadSheet(manifest.frames, pngUrl)) };
});
