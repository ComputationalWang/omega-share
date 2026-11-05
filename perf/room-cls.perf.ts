// OME-2106: Cumulative Layout Shift in the room over one full-screen enter + exit, a video shared, one client per profile
// (desktop Chromium, a Pixel 7 in landscape 915×412 and in portrait 412×915). In by our full-screen key, out the way Esc,
// the browser's UI or Android Back leave (`document.exitFullscreen()`: no input on the page, so every shift counts).
// Every layout shift without recent input from the key press until 1 s after leaving, summed (as the landing rows count it).
// Rows: room.fsCls.<profile> (< 0.01). The note names the elements that moved.
import { devices, expect, test } from "@playwright/test";
import type { BrowserContextOptions, Page } from "@playwright/test";
import { PENDING, available } from "../e2e/support/apps";
import { EMBED_URL } from "../e2e/support/network";
import { joinRoom, leaveAll, testRoom } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { joinForToken, postShare } from "../e2e/support/share";
import { BUDGETS, evaluate } from "./budgets";
import { recordMetric } from "./metrics";
import { waitPlaying } from "./sync";

const PROFILES = {
  desktop: undefined,
  landscape: { ...devices["Pixel 7"], viewport: { width: 915, height: 412 } },
  portrait: { ...devices["Pixel 7"], viewport: { width: 412, height: 915 } },
} satisfies Record<string, BrowserContextOptions | undefined>;
/** How long after a toggle the browser's resize, our relayout and the strip's move may still be running. */
const SETTLE_MS = 1000;
const LIMIT = 0.01;

const inFullscreen = (page: Page): Promise<boolean> => page.evaluate(() => document.fullscreenElement !== null);

async function settle(page: Page, on: boolean): Promise<void> {
  await expect.poll(() => inFullscreen(page)).toBe(on);
  await page.waitForTimeout(SETTLE_MS);
}

for (const profile of ["desktop", "landscape", "portrait"] as const) {
  const options = PROFILES[profile];
  test(`room CLS over a full-screen enter + exit, ${profile}`, async ({ browser, request }) => {
    const id = `room.fsCls.${profile}`;
    const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
    if (why !== null) {
      recordMetric({ id, pending: why });
      test.skip(true, why);
      return;
    }
    test.setTimeout(120_000);
    const room = testRoom("room-cls-perf", profile);
    await expect
      .poll(
        async () => {
          const member = await joinForToken(room.id, "cls-perf-sharer");
          try {
            return (await postShare(request, room.id, member.token, EMBED_URL)).status();
          } finally {
            member.close();
          }
        },
        { timeout: 60_000, intervals: [2_000, 5_000] },
      )
      .toBe(200);
    const clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "cls", contextOptions: () => options });
    try {
      await waitPlaying(clients);
      const page = clients[0]?.page;
      if (page === undefined) throw new Error("no client");
      await page.waitForTimeout(SETTLE_MS);
      await page.evaluate(() => {
        const shifts: { value: number; nodes: string[] }[] = [];
        Reflect.set(window, "__roomShifts", shifts);
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const s = e as PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] };
            if (s.hadRecentInput) continue;
            const nodes = (s.sources ?? []).map(({ node }) => (node instanceof Element ? `${node.localName}${node.className === "" ? "" : `.${node.className.trim().split(/\s+/).join(".")}`}` : "?"));
            shifts.push({ value: s.value, nodes });
          }
        }).observe({ type: "layout-shift" });
      });
      await page.locator(site.fullscreenToggle).click();
      await settle(page, true);
      await page.evaluate(() => document.exitFullscreen());
      await settle(page, false);
      const shifts = await page.evaluate(() => {
        const seen: unknown = Reflect.get(window, "__roomShifts");
        return Array.isArray(seen) ? (seen as { value: number; nodes: string[] }[]) : [];
      });
      const cls = shifts.reduce((sum, s) => sum + s.value, 0);
      const moved = [...new Set(shifts.flatMap((s) => s.nodes))];
      recordMetric({ id, value: cls, note: `${String(shifts.length)} shifts${moved.length > 0 ? ` (${moved.join(", ")})` : ""}; ${profile}, one full-screen enter + exit, video shared` });
      expect(cls, moved.join(", ")).toBeLessThan(LIMIT);
    } finally {
      await leaveAll(clients);
    }
  });
}

// OME-2261: CLS loading a room cold. A guest joins, then reloads `/r/<id>` (a returning guest, no input); every layout shift
// from navigation start until the room has drawn and 2 s after, summed. Rows: room.coldCls.desktop (1280×800), room.coldCls.phone4x.
const COLD = [
  { id: "room.coldCls.desktop", options: { viewport: { width: 1280, height: 800 } }, cpu: 1 },
  { id: "room.coldCls.phone4x", options: devices["Pixel 7"], cpu: 4 },
] as const;
const COLD_SETTLE_MS = 2000;

for (const p of COLD) {
  test(`room CLS loading cold, ${p.id}`, async ({ browser }) => {
    const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
    if (why !== null) {
      recordMetric({ id: p.id, pending: why });
      test.skip(true, why);
      return;
    }
    test.setTimeout(120_000);
    const room = testRoom("room-cls-perf", p.id.endsWith("desktop") ? "cold-desktop" : "cold-phone");
    const [client] = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "cold", contextOptions: () => p.options });
    try {
      const page = client?.page;
      if (page === undefined) throw new Error("no client");
      // From the first script of the reloaded document, so the load's own shifts count.
      await page.context().addInitScript(() => {
        const shifts: { value: number; nodes: string[] }[] = [];
        Reflect.set(window, "__roomShifts", shifts);
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const s = e as PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] };
            if (s.hadRecentInput) continue;
            const nodes = (s.sources ?? []).map(({ node }) => (node instanceof Element ? `${node.localName}${node.className === "" ? "" : `.${node.className.trim().split(/\s+/).join(".")}`}` : "?"));
            shifts.push({ value: s.value, nodes });
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: p.cpu });
      await page.reload();
      await expect(page.locator(site.room)).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(COLD_SETTLE_MS * p.cpu);
      const shifts = await page.evaluate(() => {
        const seen: unknown = Reflect.get(window, "__roomShifts");
        return Array.isArray(seen) ? (seen as { value: number; nodes: string[] }[]) : [];
      });
      const value = shifts.reduce((sum, s) => sum + s.value, 0);
      const moved = [...new Set(shifts.flatMap((s) => s.nodes))];
      const m = { id: p.id, value, note: `${String(shifts.length)} shifts${moved.length > 0 ? ` (${moved.join(", ")})` : ""}; reload of /r/<id>, returning guest` };
      recordMetric(m);
      const budget = BUDGETS.find((b) => b.id === p.id);
      if (!budget) throw new Error(`no budget ${p.id}`);
      expect(evaluate(budget, m).status, `${budget.metric}: ${value.toFixed(3)} vs ${budget.comparator} ${String(budget.limit)} (${m.note})`).toBe("pass");
    } finally {
      await leaveAll([...(client ? [client] : [])]);
    }
  });
}
