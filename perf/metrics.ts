// Perf specs write one JSON file per metric; perf/run.ts collects them into the report.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Measurement } from "./budgets";

export const RESULTS_DIR = join(import.meta.dirname, "results");
export const METRICS_DIR = join(RESULTS_DIR, "metrics");

export function recordMetric(m: Measurement): void {
  mkdirSync(METRICS_DIR, { recursive: true });
  writeFileSync(join(METRICS_DIR, `${m.id}.json`), JSON.stringify(m));
}

function isMeasurement(x: unknown): x is Measurement {
  if (typeof x !== "object" || x === null || !("id" in x) || typeof x.id !== "string") return false;
  if ("pending" in x) return typeof x.pending === "string";
  return "value" in x && typeof x.value === "number" && Number.isFinite(x.value);
}

export function readMetrics(): Measurement[] {
  let files: string[];
  try {
    files = readdirSync(METRICS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((f) => {
    const parsed: unknown = JSON.parse(readFileSync(join(METRICS_DIR, f), "utf8"));
    if (!isMeasurement(parsed)) throw new Error(`malformed metric file ${f}`);
    return parsed;
  });
}

export function p95(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error("no samples");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.NaN;
}

/**
 * rAF deltas → presented frame times: each delta rounded to a whole number of vsync intervals (at least one).
 * Raw deltas can't go below one interval and carry ±0.1 ms timer jitter, so their p95 straddles a 16.7 ms budget
 * even on a blank page; this counts missed vsyncs instead.
 */
export function vsyncFrames(deltas: readonly number[], vsyncMs: number): number[] {
  return deltas.map((d) => Math.max(1, Math.round(d / vsyncMs)) * vsyncMs);
}
