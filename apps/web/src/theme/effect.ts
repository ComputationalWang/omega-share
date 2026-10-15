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

/** The part of CanvasRenderingContext2D the painter uses. */
export interface EffectContext {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

export interface EffectPainter {
  paint(p: Particles, step: number): void;
  clear(): void;
}

/**
 * Draws particles on the effect's own canvas (QA OME-1206: ticking the whole Pixi stage cost a phone ~3 ms a frame).
 * A paint clears only the squares the last one drew, then draws each particle once; `scale` is the canvas's pixel
 * ratio. Nothing is allocated per paint.
 */
export function createEffectPainter(ctx: EffectContext, image: CanvasImageSource, frames: readonly EffectFrame[], scale: number): EffectPainter {
  // Any frame drawn about any anchor inside it, mirrored or not, stays within R of the particle's spot.
  const r = frames.reduce((m, f) => Math.max(m, f.w, f.h), 0) + 1;
  const n = frames.length;
  const lastX = new Int32Array(MAX_EFFECT_SPRITES);
  const lastY = new Int32Array(MAX_EFFECT_SPRITES);
  let drawn = 0;
  const clear = (): void => {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (let i = 0; i < drawn; i++) ctx.clearRect((lastX[i] ?? 0) - r, (lastY[i] ?? 0) - r, 2 * r, 2 * r);
    drawn = 0;
  };
  return {
    clear,
    paint(p, step) {
      clear();
      if (n === 0) return;
      const count = Math.min(p.count, MAX_EFFECT_SPRITES);
      for (let i = 0; i < count; i++) {
        const x = p.x[i] ?? 0;
        const y = p.y[i] ?? 0;
        const f = frames[(step + (p.phase[i] ?? 0)) % n];
        if (f === undefined) continue;
        ctx.setTransform(p.flip[i] === 1 ? -scale : scale, 0, 0, scale, x * scale, y * scale);
        ctx.drawImage(image, f.sx, f.sy, f.w, f.h, -f.ox, -f.oy, f.w, f.h);
        lastX[i] = x;
        lastY[i] = y;
      }
      drawn = count;
    },
  };
}
