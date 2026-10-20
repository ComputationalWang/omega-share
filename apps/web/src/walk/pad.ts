// Teleport pads (OME-1548, ADR 0053 amendment): stand on one for 400 ms after a walk and I send a teleport walk to the other.
import type { ClientMessage, FloorCell, RoomLayout } from "@omega/shared";

export interface PadsDeps {
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly send: (m: ClientMessage) => void;
}

export interface Pads {
  /** I asked for a walk: a pending teleport is off, and my next stop may be an arrival. */
  walkSent(): void;
  /** My avatar came to rest on `cell`. */
  stopped(layout: Pick<RoomLayout, "furniture">, cell: FloorCell | undefined): void;
  cancel(): void;
}

export function otherPad(_layout: Pick<RoomLayout, "furniture">, _cell: FloorCell): FloorCell | null {
  return null;
}

export function createPads(_deps: PadsDeps): Pads {
  return { walkSent() {}, stopped() {}, cancel() {} };
}
