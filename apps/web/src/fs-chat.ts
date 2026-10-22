// Full screen's "hide chat" (OME-1491, board OME-1488): a video-only view where people stay present as bubbles. While
// full screen lasts and the viewer hid the chat, the strip and the shelf go (room-layout.ts, layout.ts "hidden") and each
// line from someone else shows where the screen leaves room beside or under the picture (the strip's box; OME-1593): the speaker's head (the
// landing's avatar sheet, no new art), nickname and text, clamped to 2 lines. At most 4, the oldest out first, each gone
// after ~6 s. CSS does the drift and the fade (transform/opacity, room.css); JS only adds and removes nodes, one timer
// per bubble.
import { el } from "./controls/dom";

const STORAGE_KEY = "omega.fsChatHidden";
export const FS_BUBBLE_CAP = 4;
export const FS_BUBBLE_MS = 6000;
/** The pill dims after this long without a pointer move. */
export const FS_PILL_IDLE_MS = 3000;
/** A peek (OME-1668) ends this long after the pointer leaves, unless held. */
export const FS_PEEK_MS = 2000;

export interface FsChatOptions<H> {
  readonly store: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null;
  readonly setTimer: (fn: () => void, ms: number) => H;
  readonly clearTimer: (h: H) => void;
  /** The effective hidden state changed (full screen and the choice): the layout follows. */
  readonly onChange: (hidden: boolean) => void;
}

export interface FsChat {
  /** The bubbles' column, beside the picture: polite, never takes the pointer. */
  readonly bubbles: HTMLElement;
  /** The handle (OME-1593) that holds the toggle: the layout places it on the strip's edge or the screen's. */
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
  /** OME-1668: in full screen, true shows the hidden chat now; false hides it again FS_PEEK_MS later, unless held. */
  peek(on: boolean): void;
  /** Focus in the chat or a draft in its field: the peek stays while held. */
  hold(on: boolean): void;
}

/** Full screen hides the chat unless the viewer pinned it shown (OME-1668, board OME-1664). */
function readStored(store: FsChatOptions<unknown>["store"]): boolean {
  try {
    return store?.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function createFsChat<H>(o: FsChatOptions<H>): FsChat {
  const bubbles = el("div", { className: "fs-bubbles", ariaLabel: "Chat bubbles", hidden: true }, "fs-bubbles");
  bubbles.setAttribute("aria-live", "polite");
  const pill = el("div", { className: "fs-chat-pill", hidden: true });
  const toggle = el("button", { type: "button", className: "ui-button self icon fs-chat-toggle", ariaLabel: "Hide chat" }, "fs-chat-toggle");
  pill.append(toggle);
  toggle.setAttribute("aria-keyshortcuts", "C");
  let chosen = readStored(o.store);
  let active = false;
  let shown = false;
  const live: { node: HTMLElement; timer: H }[] = [];
  let idle: H | null = null;
  let peeking = false;
  let held = false;
  let peekTimer: H | null = null;

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
    const next = active && chosen && !peeking;
    // During a peek the handle still pins the chat shown.
    toggle.ariaLabel = active && chosen ? "Show chat" : "Hide chat";
    toggle.setAttribute("aria-expanded", String(!next));
    // The layout shows and places the handle (room-layout.ts); out of full screen it goes.
    if (!active) pill.hidden = true;
    bubbles.hidden = !next;
    if (next === shown) return;
    shown = next;
    if (!next) clearBubbles();
    wake();
    o.onChange(next);
  };
  const setHidden = (on: boolean): void => {
    chosen = on;
    // A choice ends the peek: hidden now, or pinned shown.
    if (peekTimer !== null) o.clearTimer(peekTimer);
    peekTimer = null;
    peeking = false;
    try {
      o.store?.setItem(STORAGE_KEY, on ? "1" : "0");
    } catch {
      // Storage off (private mode): remembered for this page only.
    }
    render();
  };
  const peek = (on: boolean): void => {
    if (on) {
      if (peekTimer !== null) o.clearTimer(peekTimer);
      peekTimer = null;
      if (!active || !chosen || peeking) return;
      peeking = true;
      render();
      return;
    }
    if (!peeking || peekTimer !== null) return;
    peekTimer = o.setTimer(() => {
      peekTimer = null;
      if (held) return;
      peeking = false;
      render();
    }, FS_PEEK_MS);
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
      if (peekTimer !== null) o.clearTimer(peekTimer);
      peekTimer = null;
      peeking = false;
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
    peek,
    hold(on) {
      held = on;
      peek(on);
    },
  };
}
