import { saveResume, type Left, type ResumeStore } from "./session-record";

// The landing's "You left <room> — Rejoin" chip (OME-2105, ADR 0043 amendment 3). Fixed, so its arrival moves nothing
// (landing CLS). The title is room content: text only. Rejoin puts the session back where the room page looks for it.

export interface RejoinChipOptions {
  readonly parent: HTMLElement;
  readonly left: Left;
  readonly now: number;
  readonly session: Pick<ResumeStore, "setItem">;
  readonly navigate: (path: string) => void;
  /** Where focus goes if the chip leaves while it still has it (the page's heading), never <body> (OME-2429). */
  readonly fallback: HTMLElement;
  readonly setTimeout: (fn: () => void, ms: number) => number;
  readonly clearTimeout: (id: number) => void;
}

export function mountRejoinChip(o: RejoinChipOptions): HTMLElement {
  const chip = document.createElement("p");
  chip.className = "rejoin-chip";
  chip.setAttribute("role", "status");
  chip.setAttribute("data-testid", "rejoin-chip");
  const rejoin = document.createElement("button");
  rejoin.type = "button";
  rejoin.textContent = "Rejoin";
  rejoin.addEventListener("click", () => {
    saveResume(o.session, o.left.record);
    o.navigate(`/r/${o.left.record.roomId}`);
  });
  chip.append(`You left ${o.left.title ?? "the room"} `, rejoin);
  const timer = o.setTimeout(() => {
    const had = chip.contains(document.activeElement);
    chip.remove();
    if (had) o.fallback.focus({ preventScroll: true });
  }, o.left.until - o.now);
  o.parent.append(chip);
  // Focus starts here after Leave (OME-2429); put there by us, it doesn't hold the chip (the listener comes after).
  rejoin.focus({ preventScroll: true });
  // Someone on it with a keyboard or a screen reader keeps it (WCAG 2.2.1); past the hold the room page offers Enter.
  chip.addEventListener("focusin", () => {
    o.clearTimeout(timer);
  });
  return chip;
}
