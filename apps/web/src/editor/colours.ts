// The editor's colour names per piece (its swatches and tray thumbs), from the catalogue manifests. Pure, no Pixi.
import * as v from "valibot";
import type { FurnitureKind } from "@omega/shared";
import furnitureJson from "../../../../assets/furniture/furniture.json";
import furnitureV2Json from "../../../../assets/furniture/furniture-v2.json";
import furnitureV4Json from "../../../../assets/furniture/furniture-v4.json";
import { FurnitureManifestSchema } from "../furniture";

/** Colour names per catalogue piece, set (g), v2 and batch 6 (the kilim runner is atlas id `rug`); the room atlas pieces have none. */
const COLOURS: ReadonlyMap<string, readonly string[]> = new Map(
  [furnitureJson, furnitureV2Json, furnitureV4Json].flatMap((json) => v.parse(FurnitureManifestSchema, json).meta.omega.pieces.map((p) => [p.id, p.colours] as const)),
);
export const atlasId = (kind: FurnitureKind): string | null => {
  if (kind === "armchair" || kind === "tv" || kind === "lamp" || kind === "plant" || kind === "rug") return null;
  return kind === "runner" ? "rug" : kind;
};
export const coloursOf = (kind: FurnitureKind): readonly string[] => {
  const id = atlasId(kind);
  return id === null ? [] : (COLOURS.get(id) ?? []);
};
