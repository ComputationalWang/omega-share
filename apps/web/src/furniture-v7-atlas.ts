// Dank Dungeon v7 furniture atlas (assets/furniture/furniture-v7, CC BY-SA 4.0, OME-1977): sauna, soaktub, lounger, v7 colours of
// older kinds and the shell skin. Its own chunk, like v6's: stage.ts imports it only when usesV7 (OME-1991).
import * as v from "valibot";
import json from "../../../assets/furniture/furniture-v7.json";
import pngUrl from "../../../assets/furniture/furniture-v7.png?url";
import { loadSheet, once } from "./atlas-sheet";
import { FurnitureManifestSchema } from "./furniture";
import type { FurnitureAtlas } from "./furniture-atlas";

export const loadFurnitureV7Atlas = once(async (): Promise<FurnitureAtlas> => {
  const manifest = v.parse(FurnitureManifestSchema, json);
  return { manifest, ...(await loadSheet(manifest.frames, pngUrl)) };
});
