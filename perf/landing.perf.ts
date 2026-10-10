// OME-763: the landing budgets (docs/perf-budgets.md "Landing"). Cold loads of `/` on the preview build, no interaction.
import { devices, expect, test, type Browser } from "@playwright/test";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { site } from "../e2e/support/selectors";
import { BUDGETS, evaluate, type Measurement } from "./budgets";
import { cumulativeLayoutShift, gzipBytes, landingTransfer, longestTaskBefore, median, transferNote, type LandingResource } from "./landing";
import { recordMetric } from "./metrics";

const RUNS = 3;
const IDS = ["landing.transferGzip", "landing.lcp", "landing.cls", "landing.longTask"] as const;

interface VitalsStore {
  __omegaVitals: { lcp: number; shifts: { value: number; hadRecentInput: boolean }[]; tasks: { startTime: number; duration: number }[] };
}

interface ColdLoad {
  readonly resources: LandingResource[];
  readonly lcp: number;
  readonly cls: number;
  readonly longTask: number;
}

// The perf project's device, as `browser.newContext()` doesn't inherit the project's `use`.
const desktop = devices["Desktop Chrome"];

async function coldLoad(browser: Browser): Promise<ColdLoad> {
  const context = await browser.newContext({ viewport: desktop.viewport, deviceScaleFactor: desktop.deviceScaleFactor, userAgent: desktop.userAgent, hasTouch: desktop.hasTouch, isMobile: desktop.isMobile });
  try {
    await context.addInitScript(() => {
      const v: VitalsStore["__omegaVitals"] = { lcp: 0, shifts: [], tasks: [] };
      (globalThis as unknown as VitalsStore).__omegaVitals = v;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) v.lcp = e.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) v.shifts.push({ value: Number(Reflect.get(e, "value")), hadRecentInput: Reflect.get(e, "hadRecentInput") === true });
      }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) v.tasks.push({ startTime: e.startTime, duration: e.duration });
      }).observe({ type: "longtask", buffered: true });
    });
    const page = await context.newPage();
    const bodies: Promise<LandingResource | null>[] = [];
    page.on("response", (r) => {
      const type = r.request().resourceType();
      // Redirects and aborted responses have no body; they transfer next to nothing.
      bodies.push(r.body().then((b) => ({ url: r.url(), type, bytes: gzipBytes(b) }), () => null));
    });
    await page.goto(URLS.web, { waitUntil: "load" });
    // Whatever the page fetches on `load` (the home chunk, its rooms list) and LCP/CLS settling, still without any input.
    await page.waitForTimeout(1000);
    await expect(page.locator(site.nicknameInput)).toBeEditable();
    const vitals = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const mark = performance.getEntriesByName("omega:interactive")[0]?.startTime;
      return { ...(globalThis as unknown as VitalsStore).__omegaVitals, dcl: nav?.domContentLoadedEventEnd ?? 0, mark: mark ?? null };
    });
    if (vitals.mark === null) throw new Error("the site set no omega:interactive mark, so the nickname field's usable time is unknown");
    expect(vitals.lcp, "a largest-contentful-paint entry").toBeGreaterThan(0);
    const resources = (await Promise.all(bodies)).filter((r): r is LandingResource => r !== null);
    return { resources, lcp: vitals.lcp, cls: cumulativeLayoutShift(vitals.shifts), longTask: longestTaskBefore(vitals.tasks, Math.max(vitals.dcl, vitals.mark)) };
  } finally {
    await context.close();
  }
}

test("landing: transfer, LCP, CLS and long tasks at / before interaction", async ({ browser }) => {
  if (!available.web) {
    for (const id of IDS) recordMetric({ id, pending: PENDING.web });
    return;
  }
  test.setTimeout(60_000);
  // Warm-up load so preview-server start-up isn't counted (as site.tti does), then cold loads in fresh contexts.
  await coldLoad(browser);
  const runs: ColdLoad[] = [];
  for (let i = 0; i < RUNS; i++) runs.push(await coldLoad(browser));
  const transfers = runs.map((r) => landingTransfer(r.resources));
  const worst = transfers.reduce((a, b) => (b.kb > a.kb ? b : a));
  const timing = (pick: (r: ColdLoad) => number) => runs.map(pick);
  const note = (xs: number[], digits: number) => `median of ${String(RUNS)} cold loads: ${xs.map((x) => x.toFixed(digits)).join(", ")}`;
  const lcps = timing((r) => r.lcp);
  const clss = timing((r) => r.cls);
  const tasks = timing((r) => r.longTask);
  const rows: Measurement[] = [
    { id: "landing.transferGzip", value: worst.kb, note: transferNote(worst) },
    { id: "landing.lcp", value: median(lcps), note: note(lcps, 0) },
    { id: "landing.cls", value: median(clss), note: note(clss, 3) },
    { id: "landing.longTask", value: median(tasks), note: note(tasks, 0) },
  ];
  for (const m of rows) {
    recordMetric(m);
    const budget = BUDGETS.find((b) => b.id === m.id);
    if (!budget) throw new Error(`no budget ${m.id}`);
    const r = evaluate(budget, m);
    expect.soft(r.status, `${budget.metric}: ${"value" in m ? String(m.value) : "?"} ${budget.unit} vs ${budget.comparator} ${String(budget.limit)} (${r.note ?? ""})`).toBe("pass");
  }
});
