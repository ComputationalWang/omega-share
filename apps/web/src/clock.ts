import { PING_ID_MAX } from "@omega/shared";

/** Pings sent back to back when a socket opens (research §2.2). */
export const BURST_PINGS = 5;
export const BURST_GAP_MS = 200;
/** Steady-state ping cadence after the burst. */
export const PING_INTERVAL_MS = 15_000;
/** Samples kept; the one with the smallest RTT wins. */
export const WINDOW_SIZE = 8;
/** Slower samples bound the error above 250 ms; drop them. */
export const MAX_RTT_MS = 500;
/** A longer gap between sync-loop ticks means the monotonic clock may have paused (OS sleep). */
export const SLEEP_GAP_MS = 2000;

/** Read side of the estimate; what `decide()` and the sync loop take. */
export interface ServerClock {
  /** False until the first accepted pong, and again after a resync until the next one. */
  readonly ready: boolean;
  /** server ms ≈ client ms + offsetMs. 0 while not ready. */
  readonly offsetMs: number;
  /** Server time now, from the injected client clock. Equals the client clock while not ready. */
  serverNow(): number;
}

export interface ClockSync extends ServerClock {
  /** Socket opened: burst, then ping every PING_INTERVAL_MS. Call before sending `join`. */
  start(): void;
  /** Feed every `pong`. Unknown, answered or too-slow ids are ignored. */
  onPong(id: number, at: number): void;
  /** Call on every sync-loop tick; a gap over SLEEP_GAP_MS triggers resync(). */
  tick(): void;
  /** Drop all samples (ready → false) and, if started, burst again. */
  resync(): void;
  /** Socket closed: stop pinging, keep the estimate. */
  stop(): void;
  /** Stop for good: no timers, no listeners; later calls no-op. */
  destroy(): void;
}

/** The part of `EventTarget` we use (window for `online`, document for `visibilitychange`). */
export interface ListenerTarget {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface ClockSyncOptions<Timer> {
  /** Client ms; in the browser `performance.timeOrigin + performance.now()`. */
  readonly now: () => number;
  /** Sends `ping{id}`; false if the socket isn't open (then nothing is recorded). */
  readonly sendPing: (id: number) => boolean;
  readonly setTimer: (fn: () => void, ms: number) => Timer;
  readonly clearTimer: (handle: Timer) => void;
  /** Resyncs on `online`. */
  readonly window?: ListenerTarget;
  /** Resyncs on `visibilitychange` when it becomes visible. */
  readonly document?: ListenerTarget & { readonly visibilityState: string };
  /** First ping id (tests); defaults to 0. */
  readonly startId?: number;
}

/** The browser's monotonic wall clock. */
export const browserNow = (): number => performance.timeOrigin + performance.now();

/**
 * NTP-style offset estimator (Cristian's algorithm; research §2). Samples live in
 * preallocated ring buffers, so pings and pongs allocate nothing.
 */
export function createClockSync<Timer>(opts: ClockSyncOptions<Timer>): ClockSync {
  // In-flight pings, slot = id % WINDOW_SIZE. Ids are consecutive, so a slot is only
  // reused 8 pings later, well past MAX_RTT_MS at the burst rate.
  const pendingId = new Float64Array(WINDOW_SIZE).fill(-1);
  const pendingT0 = new Float64Array(WINDOW_SIZE);
  const rtts = new Float64Array(WINDOW_SIZE);
  const offsets = new Float64Array(WINDOW_SIZE);
  let count = 0;
  let head = 0;
  let offset = 0;
  let ready = false;
  let nextId = opts.startId ?? 0;
  let burstLeft = 0;
  let timer: Timer | null = null;
  let running = false;
  let destroyed = false;
  let lastTick = -1;

  const clearTimer = (): void => {
    if (timer !== null) opts.clearTimer(timer);
    timer = null;
  };

  const fire = (): void => {
    timer = null;
    const id = nextId;
    nextId = id >= PING_ID_MAX ? 0 : id + 1;
    const t0 = opts.now();
    if (opts.sendPing(id)) {
      const slot = id % WINDOW_SIZE;
      pendingId[slot] = id;
      pendingT0[slot] = t0;
    }
    const wait = burstLeft > 0 ? BURST_GAP_MS : PING_INTERVAL_MS;
    if (burstLeft > 0) burstLeft--;
    timer = opts.setTimer(fire, wait);
  };

  const burst = (): void => {
    clearTimer();
    burstLeft = BURST_PINGS - 1;
    fire();
  };

  const reset = (): void => {
    count = 0;
    head = 0;
    offset = 0;
    ready = false;
    pendingId.fill(-1);
  };

  const resync = (): void => {
    if (destroyed) return;
    reset();
    lastTick = -1;
    if (running) burst();
  };

  const onOnline = (): void => {
    resync();
  };
  const onVisibility = (): void => {
    if (opts.document?.visibilityState === "visible") resync();
  };
  opts.window?.addEventListener("online", onOnline);
  opts.document?.addEventListener("visibilitychange", onVisibility);

  return {
    get ready() {
      return ready;
    },
    get offsetMs() {
      return offset;
    },
    serverNow() {
      return opts.now() + offset;
    },
    start() {
      if (destroyed) return;
      running = true;
      burst();
    },
    onPong(id, at) {
      const slot = id % WINDOW_SIZE;
      if (destroyed || pendingId[slot] !== id) return;
      pendingId[slot] = -1;
      const t0 = pendingT0[slot] ?? 0;
      const t3 = opts.now();
      const rtt = t3 - t0;
      if (rtt < 0 || rtt > MAX_RTT_MS) return;
      rtts[head] = rtt;
      offsets[head] = at - (t0 + t3) / 2;
      head = (head + 1) % WINDOW_SIZE;
      if (count < WINDOW_SIZE) count++;
      // Oldest first, so a tie keeps the earlier sample.
      let best = -1;
      let bestRtt = Infinity;
      for (let i = 0; i < count; i++) {
        const j = (head - count + i + WINDOW_SIZE) % WINDOW_SIZE;
        const r = rtts[j] ?? Infinity;
        if (r < bestRtt) {
          bestRtt = r;
          best = j;
        }
      }
      offset = offsets[best] ?? 0;
      ready = true;
    },
    tick() {
      if (destroyed) return;
      const now = opts.now();
      if (lastTick >= 0 && now - lastTick > SLEEP_GAP_MS) resync();
      lastTick = now;
    },
    resync,
    stop() {
      running = false;
      clearTimer();
    },
    destroy() {
      destroyed = true;
      running = false;
      clearTimer();
      opts.window?.removeEventListener("online", onOnline);
      opts.document?.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
