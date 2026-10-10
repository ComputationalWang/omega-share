// The first-visit hint (OME-768, M9 W2): a small card in the page's flow, never over the picture or the composer, that says
// how to use the room. Once per browser (`localStorage`), announced politely, gone with Esc, its close key, or the first
// thing it mentions (the room calls dismiss()). Idle DOM: no frame work. Text only.
import { el, sprite } from "../controls/dom";

/** Set once the hint has been shown in this browser. */
export const HINT_STORAGE_KEY = "omega.hintSeen";

const KEYBOARD = "Click a seat to sit · type to chat · T for emotes · F for full screen";
const TOUCH = "Tap a seat to sit · tap the message field to chat · the emote key for emotes · the frame key for full screen";

export interface HintOptions {
  /** The `localStorage` getter itself throws when storage is blocked: pass a wrapper that goes through it lazily. */
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  /** No hover (`(hover: none)`): a touch screen, so the words are about tapping. */
  readonly touch: () => boolean;
  /** Where focus goes when the close key had it: the next key on the page. */
  readonly next: () => HTMLElement | null;
}

export interface FirstHint {
  readonly root: HTMLElement;
  isOpen(): boolean;
  /** The room is up: show the hint if this browser has never seen it. */
  show(): void;
  /** Gone for this page (it was already marked seen when it showed). */
  dismiss(): void;
}

function seen(s: HintOptions["storage"]): boolean {
  try {
    return s.getItem(HINT_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function markSeen(s: HintOptions["storage"]): void {
  try {
    s.setItem(HINT_STORAGE_KEY, "1");
  } catch {
    // Storage off (private mode): it shows again on the next visit.
  }
}

export function createFirstHint(o: HintOptions): FirstHint {
  // The live region exists (empty) before the words go in, so a screen reader announces them.
  const root = el("div", { className: "ui-panel first-hint", hidden: true }, "first-hint");
  root.setAttribute("aria-live", "polite");
  const text = el("p", { className: "first-hint-text" });
  const close = el("button", { type: "button", className: "ui-button secondary icon", title: "Dismiss" }, "first-hint-close");
  close.setAttribute("aria-label", "Dismiss the tip");
  close.append(sprite("ui-icon-close"));
  root.append(text, close);
  let open = false;
  let done = false;

  const dismiss = (): void => {
    done = true;
    if (!open) return;
    open = false;
    const had = root.contains(document.activeElement);
    root.hidden = true;
    text.textContent = "";
    if (had) o.next()?.focus({ preventScroll: true });
  };
  close.addEventListener("click", dismiss);

  return {
    root,
    isOpen: () => open,
    show() {
      if (open || done) return;
      // Asked once per page: the room calls this on every render.
      done = true;
      if (seen(o.storage)) return;
      markSeen(o.storage);
      open = true;
      root.hidden = false;
      text.textContent = o.touch() ? TOUCH : KEYBOARD;
    },
    dismiss,
  };
}
