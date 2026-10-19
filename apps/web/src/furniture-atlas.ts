// Set (g) furniture atlas (assets/furniture, CC BY-SA 4.0). Its own chunk: stage.ts imports it only when a layout uses a
// set (g) piece, so the default room never fetches the sheet (assets/README.md "Furniture atlas").
import * as v from "valibot";
import json from "../../../assets/furniture/furniture.json";
import pngUrl from "../../../assets/furniture/furniture.png?url";
import { loadSheet, once, type Sheet } from "./atlas-sheet";
import { FurnitureManifestSchema, type FurnitureManifest } from "./furniture";

export interface FurnitureAtlas extends Sheet {
  /** The sheet's URL: a recolour (OME-1463) swaps a copy of its bytes. */
  readonly url: string;
  readonly manifest: FurnitureManifest;
}

export const loadFurnitureAtlas = once(async (): Promise<FurnitureAtlas> => {
  const manifest = v.parse(FurnitureManifestSchema, json);
  return { manifest, ...(await loadSheet(manifest.frames, pngUrl)) };
});
