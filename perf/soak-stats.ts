/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function -- red-commit stubs */
/** The soak's pure parts: statistics, stderr tally, the pass criteria and the arguments. Runner: perf/server-soak.ts. */

export interface Sample {
  tMs: number;
  rss: number;
  fds: number;
  threads: number;
  wal: number;
}
export interface WindowStat {
  startMs: number;
  count: number;
  p50: number;
  p95: number;
  p99: number;
}
export interface RestartResult {
  exitCode: number | null;
  exitMs: number;
  stderr: string;
  seatsExpected: number;
  seatsRestored: number;
}
export interface SoakResult {
  durationMs: number;
  /** One array of samples per server process, in order. */
  segments: Sample[][];
  windows: WindowStat[];
  restarts: RestartResult[];
  plannedRestarts: number;
  unplannedExits: number;
  unexpectedCloses: number;
  /** Error-level stderr events outside the expected list, by event. */
  errors: Record<string, number>;
  integrity: string;
  consistency: { name: string; client: number; server: number }[];
  abuse: { kind: string; started: number; cut: number }[];
}
export interface Check {
  name: string;
  ok: boolean;
  enforced: boolean;
  detail: string;
}

export const BOUNDS = { rssBytesPerHour: 1 << 20, fdsPerHour: 1, threadsPerHour: 0.5, walBytesPerHour: 256 << 10 };

export function slopePerHour(_segments: { tMs: number; v: number }[][]): number {
  return NaN;
}

export function windowPercentiles(_lat: { tMs: number; ms: number }[], _windowMs: number): WindowStat[] {
  return [{ startMs: -1, count: 0, p50: 0, p95: 0, p99: 0 }];
}

export function parseMetrics(_text: string): Map<string, number> {
  return new Map([["wrong", 0]]);
}

export class StderrTally {
  counts: Record<string, number> = {};
  total = -1;
  add(_chunk: string): void {}
  unexpectedErrors(_expected: readonly string[]): Record<string, number> {
    return { stub: 1 };
  }
}

export function evaluate(_r: SoakResult): Check[] {
  return [];
}

export interface SoakArgs {
  server: string;
  label: string;
  minutes: number;
  restartEveryMin: number;
  sampleS: number;
  windowS: number;
  rooms: number;
  members: number;
  out: string;
  allowErrors: string[];
}

export function parseSoakArgs(_argv: string[]): SoakArgs {
  return { server: "", label: "", minutes: 0, restartEveryMin: 0, sampleS: 0, windowS: 0, rooms: 0, members: 0, out: "", allowErrors: [] };
}
