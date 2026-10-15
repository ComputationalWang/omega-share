/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars -- red-commit stub */
/**
 * Long-run soak of a server binary (ADR 0050, slice S11b). Stub: the runner lands in the next commit.
 *
 *   bun perf/server-soak.ts --server "apps/server-rs/target/release/omega-server serve" --minutes 1440
 */
import { evaluate, type Check, type SoakArgs, type SoakResult } from "./soak-stats";

export async function runSoak(_args: SoakArgs): Promise<{ pass: boolean; checks: Check[]; result: SoakResult }> {
  const result: SoakResult = {
    durationMs: 0,
    segments: [],
    windows: [],
    restarts: [],
    plannedRestarts: 0,
    unplannedExits: 0,
    unexpectedCloses: 0,
    errors: {},
    integrity: "not run",
    consistency: [],
    abuse: [],
  };
  return { pass: false, checks: evaluate(result), result };
}
