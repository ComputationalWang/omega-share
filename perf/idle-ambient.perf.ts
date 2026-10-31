// OME-2067 (ADR 0058 §2): what an idle room costs once ambient loops end its 0 fps idle. The observer alone, forced
// Smooth tier, no video, holiday themes off, on desktop Chromium and a Pixel 7 (room fitted, so every piece is on
// screen), shown the cafe preset (OMEGA_PERF_IDLE_LAYOUT=<preset id> picks another; the ambient loops PR puts every
// looping piece in it). After the room settles, one 10 s window: idle.workPerS.<profile> is the renderer's main-thread
// TaskDuration (CDP Performance.getMetrics) per second, idle.rendersPerS.<profile> the room canvas's renders per second.
import { devices, expect, test } from "@playwright/test";
import type { BrowserContextOptions, Page } from "@playwright/test";
import * as v from "valibot";
import { PENDING, available } from "../e2e/support/apps";
import { joinRoom, leaveAll, testRoom } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { recordMetric } from "./metrics";
import { presetFile, showLayout } from "./show-layout";

const WINDOW_MS = 10_000;
const SETTLE_MS = 3000;
const LAYOUT_PRESET = process.env["OMEGA_PERF_IDLE_LAYOUT"] ?? "cafe";
const PROFILES = ["desktop", "phone"] as const;

/** A `window.__omega.room` getter (apps/web/src/main.ts), e.g. `roomRenders` or `furnitureLoops`. */
async function handle(page: Page, name: string): Promise<unknown> {
  return page.evaluate((n) => {
    const room: unknown = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room");
    const fn: unknown = typeof room === "object" && room !== null ? Reflect.get(room, n) : null;
    return typeof fn === "function" ? (Reflect.apply(fn, room, []) as unknown) : null;
  }, name);
}

for (const profile of PROFILES) {
  test(`idle room, every ambient loop visible: main-thread work and renders per second, ${profile}`, async ({ browser }) => {
    test.skip(!available.web || !available.server, available.web ? PENDING.server : PENDING.web);
    test.setTimeout(90_000);
    const room = testRoom("idle-perf", profile);
    const phone: BrowserContextOptions | undefined = profile === "phone" ? { ...devices["Pixel 7"] } : undefined;
    const clients = await joinRoom(browser, {
      roomUrl: room.url,
      count: 1,
      nicknamePrefix: `idle-${profile}`,
      contextOptions: () => phone,
      setup: async (context) => {
        await context.addInitScript(() => {
          localStorage.setItem("omega.motion", "smooth");
          localStorage.setItem("omega.theme", "off");
        });
        await showLayout(context, presetFile(LAYOUT_PRESET));
      },
    });
    try {
      const [observer] = clients;
      if (observer === undefined) throw new Error("no observer");
      const page = observer.page;
      await expect(page.locator("canvas.scene")).toHaveAttribute("data-motion", "smooth");
      if (profile === "phone") {
        await page.locator(site.roomWindow).evaluate((el) => {
          el.scrollIntoView({ block: "start" });
        });
        await page.getByTestId("room-zoom-fit").tap();
      }
      await expect(page.locator(site.roomWindow)).toBeInViewport();
      await page.waitForTimeout(SETTLE_MS);
      expect(await handle(page, "roomPaused"), "the stage is drawing").toBe(false);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      const taskSeconds = async (): Promise<number> => {
        const { metrics } = await cdp.send("Performance.getMetrics");
        return v.parse(v.number(), metrics.find((m) => m.name === "TaskDuration")?.value);
      };
      const r0 = v.parse(v.number(), await handle(page, "roomRenders"));
      const t0 = await taskSeconds();
      const w0 = Date.now();
      await page.waitForTimeout(WINDOW_MS);
      const t1 = await taskSeconds();
      const r1 = v.parse(v.number(), await handle(page, "roomRenders"));
      const seconds = (Date.now() - w0) / 1000;
      const workPerS = ((t1 - t0) * 1000) / seconds;
      const rendersPerS = (r1 - r0) / seconds;
      const loops = await handle(page, "furnitureLoops");
      const what = `${profile === "phone" ? "Pixel 7 emulation, room fitted" : "desktop Chromium"}, forced Smooth tier, observer alone, no video, ${LAYOUT_PRESET} layout, ${seconds.toFixed(1)} s window after ${String(SETTLE_MS)} ms settle, loops ${JSON.stringify(loops)}`;
      recordMetric({ id: `idle.workPerS.${profile}`, value: workPerS, note: `${((t1 - t0) * 1000).toFixed(1)} ms TaskDuration; ${what}` });
      recordMetric({ id: `idle.rendersPerS.${profile}`, value: rendersPerS, note: `${String(r1 - r0)} renders; ${what}` });
      expect(workPerS).toBeLessThanOrEqual(2);
      expect(rendersPerS).toBeLessThanOrEqual(8);
    } finally {
      await leaveAll(clients);
    }
  });
}
