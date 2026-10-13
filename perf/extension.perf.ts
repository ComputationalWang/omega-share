import { PENDING, available } from "../e2e/support/apps";
import { expect, test } from "../e2e/support/extension";
import { gotoFixture } from "../e2e/support/network";
import { popup } from "../e2e/support/selectors";
import { p95, recordMetric } from "./metrics";

declare const chrome: {
  scripting: {
    registerContentScripts(s: { id: string; js: string[]; matches: string[]; runAt: "document_idle"; persistAcrossSessions: boolean }[]): Promise<void>;
    getRegisteredContentScripts(): Promise<unknown[]>;
  };
};

test.describe("extension perf", () => {
  test.skip(!available.extension, PENDING.extension);

  test("popup opened → embeds listed", async ({ context, openPopup }) => {
    const page = await context.newPage();
    // All three providers plus rejected clips/events and lookalikes (listed as generic), so the scan does its full work (OME-144, OME-293).
    await gotoFixture(page, "providers-embed");
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await openPopup(page);
      await p.locator(popup.embedItem).nth(5).waitFor();
      // performance.now() is relative to the popup's navigation start.
      runs.push(await p.evaluate(() => performance.now()));
      await expect(p.locator(popup.embedItem)).toHaveCount(6);
      await p.close();
    }
    recordMetric({ id: "ext.popupToList", value: p95(runs), note: `p95 of ${String(runs.length)} opens on providers-embed (4 synced + 2 generic embeds)` });
  });

  test("found indicator: main-thread time per page check (OME-1042)", async ({ context, serviceWorker }) => {
    // Registered as the background does once https://*/* is granted, here on the e2e build's own localhost host.
    // After the background's own startup sync (the bridge is its sign), under an id that sync doesn't own.
    await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)).toBeGreaterThan(0);
    await serviceWorker.evaluate(() =>
      chrome.scripting.registerContentScripts([{ id: "omega-found-e2e", js: ["content-scripts/found.js"], matches: ["http://localhost/*"], runAt: "document_idle", persistAcrossSessions: false }]),
    );
    const page = await context.newPage();
    await gotoFixture(page, "providers-embed");
    // The e2e build's content script writes each check's duration to the page; 10 DOM changes, rechecked once per second at most.
    const checks: number[] = [];
    for (let i = 0; i < 10; i++) {
      const ms = await page.waitForFunction((n) => {
        const list = (document.documentElement.dataset["omegaFoundMs"] ?? "").split(" ").filter(Boolean);
        return list.length > n ? Number(list[n]) : false;
      }, i, { timeout: 5000 });
      checks.push(Number(await ms.jsonValue()));
      await page.evaluate(() => {
        document.body.append(document.createElement("div"));
      });
    }
    recordMetric({ id: "ext.foundCheck", value: p95(checks), note: `p95 of ${String(checks.length)} checks on providers-embed (6 embeds)` });
  });
});

test("extension perf: record pending when not built", () => {
  if (!available.extension) recordMetric({ id: "ext.popupToList", pending: PENDING.extension });
  if (!available.extension) recordMetric({ id: "ext.foundCheck", pending: PENDING.extension });
});
