// Theatre set v2 atlas (assets/furniture/furniture-v5, CC BY-SA 4.0, OME-1639): theatre rows on risers, curtain, big
// screen, aisle lights, carpet. Its own chunk, like v4's: stage.ts imports it only when a layout uses one of them (OME-1630).
import * as v from "valibot";
import json from "../../../assets/furniture/furniture-v5.json";
import pngUrl from "../../../assets/furniture/furniture-v5.png?url";
import { loadSheet, once } from "./atlas-sheet";
import { FurnitureManifestSchema } from "./furniture";
import type { FurnitureAtlas } from "./furniture-atlas";

export const loadFurnitureV5Atlas = once(async (): Promise<FurnitureAtlas> => {
  const manifest = v.parse(FurnitureManifestSchema, json);
  return { manifest, ...(await loadSheet(manifest.frames, pngUrl)) };
});
