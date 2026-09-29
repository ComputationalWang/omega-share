// Frame sampling shared by the site and load-test perf specs.
import type { Page } from "@playwright/test";

/** Headless Chromium drives rAF from a fixed 60 Hz begin-frame clock. */
export const VSYNC_MS = 1000 / 60;

/** Frame deltas from requestAnimationFrame over `ms` (unthrottled in the perf project, see playwright.config.ts). */
export async function frameTimes(page: Page, ms: number): Promise<number[]> {
  return page.evaluate(
    (duration) =>
      new Promise<number[]>((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        const end = last + duration;
        const tick = (t: number): void => {
          deltas.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(tick);
          else resolve(deltas.slice(1));
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}
