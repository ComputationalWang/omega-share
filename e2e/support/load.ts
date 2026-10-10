// Load on the box, for frame-timing specs (OME-879). Two full local e2e runs at once push load average to 30–44 on 16
// cores; specs that read frame timing must then either judge what a busy page can honestly show, or say why they can't.
import { availableParallelism, loadavg } from "node:os";
import type { BrowserContext, Page } from "@playwright/test";

/**
 * `OMEGA_E2E_CPU_THROTTLE=N` (N > 1) slows every page that joinRoom opens, and the windows those pages open, N times
 * with CDP CPU throttling: a stand-in for a shared, overloaded box that loads only this run's own Chromium. Opt-in,
 * for proving a spec load-tolerant; never set in CI.
 */
const RATE = Number(process.env["OMEGA_E2E_CPU_THROTTLE"] ?? "1");

async function throttle(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: RATE });
}

/** Applies `OMEGA_E2E_CPU_THROTTLE` to every page `context` opens from now on. */
export function throttleContext(context: BrowserContext): void {
  if (!(RATE > 1)) return;
  context.on("page", (page) => {
    throttle(page).catch(() => {
      // The page closed before the session attached (a self-closing window): nothing to slow.
    });
  });
}

/** More runnable work than cores over the last minute (or the CPU throttle is on): frame timing here is the box's, not the app's. */
export function overloaded(): { readonly busy: boolean; readonly why: string } {
  const load1 = loadavg()[0] ?? 0;
  const cores = availableParallelism();
  const why = RATE > 1 ? `CPU throttled ${String(RATE)}×` : `load1 ${load1.toFixed(1)} on ${String(cores)} cores`;
  return { busy: RATE > 1 || load1 > cores, why };
}
