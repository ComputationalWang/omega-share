// The first-visit tour (OME-1587; it replaces OME-768's one-card hint): three chips, one after another, each beside what it
// talks about. "Got it" moves on, "Skip" (or Esc, via dismiss()) ends it. Seen once per device (`omega.hints`). A status,
// never a modal: fixed over the page like the emote wheel, it takes no focus and blocks nothing but its own box. Idle
// DOM: placed once per chip and on resize or scroll while it shows, no frame work. The anchor is observed too: the room
// shows the tour before its stage is laid out (390×844 portrait, OME-1601), and a chip placed then sits over the room bar.
import * as v from "valibot";
import { el } from "../controls/dom";

export const HINTS_KEY = "omega.hints";

/** Where a chip goes against its anchor: just above it or just below it. Not on the stage: on a phone that's a thin strip
 * and a chip there covers seats or, placed before layout, the room bar (a11y sweep 320×640, 390×844; OME-1601). */
type Side = "above" | "below";
const STEPS: readonly { readonly text: string; readonly side: Side }[] = [
  { text: "Click the floor to walk, double-click to jog", side: "above" },
  { text: "Type / for commands, or open ✦", side: "above" },
  { text: "Pick colours and a hat in People", side: "below" },
];

const STORED = v.object({ seen: v.literal(true) });

/** `localStorage` is untrusted (anyone can edit it): anything but what the tour writes reads as not seen. */
export function parseHints(raw: string | null): { readonly seen: boolean } {
  if (raw === null) return { seen: false };
  try {
    return { seen: v.is(STORED, JSON.parse(raw)) };
  } catch {
    return { seen: false };
  }
}

export interface HintsOptions {
  /** The `localStorage` getter itself throws when storage is blocked: pass a wrapper that goes through it lazily. */
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  /** What chip `step` sits beside; while it's null or has no box the chip is out of sight (and the tour still open). */
  readonly anchor: (step: number) => HTMLElement | null;
  /** Where focus goes when the chip had it and the tour ends: the next key on the page. */
  readonly next: () => HTMLElement | null;
}

export interface Hints {
  readonly root: HTMLElement;
  isOpen(): boolean;
  /** The room is up: start the tour if this device has never seen it. */
  show(): void;
  /** End the tour for this page (it was marked seen when it started). */
  dismiss(): void;
  /** Show tips again: from the first chip, seen or not. */
  restart(): void;
}

const GAP = 8;

export function createHints(o: HintsOptions): Hints {
  // The status exists (empty, hidden) before the words go in, so a screen reader announces them.
  const root = el("div", { className: "ui-panel hint-chip", hidden: true }, "first-hint");
  root.setAttribute("role", "status");
  const text = el("p", { className: "hint-chip-text" });
  const skip = el("button", { type: "button", className: "ui-button secondary", textContent: "Skip" }, "hint-skip");
  const next = el("button", { type: "button", className: "ui-button", textContent: "Got it" }, "hint-next");
  const acts = el("div", { className: "hint-chip-acts" });
  acts.append(skip, next);
  root.append(text, acts);
  let step = -1;
  let asked = false;
  const sized = new ResizeObserver(() => {
    place();
  });

  const place = (): void => {
    const side = STEPS[step]?.side;
    if (side === undefined) return;
    const r = o.anchor(step)?.getBoundingClientRect();
    // Nothing to sit beside (the stage behind People on a phone): out of sight until it's back, never over the room bar.
    const away = r === undefined || r.width === 0 || r.height === 0;
    if (away && root.contains(document.activeElement)) o.next()?.focus({ preventScroll: true });
    root.style.visibility = away ? "hidden" : "";
    if (away) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = root.offsetWidth;
    const h = root.offsetHeight;
    const top = side === "above" ? r.top - h - GAP : r.bottom + GAP;
    root.style.left = `${String(Math.max(GAP, Math.min(r.left + (r.width - w) / 2, vw - w - GAP)))}px`;
    root.style.top = `${String(Math.max(GAP, Math.min(top, vh - h - GAP)))}px`;
  };

  const go = (to: number): void => {
    const s = STEPS[to];
    if (s === undefined) return;
    if (step === -1) {
      window.addEventListener("resize", place);
      window.addEventListener("scroll", place, { capture: true, passive: true });
    }
    step = to;
    sized.disconnect();
    const a = o.anchor(to);
    if (a !== null) sized.observe(a);
    root.hidden = false;
    text.textContent = s.text;
    place();
  };

  /** Only a showing tour can end: the room calls this before it's up (no stage yet), and that mustn't use up the show. */
  const dismiss = (): void => {
    if (step === -1) return;
    step = -1;
    sized.disconnect();
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place, { capture: true });
    const had = root.contains(document.activeElement);
    root.hidden = true;
    text.textContent = "";
    if (had) o.next()?.focus({ preventScroll: true });
  };
  skip.addEventListener("click", dismiss);
  next.addEventListener("click", () => {
    if (step + 1 < STEPS.length) go(step + 1);
    else dismiss();
  });

  return {
    root,
    isOpen: () => step !== -1,
    show() {
      // Asked once per page: the room calls this on every render.
      if (asked) return;
      asked = true;
      try {
        if (parseHints(o.storage.getItem(HINTS_KEY)).seen) return;
        o.storage.setItem(HINTS_KEY, JSON.stringify({ seen: true }));
      } catch {
        // Storage off (private mode): it shows again on the next visit.
      }
      go(0);
    },
    dismiss,
    restart() {
      asked = true;
      go(0);
    },
  };
}
