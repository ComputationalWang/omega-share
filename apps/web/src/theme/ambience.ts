// Mood ambience (OME-1689): the room mood's own particles, on the theme effect's one pool and overlay (ADR 0052). Night
// snows, Warm floats dust motes; None and Cool have none. A holiday theme's effect owns the pool, so ambience never adds
// sprites next to it. The art is a few drawn pixels, no sheet to fetch. Pure.
import type { RoomMood } from "@omega/shared";
import { EFFECT_BAND, type EffectFrame, type EffectMotion } from "./effect";
import type { ThemeId } from "./periods";

export interface Ambience {
  readonly kind: "snow" | "dust";
  /** Frames side by side in a `w` × `h` art canvas; they face right. */
  readonly frames: readonly EffectFrame[];
  /** ms per frame. */
  readonly ms: number;
  /** How many sprites (≤ MAX_EFFECT_SPRITES). */
  readonly max: number;
  readonly motion: EffectMotion;
  readonly w: number;
  readonly h: number;
  /** Draws the frames on the art canvas. */
  art(g: { fillStyle: string | CanvasGradient | CanvasPattern; fillRect(x: number, y: number, w: number, h: number): void }): void;
}

/** A 3 px plus and a 2 px dot, falling and swaying. */
const SNOW: Ambience = {
  kind: "snow",
  frames: [
    { sx: 0, sy: 0, w: 3, h: 3, ox: 1, oy: 1 },
    { sx: 3, sy: 0, w: 2, h: 2, ox: 1, oy: 1 },
  ],
  ms: 400,
  max: 28,
  motion: { area: EFFECT_BAND, vx: [-8, 8], vy: [18, 36], flipX: false },
  w: 5,
  h: 3,
  art(g) {
    g.fillStyle = "#f4f8ff";
    g.fillRect(1, 0, 1, 3);
    g.fillRect(0, 1, 3, 1);
    g.fillRect(3, 0, 2, 2);
  },
};

/** A 2 px and a 1 px mote, rising slowly through the warm light. */
const DUST: Ambience = {
  kind: "dust",
  frames: [
    { sx: 0, sy: 0, w: 2, h: 2, ox: 1, oy: 1 },
    { sx: 2, sy: 0, w: 1, h: 1, ox: 0, oy: 0 },
  ],
  ms: 700,
  max: 16,
  motion: { area: EFFECT_BAND, vx: [-5, 5], vy: [-7, -2], flipX: false },
  w: 3,
  h: 2,
  art(g) {
    g.fillStyle = "rgba(255, 226, 168, 0.7)";
    g.fillRect(0, 0, 2, 2);
    g.fillRect(2, 0, 1, 1);
  },
};

const BY_MOOD: Readonly<Record<RoomMood, Ambience | null>> = { none: null, warm: DUST, cool: null, night: SNOW };

/** The mood's ambience, or null: with a holiday theme (its effect owns the pool), or when motion is off (reduced motion, Basic tier). */
export function ambienceFor(mood: RoomMood, theme: ThemeId | null, motionOk: boolean): Ambience | null {
  return theme !== null || !motionOk ? null : BY_MOOD[mood];
}
