// Floating chat bubbles (OME-730, M8 W1, set (l) `.ui-float`; research m8-smooth-walk.md §4). DOM on the compositor, never
// the Pixi room: a bubble costs no canvas render and no JS per frame. A fixed pool of 8 nodes, reused oldest-first, so a
// message creates and destroys nothing. Each node is two elements: the outer one rides the speaker's head (`move`, on
// every walk frame, a transform write only); the inner one runs the rise and fade @keyframes, so a walk never restarts
// them. Overlap is resolved once per frame that brings sizes and once per walk end (`settle`), never per walk frame:
// newest nearest the heads, an older bubble in a newer one's way moves straight up, 3 px clear, loses its tail and names
// its speaker. Nothing here reads layout (OME-802): a ResizeObserver hands over each new bubble's size from the frame's
// own layout, before paint, along with its stacked twin's (the same box with the name, never painted), so neither a
// message nor a bubble that stacks forces a style and layout pass of its own.
// The layer is decorative (aria-hidden, no live region): the chat log is the accessible record.
import type { MemberId } from "@omega/shared";
import { el } from "../controls/dom";
import { STAGE_W, type Point } from "../layout";

/** Set (l) `meta.omega.bubbles`: a 5 s life, a 24 px rise in whole-pixel steps, 2 per speaker, 8 on screen. */
export const FLOAT_LIFE_MS = 5000;
export const FLOAT_RISE = 24;
export const FLOAT_LEAVE_MS = 160;
export const FLOAT_POOL = 8;
export const FLOAT_PER_SPEAKER = 2;
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

export interface FloatMessage {
  readonly id: MemberId;
  /** The speaker's nickname: a stacked bubble names them. */
  readonly name: string;
  readonly text: string;
  /** My own bubble wears the mustard rim. */
  readonly self: boolean;
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
   * The layer was hidden or shown (full screen, the room popped out and back): a hidden subtree has no CSS animations.
   * Puts every live bubble's animation back at its age (the ones said while hidden are sized, placed and stacked when
   * their size arrives). Call it on the layer's resize, not per frame.
   */
  reflow(): void;
}

export interface FloatsOptions {
  readonly reducedMotion: { readonly matches: boolean };
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (h: unknown) => void;
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
  readonly p: HTMLParagraphElement;
  readonly who: HTMLElement;
  readonly text: HTMLSpanElement;
  /** The stacked twin: the bubble's box with its speaker's name, laid out but never painted (generated content). */
  readonly twin: HTMLParagraphElement;
  readonly twinSay: HTMLSpanElement;
  state: typeof FREE | typeof LIVE | typeof LEAVING;
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
  /** False until both sizes arrive (a frame later, or once a hidden stage shows): not placed, stacked or animated. */
  measured: boolean;
  timer: unknown;
}

const px = (n: number): string => `${String(n)}px`;

export function createFloats(layer: HTMLElement, o: FloatsOptions): Floats {
  layer.setAttribute("aria-hidden", "true");
  layer.removeAttribute("aria-live");
  const watch = (o.watch ?? resizeWatch)((entries) => {
    sized(entries);
  });
  const slots: Slot[] = Array.from({ length: FLOAT_POOL }, () => {
    const text = el("span");
    const who = el("b", { className: "who", hidden: true });
    const say = el("span", { className: "say" });
    say.append(who, text);
    const p = el("p", { className: "ui-float" });
    p.append(say);
    const twinSay = el("span");
    const twin = el("p", { className: "float-twin" });
    twin.append(twinSay);
    const outer = el("div", { className: "float-slot", hidden: true });
    outer.append(p, twin);
    layer.append(outer);
    return { outer, p, who, text, twin, twinSay, state: FREE, speaker: null, seq: 0, startedAt: 0, ax: 0, ay: 0, dx: 0, w: 0, h: 0, sw: 0, sh: 0, sized: 0, push: 0, stacked: false, measured: false, timer: null };
  });
  /** Live bubbles, newest first, rebuilt per resolve (no allocation). */
  const order: Slot[] = [];
  let seq = 0;

  const free = (s: Slot): void => {
    o.clearTimer(s.timer);
    s.timer = null;
    s.state = FREE;
    s.speaker = null;
    watch.unobserve(s.p);
    watch.unobserve(s.twin);
    s.outer.hidden = true;
    s.text.removeAttribute("data-testid");
    s.p.classList.remove("is-live", "is-leaving");
  };

  const leave = (s: Slot): void => {
    o.clearTimer(s.timer);
    s.state = LEAVING;
    s.text.removeAttribute("data-testid");
    // Reduced motion exits at once; so does a bubble never sized (it was never placed or shown: nothing to fade).
    if (o.reducedMotion.matches || !s.measured) {
      free(s);
      return;
    }
    // The leave fade starts now; only the rise keeps an adopted bubble's head start.
    const delay = s.p.style.animationDelay;
    if (delay !== "") s.p.style.animationDelay = `${delay}, 0s`;
    s.p.classList.add("is-leaving");
    s.timer = o.setTimer(() => {
      free(s);
    }, FLOAT_LEAVE_MS);
  };

  const anchor = (s: Slot, x: number, y: number): void => {
    s.ax = x;
    s.ay = y;
    s.outer.style.transform = `translate(${px(x)}, ${px(y)})`;
  };

  /** Keep the box inside the stage's sides; the tail leans when the speaker is past a straight tail's reach. */
  const placeBox = (s: Slot): void => {
    const left = Math.round(Math.max(MARGIN, Math.min(STAGE_W - MARGIN - s.w, s.ax - s.w / 2)));
    s.dx = left - Math.round(s.ax);
    const tailX = Math.max(TAIL_MIN, Math.min(s.w - TAIL_MIN, -s.dx));
    s.p.style.left = px(s.dx);
    s.p.style.top = px(-(s.h + TAIL_BELOW));
    s.p.style.setProperty("--tail-x", px(tailX));
    s.p.classList.toggle("tail-sw", tailX < TAIL_S_REACH);
    s.p.classList.toggle("tail-se", tailX > s.w - TAIL_S_REACH);
  };

  const setPush = (s: Slot, push: number): void => {
    if (push !== s.push || s.p.style.getPropertyValue("--push") === "") s.p.style.setProperty("--push", px(-push));
    s.push = push;
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
   * rate, so their gaps hold for as long as both are up; the older one's head start counts (whole pixels, rounded
   * down: the closest the two get). Pushes only grow: a bubble never slides down.
   */
  const resolve = (): void => {
    order.length = 0;
    for (const s of slots) if (s.state === LIVE && s.measured) order.push(s);
    order.sort((a, b) => b.seq - a.seq);
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
          const lead = reduced ? 0 : Math.min(FLOAT_RISE, Math.max(0, Math.floor(((n.startedAt - s.startedAt) * FLOAT_RISE) / FLOAT_LIFE_MS)));
          const x0 = s.ax + s.dx;
          const nx0 = n.ax + n.dx;
          if (x0 >= nx0 + n.w || nx0 >= x0 + s.w) continue;
          const top = s.ay - (s.h + TAIL_BELOW) - push - lead;
          const bottom = top + s.h;
          const nTop = n.ay - (n.h + TAIL_BELOW) - n.push;
          const nBottom = nTop + n.h + (n.stacked ? 0 : TAIL_BELOW);
          if (top >= nBottom + GAP || bottom + (s.stacked ? 0 : TAIL_BELOW) + GAP <= nTop) continue;
          push += Math.max(0, bottom + GAP - nTop);
          // Re-measured and re-centred: the next pass checks the box as it now is.
          if (!s.stacked) stack(s);
          moved = true;
        }
      }
      setPush(s, push);
    }
  };

  /** Sizes from the frame's layout: a bubble with both is placed and its keyframes start; then one overlap pass. */
  const sized = (entries: readonly SizeEntry[]): void => {
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
          const age = o.now() - s.startedAt;
          s.p.style.animationDelay = age > 0 ? `-${String(age)}ms` : "";
          s.p.classList.add("is-live");
          any = true;
        }
        break;
      }
    }
    if (any) resolve();
  };

  return {
    say(m) {
      const now = o.now();
      const elapsed = Number.isNaN(m.startedAt) ? 0 : Math.max(0, now - m.startedAt);
      if (elapsed >= FLOAT_LIFE_MS) return;
      // 2 per speaker: their oldest goes.
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
      // A free node first, then the oldest leaving one, then the oldest on screen.
      let slot: Slot | null = null;
      for (const s of slots) {
        if (s.state === FREE) {
          slot = s;
          break;
        }
        if (slot === null || (s.state === LEAVING && slot.state === LIVE) || (s.state === slot.state && s.seq < slot.seq)) slot = s;
      }
      if (slot === null) return;
      free(slot);
      const s = slot;
      s.state = LIVE;
      s.speaker = m.id;
      s.seq = ++seq;
      s.startedAt = now - elapsed;
      // Without .is-live the node has no animation or transition: the reset push is instant and, as the frame's style
      // pass sees the node without it, adding .is-live when its size arrives (before paint) starts the keyframes over.
      s.p.className = m.self ? "ui-float is-self" : "ui-float";
      s.stacked = false;
      s.who.hidden = true;
      s.who.textContent = m.name;
      s.text.textContent = m.text;
      s.text.setAttribute("data-testid", "chat-message");
      s.twinSay.dataset["who"] = m.name;
      s.twinSay.dataset["say"] = m.text;
      s.push = 0;
      s.p.style.setProperty("--push", "0px");
      s.outer.hidden = false;
      anchor(s, m.at.x, m.at.y);
      s.measured = false;
      s.sized = 0;
      s.p.style.animationDelay = "";
      watch.observe(s.p);
      watch.observe(s.twin);
      s.timer = o.setTimer(() => {
        free(s);
      }, FLOAT_LIFE_MS - elapsed);
    },
    move(id, x, y) {
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
    reflow() {
      const now = o.now();
      let any = false;
      for (const s of slots) {
        if (s.state !== LIVE || !s.measured) continue;
        const age = now - s.startedAt;
        s.p.style.animationDelay = age > 0 ? `-${String(age)}ms` : "";
        any = true;
      }
      if (any) resolve();
    },
    keep(ids) {
      for (const s of slots) if (s.speaker !== null && !ids.has(s.speaker)) free(s);
    },
  };
}
