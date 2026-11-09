// Rooms wave 26 furniture atlas (assets/furniture/furniture-v9, CC BY-SA 4.0, OME-2440): the stage riser, dressing table,
// costume rail and the partition's colours 4–7 with their loops. Its own chunk: stage.ts imports it only when usesV9 (OME-2442).
import * as v from "valibot";
import json from "../../../assets/furniture/furniture-v9.json";
import pngUrl from "../../../assets/furniture/furniture-v9.png?url";
import { loadSheet, once } from "./atlas-sheet";
import { FurnitureManifestSchema } from "./furniture";
import type { FurnitureAtlas } from "./furniture-atlas";

export const loadFurnitureV9Atlas = once(async (): Promise<FurnitureAtlas> => {
  const manifest = v.parse(FurnitureManifestSchema, json);
  return { manifest, ...(await loadSheet(manifest.frames, pngUrl)) };
});
