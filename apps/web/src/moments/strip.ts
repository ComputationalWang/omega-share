import type { Reaction, ReactionKind } from "@omega/shared";

export const STRIP_BINS = 32;
export const STRIP_PIPS = 8;

export interface Pip {
  readonly mediaMs: number;
  readonly count: number;
  readonly kind: ReactionKind;
}

export interface Moments {
  readonly density: readonly number[];
  readonly pips: readonly Pip[];
}

export function moments(_reactions: readonly Reaction[], _durationMs: number): Moments {
  return { density: [], pips: [] };
}

export interface MomentsStrip {
  readonly root: HTMLElement;
  render(reactions: readonly Reaction[], durationMs: number): void;
  setControl(canSeek: boolean): void;
}

export function createMomentsStrip(_o: { readonly seek: (seconds: number) => boolean }): MomentsStrip {
  throw new Error("not implemented");
}
