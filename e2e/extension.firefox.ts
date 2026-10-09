import { expect, test } from "@playwright/test";
import { type FirefoxExtension, embedLabels, launchFirefoxWithExtension, openFixture, openPopup } from "./support/firefox";

// Firefox lane smoke (OME-593): the Firefox e2e build in headless Firefox, through Puppeteer over BiDi.
// The scan and share code is the same as Chrome's; this proves the Firefox build runs it.
test.describe("Firefox extension", () => {
  let ff: FirefoxExtension;
  test.beforeAll(async () => {
    ff = await launchFirefoxWithExtension();
  });
  test.afterAll(async () => {
    await ff.browser.close();
  });

  test("installs under the permanent gecko ID", () => {
    expect(ff.extensionId).toBe("omega-share@omega-share.duckdns.org");
  });

  test("the popup's scan lists the YouTube and Vimeo embeds on a page", async () => {
    const page = await openFixture(ff.browser, "providers-embed");
    const popup = await openPopup(ff.browser, page);
    // The same list as Chromium's extension.e2e.ts: four synced embeds, then the two lookalikes as generic.
    expect(await embedLabels(popup, 6)).toEqual([
      "YouTube · aqz-KE-bpKQ",
      expect.stringMatching(/^Twitch/),
      expect.stringMatching(/^Twitch/),
      "Vimeo · 76979871",
      "player-twitch.tv · not synced",
      "vimeo.co · not synced",
    ]);
  });

  test("the popup loads the rooms list from the server", async () => {
    const page = await openFixture(ff.browser, "youtube-embed");
    const popup = await openPopup(ff.browser, page);
    // Without the server the popup falls back to the bare lobby; listed rooms carry a member count, "Title (n)".
    await popup.waitForFunction(() => (document.querySelector<HTMLSelectElement>('[data-testid="room-select"]')?.options.length ?? 0) > 1, { timeout: 10_000 });
    const rooms = await popup.$$eval('[data-testid="room-select"] option', (options) => options.map((o) => o.textContent.trim()));
    expect(rooms.every((label) => /\(\d+\)$/.test(label))).toBe(true);
  });
});
