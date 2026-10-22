import { PENDING, URLS, available } from "../e2e/support/apps";
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

  test("popup opened → 20 rooms listed, the one playing the page's video first (OME-1637)", async ({ context, openPopup }) => {
    // GET /rooms stubbed: 20 public rooms, one playing youtube-embed's video; owned (seeded) rooms are private, never listed.
    const rooms = Array.from({ length: 20 }, (_, i) => ({ id: `perfroom${String(i)}`.padEnd(26, "a"), memberCount: 5, seatedCount: 0, watchingCount: 3, nowPlaying: { provider: "youtube", id: i === 13 ? "aqz-KE-bpKQ" : "bbbbbbbbbbb" } }));
    await context.route(`${URLS.server}/rooms`, (route) => route.fulfill({ json: { rooms } }));
    const page = await context.newPage();
    await gotoFixture(page, "youtube-embed");
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await openPopup(page);
      await p.locator(popup.embedItem).first().waitFor();
      await p.locator(`${popup.roomSelect} option:first-child`, { hasText: "3 watching · Join" }).waitFor({ state: "attached" });
      runs.push(await p.evaluate(() => performance.now()));
      await p.close();
    }
    // The ext.popupToList budget (docs/perf-budgets.md) holds with the room list sorted, too.
    test.info().annotations.push({ type: "popup → sorted rooms (ms)", description: `p95 ${String(Math.round(p95(runs)))} of ${runs.map((r) => String(Math.round(r))).join(", ")}` });
    expect(p95(runs)).toBeLessThanOrEqual(300);
  });

  test("found indicator: main-thread time per page check (OME-1042)", async ({ context, serviceWorker }) => {
    test.setTimeout(60_000);
    // Registered as the background does once https://*/* is granted, here on the e2e build's own localhost host.
    // After the background's own startup sync (the bridge is its sign), under an id that sync doesn't own.
    await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)).toBeGreaterThan(0);
    await serviceWorker.evaluate(() =>
      chrome.scripting.registerContentScripts([{ id: "omega-found-e2e", js: ["content-scripts/found.js"], matches: ["http://localhost/*"], runAt: "document_idle", persistAcrossSessions: false }]),
    );
    const page = await context.newPage();
    await gotoFixture(page, "providers-embed");
    // The e2e build's content script writes each check's duration to the page; 20 checks (the load, then DOM changes,
    // rechecked once per second at most). p95 of 20 is the second worst; the first, cold check is in the note.
    const checks: number[] = [];
    for (let i = 0; i < 20; i++) {
      const ms = await page.waitForFunction((n) => {
        const list = (document.documentElement.dataset["omegaFoundMs"] ?? "").split(" ").filter(Boolean);
        return list.length > n ? Number(list[n]) : false;
      }, i, { timeout: 5000 });
      checks.push(Number(await ms.jsonValue()));
      await page.evaluate(() => {
        document.body.append(document.createElement("div"));
      });
    }
    recordMetric({ id: "ext.foundCheck", value: p95(checks), note: `p95 of ${String(checks.length)} checks on providers-embed (6 embeds); first (cold) ${String(checks[0])} ms, max ${String(Math.max(...checks))} ms` });
  });
});

test("extension perf: record pending when not built", () => {
  if (!available.extension) recordMetric({ id: "ext.popupToList", pending: PENDING.extension });
  if (!available.extension) recordMetric({ id: "ext.foundCheck", pending: PENDING.extension });
});
