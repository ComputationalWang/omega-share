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
  /** While the TV shows anything (a player, a Load card), no chip covers it; while it's empty, none covers `message`: Twitch's player doesn't start covered
   * (OME-1778). One that would goes under the picture (the TV and the stage), or out of sight if that's on the TV too. */
  readonly tv: { readonly box: HTMLElement; readonly empty: () => boolean; readonly picture: HTMLElement; readonly message: HTMLElement };
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

interface Spot {
  readonly left: number;
  readonly top: number;
}

/** Where a `w`×`h` chip goes against `anchor`, kept in the viewport; null while the anchor has no box. */
function spot(anchor: HTMLElement | null, side: Side, w: number, h: number): Spot | null {
  const r = anchor?.getBoundingClientRect();
  if (r === undefined || r.width === 0 || r.height === 0) return null;
  const top = side === "above" ? r.top - h - GAP : r.bottom + GAP;
  return { left: Math.max(GAP, Math.min(r.left + (r.width - w) / 2, window.innerWidth - w - GAP)), top: Math.max(GAP, Math.min(top, window.innerHeight - h - GAP)) };
}

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
  // A video arriving swaps the TV's screen without a resize: the chip moves off before the player loads.
  const swapped = new MutationObserver(() => {
    place();
  });

  const place = (): void => {
    const side = STEPS[step]?.side;
    if (side === undefined) return;
    const w = root.offsetWidth;
    const h = root.offsetHeight;
    // An empty TV may be covered, but not its message (OME-2104).
    const tv = (o.tv.empty() ? o.tv.message : o.tv.box).getBoundingClientRect();
    const onTv = (p: Spot): boolean => p.left < tv.right && tv.left < p.left + w && p.top < tv.bottom && tv.top < p.top + h;
    let at = spot(o.anchor(step), side, w, h);
    if (at !== null && onTv(at)) at = spot(o.tv.picture, "below", w, h);
    // Nothing to sit beside (the stage behind People on a phone), or nowhere off the TV: out of sight until there is.
    const away = at === null || onTv(at);
    if (away && root.contains(document.activeElement)) o.next()?.focus({ preventScroll: true });
    root.style.visibility = away ? "hidden" : "";
    if (at === null || away) return;
    root.style.left = `${String(at.left)}px`;
    root.style.top = `${String(at.top)}px`;
  };

  const go = (to: number): void => {
    const s = STEPS[to];
    if (s === undefined) return;
    if (step === -1) {
      window.addEventListener("resize", place);
      window.addEventListener("scroll", place, { capture: true, passive: true });
    }
    if (step === -1) swapped.observe(o.tv.box, { childList: true });
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
    swapped.disconnect();
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
