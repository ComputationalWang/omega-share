// The 2 extra colours of six pieces (OME-1463, art OME-1462): a runtime PLTE swap of a sheet, per assets/furniture/recolours.json.
import type { FurnitureKind, RoomLayout } from "@omega/shared";

export interface Recolour {
  readonly sheet: string;
  readonly frames: string;
  readonly id: string;
  readonly slots: readonly number[];
  readonly colors: readonly string[];
}

export function recolourOf(_kind: FurnitureKind, _variant: number): Recolour | undefined {
  return undefined;
}

export function recolourSource(_key: string): { kind: FurnitureKind; variant: number; key: string } | null {
  return null;
}

export function recoloursIn(_layout: RoomLayout): readonly { kind: FurnitureKind; variant: number }[] {
  return [];
}
