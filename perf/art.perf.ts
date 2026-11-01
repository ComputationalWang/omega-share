// OME-2152 (ADR 0060): the room-art bytes row (docs/perf-budgets.md "Room art transfer per preset (gzipped)"). Per
// shipped preset, a cold context on the preview build goes from `/` through the directory into a room on that preset's
// layout (seeded, e2e/support/test-rooms.ts "art-perf": creating ten rooms would spend the create limits) and sits down;
// every image and JSON art response is gzipped at level 6 as the landing row counts it. The dearest preset is the value.
import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { watchCsp } from "../e2e/support/csp";
import { openDirectory } from "../e2e/support/directory";
import { clickSettled, testRoom } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { SPEC_ROOMS } from "../e2e/support/test-rooms";
import { artReport, presetArt, type PresetArt } from "./art";
import { BUDGETS, evaluate } from "./budgets";
import { responseBytes, type LandingResource } from "./landing";
import { recordMetric } from "./metrics";

const ID = "site.artGzip";
const desktop = devices["Desktop Chrome"];

/** Am I in one of the room's seats (the dev handle, apps/web/src/main.ts `window.__omega.room`)? */
async function seated(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    if (typeof room !== "object" || room === null) return false;
    const state: unknown = Reflect.apply(Reflect.get(room, "state") as () => unknown, room, []);
    if (typeof state !== "object" || state === null) return false;
    const self: unknown = Reflect.get(state, "self");
    const r: unknown = Reflect.get(state, "room");
    const seats: unknown = typeof r === "object" && r !== null ? Reflect.get(r, "seats") : null;
    return self !== null && Array.isArray(seats) && seats.includes(self);
  });
}

/** One cold visit into `preset`'s room, seated (standing where the preset has no seat), and the art it fetched. */
async function visit(browser: Browser, preset: (typeof SPEC_ROOMS)["art-perf"][number]): Promise<PresetArt & { readonly sat: boolean }> {
  // watchCsp also marks the first-visit tour seen, as the other room perf specs do (its card would cover the seats).
  const context = await watchCsp(await browser.newContext({ viewport: desktop.viewport, deviceScaleFactor: desktop.deviceScaleFactor, userAgent: desktop.userAgent }));
  try {
    const page = await context.newPage();
    const bodies: Promise<LandingResource>[] = [];
    page.on("response", (r) => {
      const type = r.request().resourceType();
      const length = r.headers()["content-length"];
      const bytes = (b: Uint8Array | null): LandingResource => ({ url: r.url(), type, bytes: responseBytes(b, length) });
      bodies.push(r.body().then(bytes, () => bytes(null)));
    });
    await page.goto(URLS.web, { waitUntil: "load" });
    await openDirectory(page, "Art");
    // The directory with its preset thumbs, then the room's link, in the same tab and cache.
    await page.waitForTimeout(1000);
    await page.goto(testRoom("art-perf", preset).url);
    await page.locator(site.avatarOption).first().click();
    await page.locator(site.joinButton).click();
    await expect(page.locator(site.room)).toBeVisible();
    const seat = page.locator(site.seat).first();
    const sat = (await seat.count()) > 0;
    if (sat) {
      await clickSettled(page, seat);
      await expect.poll(() => seated(page), { timeout: 15_000 }).toBe(true);
    }
    // Whatever the seated pose and the room's ambient art load after sitting.
    await page.waitForTimeout(2000);
    return { ...presetArt(preset, await Promise.all(bodies), new URL(URLS.web).origin), sat };
  } finally {
    await context.close();
  }
}

test("room art: the dearest preset's art transfer, cold, from / to seated (gzipped)", async ({ browser }) => {
  const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
  if (why !== null) {
    recordMetric({ id: ID, pending: why });
    test.skip(true, why);
    return;
  }
  test.setTimeout(180_000);
  const presets: (PresetArt & { readonly sat: boolean })[] = [];
  for (const preset of SPEC_ROOMS["art-perf"]) presets.push(await visit(browser, preset));
  const report = artReport(presets);
  const standing = presets.filter((p) => !p.sat).map((p) => p.preset);
  const m = { id: ID, value: report.kb, note: standing.length > 0 ? `${report.note}; standing (no seat): ${standing.join(", ")}` : report.note };
  recordMetric(m);
  const budget = BUDGETS.find((b) => b.id === ID);
  if (!budget) throw new Error(`no budget ${ID}`);
  expect(evaluate(budget, m).status, `${budget.metric}: ${m.value.toFixed(1)} KB vs ≤ ${String(budget.limit)} (${m.note})`).toBe("pass");
});
