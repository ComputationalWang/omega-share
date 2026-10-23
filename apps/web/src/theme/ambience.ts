// Mood ambience (OME-1689): stub for the red commit.
import type { RoomMood } from "@omega/shared";
import type { EffectFrame, EffectMotion } from "./effect";
import type { ThemeId } from "./periods";

export interface Ambience {
  readonly kind: "snow" | "dust";
  readonly frames: readonly EffectFrame[];
  readonly ms: number;
  readonly max: number;
  readonly motion: EffectMotion;
  readonly w: number;
  readonly h: number;
  art(g: { fillStyle: string | CanvasGradient | CanvasPattern; fillRect(x: number, y: number, w: number, h: number): void }): void;
}

export function ambienceFor(_mood: RoomMood, _theme: ThemeId | null, _motionOk: boolean): Ambience | null {
  return null;
}
