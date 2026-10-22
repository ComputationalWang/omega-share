// The reaction bar (OME-1631, Movie night): heart, laugh, wow and clap by the player, sending `react`. Shift+1–4 react
// by physical key (`code`), so they never meet the emote keys (plain 1–9), help (?), full screen (F, C) or the
// command palette (no key of its own). The server charges `react` to the emote limit, so the bar takes from the
// picker's local bucket: when it's empty the bar cools (`is-cooling`, buttons `aria-disabled`) and sends nothing until
// a token is back. A held key repeats nothing. DOM in page chrome, never the canvas.
import type { ClientMessage, ReactionKind } from "@omega/shared";
import { REACTION_KINDS } from "@omega/shared";
import { el, sprite } from "../controls/dom";
import type { EmoteBucket } from "../emote/emotes";
import { reactionIcon } from "./glyphs";

export interface ReactionBarOptions {
  readonly send: (m: ClientMessage) => boolean;
  /** The emote picker's bucket: one limit for emotes and reactions, as on the server. */
  readonly bucket: EmoteBucket;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (h: unknown) => void;
}

export interface ReactionBar {
  readonly root: HTMLElement;
  /** A keydown on the page: true if it was ours (the caller prevents the default). */
  key(ev: KeyboardEvent): boolean;
  /** Send `kind` through the bucket. True if it went out. */
  react(kind: ReactionKind): boolean;
}

const LABELS: Readonly<Record<ReactionKind, string>> = { heart: "Heart", laugh: "Laugh", wow: "Wow", clap: "Clap" };
const CODES: Readonly<Record<string, ReactionKind>> = { Digit1: "heart", Digit2: "laugh", Digit3: "wow", Digit4: "clap" };

/** Typing somewhere: the keys belong to the field. */
const typing = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement);

export function createReactionBar(o: ReactionBarOptions): ReactionBar {
  const root = el("div", { className: "reaction-bar" }, "reaction-bar");
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "Reactions");
  const buttons = REACTION_KINDS.map((kind, i) => {
    const shortcut = `Shift+${String(i + 1)}`;
    const b = el("button", { type: "button", className: "ui-button icon reaction-key", title: `${LABELS[kind]} (${shortcut})` }, `reaction-${kind}`);
    b.setAttribute("aria-label", LABELS[kind]);
    b.setAttribute("aria-keyshortcuts", shortcut);
    b.append(sprite(reactionIcon(kind)));
    b.addEventListener("click", () => {
      react(kind);
    });
    return b;
  });
  root.append(...buttons);

  let cooling = false;
  let timer: unknown = null;
  /** The cool state from the bucket; while cooling, one timer warms the bar when a token is back. */
  const show = (): void => {
    const now = o.now();
    const left = o.bucket.readyAt(now) - now;
    const cool = left > 0;
    if (cool !== cooling) {
      cooling = cool;
      root.classList.toggle("is-cooling", cool);
      for (const b of buttons) {
        if (cool) b.setAttribute("aria-disabled", "true");
        else b.removeAttribute("aria-disabled");
      }
    }
    if (timer !== null) o.clearTimer(timer);
    timer = cool
      ? o.setTimer(() => {
          timer = null;
          show();
        }, left)
      : null;
  };

  function react(kind: ReactionKind): boolean {
    const now = o.now();
    let sent = false;
    if (o.bucket.readyAt(now) <= now && o.send({ type: "react", kind })) {
      o.bucket.take(now);
      sent = true;
    }
    show();
    return sent;
  }

  return {
    root,
    react,
    key(ev) {
      const kind = CODES[ev.code];
      if (kind === undefined || !ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey || ev.isComposing || typing(ev.target)) return false;
      if (!ev.repeat) react(kind);
      return true;
    },
  };
}
