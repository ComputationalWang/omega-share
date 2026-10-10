// The emote key and set (l)'s emote wheel (OME-415, OME-732). The key (or T) opens the wheel over your own head: the six
// stickers clockwise from 12 in key order, roving focus on the arrows, Enter/Space or a click sends, Esc or T closes and
// focus goes back where it was. Keys 1–6 send straight away. When the local bucket is empty the key cools (`is-cooling`)
// and the slots are `aria-disabled` until a token is back, so we never send what the server would drop.
// The wheel is DOM in page chrome, never the canvas: opening it draws nothing in the room (R-M8a §4).
import type { ClientMessage, EmoteKind } from "@omega/shared";
import { el, sprite } from "../controls/dom";
import type { Point, Rect } from "../layout";
import { EMOTE_LABELS, PICKER_KINDS, createEmoteBucket, kindForKey } from "./emotes";
import { placeWheel } from "./wheel-place";

export interface EmotePickerOptions {
  readonly send: (m: ClientMessage) => boolean;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (h: unknown) => void;
  /**
   * Where the wheel opens (viewport px): your avatar's emote point, null if you have none in the room, and the room's
   * visible box. Without it (the pop-out chat) the wheel docks above the composer.
   */
  readonly locate?: () => { readonly head: Point | null; readonly room: Rect } | null;
  /** The wheel is opening (key or T), before it's placed: the page settles anything that would move it (OME-768). */
  readonly onOpen?: () => void;
}

export interface EmotePicker {
  readonly root: HTMLElement;
  /** A keydown on the page: T toggles the wheel, keys 1–6 emote, the wheel's own keys while it's open. True if it was ours (the caller prevents the default). */
  key(ev: KeyboardEvent): boolean;
  /** Close the wheel if it's open (your avatar started walking), focus back where it was. */
  close(): void;
}

/** Typing somewhere: digits and T belong to the field, not to the wheel. */
function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement);
}

const NO_ROOM: Rect = { x: 0, y: 0, w: 0, h: 0 };

interface Wheel {
  readonly menu: HTMLElement;
  readonly slots: readonly HTMLButtonElement[];
  readonly hub: HTMLElement;
  readonly chip: HTMLElement;
}

export function createEmotePicker(o: EmotePickerOptions): EmotePicker {
  const root = el("div", { className: "emote-picker" });
  const key = el("button", { type: "button", className: "ui-button self icon", ariaLabel: "Emote", title: "Emote (T, 1–6)" }, "emote-key");
  key.setAttribute("aria-haspopup", "menu");
  key.setAttribute("aria-expanded", "false");
  key.setAttribute("aria-keyshortcuts", "T");
  key.append(sprite("ui-icon-wheel"));
  root.append(key);

  const bucket = createEmoteBucket(o.now());
  let cooling = false;
  let timer: unknown = null;
  /** Built on the first open (DOM only, no chunk: it's six buttons). */
  let wheel: Wheel | null = null;
  let open = false;
  let selected = 0;
  /** What had focus when the wheel opened; it gets it back on close. */
  let before: HTMLElement | null = null;

  function build(): Wheel {
    const menu = el("div", { className: "ui-wheel", role: "menu", hidden: true }, "emote-menu");
    menu.setAttribute("aria-label", "Emotes");
    // reference.css places .ui-wheel-slot:nth-child(1..6) clockwise from 12, so the slots lead and their places are set once.
    const slots = PICKER_KINDS.map((kind, i) => {
      const shortcut = String(i + 1);
      const b = el("button", { type: "button", className: "ui-wheel-slot", role: "menuitem", tabIndex: -1, title: `${EMOTE_LABELS[kind]} (${shortcut})` }, "emote-item");
      b.setAttribute("aria-label", EMOTE_LABELS[kind]);
      b.setAttribute("aria-keyshortcuts", shortcut);
      b.dataset["kind"] = kind;
      b.append(sprite(`ui-emote-pick-${kind}`));
      b.addEventListener("click", () => {
        pick(i);
      });
      // Hover previews in the hub; the selection (and focus) stays put.
      b.addEventListener("pointerenter", () => {
        if (!cooling) showHub(kind);
      });
      b.addEventListener("pointerleave", () => {
        paintSelection();
      });
      return b;
    });
    const hub = el("span", { className: "ui-wheel-hub" });
    hub.setAttribute("aria-hidden", "true");
    const chip = el("span", { className: "ui-chip self ui-wheel-label" });
    chip.setAttribute("aria-hidden", "true");
    menu.append(...slots, hub, chip);
    root.append(menu);
    return { menu, slots, hub, chip };
  }

  function showHub(kind: EmoteKind): void {
    if (wheel === null) return;
    wheel.hub.replaceChildren(sprite(`ui-emote-pick-${kind}`));
  }

  /** The hub, the chip and the cool state from `selected` and the bucket. */
  function paintSelection(): void {
    if (wheel === null) return;
    const kind = PICKER_KINDS[selected] ?? "heart";
    for (const [i, b] of wheel.slots.entries()) {
      b.tabIndex = i === selected ? 0 : -1;
      b.setAttribute("aria-disabled", String(cooling));
    }
    if (cooling) {
      const now = o.now();
      const left = Math.max(0, bucket.readyAt(now) - now);
      const dial = sprite("ui-wait");
      dial.style.setProperty("--cool", `${String(left)}ms`);
      wheel.hub.replaceChildren(dial);
      wheel.chip.replaceChildren(`Emotes in ${String(Math.ceil(left / 1000))} s`);
    } else {
      showHub(kind);
      wheel.chip.replaceChildren(EMOTE_LABELS[kind], el("kbd", { className: "ui-kbd is-small", textContent: String(selected + 1) }));
    }
  }

  function select(i: number): void {
    if (wheel === null) return;
    selected = (i + PICKER_KINDS.length) % PICKER_KINDS.length;
    paintSelection();
    // Focusing the slot mustn't scroll the page: that would close the wheel.
    wheel.slots[selected]?.focus({ preventScroll: true });
  }

  function setCooling(on: boolean): void {
    if (cooling === on) return;
    cooling = on;
    key.classList.toggle("is-cooling", on);
    key.setAttribute("aria-disabled", String(on));
    if (wheel !== null) paintSelection();
  }

  function rearm(): void {
    if (timer !== null) o.clearTimer(timer);
    timer = null;
    const now = o.now();
    const at = bucket.readyAt(now);
    setCooling(at > now);
    if (at > now) {
      timer = o.setTimer(() => {
        timer = null;
        rearm();
      }, at - now);
    }
  }

  function emote(i: number): void {
    const kind = PICKER_KINDS[i];
    const now = o.now();
    if (kind === undefined || bucket.readyAt(now) > now) return;
    if (o.send({ type: "emote", kind })) bucket.take(now);
    rearm();
  }

  /** A pick from the open wheel sends and closes; while cooling it sends nothing and stays open, the dial running (OME-776). */
  function pick(i: number): void {
    if (cooling) return;
    emote(i);
    close(true);
  }

  /**
   * The wheel is placed once, `position: fixed`: a scroll of the page (or of a scroller holding the key, the wide page
   * column) would leave it behind, off your head, so it closes (OME-776). Other scrollers (the chat log) don't move it.
   */
  function onScroll(ev: Event): void {
    if (ev.target === document || (ev.target instanceof Node && ev.target.contains(root))) close(false);
  }

  function show(): void {
    const focused = document.activeElement;
    before = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    o.onOpen?.();
    wheel ??= build();
    const where = o.locate?.() ?? null;
    const r = (root.parentElement ?? root).getBoundingClientRect();
    const p = placeWheel(where?.head ?? null, where?.room ?? NO_ROOM, { x: r.left, y: r.top, w: r.width, h: r.height });
    wheel.menu.style.left = `${String(p.x)}px`;
    wheel.menu.style.top = `${String(p.y)}px`;
    wheel.menu.classList.toggle("no-tail", !p.tail);
    open = true;
    wheel.menu.hidden = false;
    key.setAttribute("aria-expanded", "true");
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    select(0);
  }

  /** Closes the wheel; `refocus` puts focus back where it was (not when focus already went elsewhere). */
  function close(refocus: boolean): void {
    if (!open || wheel === null) return;
    open = false;
    document.removeEventListener("scroll", onScroll, { capture: true });
    const had = wheel.menu.contains(document.activeElement);
    wheel.menu.hidden = true;
    key.setAttribute("aria-expanded", "false");
    if (refocus && had) {
      if (before?.isConnected === true) before.focus();
      else if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    }
    before = null;
  }

  // A click anywhere else takes focus out of the wheel: close it.
  root.addEventListener("focusout", (ev) => {
    if (!(ev.relatedTarget instanceof Node && root.contains(ev.relatedTarget))) close(false);
  });
  key.addEventListener("click", () => {
    if (open) close(true);
    else show();
  });

  /** The wheel's own keys while it's open; null if the key isn't one of them. */
  function wheelKey(ev: KeyboardEvent): boolean | null {
    switch (ev.key) {
      case "Escape":
        close(true);
        return true;
      case "ArrowRight":
      case "ArrowDown":
        select(selected + 1);
        return true;
      case "ArrowLeft":
      case "ArrowUp":
        select(selected - 1);
        return true;
      case "Home":
        select(0);
        return true;
      case "End":
        select(PICKER_KINDS.length - 1);
        return true;
      case "Enter":
      case " ":
        if (!ev.repeat) pick(selected);
        return true;
      case "Tab":
        close(false);
        return false;
      default:
        return null;
    }
  }

  return {
    root,
    key(ev) {
      if (ev.isComposing) return false;
      if (open) {
        const own = wheelKey(ev);
        if (own !== null) return own;
      } else if (ev.key === "Escape") return false;
      if (ev.ctrlKey || ev.altKey || ev.metaKey || typing(ev.target)) return false;
      if (ev.key === "t" || ev.key === "T") {
        if (ev.shiftKey || document.querySelector("dialog[open]") !== null) return false;
        if (ev.repeat) return true;
        if (open) close(true);
        else show();
        return true;
      }
      const kind = kindForKey(ev.key);
      if (kind === null) return false;
      // A held key sends once; its repeats are ours (swallowed) but spend nothing.
      if (ev.repeat) return true;
      if (open) pick(PICKER_KINDS.indexOf(kind));
      else emote(PICKER_KINDS.indexOf(kind));
      return true;
    },
    close() {
      close(true);
    },
  };
}
