// The recap card (OME-1629): when the video ends or the queue moves on, a DOM card with the item's 3 busiest moments
// (the strip's densest windows), who watched and the reaction counts. Built here from contract B data, never per frame.
// Nicknames go in as text only. It sits in the page flow, so it never covers the composer; Esc or × dismisses it.
import { REACTION_KINDS, type Reaction, type ReactionKind } from "@omega/shared";
import { el, sprite } from "../controls/dom";
import { formatClock } from "../controls/sysline";
import { emoteIcon } from "../emote/emotes";
import { REACTION_EMOTE } from "./replay";
import { moments, type Pip } from "./strip";

export const RECAP_MOMENTS = 3;

export interface Recap {
  /** Busiest first, at most RECAP_MOMENTS. */
  readonly moments: readonly Pip[];
  /** Nicknames, as given. */
  readonly watched: readonly string[];
  readonly counts: Readonly<Record<ReactionKind, number>>;
}

/** Pure: the recap of an item `durationMs` long (0 = unknown), or null when nobody reacted. */
export function recapOf(reactions: readonly Reaction[], durationMs: number, watched: readonly string[]): Recap | null {
  if (reactions.length === 0) return null;
  const counts: Record<ReactionKind, number> = { heart: 0, laugh: 0, wow: 0, clap: 0 };
  let last = 0;
  for (const r of reactions) {
    counts[r.kind]++;
    last = Math.max(last, r.mediaMs);
  }
  // Unknown duration: the last reaction bounds the item, so the windows still split it.
  const span = durationMs > 0 ? durationMs : last + 1;
  return { moments: moments(reactions, span).pips.slice(0, RECAP_MOMENTS), watched: [...watched], counts };
}

export interface RecapCard {
  readonly root: HTMLElement;
  show(d: Recap): void;
  hide(): void;
}

const plural = (n: number, one: string): string => `${String(n)} ${n === 1 ? one : `${one}s`}`;

export function createRecapCard(): RecapCard {
  const root = el("section", { className: "recap", hidden: true }, "recap");
  root.setAttribute("aria-label", "Recap");
  const title = el("h3", { className: "recap-title", textContent: "That was the video" });
  const close = el("button", { type: "button", className: "recap-close", textContent: "×", ariaLabel: "Close the recap" }, "recap-close");
  const list = el("ol", { className: "recap-moments" });
  const counts = el("p", { className: "recap-counts" }, "recap-counts");
  const watched = el("p", { className: "recap-watched" }, "recap-watched");
  root.append(el("div", { className: "recap-head" }), list, counts, watched);
  root.firstElementChild?.append(title, close);

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape" || ev.defaultPrevented) return;
    ev.preventDefault();
    hide();
  };
  function hide(): void {
    root.hidden = true;
    window.removeEventListener("keydown", onKey);
  }
  close.addEventListener("click", hide);

  return {
    root,
    show(d) {
      list.replaceChildren(
        ...d.moments.map((m) => {
          const li = el("li", { className: "recap-moment" }, "recap-moment");
          li.append(sprite(emoteIcon(REACTION_EMOTE[m.kind])), ` ${formatClock(m.mediaMs / 1000)} · ${plural(m.count, "reaction")}`);
          return li;
        }),
      );
      counts.replaceChildren(
        ...REACTION_KINDS.filter((k) => d.counts[k] > 0).map((k) => {
          const s = el("span", { className: "recap-count", title: `${String(d.counts[k])} ${k}` });
          s.append(sprite(emoteIcon(REACTION_EMOTE[k])), String(d.counts[k]));
          return s;
        }),
      );
      watched.textContent = d.watched.length === 0 ? "" : `Watched by ${d.watched.join(", ")}`;
      watched.hidden = d.watched.length === 0;
      if (root.hidden) window.addEventListener("keydown", onKey);
      root.hidden = false;
    },
    hide,
  };
}
