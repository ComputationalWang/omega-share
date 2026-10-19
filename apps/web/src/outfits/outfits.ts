// Outfit slots (OME-1453): three saved looks (avatar, tint, hair, accessory) in localStorage. Stored values are untrusted
// (anyone can edit localStorage): each slot is parsed at read and a bad one is an empty slot.
import * as v from "valibot";
import { AccessorySchema, AvatarSchema, HairSchema, TintSchema } from "@omega/shared";
import type { KeyValueStore } from "../profile";

export const OUTFIT_SLOTS = 3;
const KEY = "omega.outfits";

const OutfitSchema = v.object({ avatar: AvatarSchema, tint: TintSchema, hair: HairSchema, accessory: AccessorySchema });
export type Outfit = v.InferOutput<typeof OutfitSchema>;

export function readOutfits(store: KeyValueStore): (Outfit | null)[] {
  let raw: unknown = null;
  try {
    raw = JSON.parse(store.getItem(KEY) ?? "null");
  } catch {
    // Blocked storage or not JSON: all empty.
  }
  const list: readonly unknown[] = Array.isArray(raw) ? raw : [];
  return Array.from({ length: OUTFIT_SLOTS }, (_, i) => {
    const r = v.safeParse(OutfitSchema, list[i]);
    return r.success ? r.output : null;
  });
}

/** Writes `slot`, keeping the others; false when storage refuses. */
export function saveOutfit(store: KeyValueStore, slot: number, outfit: Outfit): boolean {
  const all = readOutfits(store);
  all[slot] = outfit;
  try {
    store.setItem(KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}
