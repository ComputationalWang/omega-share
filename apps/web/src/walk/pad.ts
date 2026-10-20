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

/** The pad cell a teleport from the pad at `cell` goes to; null off a pad or without a pair. */
export function otherPad(layout: Pick<RoomLayout, "furniture">, cell: FloorCell): FloorCell | null {
  const pads = layout.furniture.filter((f) => f.kind === "pad");
  if (!pads.some((f) => f.col === cell.x && f.row === cell.y)) return null;
  const other = pads.find((f) => f.col !== cell.x || f.row !== cell.y);
  return other === undefined ? null : { x: other.col, y: other.row };
}

/** How long I stand on a pad before it takes me. */
export const PAD_DELAY_MS = 400;

export function createPads(deps: PadsDeps): Pads {
  let timer: unknown = null;
  // Only a stop that ends a walk of mine counts: a teleport's own arrival, a snapshot or a layout snap never re-triggers.
  let armed = false;
  const clear = (): void => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };
  return {
    walkSent() {
      clear();
      armed = true;
    },
    stopped(layout, cell) {
      if (!armed) return;
      armed = false;
      const to = cell === undefined ? null : otherPad(layout, cell);
      if (to === null) return;
      clear();
      timer = deps.setTimer(() => {
        timer = null;
        deps.send({ type: "walk", cell: to, teleport: true });
      }, PAD_DELAY_MS);
    },
    cancel() {
      clear();
      armed = false;
    },
  };
}
