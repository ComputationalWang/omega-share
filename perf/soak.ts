// Soak gating: the 10-minute heap soak only runs under `bun run perf --soak` (which sets OMEGA_PERF_SOAK=1).
import type { Page } from "@playwright/test";

const MB = 1024 * 1024;

/** The page's used JS heap in MB after a forced GC, over CDP. */
export async function heapAfterGcMb(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    const { usedSize } = await cdp.send("Runtime.getHeapUsage");
    return usedSize / MB;
  } finally {
    await cdp.detach();
  }
}

/** The soak length docs/perf-budgets.md budgets for ("JS heap after 10 min in room"). */
export const SOAK_BUDGET_MS = 10 * 60_000;

export type SoakPlan =
  | { readonly run: false; readonly reason: string }
  | { readonly run: true; readonly durationMs: number; readonly full: boolean };

/** OMEGA_SOAK_MS shortens the soak for local iteration; only a full-length soak counts against the budget. */
export function soakPlan(env: Readonly<Record<string, string | undefined>>): SoakPlan {
  if (env["OMEGA_PERF_SOAK"] !== "1") return { run: false, reason: "slow (10 min): run `bun run perf --soak`" };
  const raw = env["OMEGA_SOAK_MS"];
  if (raw === undefined) return { run: true, durationMs: SOAK_BUDGET_MS, full: true };
  const durationMs = Number(raw);
  if (!Number.isInteger(durationMs) || durationMs <= 0) throw new Error(`OMEGA_SOAK_MS must be a positive integer, got "${raw}"`);
  return { run: true, durationMs, full: durationMs >= SOAK_BUDGET_MS };
}
