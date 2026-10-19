// The 2 extra colours of six pieces (OME-1463, art OME-1462): a runtime PLTE swap of a sheet, per
// assets/furniture/recolours.json. A recoloured piece draws its source colour's frames from a copy of the sheet with the
// swap applied, under the key `recolour/<kind>/<variant>/<source key>` (no shipped frame starts with `recolour/`). Pure, no Pixi.
import * as v from "valibot";
import { FURNITURE_KINDS, type FurnitureKind, type RoomLayout } from "@omega/shared";
import json from "../../../assets/furniture/recolours.json";

const HexSchema = v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/));
const SlotSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255));
const SheetSchema = v.picklist(["furniture/furniture.png", "furniture/furniture-v2.png", "furniture/furniture-v4.png", "room/room.png"]);
const RecoloursSchema = v.object({
  kinds: v.record(
    v.picklist(FURNITURE_KINDS),
    v.object({
      sheet: SheetSchema,
      frames: v.string(),
      slots: v.array(SlotSchema),
      variants: v.array(v.object({ variant: v.pipe(v.number(), v.integer(), v.minValue(1)), id: v.pipe(v.string(), v.regex(/^[a-z]+$/)), colors: v.array(HexSchema) })),
    }),
  ),
});

export type RecolourSheet = v.InferOutput<typeof SheetSchema>;

export interface Recolour {
  /** The sheet the swap is for, as the table names it. */
  readonly sheet: RecolourSheet;
  /** The source colour's key prefix in that sheet. */
  readonly frames: string;
  /** The swatch name. */
  readonly id: string;
  readonly slots: readonly number[];
  readonly colors: readonly string[];
}

const KINDS = v.parse(RecoloursSchema, json).kinds;

export function recolourOf(kind: FurnitureKind, variant: number): Recolour | undefined {
  const k = KINDS[kind];
  const r = k?.variants.find((x) => x.variant === variant);
  return k === undefined || r === undefined ? undefined : { sheet: k.sheet, frames: k.frames, id: r.id, slots: k.slots, colors: r.colors };
}

/** The new colours' swatch names for `kind`, in variant order (after its shipped ones). */
export const recolourIds = (kind: FurnitureKind): readonly string[] => KINDS[kind]?.variants.map((x) => x.id) ?? [];

/** The key a recoloured piece draws `key` (its source colour's frame) under. */
export const recolourKey = (kind: FurnitureKind, variant: number, key: string): string => `recolour/${kind}/${String(variant)}/${key}`;

const KEY = /^recolour\/([a-z]+)\/(\d+)\/(.+)$/;

/** The recolour and source frame a `recolourKey` names; null for any other key. */
export function recolourSource(key: string): { kind: FurnitureKind; variant: number; key: string } | null {
  const m = KEY.exec(key);
  const kind = FURNITURE_KINDS.find((k) => k === m?.[1]);
  const variant = Number(m?.[2]);
  const source = m?.[3];
  if (kind === undefined || source === undefined || recolourOf(kind, variant) === undefined) return null;
  return { kind, variant, key: source };
}

/** The recoloured copies `layout` draws from, each once, in layout order. */
export function recoloursIn(layout: RoomLayout): readonly { kind: FurnitureKind; variant: number }[] {
  const out: { kind: FurnitureKind; variant: number }[] = [];
  for (const { kind, variant = 0 } of layout.furniture) {
    if (recolourOf(kind, variant) !== undefined && !out.some((x) => x.kind === kind && x.variant === variant)) out.push({ kind, variant });
  }
  return out;
}
