// Pure maths for the sync.spread metric and the frame-time summary (OME-90). Playwright-side sampling is in sync.ts.
import type { PlaybackState } from "@omega/shared";
import { p95, vsyncFrames } from "./metrics";

/** One client's player, read at wall-clock time `t` (ms since epoch; the server's clock on localhost). */
export interface ClientSample {
  readonly t: number;
  /** The player's current time, seconds. */
  readonly actual: number;
}

/** The room's position at server time `t` (the contract's formula, ADR 0011), computed independently of the apps. */
function expected(p: PlaybackState, t: number): number {
  const s = p.playing ? p.position + ((t - p.at) / 1000) * p.rate : p.position;
  return Math.max(0, s);
}

/** Expected minus actual, ms. Positive = the client is behind the room. */
export function driftMs(p: PlaybackState, s: ClientSample): number {
  return (expected(p, s.t) - s.actual) * 1000;
}

export interface Spread {
  readonly spreadMs: number;
  /** Per client, in sample order. */
  readonly drifts: readonly number[];
}

/** max − min of the clients' drifts: how far apart they are, whatever their common offset from the room. */
export function spread(p: PlaybackState, samples: readonly ClientSample[]): Spread {
  if (samples.length < 2) throw new Error("spread needs at least two clients");
  const drifts = samples.map((s) => driftMs(p, s));
  return { spreadMs: Math.max(...drifts) - Math.min(...drifts), drifts };
}

export interface ArrivalSpread {
  /** Last minus first client to apply the action. */
  readonly spreadMs: number;
  /** Last client to apply it minus the action itself. */
  readonly latencyMs: number;
}

/**
 * A live stream has no position to drift from (ADR 0014 §3), so its sync.spread is when a pause or play-from-live
 * landed on each client: `arrivals` are wall-clock ms, `at` is when the action was taken (OME-131).
 */
export function arrivalSpread(at: number, arrivals: readonly number[]): ArrivalSpread {
  if (arrivals.length < 2) throw new Error("arrival spread needs at least two clients");
  if (arrivals.some((t) => t < at)) throw new Error("an arrival is before the action: stale reading");
  const last = Math.max(...arrivals);
  return { spreadMs: last - Math.min(...arrivals), latencyMs: last - at };
}

export interface FrameSummary {
  /** p95 of frame times in whole vsync intervals: the budgeted number (ADR 0009). */
  readonly p95: number;
  readonly rawP95: number;
  readonly frames: number;
  /** Frames that took two or more vsync intervals. */
  readonly missed: number;
  readonly missedPct: number;
  /** ADR 0009 has no headroom: raw p95 over 16.7 ms or more than 5% missed vsyncs is worth a look even on a pass. */
  readonly flags: readonly string[];
  readonly note: string;
}

const RAW_P95_FLAG_MS = 16.7;
const MISSED_FLAG_PCT = 5;

export function summarizeFrames(deltas: readonly number[], vsyncMs: number): FrameSummary {
  const frames = vsyncFrames(deltas, vsyncMs);
  const missed = frames.filter((f) => f > vsyncMs * 1.5).length;
  const missedPct = (missed / frames.length) * 100;
  const rawP95 = p95(deltas);
  const flags: string[] = [];
  if (rawP95 > RAW_P95_FLAG_MS) flags.push(`raw p95 ${rawP95.toFixed(2)} ms > ${String(RAW_P95_FLAG_MS)} ms`);
  if (missedPct > MISSED_FLAG_PCT) flags.push(`missed vsyncs ${missedPct.toFixed(1)}% > ${String(MISSED_FLAG_PCT)}%`);
  const base = `${String(deltas.length)} frames, ${String(missed)} missed vsync (${missedPct.toFixed(1)}%), raw p95 ${rawP95.toFixed(2)} ms`;
  const note = flags.length === 0 ? base : `${base}; ⚠ ${flags.join("; ")}`;
  return { p95: p95(frames), rawP95, frames: deltas.length, missed, missedPct, flags, note };
}

/** The middle sample; of an even count the higher middle, so it is never kinder than the plain median (OME-846). */
export function upperMedian(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error("no samples");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

/** One traced rAF window: frame deltas and the observer's main-thread work per frame, ms. */
export interface SampledWindow {
  readonly samples: readonly number[];
  readonly workMs: readonly number[];
}

export interface WindowsSummary {
  readonly windows: number;
  /** Median of the windows' quantised p95s: the budgeted frame number. */
  readonly p95: number;
  readonly windowP95s: readonly number[];
  /** Median of the windows' work p95s. */
  readonly workP95: number;
  readonly windowWorkP95s: readonly number[];
  /** Pooled over every window. */
  readonly frames: number;
  readonly missed: number;
  readonly missedPct: number;
  readonly flags: readonly string[];
  /** For the frame p95, work p95 and missed-vsync rows. */
  readonly note: string;
  readonly workNote: string;
  readonly missedNote: string;
}

/**
 * Several back-to-back windows on one set-up room as one row (OME-846): missed vsyncs pooled over every frame, so one
 * stray frame in ~900 can't flip the 1 % budget; frame and work p95 as the median of the window p95s, so one slow
 * window can't decide them.
 */
export function summarizeWindows(windows: readonly SampledWindow[], vsyncMs: number): WindowsSummary {
  if (windows.length === 0) throw new Error("no windows");
  const each = windows.map((w) => summarizeFrames(w.samples, vsyncMs));
  const windowP95s = each.map((f) => f.p95);
  const windowWorkP95s = windows.map((w) => p95(w.workMs));
  const frames = each.reduce((n, f) => n + f.frames, 0);
  const missed = each.reduce((n, f) => n + f.missed, 0);
  const work = windows.reduce((n, w) => n + w.workMs.length, 0);
  const workMax = Math.max(...windows.flatMap((w) => w.workMs));
  const flags = [...new Set(each.flatMap((f) => f.flags))];
  const n = String(windows.length);
  const raw = each.map((f) => f.rawP95.toFixed(2)).join(" / ");
  const base = `median of ${n} windows (${windowP95s.map((v) => v.toFixed(2)).join(" / ")} ms), ${String(frames)} frames, raw p95 ${raw} ms`;
  return {
    windows: windows.length,
    p95: upperMedian(windowP95s),
    windowP95s,
    workP95: upperMedian(windowWorkP95s),
    windowWorkP95s,
    frames,
    missed,
    missedPct: (missed / frames) * 100,
    flags,
    note: flags.length === 0 ? base : `${base}; ⚠ ${flags.join("; ")}`,
    workNote: `median of ${n} windows (${windowWorkP95s.map((v) => v.toFixed(2)).join(" / ")} ms), ${String(work)} traced frames, max ${workMax.toFixed(2)} ms`,
    missedNote: `${String(missed)} of ${String(frames)} frames over ${n} windows (${each.map((f) => String(f.missed)).join(" / ")})`,
  };
}

export interface SpreadVerdict {
  /** The worst action's upper median over its rounds, ms. */
  readonly value: number;
  /** The single worst sample, ms: printed, not budgeted. */
  readonly max: number;
  readonly samples: number;
  readonly note: string;
}

/**
 * sync.spread over several rounds (OME-846): per action the upper median of its rounds, the row the worst action.
 * Spreads are bimodal, so a worst-of-2 flips on one slow round; with 4 rounds one outlier per action is tolerated
 * and two decide it.
 */
export function spreadVerdict(rounds: Readonly<Record<string, readonly number[]>>): SpreadVerdict {
  const actions = Object.entries(rounds).map(([action, xs]) => {
    if (xs.length === 0) throw new Error(`no rounds for ${action}`);
    return { action, median: upperMedian(xs), max: Math.max(...xs), n: xs.length };
  });
  if (actions.length === 0) throw new Error("no actions");
  const counts = [...new Set(actions.map((a) => a.n))].join("–");
  const each = actions.map((a) => `${a.action} ${a.median.toFixed(0)} (max ${a.max.toFixed(0)})`).join(" / ");
  const samples = actions.reduce((n, a) => n + a.n, 0);
  return {
    value: Math.max(...actions.map((a) => a.median)),
    max: Math.max(...actions.map((a) => a.max)),
    samples,
    note: `${each} ms, upper median of ${counts} rounds per action, ${String(samples)} samples`,
  };
}
