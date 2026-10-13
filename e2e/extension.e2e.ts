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
    await expect(p.locator(popup.embedItem)).toHaveText([/YouTube/, /Twitch/, /Twitch/, /Vimeo/, "player-twitch.tv · 300×150 · not synced", "vimeo.co · 300×150 · not synced"]);
  });

  test("pre-selects the large player, not the comments widget before it; tiny and hidden frames are not listed (OME-1037)", async ({ context, openPopup }) => {
    const page = await context.newPage();
    await gotoFixture(page, "likely-video");
    const p = await openPopup(page);
    await expect(p.locator(popup.embedItem)).toHaveText(["player.omega-fixture.org · 960×540 · not synced", "comments.omega-fixture.org · 640×200 · not synced"]);
    await expect(p.locator(`${popup.embedItem} input:checked`)).toHaveValue("https://player.omega-fixture.org/embed/7");
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

// OME-1042: the opt-in "video found" indicator. Playwright can't click the https://*/* prompt, so the spec registers
// the shipped script the way the background does once granted, on the e2e build's own http://localhost/* host.
declare const chrome: {
  tabs: { query(q: Record<string, never>): Promise<{ readonly id?: number; readonly url?: string }[]> };
  action: { getTitle(d: { tabId: number }): Promise<string> };
  scripting: {
    registerContentScripts(s: { id: string; js: string[]; matches: string[]; runAt: "document_idle"; persistAcrossSessions: boolean }[]): Promise<void>;
    getRegisteredContentScripts(): Promise<unknown[]>;
  };
};

test.describe("found indicator", () => {
  test.fixme(!available.extension, PENDING.extension);

  test("the toolbar title says a video is found, and resets when the tab navigates to a page without one", async ({ context, serviceWorker }) => {
    // After the background's own startup sync (the bridge is its sign), under an id that sync doesn't own.
    await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)).toBeGreaterThan(0);
    await serviceWorker.evaluate(() =>
      chrome.scripting.registerContentScripts([{ id: "omega-found-e2e", js: ["content-scripts/found.js"], matches: ["http://localhost/*"], runAt: "document_idle", persistAcrossSessions: false }]),
    );
    const page = await context.newPage();
    const title = (): Promise<string> =>
      serviceWorker.evaluate(async (url) => {
        const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
        return tab?.id === undefined ? "no tab" : chrome.action.getTitle({ tabId: tab.id });
      }, page.url());
    await gotoFixture(page, "providers-embed");
    await expect.poll(title).toBe("omega share: video found");
    await gotoFixture(page, "no-video");
    await expect.poll(title).toBe("omega share");
    // A video added later is picked up by the throttled recheck.
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.src = "https://www.youtube.com/embed/aqz-KE-bpKQ";
      document.body.append(frame);
    });
    await expect.poll(title, { timeout: 3000 }).toBe("omega share: video found");
  });
});
