import type { Accessory, Avatar, Hair, Tint } from "@omega/shared";
import type { KeyValueStore } from "../profile";

export const OUTFIT_SLOTS = 3;

export interface Outfit {
  readonly avatar: Avatar;
  readonly tint: Tint;
  readonly hair: Hair;
  readonly accessory: Accessory;
}

// Red stubs (OME-1453).
export const readOutfits: (store: KeyValueStore) => (Outfit | null)[] = () => [];
export const saveOutfit: (store: KeyValueStore, slot: number, outfit: Outfit) => boolean = () => false;
