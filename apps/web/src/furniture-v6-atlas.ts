// Dank Dungeon furniture atlas (assets/furniture/furniture-v6, CC BY-SA 4.0, OME-1670): bed, whirlpool, mirror, minibar, desk,
// washbasin. Its own chunk, like v4's: stage.ts imports it only when a layout uses one of them (OME-1672).
import * as v from "valibot";
import json from "../../../assets/furniture/furniture-v6.json";
import pngUrl from "../../../assets/furniture/furniture-v6.png?url";
import { loadSheet, once } from "./atlas-sheet";
import { FurnitureManifestSchema } from "./furniture";
import type { FurnitureAtlas } from "./furniture-atlas";

export const loadFurnitureV6Atlas = once(async (): Promise<FurnitureAtlas> => {
  const manifest = v.parse(FurnitureManifestSchema, json);
  return { manifest, ...(await loadSheet(manifest.frames, pngUrl)) };
});
