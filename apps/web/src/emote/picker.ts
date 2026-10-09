// The emote key and its picker (set (i), OME-415): five stickers, the groove, the wave. Pressing one (or keys 1–6) sends
// `emote` and closes the picker. When the local bucket is empty the key cools (`is-cooling`) and the cells are
// `aria-disabled` until a token is back, so we never send what the server would drop.
import type { ClientMessage } from "@omega/shared";
import { el, sprite } from "../controls/dom";
import { EMOTE_LABELS, PICKER_KINDS, createEmoteBucket, kindForKey } from "./emotes";

export interface EmotePickerOptions {
  readonly send: (m: ClientMessage) => boolean;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (h: unknown) => void;
}

export interface EmotePicker {
  readonly root: HTMLElement;
  /** A keydown on the page: keys 1–6 emote, Escape closes the picker. True if it was ours (the caller prevents the default). */
  key(ev: KeyboardEvent): boolean;
}

/** Typing somewhere: digits belong to the field, not to the picker. */
function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement);
}

export function createEmotePicker(o: EmotePickerOptions): EmotePicker {
  const root = el("div", { className: "emote-picker" });
  const key = el("button", { type: "button", className: "ui-button self icon", ariaLabel: "Emote", title: "Emote (1–6)" }, "emote-key");
  key.setAttribute("aria-haspopup", "menu");
  key.setAttribute("aria-expanded", "false");
  key.append(sprite("ui-icon-emote"));
  const menu = el("div", { className: "ui-emotes", role: "menu", ariaLabel: "Emotes", hidden: true }, "emote-menu");
  const items = PICKER_KINDS.map((kind, i) => {
    const shortcut = String(i + 1);
    const b = el("button", { type: "button", className: "ui-emote", role: "menuitem", title: `${EMOTE_LABELS[kind]} (${shortcut})` }, "emote-item");
    b.setAttribute("aria-label", EMOTE_LABELS[kind]);
    b.setAttribute("aria-keyshortcuts", shortcut);
    b.dataset["kind"] = kind;
    b.append(sprite(`ui-emote-pick-${kind}`));
    if (kind === "wave") menu.append(sprite("ui-emotes-sep"));
    menu.append(b);
    b.addEventListener("click", () => {
      emote(i);
      close();
    });
    return b;
  });
  root.append(menu, key);

  const bucket = createEmoteBucket(o.now());
  let cooling = false;
  let timer: unknown = null;

  function setCooling(on: boolean): void {
    if (cooling === on) return;
    cooling = on;
    key.classList.toggle("is-cooling", on);
    key.setAttribute("aria-disabled", String(on));
    for (const b of items) b.setAttribute("aria-disabled", String(on));
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

  function open(on: boolean): void {
    menu.hidden = !on;
    key.setAttribute("aria-expanded", String(on));
  }
  const close = (): void => {
    open(false);
  };

  // A click anywhere else takes focus out of the picker: close it.
  root.addEventListener("focusout", (ev) => {
    if (!(ev.relatedTarget instanceof Node && root.contains(ev.relatedTarget))) close();
  });
  key.addEventListener("click", () => {
    open(menu.hidden === true);
    if (!menu.hidden) items[0]?.focus();
  });

  return {
    root,
    key(ev) {
      if (ev.key === "Escape") {
        if (menu.hidden) return false;
        close();
        key.focus();
        return true;
      }
      if (ev.ctrlKey || ev.altKey || ev.metaKey || typing(ev.target)) return false;
      const kind = kindForKey(ev.key);
      if (kind === null) return false;
      emote(PICKER_KINDS.indexOf(kind));
      return true;
    },
  };
}
