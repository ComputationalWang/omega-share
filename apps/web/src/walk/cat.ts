// The room cat wanders (OME-1520). Stub: the red commit.
export const CAT_SLOT_MS = 20_000;
export const CAT_RANGE = 3;

export function catSeed(_roomId: string, _piece: number, _slot: number): number {
  return 0;
}

export function catMove(_grid: Uint8Array, _home: number, from: number, _seed: number, _taken: ReadonlySet<number>): number[] {
  return [from];
}
