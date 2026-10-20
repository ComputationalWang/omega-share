// Floating chat bubbles (OME-730, M8 W1, set (l) `.ui-float`; research m8-smooth-walk.md §4). DOM, never the Pixi room:
// a bubble costs no canvas render and no JS per frame. A fixed pool of 16 nodes, reused oldest-first, so a message creates
// and destroys nothing. Each node is three elements: the outer one rides the speaker's head (`move`, on every walk frame,
// a transform write only); a bare wrapper inside it carries the push, the rise and the fade (restyling it is cheap: no
// rules, no tail, no custom properties); the bubble itself is only written when a message lands or it stacks. Overlap
// is resolved once per frame that brings sizes and once per walk end (`settle`), never per walk frame: newest nearest
// the heads, an older bubble in a newer one's way moves straight up, 3 px clear, loses its tail and names its speaker.
// `.is-live` marks a bubble sized and placed (no style hangs on it: a hook for tests and QA).
// OME-802 (ADR 0040): no CSS animation, and nothing here reads layout. Blink restyles every running CSS animation on
// every main frame, composited or not, so the 24-step rise and the fades are written on one shared step clock instead:
// one timer for the whole layer, 24 steps a life, every bubble's writes on the same step. A ResizeObserver hands over
// each new bubble's size from the frame's own layout, before paint, along with its stacked twin's (the same box with
// the name, never painted), so neither a message nor a bubble that stacks forces a style and layout pass of its own.
// The layer is decorative (aria-hidden, no live region): the chat log is the accessible record.
// OME-1390: a typing indicator ("…") takes a node from the same pool. It never rises, fades or expires (the server clears
// it), is ordered nearest the head, and a line from the same member replaces it. Its dots step on the same clock (ADR
// 0040: no CSS animation in the room), one `data-dot` write a step; under reduced motion they're static.
import type { MemberId } from "@omega/shared";
import { el } from "../controls/dom";
import { isShout, meAction, thinkText } from "../chat/effects";
import { ROOM_VIEW, STAGE_W, type Point } from "../layout";

/** Set (l) `meta.omega.bubbles`: a 5 s life, a 24 px rise in whole-pixel steps; 10 per speaker, 16 on screen (OME-1050). */
export const FLOAT_LIFE_MS = 5000;
export const FLOAT_RISE = 24;
export const FLOAT_LEAVE_MS = 160;
export const FLOAT_POOL = 16;
export const FLOAT_PER_SPEAKER = 10;
/** Clear space between a pushed bubble and the newer one under it. */
const GAP = 3;
/** The box keeps this far from the stage's side edges. */
const MARGIN = 4;
/** The tail's tip hangs this far below the box (reference.css `.ui-float::after`). */
const TAIL_BELOW = 4;
/** A straight tail needs this much box either side of the speaker; nearer the edge it leans (`tail-sw`/`tail-se`). */
const TAIL_S_REACH = 11;
/** A leaning tail's tip stays at least this far inside the box. */
const TAIL_MIN = 6;
/** Set (l): the fade out starts at 72 % of the life on this curve; under reduced motion at 80 %, linear. */
const FADE_AT = 0.72;
const REDUCED_FADE_AT = 0.8;
const FADE_CURVE = cubicBezier(0.55, 0, 1, 0.45);

/** CSS `cubic-bezier(x1, y1, x2, y2)` as a function of progress, by Newton's method on x(t). */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const at = (a: number, b: number, t: number): number => 3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t;
  return (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = at(x1, x2, t) - x;
      const slope = 3 * x1 * (1 - t) * (1 - t) + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
      if (Math.abs(err) < 1e-6 || slope === 0) break;
      t = Math.min(1, Math.max(0, t - err / slope));
    }
    return at(y1, y2, t);
  };
}

/** The shared step clock: step `i` falls at i × life / 24 ms on `now`'s clock, the same instants for every bubble. */
const stepOf = (t: number): number => Math.floor((t * FLOAT_RISE) / FLOAT_LIFE_MS);
const stepAt = (i: number): number => (i * FLOAT_LIFE_MS) / FLOAT_RISE;

export interface FloatMessage {
  readonly id: MemberId;
  /** The speaker's nickname: a stacked bubble names them. */
  readonly name: string;
  readonly text: string;
  /** The speaker's shirt colour (OME-1375), the bubble's edge. */
  readonly accent?: string;
  /** My own bubble wears the mustard rim. */
  readonly self: boolean;
  /** It names me (OME-1531): a ring, for me only. */
  readonly mention?: boolean;
  /** The speaker's head (stage px): the tail's tip. */
  readonly at: Point;
  /** When it was said (ms on `now`'s clock), for a bubble adopted mid-life (the pop-out window); NaN: now. */
  readonly startedAt: number;
}

export interface Floats {
  say(m: FloatMessage): void;
  /** The speaker's avatar moved (a walk frame): their bubbles ride along. No measuring, no overlap check. */
  move(id: MemberId, x: number, y: number): void;
  /** The speaker's walk ended at (x, y): re-clamp their bubbles at the stage edge and resolve overlap once. */
  settle(id: MemberId, x: number, y: number): void;
  /** Drop the bubbles of anyone not in `ids` (they left). */
  keep(ids: { has(id: MemberId): boolean }): void;
  /**
   * Bubbles are shown `k`× their measured size (OME-1184: room.css --label-scale on the motion wrapper, zoomed out on a
   * phone): they're clamped and stacked by the size they're shown at, and the ones up are placed again.
   */
  scale(k: number): void;
  /** The member started or stopped typing (`at`: their head): the dots show or go. `keep` leaves them alone. */
  typing(id: MemberId, on: boolean, at: Point): void;
}

export interface FloatsOptions {
  readonly reducedMotion: { readonly matches: boolean };
  readonly now: () => number;
  /** Runs the step clock: one timer at a time for the whole layer. */
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  /** Watches boxes' border-box sizes (stage px) from the browser's own layout: by default a ResizeObserver. */
  readonly watch?: (onSizes: (entries: readonly SizeEntry[]) => void) => SizeWatch;
}

/** The part of a ResizeObserverEntry the floats read. */
export interface SizeEntry {
  readonly target: Element;
  readonly borderBoxSize: readonly { readonly inlineSize: number; readonly blockSize: number }[];
}

export interface SizeWatch {
  observe(e: HTMLElement): void;
  unobserve(e: HTMLElement): void;
}

const resizeWatch = (onSizes: (entries: readonly SizeEntry[]) => void): SizeWatch => {
  const ro = new ResizeObserver(onSizes);
  return {
    observe: (e) => {
      ro.observe(e, { box: "border-box" });
    },
    unobserve: (e) => {
      ro.unobserve(e);
    },
  };
};

const FREE = 0;
const LIVE = 1;
const LEAVING = 2;

interface Slot {
  readonly outer: HTMLDivElement;
  readonly motion: HTMLDivElement;
  readonly p: HTMLParagraphElement;
  readonly who: HTMLElement;
  readonly whoText: Text;
  readonly text: HTMLSpanElement;
  readonly textNode: Text;
  /** The typing indicator's three dots, shown only on a typing node. */
  readonly dots: HTMLSpanElement;
  /** The stacked twin: the bubble's box with its speaker's name, laid out but never painted (generated content). */
  readonly twin: HTMLParagraphElement;
  readonly twinSay: HTMLSpanElement;
  state: typeof FREE | typeof LIVE | typeof LEAVING;
  /** A typing indicator, not a line. */
  typing: boolean;
  /** The lit dot as written (`data-dot`), -1 none. */
  dot: number;
  speaker: MemberId | null;
  /** Arrival order, for oldest-first reuse. */
  seq: number;
  startedAt: number;
  /** The head it hangs from, and the box relative to it. */
  ax: number;
  ay: number;
  dx: number;
  w: number;
  h: number;
  /** The box's size once stacked (the twin's). */
  sw: number;
  sh: number;
  /** Which sizes have arrived since `say`: 1 the bubble's, 2 the twin's. */
  sized: number;
  push: number;
  stacked: boolean;
  /** False until both sizes arrive (a frame later, or once a hidden stage shows): not placed, stacked or shown. */
  measured: boolean;
  /** As written: whole pixels risen, and opacity (hundredths). */
  rise: number;
  alpha: number;
  /** Sent away: it goes at the clock's first step from this time on. */
  leaveAt: number;
}

const px = (n: number): string => `${String(n)}px`;

export function createFloats(layer: HTMLElement, o: FloatsOptions): Floats {
  layer.setAttribute("aria-hidden", "true");
  layer.removeAttribute("aria-live");
  const watch = (o.watch ?? resizeWatch)((entries) => {
    sized(entries);
  });
  const slots: Slot[] = Array.from({ length: FLOAT_POOL }, () => {
    // One text node each, rewritten in place: a message inserts no node.
    const textNode = document.createTextNode("");
    const text = el("span");
    text.append(textNode);
    const whoText = document.createTextNode("");
    const who = el("b", { className: "who", hidden: true });
    who.append(whoText);
    const dots = el("span", { className: "dots", hidden: true });
    dots.append(el("i"), el("i"), el("i"));
    const say = el("span", { className: "say" });
    say.append(who, text);
    // Beside `.say`, not in it: `.say > span` stays the line's text alone.
    const p = el("p", { className: "ui-float" });
    p.append(say, dots);
    const twinSay = el("span");
    const twin = el("p", { className: "float-twin" });
    twin.append(twinSay);
    const motion = el("div", { className: "float-motion" });
    motion.append(p);
    const outer = el("div", { className: "float-slot", hidden: true });
    outer.append(motion, twin);
    layer.append(outer);
    return { outer, motion, p, who, whoText, text, textNode, dots, twin, twinSay, state: FREE, typing: false, dot: -1, speaker: null, seq: 0, startedAt: 0, ax: 0, ay: 0, dx: 0, w: 0, h: 0, sw: 0, sh: 0, sized: 0, push: 0, stacked: false, measured: false, rise: 0, alpha: 1, leaveAt: 0 };
  });
  /** Typing on, not yet a whole step: no node yet (where their head is, and since when). */
  const waiting = new Map<MemberId, { x: number; y: number; since: number }>();
  /** Live bubbles, newest first, rebuilt per resolve (no allocation). */
  const order: Slot[] = [];
  let seq = 0;
  let clock: unknown = null;
  /** Bubbles show k× their measured size (OME-1184, `scale`); pushes and dx are stage px. */
  let k = 1;

  /** Back to the pool; `hide` false when the node is reused at once (it stays shown: one attribute write fewer). */
  const free = (s: Slot, hide = true): void => {
    s.state = FREE;
    s.speaker = null;
    watch.unobserve(s.p);
    watch.unobserve(s.twin);
    if (hide) s.outer.hidden = true;
    s.text.removeAttribute("data-testid");
    if (s.typing) {
      s.typing = false;
      s.dots.hidden = true;
      s.dots.removeAttribute("data-testid");
      s.p.removeAttribute("data-dot");
      s.dot = -1;
    }
  };

  /** The rise and opacity for `now`, written only when they change. The rise counts whole steps to the clock's last. */
  const paint = (s: Slot, now: number): void => {
    if (s.typing) return;
    const reduced = o.reducedMotion.matches;
    const rise = reduced ? 0 : Math.min(FLOAT_RISE, Math.max(0, stepOf(now) - Math.ceil((s.startedAt * FLOAT_RISE) / FLOAT_LIFE_MS)));
    const life = (now - s.startedAt) / FLOAT_LIFE_MS;
    const from = reduced ? REDUCED_FADE_AT : FADE_AT;
    const out = life <= from ? 0 : Math.min(1, (life - from) / (1 - from));
    let alpha = 1 - (reduced ? out : FADE_CURVE(out));
    if (s.state === LEAVING) alpha /= 2;
    alpha = Math.round(alpha * 100) / 100;
    if (rise !== s.rise) {
      s.rise = rise;
      s.motion.style.translate = rise === 0 ? "" : `0 ${px(-rise)}`;
    }
    if (alpha !== s.alpha) {
      s.alpha = alpha;
      s.motion.style.opacity = alpha === 1 ? "" : String(alpha);
    }
  };

  /** A step of the clock: every bubble due goes, the rest are painted; it stops when the layer is empty. */
  const step = (): void => {
    clock = null;
    const now = o.now();
    let any = false;
    for (const s of slots) {
      if (s.state === FREE) continue;
      if (s.typing && s.state === LIVE) {
        any = true;
        const dot = stepOf(now) % 3;
        if (!o.reducedMotion.matches && dot !== s.dot) {
          s.dot = dot;
          s.p.dataset["dot"] = String(dot);
        }
        continue;
      }
      if (s.state === LEAVING ? now >= s.leaveAt : now - s.startedAt >= FLOAT_LIFE_MS) {
        free(s);
        continue;
      }
      any = true;
      if (s.measured) paint(s, now);
    }
    for (const [id, w] of waiting) {
      if (now - w.since < FLOAT_LIFE_MS / FLOAT_RISE) continue;
      waiting.delete(id);
      startTyping(id, w.x, w.y, now);
    }
    if (any || waiting.size > 0) run(now);
  };

  const run = (now: number): void => {
    if (clock === null) clock = o.setTimer(step, Math.max(1, Math.ceil(stepAt(stepOf(now) + 1) - now)));
  };

  const leave = (s: Slot): void => {
    s.state = LEAVING;
    s.text.removeAttribute("data-testid");
    // Reduced motion exits at once; so does a bubble never sized (it was never placed or shown: nothing to fade).
    if (o.reducedMotion.matches || !s.measured) {
      free(s);
      return;
    }
    s.leaveAt = o.now() + FLOAT_LEAVE_MS;
    s.p.classList.add("is-leaving");
    paint(s, o.now());
  };

  const anchor = (s: Slot, x: number, y: number): void => {
    s.ax = x;
    s.ay = y;
    s.outer.style.transform = `translate(${px(x)}, ${px(y)})`;
  };

  /**
   * Keep the box inside the stage's sides; the tail leans when the speaker is past a straight tail's reach. `dx` is in
   * stage px; the box's own styles are in its px (shown `k`× inside the motion wrapper).
   */
  const placeBox = (s: Slot): void => {
    const w = s.w * k;
    const left = Math.round(Math.max(MARGIN, Math.min(STAGE_W - MARGIN - w, s.ax - w / 2)));
    s.dx = left - Math.round(s.ax);
    const tailX = Math.max(TAIL_MIN, Math.min(s.w - TAIL_MIN, -s.dx / k));
    s.p.style.left = px(s.dx / k);
    s.p.style.top = px(-(s.h + TAIL_BELOW));
    s.p.style.setProperty("--tail-x", px(tailX));
    s.p.classList.toggle("tail-sw", tailX < TAIL_S_REACH);
    s.p.classList.toggle("tail-se", tailX > s.w - TAIL_S_REACH);
  };

  const setPush = (s: Slot, push: number): void => {
    if (push === s.push) return;
    s.push = push;
    s.motion.style.transform = push === 0 ? "" : `translateY(${px(-push / k)})`;
  };

  /**
   * The bubble loses its tail and names its speaker. The name widens the box, so it takes its twin's size and is
   * centred again (once per bubble: a stacked bubble stays stacked) before the overlap maths uses its width (OME-791).
   */
  const stack = (s: Slot): void => {
    s.stacked = true;
    s.p.classList.add("is-stacked");
    s.who.hidden = false;
    s.w = s.sw;
    s.h = s.sh;
    placeBox(s);
  };

  /**
   * Newest first, push each older bubble up until it clears every newer one by GAP. Live bubbles all rise at the same
   * rate on the same steps, so their gaps hold for as long as both are up; the older one's head start counts (whole
   * steps, rounded down, and no more than it shows now: the closest the two get). Pushes only grow: a bubble never
   * slides down. One pushed so high that its rise would leave ROOM_VIEW (the page clips it there) goes instead.
   */
  const resolve = (): void => {
    order.length = 0;
    for (const s of slots) if (s.state === LIVE && s.measured) order.push(s);
    // Typing dots stay nearest the heads (they never rise): lines climb over them.
    order.sort((a, b) => Number(b.typing) - Number(a.typing) || b.seq - a.seq);
    const reduced = o.reducedMotion.matches;
    for (let i = 0; i < order.length; i++) {
      const s = order[i];
      if (s === undefined) continue;
      let push = s.push;
      for (let moved = true; moved; ) {
        moved = false;
        for (let j = 0; j < i; j++) {
          const n = order[j];
          if (n === undefined) continue;
          const lead = reduced ? 0 : Math.max(0, Math.min(Math.floor(((n.startedAt - s.startedAt) * FLOAT_RISE) / FLOAT_LIFE_MS), s.rise - n.rise));
          const x0 = s.ax + s.dx;
          const nx0 = n.ax + n.dx;
          if (x0 >= nx0 + n.w * k || nx0 >= x0 + s.w * k) continue;
          const top = s.ay - (s.h + TAIL_BELOW) * k - push - lead;
          const bottom = top + s.h * k;
          const nTop = n.ay - (n.h + TAIL_BELOW) * k - n.push;
          const nBottom = nTop + (n.h + (n.stacked ? 0 : TAIL_BELOW)) * k;
          if (top >= nBottom + GAP || bottom + (s.stacked ? 0 : TAIL_BELOW * k) + GAP <= nTop) continue;
          // Typing dots never stack, so they keep their tail.
          push += Math.max(0, bottom + (s.typing ? TAIL_BELOW * k : 0) + GAP - nTop);
          // Re-measured and re-centred: the next pass checks the box as it now is.
          if (!s.stacked && !s.typing) stack(s);
          moved = true;
        }
      }
      if (i > 0 && s.ay - (s.h + TAIL_BELOW) * k - push - (reduced || s.typing ? 0 : FLOAT_RISE) < ROOM_VIEW.y) {
        leave(s);
        continue;
      }
      setPush(s, push);
    }
  };

  /** Sizes from the frame's layout: a bubble with both is placed and shown at its age; then one overlap pass. */
  const sized = (entries: readonly SizeEntry[]): void => {
    const now = o.now();
    let any = false;
    for (const e of entries) {
      const box = e.borderBoxSize[0];
      if (box === undefined) continue;
      const w = Math.round(box.inlineSize);
      const h = Math.round(box.blockSize);
      // No layout (the stage is hidden): keep watching, it reports again once it shows.
      if (w === 0 && h === 0) continue;
      for (const s of slots) {
        if (s.state !== LIVE || s.measured) continue;
        if (e.target === s.p) {
          s.w = w;
          s.h = h;
          s.sized |= 1;
          watch.unobserve(s.p);
        } else if (e.target === s.twin) {
          s.sw = w;
          s.sh = h;
          s.sized |= 2;
          watch.unobserve(s.twin);
        } else continue;
        if (s.sized === 3) {
          s.measured = true;
          placeBox(s);
          paint(s, now);
          s.p.classList.add("is-live");
          any = true;
        }
        break;
      }
    }
    if (any) resolve();
  };

  /** A node for `id`: a free one first, then the oldest leaving one, then the oldest on screen. */
  const take = (id: MemberId): Slot | null => {
    let slot: Slot | null = null;
    for (const s of slots) {
      if (s.state === FREE) {
        slot = s;
        break;
      }
      if (slot === null || (s.state === LEAVING && slot.state === LIVE) || (s.state === slot.state && s.seq < slot.seq)) slot = s;
    }
    if (slot === null) return null;
    free(slot, false);
    slot.state = LIVE;
    slot.speaker = id;
    slot.seq = ++seq;
    return slot;
  };

  /** Shown at `at`, unplaced until its sizes arrive in the frame's layout. */
  const show = (s: Slot, at: Point, now: number): void => {
    s.push = 0;
    s.rise = 0;
    s.alpha = 1;
    s.motion.style.transform = "";
    s.motion.style.translate = "";
    s.motion.style.opacity = "";
    if (s.outer.hidden) s.outer.hidden = false;
    anchor(s, at.x, at.y);
    s.measured = false;
    s.sized = 0;
    watch.observe(s.p);
    watch.observe(s.twin);
    run(now);
  };

  /** Typing dots for `id` at (x, y): a pool node with three dots in place of words. */
  const startTyping = (id: MemberId, x: number, y: number, now: number): void => {
    const s = take(id);
    if (s === null) return;
    s.startedAt = now;
    s.typing = true;
    s.p.className = "ui-float is-typing";
    s.p.style.setProperty("--tint", "");
    s.twin.classList.remove("is-shout", "is-action", "is-think");
    s.stacked = false;
    s.who.hidden = true;
    s.whoText.data = "";
    s.textNode.data = "";
    s.dots.hidden = false;
    s.dots.setAttribute("data-testid", "typing-dots");
    s.twinSay.dataset["who"] = "";
    s.twinSay.dataset["say"] = "…";
    show(s, { x, y }, now);
  };

  return {
    say(m) {
      const now = o.now();
      const elapsed = Number.isNaN(m.startedAt) ? 0 : Math.max(0, now - m.startedAt);
      if (elapsed >= FLOAT_LIFE_MS) return;
      // A line replaces its speaker's typing dots.
      waiting.delete(m.id);
      for (const s of slots) if (s.typing && s.speaker === m.id) free(s);
      // FLOAT_PER_SPEAKER per speaker: their oldest goes.
      for (;;) {
        let count = 0;
        let oldest: Slot | null = null;
        for (const s of slots) {
          if (s.state !== LIVE || s.speaker !== m.id) continue;
          count++;
          if (oldest === null || s.seq < oldest.seq) oldest = s;
        }
        if (count < FLOAT_PER_SPEAKER || oldest === null) break;
        leave(oldest);
      }
      const s = take(m.id);
      if (s === null) return;
      s.startedAt = now - elapsed;
      // Not .is-live until its size arrives in this frame's layout, before paint: then it is placed and shown at its age.
      // `/me waves` (OME-1375): an action names its speaker from the start ("Sam waves"), so it's the twin's size already.
      const action = meAction(m.text);
      // `/think hmm` (OME-1465): a thought bubble, its words only, like a plain line.
      const thought = thinkText(m.text);
      const text = action ?? thought ?? m.text;
      const shout = isShout(text);
      s.p.className = `ui-float${m.self ? " is-self" : ""}${m.mention === true ? " is-mention" : ""}${shout ? " is-shout" : ""}${action === null ? "" : " is-action"}${thought === null ? "" : " is-think"}`;
      s.p.style.setProperty("--tint", m.accent ?? "");
      // The twin measures the stacked size, so it wears the shout's weight too.
      s.twin.classList.toggle("is-shout", shout);
      s.twin.classList.toggle("is-action", action !== null);
      s.twin.classList.toggle("is-think", thought !== null);
      s.stacked = false;
      s.who.hidden = action === null;
      s.whoText.data = m.name;
      s.textNode.data = text;
      s.text.setAttribute("data-testid", "chat-message");
      s.twinSay.dataset["who"] = m.name;
      s.twinSay.dataset["say"] = text;
      show(s, m.at, now);
    },
    typing(id, on, at) {
      if (!on) {
        waiting.delete(id);
        for (const t of slots) if (t.typing && t.speaker === id) free(t);
        return;
      }
      // One already up or waiting; a leaving one is left to go.
      if (waiting.has(id)) return;
      for (const t of slots) if (t.typing && t.state === LIVE && t.speaker === id) return;
      // Shown once on for a whole step (QA OME-1401): a line straight after the first keystroke costs no node.
      const now = o.now();
      waiting.set(id, { x: at.x, y: at.y, since: now });
      run(now);
    },
    move(id, x, y) {
      const w = waiting.get(id);
      if (w !== undefined) {
        w.x = x;
        w.y = y;
      }
      for (const s of slots) if (s.state !== FREE && s.speaker === id) anchor(s, x, y);
    },
    settle(id, x, y) {
      let any = false;
      for (const s of slots) {
        if (s.state === FREE || s.speaker !== id) continue;
        anchor(s, x, y);
        if (!s.measured) continue;
        placeBox(s);
        any = true;
      }
      if (any) resolve();
    },
    keep(ids) {
      for (const s of slots) if (s.speaker !== null && !s.typing && !ids.has(s.speaker)) free(s);
    },
    scale(next) {
      if (next === k) return;
      k = next;
      for (const s of slots) {
        if (s.state === FREE || !s.measured) continue;
        placeBox(s);
        // The push is written in the wrapper's own px: rewrite it at the new scale (live ones are stacked again below).
        const push = s.state === LIVE ? 0 : s.push;
        s.push = Number.NaN;
        setPush(s, push);
      }
      resolve();
    },
  };
}
