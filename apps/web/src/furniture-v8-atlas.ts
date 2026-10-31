// Wave 2 furniture atlas (assets/furniture/furniture-v8, CC BY-SA 4.0, OME-2066): the wall screens (and, later, ambient loops). Its own chunk,
// like v7s: stage.ts imports it only when usesV8 (OME-2069).
import * as v from "valibot";
import json from "../../../assets/furniture/furniture-v8.json";
import pngUrl from "../../../assets/furniture/furniture-v8.png?url";
import { loadSheet, once } from "./atlas-sheet";
import { FurnitureManifestSchema } from "./furniture";
import type { FurnitureAtlas } from "./furniture-atlas";

export const loadFurnitureV8Atlas = once(async (): Promise<FurnitureAtlas> => {
  const manifest = v.parse(FurnitureManifestSchema, json);
  return { manifest, ...(await loadSheet(manifest.frames, pngUrl)) };
});
