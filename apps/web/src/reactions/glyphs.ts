// Reaction glyph bursts (OME-1631, Movie night): a received `reacted` bursts a few glyphs up from the sender's head.
// DOM over the room like the chat floats, never the Pixi room: a burst costs no canvas render. A fixed pool of at most
// 12 nodes, made on first need and reused; a burst into a full pool shows what fits, then nothing (the oldest finish
// on their own within a life). ADR 0040: no CSS animation, so the rise and the fade are written on one step timer for
// the whole layer, which stops when nothing is live. The caller's `allowed` gate turns it off (Basic tier, reduced
// motion, a Smooth frame near budget). Placeholder art: the emote picker's stickers until the Designer's glyph sheet
// passes the judge. The layer is decorative: who reacted is not announced.
import type { ReactionKind } from "@omega/shared";
import { el } from "../controls/dom";
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

/** Placeholder icons (UI sprite classes); "wow" borrows the Surprise sticker. */
const ICONS: Readonly<Record<ReactionKind, string>> = { heart: "ui-emote-pick-heart", laugh: "ui-emote-pick-laugh", wow: "ui-emote-pick-exclaim", clap: "ui-emote-pick-clap" };
export const reactionIcon = (kind: ReactionKind): string => ICONS[kind];

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
  destroy(): void;
}

export function createReactionGlyphs(layer: HTMLElement, o: GlyphOptions): ReactionGlyphs {
  layer.setAttribute("aria-hidden", "true");
  const nodes: HTMLElement[] = [];
  const born = new Float64Array(GLYPH_POOL);
  const xs = new Float64Array(GLYPH_POOL);
  const ys = new Float64Array(GLYPH_POOL);
  const busy = new Uint8Array(GLYPH_POOL);
  let live = 0;
  let timer: unknown = null;
  let destroyed = false;

  const place = (i: number, node: HTMLElement, t: number): boolean => {
    const k = Math.min(STEPS, Math.floor((t - (born[i] ?? 0)) / STEP_MS));
    if (k >= STEPS) return false;
    const rise = Math.round((RISE * k) / STEPS);
    node.style.transform = `translate(${String(xs[i] ?? 0)}px, ${String((ys[i] ?? 0) - rise)}px)`;
    const p = k / STEPS;
    node.style.opacity = p <= FADE_AT ? "1" : String(Math.round((100 * (1 - p)) / (1 - FADE_AT)) / 100);
    return true;
  };
  const step = (): void => {
    timer = null;
    const t = o.now();
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (busy[i] !== 1 || node === undefined || place(i, node, t)) continue;
      busy[i] = 0;
      node.hidden = true;
      live--;
    }
    if (live > 0) timer = o.setTimer(step, STEP_MS);
  };
  const free = (): number => {
    for (let i = 0; i < nodes.length; i++) if (busy[i] !== 1) return i;
    if (nodes.length === GLYPH_POOL) return -1;
    nodes.push(layer.appendChild(el("span", { className: "reaction-glyph" })));
    return nodes.length - 1;
  };

  return {
    burst(at, kind) {
      if (destroyed || !o.allowed()) return 0;
      const t = o.now();
      let shown = 0;
      for (let j = 0; j < GLYPHS_PER_BURST; j++) {
        const i = free();
        const node = nodes[i];
        if (node === undefined) break;
        busy[i] = 1;
        born[i] = t;
        xs[i] = Math.round(at.x + (FAN[j] ?? 0));
        ys[i] = Math.round(at.y - (LIFT[j] ?? 0));
        node.className = `reaction-glyph ui-sprite ${ICONS[kind]}`;
        place(i, node, t);
        node.hidden = false;
        live++;
        shown++;
      }
      if (shown > 0 && timer === null) timer = o.setTimer(step, STEP_MS);
      return shown;
    },
    live: () => live,
    destroy() {
      destroyed = true;
      if (timer !== null) o.clearTimer(timer);
      timer = null;
      for (const n of nodes) n.hidden = true;
      busy.fill(0);
      live = 0;
    },
  };
}
