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

/** Any frame drawn about any anchor inside it, mirrored or not, stays within this of the particle's spot. */
const reach = (frames: readonly EffectFrame[]): number => frames.reduce((m, f) => Math.max(m, f.w, f.h), 0) + 1;

/**
 * Draws particles on the effect's own small overlay canvas (ADR 0052). It never renders the room (QA OME-1206) and never
 * reads a canvas (OME-1212: a readback per particle took a phone to ~250 ms a frame). The overlay covers only the
 * effect's band at 1 px per stage px, because a full-size layer cost ~2.5 ms a frame even when empty (OME-1211). A paint
 * clears the squares the last one drew, then draws each particle once. Nothing is allocated per paint.
 */
export function createEffectPainter(o: EffectPainterOptions): EffectPainter {
  const { ctx, image, frames, origin } = o;
  const r = reach(frames);
  const n = frames.length;
  const lastX = new Int32Array(MAX_EFFECT_SPRITES);
  const lastY = new Int32Array(MAX_EFFECT_SPRITES);
  let drawn = 0;
  const clear = (): void => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
        const x = (p.x[i] ?? 0) - origin.x;
        const y = (p.y[i] ?? 0) - origin.y;
        const f = frames[(step + (p.phase[i] ?? 0)) % n];
        if (f === undefined) continue;
        ctx.setTransform(p.flip[i] === 1 ? -1 : 1, 0, 0, 1, x, y);
        ctx.drawImage(image, f.sx, f.sy, f.w, f.h, -f.ox, -f.oy, f.w, f.h);
        lastX[i] = x;
        lastY[i] = y;
      }
      drawn = count;
    },
  };
}

/** The overlay's rect on the stage: the drift area, plus the wrap margin and a sprite's reach on every side. */
export function effectBounds(motion: EffectMotion, frames: readonly EffectFrame[]): Rect {
  const pad = MARGIN + reach(frames);
  const { area } = motion;
  return { x: Math.floor(area.x) - pad, y: Math.floor(area.y) - pad, w: Math.ceil(area.w) + 2 * pad, h: Math.ceil(area.h) + 2 * pad };
}

/**
 * The effect frames side by side on their own small canvas, top-aligned. The painter draws from that canvas: drawing
 * from the sheet's <img> cost a phone ~50 µs per particle a frame (QA OME-1223: Christmas's 40 flakes, +2 ms work).
 */
export function packEffectFrames(frames: readonly EffectFrame[]): { w: number; h: number; frames: EffectFrame[] } {
  let x = 0;
  const packed = frames.map((f) => {
    const p = { ...f, sx: x, sy: 0 };
    x += f.w;
    return p;
  });
  return { w: x, h: frames.reduce((m, f) => Math.max(m, f.h), 0), frames: packed };
}
