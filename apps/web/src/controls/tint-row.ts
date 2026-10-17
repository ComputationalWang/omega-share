// The shirt tint row (OME-1352, ADR 0053).
import type { Tint } from "@omega/shared";
import type { TintRamp } from "../walk/tint";

export interface TintRow {
  show(tints: readonly TintRamp[], tint: Tint): void;
}

export function buildTintRow(): HTMLElement {
  return document.createElement("div");
}

export function bindTintRow(_group: HTMLElement, _onPick: (t: Tint) => void): TintRow {
  return { show: () => undefined };
}
