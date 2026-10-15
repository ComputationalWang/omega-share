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
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

export interface EffectPainterOptions {
  /** The room canvas and its context (Pixi's own 2D canvas). */
  readonly ctx: EffectContext;
  readonly canvas: CanvasImageSource;
  /** A small canvas that keeps what each particle covers, one square slot per particle. */
  readonly patchCtx: EffectContext;
  readonly patchCanvas: CanvasImageSource;
  /** The theme sheet and its effect frames. */
  readonly image: CanvasImageSource;
  readonly frames: readonly EffectFrame[];
  /** Device px per stage px. */
  readonly scale: number;
}

export interface EffectPainter {
  /** Put back what the last paint covered, then save and draw `p`. */
  paint(p: Particles, step: number): void;
  /** Put back what the last paint covered. */
  clear(): void;
}

/**
 * Draws particles straight into the room canvas, so the effect adds no layer (QA OME-1211: an extra full-size canvas cost
 * a phone ~2.5 ms a frame even empty) and never renders the room (OME-1206). Before drawing a particle it copies the
 * square of room pixels under it into its slot on the patch canvas; the next paint clears and puts those squares back,
 * last first so overlaps come back right, and draws again. The room view clears before each room render, so Pixi
 * always starts from its own frame. The room context's state is saved and restored around each paint, since Pixi draws with it too.
 * Nothing is allocated per paint.
 */
export function createEffectPainter(o: EffectPainterOptions): EffectPainter {
  const { ctx, canvas, patchCtx, patchCanvas, image, frames, scale } = o;
  // Any frame drawn about any anchor inside it, mirrored or not, stays within R of the particle's spot.
  const r = frames.reduce((m, f) => Math.max(m, f.w, f.h), 0) + 1;
  /** A patch's side in device px. */
  const side = 2 * r * scale;
  const n = frames.length;
  const lastX = new Int32Array(MAX_EFFECT_SPRITES);
  const lastY = new Int32Array(MAX_EFFECT_SPRITES);
  let saved = 0;
  /** Put the saved squares back, last first; the caller holds ctx's state. */
  const putBack = (): void => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = saved - 1; i >= 0; i--) {
      const x = lastX[i] ?? 0;
      const y = lastY[i] ?? 0;
      ctx.clearRect(x, y, side, side);
      ctx.drawImage(patchCanvas, i * side, 0, side, side, x, y, side, side);
    }
    saved = 0;
  };
  return {
    paint(p, step) {
      ctx.save();
      putBack();
      const count = n === 0 ? 0 : Math.min(p.count, MAX_EFFECT_SPRITES);
      for (let i = 0; i < count; i++) {
        const px = p.x[i] ?? 0;
        const py = p.y[i] ?? 0;
        const f = frames[(step + (p.phase[i] ?? 0)) % n];
        if (f === undefined) continue;
        const x = (px - r) * scale;
        const y = (py - r) * scale;
        // Cleared first: drawing the room's transparent margins over the slot would keep the last patch there.
        patchCtx.clearRect(i * side, 0, side, side);
        patchCtx.drawImage(canvas, x, y, side, side, i * side, 0, side, side);
        lastX[i] = x;
        lastY[i] = y;
        saved = i + 1;
        ctx.setTransform(p.flip[i] === 1 ? -scale : scale, 0, 0, scale, px * scale, py * scale);
        ctx.drawImage(image, f.sx, f.sy, f.w, f.h, -f.ox, -f.oy, f.w, f.h);
      }
      ctx.restore();
    },
    clear() {
      ctx.save();
      putBack();
      ctx.restore();
    },
  };
}

/** The patch canvas's size in device px for `frames` at `scale`: one square slot per particle, side by side. */
export function patchCanvasSize(frames: readonly EffectFrame[], scale: number): { w: number; h: number } {
  const side = 2 * (frames.reduce((m, f) => Math.max(m, f.w, f.h), 0) + 1) * scale;
  return { w: side * MAX_EFFECT_SPRITES, h: side };
}
