// Extension smoke: loads unpacked, stays event-driven, lists only allowlisted embeds.
import { PENDING, available } from "./support/apps";
import { expect, test } from "./support/extension";
import { gotoFixture } from "./support/network";
import { popup } from "./support/selectors";

test.describe("extension", () => {
  test.fixme(!available.extension, PENDING.extension);

  test("loads unpacked and exposes an MV3 service worker", ({ extensionId, serviceWorker }) => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(serviceWorker.url()).toContain(`chrome-extension://${extensionId}/`);
  });

  test("lists the YouTube embed", async ({ context, openPopup }) => {
    const page = await context.newPage();
    await gotoFixture(page, "youtube-embed");
    const p = await openPopup(page);
    await expect(p.locator(popup.embedItem)).toHaveCount(1);
  });

  test("lists the video on a watch URL", async ({ context, openPopup }) => {
    const page = await context.newPage();
    await gotoFixture(page, "watch-url");
    const p = await openPopup(page);
    await expect(p.locator(popup.embedItem)).toHaveCount(1);
  });

  for (const fixture of ["non-allowlisted", "no-video"] as const) {
    test(`lists nothing on ${fixture}`, async ({ context, openPopup }) => {
      const page = await context.newPage();
      await gotoFixture(page, fixture);
      const p = await openPopup(page);
      await expect(p.locator(popup.embedsEmpty)).toBeVisible();
      await expect(p.locator(popup.embedItem)).toHaveCount(0);
    });
  }
});
