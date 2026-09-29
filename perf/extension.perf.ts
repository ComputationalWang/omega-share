import { PENDING, available } from "../e2e/support/apps";
import { test } from "../e2e/support/extension";
import { gotoFixture } from "../e2e/support/network";
import { popup } from "../e2e/support/selectors";
import { p95, recordMetric } from "./metrics";

test.describe("extension perf", () => {
  test.skip(!available.extension, PENDING.extension);

  test("popup opened → embeds listed", async ({ context, openPopup }) => {
    const page = await context.newPage();
    await gotoFixture(page, "youtube-embed");
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await openPopup(page);
      await p.locator(popup.embedItem).first().waitFor();
      // performance.now() is relative to the popup's navigation start.
      runs.push(await p.evaluate(() => performance.now()));
      await p.close();
    }
    recordMetric({ id: "ext.popupToList", value: p95(runs), note: `p95 of ${String(runs.length)} opens` });
  });
});

test("extension perf: record pending when not built", () => {
  if (!available.extension) recordMetric({ id: "ext.popupToList", pending: PENDING.extension });
});
