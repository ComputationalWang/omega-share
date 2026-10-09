import { expect, test } from "./support/csp";
import { type FirefoxExtension, embedLabels, launchFirefoxWithExtension, openFixture, openPopup } from "./support/firefox";
import { testRoom } from "./support/room";
import { popup, site } from "./support/selectors";

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

  // OME-611: the POST is what an AMO reviewer clicks. Firefox sends `Origin: moz-extension://<uuid>`, which the server
  // must accept (OME-617), and the popup must hold the server's port grant (see the e2e manifest test).
  test("Share from the popup lands in a room open in another tab", async () => {
    test.setTimeout(60_000);
    const room = await ff.browser.newPage();
    await room.goto(testRoom("ext-firefox", "share").url, { waitUntil: "domcontentloaded" });
    await room.waitForSelector(site.nicknameInput);
    await room.type(site.nicknameInput, "fox");
    await room.click(site.avatarOption);
    await room.click(site.joinButton);
    await room.waitForSelector(site.room, { visible: true });

    const page = await openFixture(ff.browser, "youtube-embed");
    const p = await openPopup(ff.browser, page);
    await embedLabels(p, 1);
    await p.waitForFunction((s) => document.querySelector<HTMLButtonElement>(s)?.disabled === false, { timeout: 10_000 }, popup.shareButton);
    await p.$eval(popup.roomSelect, (select, id) => {
      if (select instanceof HTMLSelectElement) select.value = id;
    }, testRoom("ext-firefox", "share").id);
    // BiDi input actions are refused in extension (privileged) pages, so click from inside the page.
    await p.$eval(popup.shareButton, (button) => {
      if (button instanceof HTMLButtonElement) button.click();
    });
    await p.waitForFunction((s) => document.querySelector<HTMLElement>(s)?.dataset["state"] !== undefined, { timeout: 10_000 }, popup.shareStatus);
    const status = await p.$eval(popup.shareStatus, (el) => ({ state: el.getAttribute("data-state"), text: el.textContent }));
    expect(status).toEqual({ state: "ok", text: expect.stringContaining("e2e-ext-firefox-share") });
    await room.waitForSelector(site.sharedVideo, { timeout: 10_000 });
  });
});
