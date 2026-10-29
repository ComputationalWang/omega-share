// The editor's colour names per piece (its swatches and tray thumbs), from the catalogue manifests. Pure, no Pixi.
import * as v from "valibot";
import type { FurnitureKind } from "@omega/shared";
import furnitureJson from "../../../../assets/furniture/furniture.json";
import furnitureV2Json from "../../../../assets/furniture/furniture-v2.json";
import furnitureV4Json from "../../../../assets/furniture/furniture-v4.json";
import furnitureV5Json from "../../../../assets/furniture/furniture-v5.json";
import furnitureV7Json from "../../../../assets/furniture/furniture-v7.json";
import { FurnitureManifestSchema, V7_COLOURS } from "../furniture";
import { recolourIds } from "../recolours";

/** Colour names per catalogue piece, set (g), v2, batch 6 and the theatre set (the kilim runner is atlas id `rug`); the room atlas pieces have none. */
const COLOURS = new Map<string, readonly string[]>(
  [furnitureJson, furnitureV2Json, furnitureV4Json, furnitureV5Json].flatMap((json) => v.parse(FurnitureManifestSchema, json).meta.omega.pieces.map((p) => [p.id, p.colours] as const)),
);
// v7 (OME-1991): its own kinds, and the colours it adds right after an older sheet's (carpet's oval). The tray doesn't offer the
// older kinds whose sheets (v6) aren't imported here (mirror, minibar, partition) or the tv (OME-1994), so those are skipped.
for (const p of v.parse(FurnitureManifestSchema, furnitureV7Json).meta.omega.pieces) {
  const first = V7_COLOURS[`${p.id}/${p.colours[0] ?? ""}`];
  const have = COLOURS.get(p.id) ?? [];
  if (first === undefined) COLOURS.set(p.id, p.colours);
  else if (first === have.length && have.length > 0) COLOURS.set(p.id, [...have, ...p.colours]);
}
export const atlasId = (kind: FurnitureKind): string | null => {
  if (kind === "armchair" || kind === "tv" || kind === "lamp" || kind === "plant" || kind === "rug") return null;
  return kind === "runner" ? "rug" : kind;
};
/** The room atlas pieces' one shipped look, named for its swatch (OME-1463, OME-1688). */
const ROOM_SHIPPED: Partial<Record<FurnitureKind, string>> = { rug: "navy", lamp: "cream", plant: "rust" };
/** A piece's colours by variant: its shipped ones, then its recolours. */
export const coloursOf = (kind: FurnitureKind): readonly string[] => {
  const id = atlasId(kind);
  const extra = recolourIds(kind);
  const room = ROOM_SHIPPED[kind];
  const shipped = id === null ? (extra.length > 0 && room !== undefined ? [room] : []) : (COLOURS.get(id) ?? []);
  return [...shipped, ...extra];
};
