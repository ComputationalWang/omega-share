// Shared 3-2-1 (OME-1634, ADR 0056). Stub: lands with the implementation commit.
import type { PlaybackState } from "@omega/shared";

export interface CountdownOptions<Timer> {
  /** Server ms now (clock sync). */
  readonly serverNow: () => number;
  /** A plain number, no animation: prefers-reduced-motion or the basic tier. Read at each digit. */
  readonly plain: () => boolean;
  /** After each digit and when it ends or is cancelled: the room re-reads `lit()` for the dim. */
  readonly onChange: () => void;
  readonly setTimer: (fn: () => void, ms: number) => Timer;
  readonly clearTimer: (t: Timer) => void;
}

export interface Countdown {
  readonly el: HTMLElement;
  /** The room's playback, after every change. */
  set(pb: PlaybackState | null): void;
  /** False while the countdown shows 3 or 2: the lights go down on 1. */
  lit(): boolean;
  destroy(): void;
}

export function createCountdown<Timer>(o: CountdownOptions<Timer>): Countdown {
  const el = document.createElement("div");
  return {
    el,
    set: () => {
      o.onChange();
    },
    lit: () => true,
    destroy: () => undefined,
  };
}
