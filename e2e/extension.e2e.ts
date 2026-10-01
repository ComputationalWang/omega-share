// Extension smoke: loads unpacked, stays event-driven, lists allowlisted embeds as synced and nothing else as synced.
import { PENDING, URLS, available } from "./support/apps";
import { expect, test } from "./support/extension";
import { gotoFixture } from "./support/network";
import { popup } from "./support/selectors";

test.describe("extension", () => {
  test.fixme(!available.extension, PENDING.extension);

  test("loads unpacked and exposes an MV3 service worker", ({ extensionId, serviceWorker }) => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(serviceWorker.url()).toContain(`chrome-extension://${extensionId}/`);
  });

  test("popup talks to URLS.server, not the built-in default", async ({ context, openPopup }) => {
    // The popup requests `GET /rooms` on open; on OMEGA_SERVER_PORT runs it must not fall back to :8787 (OME-111).
    const page = await context.newPage();
    await gotoFixture(page, "youtube-embed");
    const rooms = context.waitForEvent("request", (r) => new URL(r.url()).pathname === "/rooms");
    await openPopup(page);
    expect(new URL((await rooms).url()).origin).toBe(new URL(URLS.server).origin);
  });

  test("the popup is watched by the zero-CSP-violation fixture (OME-198)", async ({ context, openPopup, csp }) => {
    const page = await context.newPage();
    await gotoFixture(page, "youtube-embed");
    const p = await openPopup(page);
    await expect(p.locator(popup.embedItem)).toHaveCount(1);
    expect(await p.evaluate(() => typeof Reflect.get(window, "__omegaCspViolation"))).toBe("function");
    expect(csp.enforced).toEqual([]);
  });

  test("lists the YouTube embed", async ({ context, openPopup }) => {
    const page = await context.newPage();
    await gotoFixture(page, "youtube-embed");
    const p = await openPopup(page);
    await expect(p.locator(popup.embedItem)).toHaveCount(1);
  });

  test("lists exactly the YouTube, Twitch live, Twitch VOD and Vimeo embeds on a mixed page", async ({ context, openPopup }) => {
    // Clips, collections, Vimeo events and lookalike hosts are on the page too and must not be listed as synced (OME-129).
    const page = await context.newPage();
    await gotoFixture(page, "providers-embed");
    const p = await openPopup(page);
    await expect(p.locator(`${popup.embedItem}:not([data-provider="generic"])`)).toHaveCount(4);
    // Lookalikes on real public hosts are only ever generic: after the synced ones, labelled with their own host (ADR 0024, OME-293).
    await expect(p.locator(popup.embedItem)).toHaveText([/YouTube/, /Twitch/, /Twitch/, /Vimeo/, "player-twitch.tv · not synced", "vimeo.co · not synced"]);
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
