// Stage Door's and Reef's shell skins (assets/furniture/furniture-v9-shell, CC BY-SA 4.0, OME-2440). Its own chunk: stage.ts
// imports it only when usesV9Shell (OME-2442).
import * as v from "valibot";
import json from "../../../assets/furniture/furniture-v9-shell.json";
import pngUrl from "../../../assets/furniture/furniture-v9-shell.png?url";
import { loadSheet, once } from "./atlas-sheet";
import { FurnitureManifestSchema } from "./furniture";
import type { FurnitureAtlas } from "./furniture-atlas";

export const loadFurnitureV9ShellAtlas = once(async (): Promise<FurnitureAtlas> => {
  const manifest = v.parse(FurnitureManifestSchema, json);
  return { manifest, ...(await loadSheet(manifest.frames, pngUrl)) };
});
