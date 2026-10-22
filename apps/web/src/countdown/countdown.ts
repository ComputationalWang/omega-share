// Shared 3-2-1 (OME-1634, ADR 0056). A `playback` with `startAt` shows 3, 2, 1 on the server clock over the room and
// is gone at startAt; a playback without it (a pause or a seek) cancels it. One timer per digit, nothing per frame.
// The pop is CSS (countdown.css); reduced motion and the basic tier get a plain number (`data-plain`).
import type { PlaybackState } from "@omega/shared";
import "./countdown.css";

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
  el.className = "countdown";
  el.dataset["testid"] = "countdown";
  el.setAttribute("role", "status");
  el.hidden = true;
  let shown: PlaybackState | null = null;
  let startAt = 0;
  let digit = 0;
  let timer: Timer | null = null;

  const stop = (): void => {
    if (timer !== null) o.clearTimer(timer);
    timer = null;
  };
  const show = (): void => {
    timer = null;
    const left = startAt - o.serverNow();
    digit = left > 0 ? Math.min(3, Math.ceil(left / 1000)) : 0;
    el.hidden = digit === 0;
    if (digit > 0) {
      if (o.plain()) el.dataset["plain"] = "true";
      else delete el.dataset["plain"];
      // A fresh span per digit restarts the CSS pop.
      const span = document.createElement("span");
      span.textContent = String(digit);
      el.replaceChildren(span);
      timer = o.setTimer(show, left - (digit - 1) * 1000);
    } else {
      el.replaceChildren();
    }
    o.onChange();
  };

  return {
    el,
    set(pb) {
      if (pb === shown) return;
      shown = pb;
      stop();
      const was = digit;
      if (pb?.playing === true && pb.startAt !== undefined) {
        startAt = pb.startAt;
        show();
      } else if (was > 0) {
        digit = 0;
        el.hidden = true;
        el.replaceChildren();
        o.onChange();
      }
    },
    lit: () => digit < 2,
    destroy: stop,
  };
}
