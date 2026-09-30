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
