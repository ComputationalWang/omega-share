// Back-view atlas (assets/furniture/furniture-back, CC BY-SA 4.0, OME-1997): the turned frames of one-sided pieces and the
// north shell skin for the 180° view swap (OME-1961). Its own chunk: stage.ts imports it only when usesBack.
import * as v from "valibot";
import json from "../../../assets/furniture/furniture-back.json";
import pngUrl from "../../../assets/furniture/furniture-back.png?url";
import { loadSheet, once } from "./atlas-sheet";
import { FurnitureManifestSchema } from "./furniture";
import type { FurnitureAtlas } from "./furniture-atlas";

export const loadFurnitureBackAtlas = once(async (): Promise<FurnitureAtlas> => {
  const manifest = v.parse(FurnitureManifestSchema, json);
  return { manifest, ...(await loadSheet(manifest.frames, pngUrl)) };
});
