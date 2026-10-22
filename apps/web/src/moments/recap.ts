import type { Reaction, ReactionKind } from "@omega/shared";
import type { Pip } from "./strip";

export const RECAP_MOMENTS = 3;

export interface Recap {
  readonly moments: readonly Pip[];
  readonly watched: readonly string[];
  readonly counts: Readonly<Record<ReactionKind, number>>;
}

export function recapOf(_reactions: readonly Reaction[], _durationMs: number, _watched: readonly string[]): Recap | null {
  return null;
}

export interface RecapCard {
  readonly root: HTMLElement;
  show(d: Recap): void;
  hide(): void;
}

export function createRecapCard(): RecapCard {
  const root = document.createElement("section");
  return { root, show() {}, hide() {} };
}
