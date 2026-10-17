// Shirt tints (ADR 0053, art OME-1347): a tint is a PLTE swap of the avatar sheets. Pure, no Pixi.
export interface TintRamp {
  readonly id: string;
  /** Highlight, base, shade. */
  readonly colors: readonly [string, string, string];
}

export interface AvatarTints {
  /** The PLTE entries of the avatar's swatch ramp (highlight, base, shade). */
  readonly slots: readonly [number, number, number];
  /** TINT_COUNT ramps; [0] is the shipped look. */
  readonly tints: readonly TintRamp[];
}

export function parseTints(_json: unknown, _ids: readonly string[]): readonly AvatarTints[] {
  throw new Error("todo");
}

export function retintPng(_png: Uint8Array, _slots: readonly number[], _colors: readonly string[]): Uint8Array {
  throw new Error("todo");
}
