import type { Left, ResumeStore } from "./session-record";

export interface RejoinChipOptions {
  readonly parent: HTMLElement;
  readonly left: Left;
  readonly now: number;
  readonly session: Pick<ResumeStore, "setItem">;
  readonly navigate: (path: string) => void;
  readonly setTimeout: (fn: () => void, ms: number) => number;
  readonly clearTimeout: (id: number) => void;
}

export function mountRejoinChip(o: RejoinChipOptions): HTMLElement {
  // Stub (OME-2105 red commit).
  const chip = document.createElement("div");
  o.parent.append(chip);
  return chip;
}
