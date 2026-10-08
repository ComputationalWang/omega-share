import type { PlaybackCaps, PlaybackState } from "@omega/shared";
import type { PlayerAdapter, PlayerState } from "./player/adapter";

// Thresholds: ADR 0011, research §1.2–§1.3.
export const SYNC_INTERVAL_MS = 250;
export const DEAD_BAND_MS = 100;
export const SEEK_THRESHOLD_MS = 1000;
/**
 * Seek threshold when the player can't change rate at all: half the 500 ms pairwise
 * budget, so two clients each within it stay within the budget of each other (OME-392).
 */
export const SEEK_ONLY_THRESHOLD_MS = 250;
/** Drift is only trusted after the player has been playing this long. */
export const STABLE_MS = 500;
export const MAX_NUDGE = 0.1;
/**
 * YouTube floors setPlaybackRate to 0.05 steps (1.02 plays at 1×, 0.98 at 0.95; OME-109),
 * so a fine nudge is a whole number of steps: 1 ± min(MAX_NUDGE, ⌈|drift| / NUDGE_SPAN_MS / step⌉ · step).
 */
export const RATE_STEP = 0.05;
export const NUDGE_SPAN_MS = 5000;
const STEP_SPAN_MS = NUDGE_SPAN_MS * RATE_STEP;
const MAX_STEPS = Math.round(MAX_NUDGE / RATE_STEP);
/** How long a nudge runs before we check the media really plays at that rate. */
export const RATE_CHECK_MS = 2000;
/** A nudge is "applied" if the slope moved at least half the requested amount, and at least this much. */
export const RATE_EFFECT_MIN = 0.01;
/** After the user clicks play/pause in the player, leave it alone this long while the room answers. */
export const INTENT_HOLD_MS = 1000;
/** Don't re-send the same play/pause more often than this while the player is slow to react. */
export const RESEND_MS = 1000;
export const BURST_SLOW = 0.75;
export const BURST_FAST = 1.25;
const SEEK_LATENCY_ALPHA = 0.25;
const MAX_SEEK_LATENCY_MS = 2000;

/**
 * fine: 1 ± ≤10 %; burst: 0.75/1.25 only; seek-only: no rate changes, seek above 250 ms;
 * live: can't seek (Twitch live), so only play/pause is matched (ADR 0014 §3).
 */
export type RateMode = "fine" | "burst" | "seek-only" | "live";

export type Correction =
  | { readonly kind: "none" }
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  /** Seek, then play or pause to match the room. */
  | { readonly kind: "seek"; readonly to: number; readonly play: boolean }
  | { readonly kind: "rate"; readonly rate: number };

const NONE: Correction = { kind: "none" };
const PLAY: Correction = { kind: "play" };
const PAUSE: Correction = { kind: "pause" };
const RATE_ONE: Correction = { kind: "rate", rate: 1 };

/** Mutable on purpose: the loop reuses one instance per tick. */
export interface DecideInput {
  room: PlaybackState | null;
  serverNowMs: number;
  /** Seconds, as the player reports it. */
  playerTime: number;
  playerState: PlayerState;
  /** How long the player has been in `playerState`, ms. */
  stableForMs: number;
  /** Last 3 drift samples, ms, player − room (+ = ahead). Taken only while stable-playing. */
  samples: ArrayLike<number>;
  sampleCount: number;
  /** The newest sample, ms. Ends a nudge early; the median lags by a tick. */
  lastDriftMs: number;
  /** An explicit action, join or embed change is pending: seek regardless of drift. */
  hardSeek: boolean;
  /** The rate we last set. */
  rate: number;
  mode: RateMode;
  /** Estimated time a seek takes to land while playing, ms. */
  seekLatencyMs: number;
  /** Estimated time a stopped player takes from seek + play until it plays, ms (OME-392). */
  startLatencyMs: number;
}

/** The room's position at server time `serverNowMs`, seconds. */
export function expectedPosition(room: PlaybackState, serverNowMs: number): number {
  const p = room.playing ? room.position + ((serverNowMs - room.at) / 1000) * room.rate : room.position;
  return p > 0 ? p : 0;
}

/** Pure: what to do to the local player this tick. Returns shared constants for none/play/pause. */
export function decide(i: DecideInput): Correction {
  const room = i.room;
  if (room === null || i.playerState === "ad") return NONE;
  if (i.mode === "live") return decideLive(i, room);
  const expected = expectedPosition(room, i.serverNowMs);
  if (i.hardSeek) {
    const moving = i.playerState === "playing" || i.playerState === "buffering";
    return seekTo(expected, room, moving ? i.seekLatencyMs : i.startLatencyMs);
  }
  if (i.playerState === "buffering") return NONE;
  if (!room.playing) {
    if (i.playerState === "playing") return PAUSE;
    return Math.abs(i.playerTime - expected) * 1000 > SEEK_THRESHOLD_MS ? seekTo(expected, room, 0) : NONE;
  }
  if (i.playerState === "ended") return NONE;
  if (i.playerState !== "playing") return PLAY;
  if (i.stableForMs < STABLE_MS || i.sampleCount < 3) return NONE;

  const drift = median3(i.samples);
  const abs = Math.abs(drift);
  if (i.mode === "seek-only") {
    if (abs > SEEK_ONLY_THRESHOLD_MS) return seekTo(expected, room, i.seekLatencyMs);
    return i.rate !== 1 ? RATE_ONE : NONE;
  }
  if (abs > SEEK_THRESHOLD_MS) return seekTo(expected, room, i.seekLatencyMs);
  if (abs <= DEAD_BAND_MS) return i.rate !== 1 ? RATE_ONE : NONE;
  const ahead = drift > 0;
  const newestAgrees = ahead ? i.lastDriftMs > DEAD_BAND_MS : i.lastDriftMs < -DEAD_BAND_MS;
  if (i.rate !== 1) {
    // Hold a nudge that points the right way until the newest sample says we're there.
    if (ahead ? i.rate < 1 : i.rate > 1) return newestAgrees ? NONE : RATE_ONE;
    if (!newestAgrees) return RATE_ONE;
  } else if (!newestAgrees) {
    return NONE;
  }
  if (i.mode === "burst") return { kind: "rate", rate: ahead ? BURST_SLOW : BURST_FAST };
  const n = Math.min(MAX_STEPS, Math.ceil(abs / STEP_SPAN_MS)) * RATE_STEP;
  return { kind: "rate", rate: ahead ? 1 - n : 1 + n };
}

/** Live: no position to match. Play (= back to the live edge) or pause like the room; a hard seek is just that. */
function decideLive(i: DecideInput, room: PlaybackState): Correction {
  if (i.rate !== 1) return RATE_ONE;
  if (i.playerState === "buffering") return NONE;
  if (!room.playing) return i.playerState === "playing" ? PAUSE : NONE;
  return i.playerState === "playing" ? NONE : PLAY;
}

function seekTo(expected: number, room: PlaybackState, latencyMs: number): Correction {
  const to = room.playing ? expected + (latencyMs / 1000) * room.rate : expected;
  return { kind: "seek", to, play: room.playing };
}

function median3(s: ArrayLike<number>): number {
  const a = s[0] ?? 0;
  const b = s[1] ?? 0;
  const c = s[2] ?? 0;
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/**
 * From the embed's static caps first: no seek → live; no rate → seek-only. Otherwise
 * fine nudges unless the player offers nothing but 1× (a Vimeo probe that failed).
 */
export function initialRateMode(rates: readonly number[], caps: PlaybackCaps): RateMode {
  if (caps.live || !caps.seek) return "live";
  if (caps.rate === "no") return "seek-only";
  return rates.some((r) => r !== 1) ? "fine" : "seek-only";
}

/**
 * Fallback ladder after an effective-rate check: `slope` is how fast the player's
 * time advanced per wall second while `requested` was set.
 */
export function nextRateMode(mode: RateMode, requested: number, slope: number, rates: readonly number[]): RateMode {
  if (mode === "seek-only" || mode === "live" || requested === 1) return mode;
  if (Math.abs(slope - 1) >= Math.max(RATE_EFFECT_MIN, Math.abs(requested - 1) / 2)) return mode;
  if (mode === "fine" && rates.includes(BURST_SLOW) && rates.includes(BURST_FAST)) return "burst";
  return "seek-only";
}

/**
 * EWMA of how long a seek takes to land. A seek aimed `compensationMs` ahead that
 * then measures `residualDriftMs` took `compensation − residual` ms.
 */
export function updateSeekLatency(prevMs: number, compensationMs: number, residualDriftMs: number, alpha = SEEK_LATENCY_ALPHA): number {
  const sample = Math.min(MAX_SEEK_LATENCY_MS, Math.max(0, compensationMs - residualDriftMs));
  return prevMs + alpha * (sample - prevMs);
}

/** What the loop needs of the clock-sync module. */
export interface SyncClock {
  readonly ready: boolean;
  /** Server ms now. */
  serverNow(): number;
}

export interface SyncLoopOptions<Timer> {
  readonly player: PlayerAdapter;
  readonly clock: SyncClock;
  /** Monotonic client ms. */
  readonly now: () => number;
  readonly setInterval: (fn: () => void, ms: number) => Timer;
  readonly clearInterval: (t: Timer) => void;
}

export interface SyncLoop {
  /** The room's latest playback (already rev-filtered). A new state means a hard seek. */
  setPlayback(p: PlaybackState | null): void;
  tick(): void;
  start(): void;
  stop(): void;
  /** stop() and detach from the player. */
  destroy(): void;
  readonly mode: RateMode;
  readonly seekLatencyMs: number;
  readonly startLatencyMs: number;
}

/**
 * Keeps one player in step with the room, on its own 4 Hz timer (not the PixiJS
 * ticker). Idle until the clock is ready. No allocation per tick in steady state.
 */
export function createSyncLoop<Timer>(o: SyncLoopOptions<Timer>): SyncLoop {
  const p = o.player;
  const samples = new Float64Array(3);
  const input: DecideInput = {
    room: null,
    serverNowMs: 0,
    playerTime: 0,
    playerState: "unstarted",
    stableForMs: 0,
    samples,
    sampleCount: 0,
    lastDriftMs: 0,
    hardSeek: false,
    rate: 1,
    mode: "fine",
    seekLatencyMs: 0,
    startLatencyMs: 0,
  };
  let timer: Timer | null = null;
  let modeKnown = false;
  let lastState: PlayerState | null = null;
  let stateSince = 0;
  let next = 0;
  /** Effective-rate check: when (client ms) and where (s) the current nudge started; -1 = none. */
  let checkFrom = -1;
  let checkPos = 0;
  /** Compensation used by the last seek while playing, ms; -1 = nothing to learn. */
  let pendingComp = -1;
  /** The pending seek was a resume from "paused": it measures start-up latency, not seek latency. */
  let pendingStart = false;
  /** No start-up sample yet: the first one replaces the 0 prior instead of easing in from it. */
  let startLearned = false;
  let holdUntil = Number.NEGATIVE_INFINITY;
  let lastPlayAt = Number.NEGATIVE_INFINITY;
  let lastPauseAt = Number.NEGATIVE_INFINITY;
  const off = p.onEvent((e) => {
    if (e.type !== "intent") return;
    holdUntil = o.now() + INTENT_HOLD_MS;
    pendingComp = -1;
  });

  const unstable = (now: number) => {
    input.sampleCount = 0;
    next = 0;
    stateSince = now;
    checkFrom = -1;
  };
  const setRate = (r: number) => {
    p.setRate(r);
    input.rate = r;
  };

  function tick(): void {
    const room = input.room;
    if (room === null || !o.clock.ready || !p.ready()) return;
    if (!modeKnown) {
      input.mode = initialRateMode(p.rates(), p.caps);
      modeKnown = true;
    }
    const now = o.now();
    if (now < holdUntil) return;
    const st = p.state();
    if (st !== lastState) {
      lastState = st;
      unstable(now);
      if (st === "ad") pendingComp = -1;
    }
    const t = p.time();
    const serverNow = o.clock.serverNow();
    input.serverNowMs = serverNow;
    input.playerTime = t;
    input.playerState = st;
    input.stableForMs = now - stateSince;
    if (st === "playing" && room.playing && input.mode !== "live" && input.stableForMs >= STABLE_MS) {
      const d = (t - expectedPosition(room, serverNow)) * 1000;
      samples[next] = d;
      input.lastDriftMs = d;
      next = (next + 1) % 3;
      if (input.sampleCount < 3) input.sampleCount++;
    }
    if (pendingComp >= 0 && input.sampleCount === 3) {
      const residual = median3(samples);
      if (!pendingStart) {
        input.seekLatencyMs = updateSeekLatency(input.seekLatencyMs, pendingComp, residual);
      } else {
        input.startLatencyMs = updateSeekLatency(input.startLatencyMs, pendingComp, residual, startLearned ? undefined : 1);
        startLearned = true;
      }
      pendingComp = -1;
    }
    if (checkFrom >= 0 && now - checkFrom >= RATE_CHECK_MS) {
      const slope = (t - checkPos) / ((now - checkFrom) / 1000);
      checkFrom = -1;
      const m = nextRateMode(input.mode, input.rate, slope, p.rates());
      if (m !== input.mode) {
        input.mode = m;
        setRate(1);
      }
    }
    apply(decide(input), now, t, st);
  }

  function apply(c: Correction, now: number, t: number, st: PlayerState): void {
    switch (c.kind) {
      case "none":
        return;
      case "play":
        if (now - lastPlayAt < RESEND_MS) return;
        lastPlayAt = now;
        p.play();
        // A start that needed another play (blocked autoplay, slow load) doesn't measure latency.
        pendingComp = -1;
        return;
      case "pause":
        if (now - lastPauseAt < RESEND_MS) return;
        lastPauseAt = now;
        p.pause();
        return;
      case "rate":
        setRate(c.rate);
        checkFrom = c.rate === 1 ? -1 : now;
        checkPos = t;
        return;
      case "seek":
        input.hardSeek = false;
        if (input.rate !== 1) setRate(1);
        p.seek(c.to);
        if (c.play) {
          lastPlayAt = now;
          p.play();
        } else {
          lastPauseAt = now;
          p.pause();
        }
        // Learn from a seek while playing, or a resume from paused (OME-392). A cold join
        // (cued, unstarted) includes loading the media, so it would overshoot later resumes.
        pendingStart = st === "paused";
        pendingComp = !c.play ? -1 : st === "playing" ? input.seekLatencyMs : pendingStart ? input.startLatencyMs : -1;
        unstable(now);
        return;
    }
  }

  return {
    setPlayback(pb) {
      input.room = pb;
      input.hardSeek = pb !== null;
      holdUntil = Number.NEGATIVE_INFINITY;
      // RESEND_MS only suppresses repeats within one room state (OME-170).
      lastPlayAt = Number.NEGATIVE_INFINITY;
      lastPauseAt = Number.NEGATIVE_INFINITY;
      pendingComp = -1;
    },
    tick,
    start() {
      timer ??= o.setInterval(tick, SYNC_INTERVAL_MS);
    },
    stop() {
      if (timer !== null) o.clearInterval(timer);
      timer = null;
    },
    destroy() {
      this.stop();
      off();
    },
    get mode() {
      return input.mode;
    },
    get seekLatencyMs() {
      return input.seekLatencyMs;
    },
    get startLatencyMs() {
      return input.startLatencyMs;
    },
  };
}
