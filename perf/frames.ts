// Frame sampling shared by the site and load-test perf specs.
import type { Browser, Page } from "@playwright/test";
import type { FrameProvider } from "./budgets";
import { OBSERVER_MARK, TRACE_CATEGORIES, frameWorkMs } from "./frame-work";
import { recordMetric } from "./metrics";
import { summarizeWindows } from "./spread";

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

export interface FrameWindow {
  /** rAF deltas, ms. */
  readonly samples: number[];
  /** Observer main-thread work per frame, ms (ADR 0017). */
  readonly workMs: number[];
}

/** `frameTimes` on the observer inside a minimal Chromium trace of the whole browser, for the work-per-frame row. */
export async function tracedFrames(browser: Browser, page: Page, ms: number): Promise<FrameWindow> {
  await browser.startTracing(undefined, { categories: TRACE_CATEGORIES });
  let samples: number[];
  let buffer: Buffer;
  try {
    await page.evaluate((name) => performance.mark(name), OBSERVER_MARK);
    samples = await frameTimes(page, ms);
  } finally {
    // Always stop, or the next spec's startTracing throws.
    buffer = await browser.stopTracing();
  }
  const trace: unknown = JSON.parse(buffer.toString("utf8"));
  return { samples, workMs: frameWorkMs(trace) };
}

/** Back-to-back traced windows per frame row (OME-846): one ~300-frame window flips a 1 % missed-vsync budget on one frame. */
export const FRAME_WINDOWS = 3;

/** `count` back-to-back `tracedFrames` windows on the same, already set-up page: rows from these via `summarizeWindows`. */
export async function sampledFrames(browser: Browser, page: Page, ms: number, count = FRAME_WINDOWS): Promise<FrameWindow[]> {
  const windows: FrameWindow[] = [];
  for (let i = 0; i < count; i++) windows.push(await tracedFrames(browser, page, ms));
  return windows;
}

/** The three frame rows of one provider: ADR 0009's quantised p95, and ADR 0017's work p95 and missed vsyncs. */
export function recordFrameRows(provider: FrameProvider, windows: readonly FrameWindow[], what: string): void {
  const f = summarizeWindows(windows, VSYNC_MS);
  recordMetric({ id: provider === "youtube" ? "site.frameP95" : `site.frameP95.${provider}`, value: f.p95, note: `${f.note}; ${what}` });
  recordMetric({ id: `site.frameWorkP95.${provider}`, value: f.workP95, note: `${f.workNote}; ${what}` });
  recordMetric({ id: `site.missedVsync.${provider}`, value: f.missedPct, note: `${f.missedNote}; Playwright tracing off; ${what}` });
}
