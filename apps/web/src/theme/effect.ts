// The theme's background effect (OME-1186). Stub.
import type { Rect } from "../layout";

export const MAX_EFFECT_SPRITES = 0;
export const EFFECT_MIN_INTERVAL_MS = 0;

export interface EffectMotion {
  readonly area: Rect;
  readonly vx: readonly [number, number];
  readonly vy: readonly [number, number];
  readonly flipX: boolean;
}

export interface Particles {
  readonly count: number;
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly flip: Uint8Array;
  step(dtMs: number): void;
}

export function createParticles(_motion: EffectMotion, _count: number, _rand: () => number): Particles {
  return { count: 0, x: new Int32Array(0), y: new Int32Array(0), flip: new Uint8Array(0), step: () => undefined };
}
