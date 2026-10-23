// The moments strip (OME-1628): under the player, a thin density bar of the current item's reactions and up to 8 pips
// at the densest moments; a pip seeks there if the room's control policy lets me. DOM only, redrawn when a reaction
// arrives (or the item or its duration changes), never per frame: one background write for the bar, 8 pooled buttons.
import type { Reaction, ReactionKind } from "@omega/shared";
import { el, sprite } from "../controls/dom";
import { formatClock } from "../controls/sysline";
import { emoteIcon } from "../emote/emotes";
import { REACTION_EMOTE } from "./replay";

export const STRIP_BINS = 32;
export const STRIP_PIPS = 8;

export interface Pip {
  /** The window's first reaction, clamped to the item: where the moment starts. */
  readonly mediaMs: number;
  readonly count: number;
  /** The window's most common kind. */
  readonly kind: ReactionKind;
}

export interface Moments {
  /** Per bin, its count over the busiest bin's: 0–1. Empty without a duration. */
  readonly density: readonly number[];
  /** Busiest first. */
  readonly pips: readonly Pip[];
}

/** Pure: the bar and the pips for `reactions` over an item `durationMs` long (0 = unknown: nothing). */
export function moments(reactions: readonly Reaction[], durationMs: number): Moments {
  if (!(durationMs > 0) || reactions.length === 0) return { density: [], pips: [] };
  const counts = new Array<number>(STRIP_BINS).fill(0);
  const first = new Array<number>(STRIP_BINS).fill(Infinity);
  const kinds = Array.from({ length: STRIP_BINS }, (): Record<ReactionKind, number> => ({ heart: 0, laugh: 0, wow: 0, clap: 0 }));
  for (const r of reactions) {
    const ms = Math.min(Math.max(r.mediaMs, 0), durationMs);
    const b = Math.min(STRIP_BINS - 1, Math.floor((ms / durationMs) * STRIP_BINS));
    counts[b] = (counts[b] ?? 0) + 1;
    first[b] = Math.min(first[b] ?? Infinity, ms);
    const k = kinds[b];
    if (k !== undefined) k[r.kind]++;
  }
  const peak = Math.max(...counts);
  const pips = counts
    .map((count, b) => ({ count, b }))
    .filter((x) => x.count > 0)
    .sort((x, y) => y.count - x.count || x.b - y.b)
    .slice(0, STRIP_PIPS)
    .map(({ count, b }): Pip => {
      const k = kinds[b] ?? { heart: 0, laugh: 0, wow: 0, clap: 0 };
      const kind = (Object.keys(k) as ReactionKind[]).reduce((a, c) => (k[c] > k[a] ? c : a));
      return { mediaMs: first[b] ?? 0, count, kind };
    });
  return { density: counts.map((c) => c / peak), pips };
}

export interface MomentsStrip {
  readonly root: HTMLElement;
  /** Redraw: the current item's reactions, its duration in ms (0 = unknown, hidden). */
  render(reactions: readonly Reaction[], durationMs: number): void;
  /** May I seek (the room's control policy, state.ts `controlHeld`)? */
  setControl(canSeek: boolean): void;
}

const HELD_TITLE = "Only the host controls playback";

export function createMomentsStrip(o: { readonly seek: (seconds: number) => boolean }): MomentsStrip {
  const bar = el("div", { className: "moments-bar", ariaHidden: "true" }, "moments-bar");
  const root = el("div", { className: "moments", hidden: true }, "moments");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Moments");
  let canSeek = true;
  const at: number[] = [];
  const pips = Array.from({ length: STRIP_PIPS }, (_, i) => {
    const b = el("button", { type: "button", className: "moments-pip", hidden: true }, "moments-pip");
    b.addEventListener("click", () => {
      const ms = at[i];
      if (canSeek && ms !== undefined) o.seek(ms / 1000);
    });
    return b;
  });
  root.append(bar, ...pips);
  const label = (b: HTMLButtonElement, ms: number, count: number): void => {
    const what = `${formatClock(ms / 1000)}, ${String(count)} ${count === 1 ? "reaction" : "reactions"}`;
    b.ariaLabel = canSeek ? `Jump to ${what}` : what;
    b.title = canSeek ? b.ariaLabel : `${what}. ${HELD_TITLE}`;
    b.disabled = !canSeek;
  };
  return {
    root,
    render(reactions, durationMs) {
      const m = moments(reactions, durationMs);
      root.hidden = m.pips.length === 0;
      if (root.hidden) return;
      const step = 100 / STRIP_BINS;
      bar.style.background = `linear-gradient(to right, ${m.density.map((d, i) => `rgb(255 214 102 / ${(d * 0.9).toFixed(2)}) ${String(i * step)}% ${String((i + 1) * step)}%`).join(", ")})`;
      pips.forEach((b, i) => {
        const p = m.pips[i];
        b.hidden = p === undefined;
        if (p === undefined) return;
        at[i] = p.mediaMs;
        b.style.setProperty("--at", `${String((p.mediaMs / durationMs) * 100)}%`);
        b.replaceChildren(sprite(emoteIcon(REACTION_EMOTE[p.kind])));
        b.dataset["count"] = String(p.count);
        label(b, p.mediaMs, p.count);
      });
    },
    setControl(can) {
      // onView fires several times a second; a rewritten aria-label is re-announced on a focused pip (QA OME-1715).
      if (can === canSeek) return;
      canSeek = can;
      pips.forEach((b, i) => {
        const ms = at[i];
        if (!b.hidden && ms !== undefined) label(b, ms, Number(b.dataset["count"]));
      });
    },
  };
}
