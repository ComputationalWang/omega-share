// Reaction glyph bursts (OME-1631). Red stub.
import type { ReactionKind } from "@omega/shared";
import type { Point } from "../layout";

export const GLYPH_POOL = 12;
export const GLYPHS_PER_BURST = 3;
export const GLYPH_LIFE_MS = 900;

export const reactionIcon = (_kind: ReactionKind): string => "";

export interface GlyphOptions {
  readonly allowed: () => boolean;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (h: unknown) => void;
}

export interface ReactionGlyphs {
  burst(at: Point, kind: ReactionKind): number;
  live(): number;
  destroy(): void;
}

export function createReactionGlyphs(_layer: HTMLElement, _o: GlyphOptions): ReactionGlyphs {
  throw new Error("not implemented");
}
