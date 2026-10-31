// OME-2072: joining a room must not freeze the page. A fresh context opens a seeded room, types a nickname and presses
// Join; a longtask observer runs from the click until the room shows and 1.5 s after (the room chunk, Pixi, the
// stage and the first answer from the server). Median of 3 cold joins per profile.
// Rows: join.longTask.desktop (≤ 50 ms), join.longTask.phone4x (Pixel 7, 4× CPU throttle, ≤ 150 ms).
import { devices, expect, test, type Browser, type BrowserContextOptions } from "@playwright/test";
import { PENDING, available } from "../e2e/support/apps";
import { watchCsp } from "../e2e/support/csp";
import { stubExternalNetwork } from "../e2e/support/network";
import { testRoom } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { BUDGETS, evaluate } from "./budgets";
import { median } from "./landing";
import { recordMetric } from "./metrics";

const RUNS = 3;
const SETTLE_MS = 1500;

interface JoinStore {
  __joinTasks: { duration: number; scripts: string }[];
}

const PROFILES = [
  { id: "join.longTask.desktop", room: "desktop", device: devices["Desktop Chrome"], cpu: 1 },
  { id: "join.longTask.phone4x", room: "phone", device: devices["Pixel 7"], cpu: 4 },
] as const;

/** One cold join: the longest task (0 when none passed 50 ms) and what LoAF blamed for it. */
async function join(browser: Browser, roomUrl: string, device: BrowserContextOptions, cpu: number, n: number): Promise<{ longest: number; scripts: string }> {
  // watchCsp also starts with the first-visit tour seen: its card is not part of joining.
  const context = await watchCsp(await browser.newContext(device));
  try {
    await stubExternalNetwork(context);
    const page = await context.newPage();
    await page.goto(roomUrl);
    await page.locator(site.nicknameInput).fill(`join-${String(n)}`);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    await page.evaluate(() => {
      const seen: JoinStore["__joinTasks"] = [];
      (globalThis as unknown as JoinStore).__joinTasks = seen;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) seen.push({ duration: e.duration, scripts: "" });
      }).observe({ type: "longtask" });
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const scripts: unknown = Reflect.get(e, "scripts");
          const names = Array.isArray(scripts)
            ? scripts.map((s: unknown) => `${String(Reflect.get(s as object, "sourceFunctionName"))}@${String(Reflect.get(s as object, "sourceURL")).split("/").pop() ?? ""} ${Math.round(Number(Reflect.get(s as object, "duration"))).toString()}ms`)
            : [];
          seen.push({ duration: 0, scripts: `LoAF ${Math.round(e.duration).toString()}ms: ${names.join(", ")}` });
        }
      }).observe({ type: "long-animation-frame" });
    });
    await page.locator(site.joinButton).click();
    await expect(page.locator(site.room)).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(SETTLE_MS * cpu);
    const seen = await page.evaluate(() => (globalThis as unknown as JoinStore).__joinTasks);
    const longest = Math.max(0, ...seen.map((t) => t.duration));
    const loaf = seen.filter((t) => t.scripts !== "").map((t) => t.scripts);
    return { longest, scripts: loaf.slice(0, 3).join(" | ") };
  } finally {
    await context.close();
  }
}

test("joining a room: the longest task from Join until the room has settled", async ({ browser }) => {
  const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
  if (why !== null) {
    for (const p of PROFILES) recordMetric({ id: p.id, pending: why });
    test.skip(true, why);
    return;
  }
  test.setTimeout(180_000);
  for (const p of PROFILES) {
    const url = testRoom("join-perf", p.room).url;
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await join(browser, url, p.device, p.cpu, i));
    const value = median(runs.map((r) => r.longest));
    const m = { id: p.id, value, note: `${String(RUNS)} cold joins: ${runs.map((r) => r.longest.toFixed(0)).join(", ")} ms; ${runs.at(-1)?.scripts ?? ""}` };
    recordMetric(m);
    const budget = BUDGETS.find((b) => b.id === p.id);
    if (!budget) throw new Error(`no budget ${p.id}`);
    const r = evaluate(budget, m);
    expect.soft(r.status, `${budget.metric}: ${String(value)} ms vs ${budget.comparator} ${String(budget.limit)} (${m.note})`).toBe("pass");
  }
});
