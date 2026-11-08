// Reaction glyph bursts (OME-1631, Movie night): a received `reacted` bursts a few glyphs up from the sender's head.
// OME-2307: painted as pooled sprites on the room canvas (room-view.ts `reactions` layer), not DOM. This file owns the
// timing and asks a paint sink to show/hide slots; each step that changed something asks for one render, an idle room
// none. A fixed pool of at most 12 slots, reused; a burst into a full pool shows what fits, then nothing (the oldest
// finish on their own within a life). ADR 0040: no CSS animation, so the rise and the fade are written on one step timer for
// the whole layer, which stops when nothing is live. The caller's `allowed` gate turns it off (Basic tier, reduced
// motion, a Smooth frame near budget). Placeholder art: the emote picker's stickers until the Designer's glyph sheet
// passes the judge. The layer is decorative: who reacted is not announced.
import type { ReactionKind } from "@omega/shared";
import type { Point } from "../layout";

export const GLYPH_POOL = 12;
export const GLYPHS_PER_BURST = 3;
export const GLYPH_LIFE_MS = 900;
/** Steps per life: whole-pixel rise steps on the shared timer. */
const STEPS = 9;
const STEP_MS = GLYPH_LIFE_MS / STEPS;
const RISE = 27;
/** The burst's fan: each glyph's x offset from the head, and how far apart their starts are (stage px). */
const FAN = [-11, 0, 11] as const;
const LIFT = [0, 6, 2] as const;
/** The fade starts at this share of the life. */
const FADE_AT = 0.4;

/** The bar's placeholder icons (UI sprite classes); "wow" borrows the Surprise sticker. */
const ICONS: Readonly<Record<ReactionKind, string>> = { heart: "ui-emote-pick-heart", laugh: "ui-emote-pick-laugh", wow: "ui-emote-pick-exclaim", clap: "ui-emote-pick-clap" };
/** The motion atlas's sticker frames the glyphs paint (the same `emote/<kind>` art as the emote stickers). */
const FRAMES: Readonly<Record<ReactionKind, string>> = { heart: "emote/heart", laugh: "emote/laugh", wow: "emote/exclaim", clap: "emote/clap" };
export const glyphFrame = (kind: ReactionKind): string => FRAMES[kind];
export const reactionIcon = (kind: ReactionKind): string => ICONS[kind];

/** Where glyphs are painted (room-view.ts), and the render request. */
export interface GlyphPaint {
  show(i: number, frame: string, x: number, y: number, alpha: number): void;
  hide(i: number): void;
  /** Draw the room once. */
  render(): void;
}

export interface GlyphOptions {
  /** Read once per burst: may glyphs play now? */
  readonly allowed: () => boolean;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (h: unknown) => void;
}

export interface ReactionGlyphs {
  /** A burst over `at` (stage px, the sender's head). Returns how many glyphs it showed (0: gated or pool full). */
  burst(at: Point, kind: ReactionKind): number;
  /** Glyphs live now, for e2e and perf. */
  live(): number;
  /** Which slots are live and their kinds, for the e2e hook (allocates: not for a frame). */
  active(): { kind: ReactionKind; i: number }[];
  destroy(): void;
}

export function createReactionGlyphs(paint: GlyphPaint, o: GlyphOptions): ReactionGlyphs {
  const born = new Float64Array(GLYPH_POOL);
  const xs = new Float64Array(GLYPH_POOL);
  const ys = new Float64Array(GLYPH_POOL);
  const busy = new Uint8Array(GLYPH_POOL);
  const kinds: ReactionKind[] = new Array<ReactionKind>(GLYPH_POOL).fill("heart");
  let live = 0;
  let timer: unknown = null;
  let destroyed = false;

  const place = (i: number, t: number): boolean => {
    const k = Math.min(STEPS, Math.floor((t - (born[i] ?? 0)) / STEP_MS));
    if (k >= STEPS) return false;
    const rise = Math.round((RISE * k) / STEPS);
    const p = k / STEPS;
    const alpha = p <= FADE_AT ? 1 : Math.round((100 * (1 - p)) / (1 - FADE_AT)) / 100;
    paint.show(i, FRAMES[kinds[i] ?? "heart"], xs[i] ?? 0, (ys[i] ?? 0) - rise, alpha);
    return true;
  };
  const step = (): void => {
    timer = null;
    const t = o.now();
    for (let i = 0; i < GLYPH_POOL; i++) {
      if (busy[i] !== 1 || place(i, t)) continue;
      busy[i] = 0;
      paint.hide(i);
      live--;
    }
    paint.render();
    if (live > 0) timer = o.setTimer(step, STEP_MS);
  };

  return {
    burst(at, kind) {
      if (destroyed || !o.allowed()) return 0;
      const t = o.now();
      let shown = 0;
      for (let j = 0; j < GLYPHS_PER_BURST; j++) {
        const i = busy.indexOf(0);
        if (i < 0) break;
        busy[i] = 1;
        born[i] = t;
        kinds[i] = kind;
        xs[i] = Math.round(at.x + (FAN[j] ?? 0));
        ys[i] = Math.round(at.y - (LIFT[j] ?? 0));
        place(i, t);
        live++;
        shown++;
      }
      if (shown > 0) {
        paint.render();
        if (timer === null) timer = o.setTimer(step, STEP_MS);
      }
      return shown;
    },
    live: () => live,
    active: () => kinds.flatMap((kind, i) => (busy[i] === 1 ? [{ kind, i }] : [])),
    destroy() {
      destroyed = true;
      if (timer !== null) o.clearTimer(timer);
      timer = null;
      if (live > 0) {
        for (let i = 0; i < GLYPH_POOL; i++) if (busy[i] === 1) paint.hide(i);
        paint.render();
      }
      busy.fill(0);
      live = 0;
    },
  };
}
