// Which walk tier this device gets (ADR 0037, research R-M8a §3). Smooth draws every frame while anyone walks (the
// 8-frame 75 ms cycle); Basic draws once per 150 ms step. Static gates first; otherwise start in Basic and probe the
// post-render work of the first 30 renders, upgrade if a frame fits the budget, and drop back to Basic for the session
// if Smooth walking frames get slow or late. No flipping back until reload. Pure: the browser parts are injected, and
// nothing here allocates per frame.
import * as v from "valibot";

export type MotionTier = "smooth" | "basic";

export interface TierHints {
  /** `localStorage["omega.motion"]`, for e2e, perf and later a user setting. */
  readonly forced: MotionTier | null;
  readonly reducedMotion: boolean;
  readonly saveData: boolean;
  readonly hardwareConcurrency: number | undefined;
  /** GB, as Chromium reports it (a power of two, capped at 8); undefined where it isn't reported (Firefox). */
  readonly deviceMemory: number | undefined;
}

export interface Tier {
  /** Walk in Smooth now. Read every frame. */
  smooth(): boolean;
  /** Still deciding whether to upgrade: the caller also measures a rAF interval next to each render. */
  probing(): boolean;
  /** One render's post-render work (ms). `walking`: a Smooth frame that drew a walk. */
  work(ms: number, walking: boolean): void;
  /** One rAF interval (ms): next to a Basic render while probing, or between two Smooth walking frames. */
  interval(ms: number): void;
}

/** The upgrade window: the first room renders. */
const PROBE_RENDERS = 30;
const UPGRADE_WORK_MS = 8;
const UPGRADE_MEDIAN_MS = 20;
/** The drop windows: the last Smooth walking renders, and the walking frames of the last 5 s. */
const DROP_RENDERS = 120;
const DROP_WORK_MS = 10;
const DROP_WINDOW_MS = 5000;
const LATE_FACTOR = 1.5;
const LATE_SHARE = 0.05;
/** A longer gap is a tab coming back or a pause (full screen), not jank. */
const MAX_INTERVAL_MS = 1000;
/** Room for the intervals of the 5 s window up to a 200 Hz screen; if it fills first the window ends early. */
const LATE_CAP = 1024;

/** How many of `n` samples may exceed a limit while the nearest-rank 95th percentile stays within it. */
const tail95 = (n: number): number => n - Math.ceil(0.95 * n);

const STATIC = 0;
const PROBING = 1;
const SMOOTH = 2;

export function createTier(h: TierHints): Tier {
  const gated = h.reducedMotion || h.saveData || (h.hardwareConcurrency ?? 4) < 4 || (h.deviceMemory ?? 4) < 4;
  let state = h.forced !== null || gated ? STATIC : PROBING;
  let smooth = h.forced === "smooth";

  // Upgrade: renders seen, how many were over budget, and their rAF intervals.
  let renders = 0;
  let slowProbe = 0;
  const probeIntervals = new Float64Array(64);
  let probeN = 0;

  // Drop: a ring of the last Smooth walking renders' work, and how many in it are over 10 ms.
  const ring = new Float64Array(DROP_RENDERS);
  let ringN = 0;
  let ringAt = 0;
  let slowRing = 0;
  // Drop: the walking rAF intervals of the current 5 s window.
  const late = new Float64Array(LATE_CAP);
  let lateN = 0;
  let lateSum = 0;

  const drop = (): void => {
    smooth = false;
    state = STATIC;
  };

  /** Median of the first `n` of `a`; sorts `a` in place (the samples are spent once judged). */
  const median = (a: Float64Array, n: number): number => {
    if (n === 0) return Infinity;
    a.fill(Infinity, n);
    a.sort();
    return a[(n - 1) >> 1] ?? Infinity;
  };

  return {
    smooth: () => smooth,
    probing: () => state === PROBING,
    work(ms, walking) {
      if (state === PROBING) {
        renders++;
        if (ms > UPGRADE_WORK_MS) slowProbe++;
        if (renders < PROBE_RENDERS) return;
        const fast = slowProbe <= tail95(PROBE_RENDERS) && median(probeIntervals, probeN) <= UPGRADE_MEDIAN_MS;
        smooth = fast;
        state = fast ? SMOOTH : STATIC;
        return;
      }
      if (state !== SMOOTH || !walking) return;
      if (ringN === DROP_RENDERS && (ring[ringAt] ?? 0) > DROP_WORK_MS) slowRing--;
      ring[ringAt] = ms;
      ringAt = (ringAt + 1) % DROP_RENDERS;
      if (ringN < DROP_RENDERS) ringN++;
      if (ms > DROP_WORK_MS) slowRing++;
      if (ringN === DROP_RENDERS && slowRing > tail95(DROP_RENDERS)) drop();
    },
    interval(ms) {
      if (!(ms > 0) || ms > MAX_INTERVAL_MS) return;
      if (state === PROBING) {
        if (probeN < probeIntervals.length) probeIntervals[probeN++] = ms;
        return;
      }
      if (state !== SMOOTH) return;
      late[lateN++] = ms;
      lateSum += ms;
      if (lateSum < DROP_WINDOW_MS && lateN < LATE_CAP) return;
      const n = lateN;
      const limit = median(late, n) * LATE_FACTOR;
      let over = 0;
      for (let i = 0; i < n; i++) if ((late[i] ?? 0) > limit) over++;
      lateN = 0;
      lateSum = 0;
      if (over > n * LATE_SHARE) drop();
    },
  };
}

const ForcedSchema = v.picklist(["smooth", "basic"]);

/** `localStorage["omega.motion"]`: "smooth" or "basic"; anything else forces nothing. */
export function parseForcedTier(raw: unknown): MotionTier | null {
  const r = v.safeParse(ForcedSchema, raw);
  return r.success ? r.output : null;
}

const NavigatorSchema = v.object({
  hardwareConcurrency: v.optional(v.unknown()),
  deviceMemory: v.optional(v.unknown()),
  connection: v.optional(v.unknown()),
});
const SaveDataSchema = v.object({ saveData: v.boolean() });
const count = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined);

/** The hints, parsed from what the browser gives (fields missing or odd count as not reported). Read at room start. */
export function readTierHints(env: { reducedMotion: boolean; navigator: unknown; storage: { getItem(key: string): string | null } | null }): TierHints {
  let forced: MotionTier | null = null;
  try {
    forced = parseForcedTier(env.storage?.getItem("omega.motion"));
  } catch {
    // Storage blocked: nothing forced.
  }
  const nav = v.safeParse(NavigatorSchema, env.navigator);
  const n = nav.success ? nav.output : {};
  const conn = v.safeParse(SaveDataSchema, n.connection);
  return {
    forced,
    reducedMotion: env.reducedMotion,
    saveData: conn.success && conn.output.saveData,
    hardwareConcurrency: count(n.hardwareConcurrency),
    deviceMemory: count(n.deviceMemory),
  };
}

export interface TierProbeDeps {
  readonly now: () => number;
  readonly raf: (fn: (t: number) => void) => void;
  /** Made once. A message posted after render runs after the frame's paint and commit, so it times the raster too. */
  readonly channel: () => { port1: { onmessage: (() => void) | null }; port2: { postMessage(m: null): void } };
}

export interface TierProbe {
  /** After a render: when the frame started, its rAF timestamp, and whether Smooth drew a walk in it. */
  rendered(start: number, frameTs: number, walking: boolean): void;
}

export function createTierProbe(tier: Tier, d: TierProbeDeps): TierProbe {
  let ch: ReturnType<TierProbeDeps["channel"]> | null = null;
  let pendingStart = NaN;
  let pendingWalking = false;
  /** The last Smooth walking frame's rAF timestamp (NaN: the chain broke). */
  let lastWalkTs = NaN;
  let renderTs = NaN;
  const onMessage = (): void => {
    if (Number.isNaN(pendingStart)) return;
    tier.work(d.now() - pendingStart, pendingWalking);
    pendingStart = NaN;
  };
  const nextFrame = (t: number): void => {
    tier.interval(t - renderTs);
  };
  return {
    rendered(start, frameTs, walking) {
      const probing = tier.probing();
      const smooth = tier.smooth();
      if (!probing && !smooth) return;
      if (walking && !Number.isNaN(lastWalkTs)) tier.interval(frameTs - lastWalkTs);
      lastWalkTs = walking ? frameTs : NaN;
      if (probing) {
        renderTs = frameTs;
        d.raf(nextFrame);
      } else if (!walking) return; // Smooth at rest: breathe renders don't count

      if (ch === null) {
        ch = d.channel();
        ch.port1.onmessage = onMessage;
      }
      pendingStart = start;
      pendingWalking = walking;
      ch.port2.postMessage(null);
    },
  };
}
