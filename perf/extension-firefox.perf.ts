import { expect, test } from "../e2e/support/csp";
import { PENDING, available } from "../e2e/support/apps";
import { embedLabels, embedsListedAt, launchFirefoxWithExtension, missedOpens, openFixture, openPopup } from "../e2e/support/firefox";
import { BUDGETS } from "./budgets";
import { p95, recordMetric } from "./metrics";

// Firefox row of "Popup opened → embeds listed" (OME-593): the Firefox e2e build in headless Firefox via Puppeteer/BiDi.
// A proxy like the Chromium row: the popup opens as a tab (pointed at the fixture tab by `?tabId=`), and an in-page
// MutationObserver timestamps the list, so BiDi round trips are not counted.
const RUNS = 30;

test.describe("extension perf (Firefox)", () => {
  test.skip(!available.extension, PENDING.extension);

  test("popup opened → embeds listed (Firefox)", async () => {
    test.setTimeout(180_000);
    const { browser } = await launchFirefoxWithExtension();
    try {
      // The same full-work page as the Chromium row: all three providers, rejected clips/events and lookalikes.
      const page = await openFixture(browser, "providers-embed");
      // One cold open first: the Chromium row is warm too (its fixture opens the popup page before measuring).
      await (await openPopup(browser, page)).close();
      const runs: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const popup = await openPopup(browser, page);
        // performance.now() is relative to the popup's navigation start.
        runs.push(await embedsListedAt(popup, 6));
        expect(await embedLabels(popup, 6)).toHaveLength(6);
        await popup.close();
      }
      const value = p95(runs);
      recordMetric({ id: "ext.firefox.popupToList", value, note: `p95 of ${String(RUNS)} opens on providers-embed, headless Firefox via BiDi (${String(missedOpens.count)} harness re-opens)` });
      const budget = BUDGETS.find((b) => b.id === "ext.firefox.popupToList");
      expect(value).toBeLessThanOrEqual(budget?.limit ?? 0);
    } finally {
      await browser.close();
    }
  });
});

test("extension perf (Firefox): record pending when not built", () => {
  if (!available.extension) recordMetric({ id: "ext.firefox.popupToList", pending: PENDING.extension });
});
