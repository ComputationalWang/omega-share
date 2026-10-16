// The theme's background effect (OME-1186, ADR 0052): a fixed pool of particles drifting through an area and wrapping
// round it. Positions are whole pixels; step() writes into the same typed arrays, so a frame allocates nothing. Pure:
// room-view.ts draws them with one sprite each, all frames from one texture.
import type { Rect } from "../layout";

/** The effect's sprite cap (perf rule, plan OME-1140). */
export const MAX_EFFECT_SPRITES = 40;
/** The effect loop's shortest frame gap: at most ~30 Hz, whatever the screen's refresh rate. */
export const EFFECT_MIN_INTERVAL_MS = 33;
/** How far past the area a particle goes before it wraps in at the other side (an effect sprite is ≤ 16 px). */
const MARGIN = 16;

export interface EffectMotion {
  /** Where the particles drift (stage px). */
  readonly area: Rect;
  /** Speed ranges, px/s. */
  readonly vx: readonly [number, number];
  readonly vy: readonly [number, number];
  /** Half of them go left (vx negated); those are drawn mirrored (effect frames face right). */
  readonly flipX: boolean;
}

export interface Particles {
  readonly count: number;
  /** Where each is drawn now, whole stage px. */
  readonly x: Int32Array;
  readonly y: Int32Array;
  /** 1: going left, draw mirrored. */
  readonly flip: Uint8Array;
  /** Frame offset, so they don't flap in step. */
  readonly phase: Uint8Array;
  step(dtMs: number): void;
}

const between = (r: readonly [number, number], rand: () => number): number => r[0] + (r[1] - r[0]) * rand();

/** Wrap `p` into [lo − MARGIN, hi + MARGIN). */
const wrap = (p: number, lo: number, hi: number): number => {
  const span = hi - lo + 2 * MARGIN;
  return ((((p - lo + MARGIN) % span) + span) % span) + lo - MARGIN;
};

export function createParticles(motion: EffectMotion, count: number, rand: () => number): Particles {
  const n = Math.max(0, Math.min(MAX_EFFECT_SPRITES, Math.floor(count)));
  const { area } = motion;
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const x = new Int32Array(n);
  const y = new Int32Array(n);
  const flip = new Uint8Array(n);
  const phase = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    fx[i] = area.x + area.w * rand();
    fy[i] = area.y + area.h * rand();
    const left = motion.flipX && rand() < 0.5;
    vx[i] = between(motion.vx, rand) * (left ? -1 : 1);
    vy[i] = between(motion.vy, rand);
    flip[i] = left ? 1 : 0;
    phase[i] = Math.floor(rand() * 4);
    x[i] = Math.round(fx[i] ?? 0);
    y[i] = Math.round(fy[i] ?? 0);
  }
  return {
    count: n,
    x,
    y,
    flip,
    phase,
    step(dtMs) {
      const dt = dtMs / 1000;
      for (let i = 0; i < n; i++) {
        const px = wrap((fx[i] ?? 0) + (vx[i] ?? 0) * dt, area.x, area.x + area.w);
        const py = wrap((fy[i] ?? 0) + (vy[i] ?? 0) * dt, area.y, area.y + area.h);
        fx[i] = px;
        fy[i] = py;
        x[i] = Math.round(px);
        y[i] = Math.round(py);
      }
    },
  };
}

/** One effect frame in the theme sheet: its rect, and its anchor in px from the rect's top-left. */
export interface EffectFrame {
  readonly sx: number;
  readonly sy: number;
  readonly w: number;
  readonly h: number;
  readonly ox: number;
  readonly oy: number;
}

/** The part of CanvasRenderingContext2D the painter uses: no reads (QA OME-1212). */
export interface EffectContext {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

export interface EffectPainterOptions {
  /** The overlay canvas's context, at 1 px per stage px. */
  readonly ctx: EffectContext;
  readonly image: CanvasImageSource;
  readonly frames: readonly EffectFrame[];
  /** The overlay's top-left on the stage. */
  readonly origin: { readonly x: number; readonly y: number };
}

export interface EffectPainter {
  paint(p: Particles, step: number): void;
  clear(): void;
}

/** Stub (red). */
export function createEffectPainter(_o: EffectPainterOptions): EffectPainter {
  return { paint: () => undefined, clear: () => undefined };
}

/** Stub (red). */
export function effectBounds(_motion: EffectMotion, _frames: readonly EffectFrame[]): Rect {
  return { x: 0, y: 0, w: 0, h: 0 };
}
