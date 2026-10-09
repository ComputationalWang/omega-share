// Emotes under prefers-reduced-motion (OME-415): no frame swaps, a static badge (set (i)'s picker icon, which the design
// gives as the floating sticker's static fallback) over the avatar for as long as the animation would have played.
import type { EmoteKind, MemberId } from "@omega/shared";
import { el } from "../controls/dom";

/** About as long as a sticker plays (set (d): 1.32 s), a little longer since it doesn't move. */
export const BADGE_MS = 1600;

export interface EmoteBadges {
  /** Show `kind` for `id` with its bottom centre at `at` (stage px), replacing theirs. */
  show(id: MemberId, kind: EmoteKind, at: { x: number; y: number }): void;
  /** Their avatar moved (a walk). */
  move(id: MemberId, x: number, y: number): void;
  /** Drop the badges of anyone not in `ids` (they left). */
  keep(ids: { has(id: MemberId): boolean }): void;
}

export function createEmoteBadges(layer: HTMLElement, o: { setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void }): EmoteBadges {
  const shown = new Map<MemberId, { e: HTMLElement; timer: unknown }>();
  const place = (e: HTMLElement, x: number, y: number): void => {
    e.style.transform = `translate(${String(x)}px, ${String(y)}px)`;
  };
  const drop = (id: MemberId): void => {
    const b = shown.get(id);
    if (b === undefined) return;
    o.clearTimer(b.timer);
    b.e.remove();
    shown.delete(id);
  };
  return {
    show(id, kind, at) {
      drop(id);
      const e = el("span", { className: `emote-badge ui-sprite ui-emote-pick-${kind}`, ariaHidden: "true" }, "emote-badge");
      e.dataset["member"] = id;
      place(e, at.x, at.y);
      layer.append(e);
      const timer = o.setTimer(() => {
        if (shown.get(id)?.e !== e) return;
        e.remove();
        shown.delete(id);
      }, BADGE_MS);
      shown.set(id, { e, timer });
    },
    move(id, x, y) {
      const b = shown.get(id);
      if (b !== undefined) place(b.e, x, y);
    },
    keep(ids) {
      for (const id of [...shown.keys()]) if (!ids.has(id)) drop(id);
    },
  };
}
