// Full screen's "hide chat" (OME-1491, board OME-1488): a video-only view where people stay present as bubbles. While
// full screen lasts and the viewer hid the chat, the strip and the shelf go (room-layout.ts, layout.ts "hidden") and each
// line from someone else floats over the picture's bottom-right corner: the speaker's head (the landing's avatar sheet,
// no new art), nickname and text, clamped to 2 lines. At most 4, the oldest out first, each gone after ~6 s. CSS does
// the drift and the fade (transform/opacity, room.css); JS only adds and removes nodes, one timer per bubble.
import { el } from "./controls/dom";

const STORAGE_KEY = "omega.fsChatHidden";
export const FS_BUBBLE_CAP = 4;
export const FS_BUBBLE_MS = 6000;
/** The pill dims after this long without a pointer move. */
export const FS_PILL_IDLE_MS = 3000;

export interface FsChatOptions<H> {
  readonly store: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null;
  readonly setTimer: (fn: () => void, ms: number) => H;
  readonly clearTimer: (h: H) => void;
  /** Where the toggle sits while the chat shows (the strip's head). */
  readonly home?: HTMLElement;
  /** The effective hidden state changed (full screen and the choice): the layout follows. */
  readonly onChange: (hidden: boolean) => void;
}

export interface FsChat {
  /** The bubbles' region, over the picture: polite, never takes the pointer. */
  readonly bubbles: HTMLElement;
  /** The top-corner pill that holds the toggle while the chat is hidden. */
  readonly pill: HTMLElement;
  readonly toggle: HTMLButtonElement;
  /** Full screen is on and the viewer hid the chat. */
  hidden(): boolean;
  setHidden(on: boolean): void;
  /** Full screen began or ended. */
  setActive(on: boolean): void;
  /** C toggles in full screen, not while typing; a held key's repeats are swallowed. True if handled. */
  key(key: string, typing: boolean, repeat?: boolean): boolean;
  /** A chat line from someone else. */
  say(avatar: number, nickname: string, text: string): void;
  /** A pointer moved: the pill comes back for a while. */
  wake(): void;
}

function readStored(store: FsChatOptions<unknown>["store"]): boolean {
  try {
    return store?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function createFsChat<H>(o: FsChatOptions<H>): FsChat {
  const bubbles = el("div", { className: "fs-bubbles", ariaLabel: "Chat bubbles", hidden: true }, "fs-bubbles");
  bubbles.setAttribute("aria-live", "polite");
  const pill = el("div", { className: "fs-chat-pill", hidden: true });
  const toggle = el("button", { type: "button", className: "ui-button self fs-chat-toggle", ariaLabel: "Hide chat" }, "fs-chat-toggle");
  toggle.setAttribute("aria-keyshortcuts", "C");
  let chosen = readStored(o.store);
  let active = false;
  let shown = false;
  const live: { node: HTMLElement; timer: H }[] = [];
  let idle: H | null = null;

  const drop = (i: number): void => {
    const b = live[i];
    if (b === undefined) return;
    o.clearTimer(b.timer);
    b.node.remove();
    live.splice(i, 1);
  };
  const clearBubbles = (): void => {
    while (live.length > 0) drop(0);
  };
  const wake = (): void => {
    if (idle !== null) o.clearTimer(idle);
    idle = null;
    pill.classList.remove("is-idle");
    if (!shown) return;
    idle = o.setTimer(() => {
      idle = null;
      pill.classList.add("is-idle");
    }, FS_PILL_IDLE_MS);
  };
  const render = (): void => {
    const next = active && chosen;
    toggle.setAttribute("aria-pressed", String(chosen));
    toggle.textContent = next ? "Chat hidden · C" : "Hide chat";
    // One key, two homes: the pill while hidden, the strip's head otherwise. Focus survives the move.
    const home = next ? pill : o.home;
    if (home !== undefined && toggle.parentElement !== home) {
      const focused = document.activeElement === toggle;
      home.append(toggle);
      if (focused) toggle.focus({ preventScroll: true });
    }
    pill.hidden = !next;
    bubbles.hidden = !next;
    if (next === shown) return;
    shown = next;
    if (!next) clearBubbles();
    wake();
    o.onChange(next);
  };
  const setHidden = (on: boolean): void => {
    chosen = on;
    try {
      o.store?.setItem(STORAGE_KEY, on ? "1" : "0");
    } catch {
      // Storage off (private mode): remembered for this page only.
    }
    render();
  };
  toggle.addEventListener("click", () => {
    setHidden(!chosen);
  });
  pill.addEventListener("focusin", wake);
  render();

  return {
    bubbles,
    pill,
    toggle,
    hidden: () => shown,
    setHidden,
    setActive(on) {
      active = on;
      render();
    },
    key(key, typing, repeat = false) {
      if ((key !== "c" && key !== "C") || typing || !active) return false;
      if (!repeat) setHidden(!chosen);
      return true;
    },
    say(avatar, nickname, text) {
      if (!shown) return;
      if (live.length >= FS_BUBBLE_CAP) drop(0);
      const head = el("span", { className: `fs-bubble-head a${String(avatar)}`, ariaHidden: "true" });
      const name = el("span", { className: "fs-bubble-name", textContent: nickname });
      const words = el("span", { className: "fs-bubble-text", textContent: text });
      const node = el("div", { className: "fs-bubble" });
      node.append(head, name, words);
      bubbles.append(node);
      const entry = { node, timer: o.setTimer(() => { drop(live.indexOf(entry)); }, FS_BUBBLE_MS) };
      live.push(entry);
    },
    wake,
  };
}
