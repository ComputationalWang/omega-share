// Wave 2 shell skins (assets/furniture/furniture-v8-shell, CC BY-SA 4.0, OME-2066): the penthouse and studio floors and walls. Its own chunk,
// like v7s: stage.ts imports it only when usesV8Shell (OME-2455).
import * as v from "valibot";
import json from "../../../assets/furniture/furniture-v8-shell.json";
import pngUrl from "../../../assets/furniture/furniture-v8-shell.png?url";
import { loadSheet, once } from "./atlas-sheet";
import { FurnitureManifestSchema } from "./furniture";
import type { FurnitureAtlas } from "./furniture-atlas";

export const loadFurnitureV8ShellAtlas = once(async (): Promise<FurnitureAtlas> => {
  const manifest = v.parse(FurnitureManifestSchema, json);
  return { manifest, ...(await loadSheet(manifest.frames, pngUrl)) };
});
