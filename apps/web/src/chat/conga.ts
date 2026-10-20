// /conga (OME-1564): a party line built on Follow. Every client derives the same line from the relayed `/conga` and
// `/stop` chat lines (server time `at`) and the room state; nothing new goes on the wire.
import type { MemberId } from "@omega/shared";
import type { ViewState } from "../state";

export const CONGA_WINDOW_MS = 120_000;
export const CONGA_CAP = 12;

export interface Conga {
  /** Leader first. */
  readonly ids: readonly MemberId[];
  /** Server time of the last join. */
  readonly last: number;
}

export const NO_CONGA: Conga = { ids: [], last: Number.NEGATIVE_INFINITY };

export function congaText(_text: string): "conga" | "stop" | null {
  return null;
}

export function congaJoin(line: Conga, _id: MemberId, _at: number): Conga | "full" {
  return line;
}

export function congaLeave(line: Conga, _id: MemberId): Conga {
  return line;
}

export function congaPrune(line: Conga, _s: ViewState): Conga {
  return line;
}

export function congaAhead(_line: Conga, _id: MemberId | null): MemberId | null {
  return null;
}
