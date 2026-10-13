import type { Page } from "puppeteer-core";
import { URLS } from "./support/apps";
import { expect, test } from "./support/csp";
import { type FirefoxExtension, OPEN_POPUP_HASH, launchFirefoxWithExtension } from "./support/firefox";

// ADR 0047 (OME-1040) in Firefox: the X-Frame-Options rule unlocks the host; there is no CSP rule here (§2).
// Same fixtures as e2e/unlock.e2e.ts: the fixtures origin is our site, xfo.omega-fixture.net sends XFO: DENY.
const XFO_HOST = "xfo.omega-fixture.net";

test.describe("Firefox unlock", () => {
  let ff: FirefoxExtension;
  test.beforeAll(async () => {
    ff = await launchFirefoxWithExtension({ "network.dns.localDomains": XFO_HOST });
  });
  test.afterAll(async () => {
    await ff.browser.close();
  });

  const text = (page: Page, id: string) => page.$eval(`#${id}`, (el) => el.textContent);
  const played = async (page: Page) => {
    for (const frame of page.frames()) if ((await frame.$("#framed").catch(() => null)) !== null) return true;
    return false;
  };
  async function load(page: Page): Promise<void> {
    const before = Number(await text(page, "loads"));
    await page.click("#load");
    await page.waitForFunction((n) => document.querySelector("#loads")?.textContent === String(n), {}, before + 1);
  }

  test("an XFO host is blank without the unlock and plays with it", async () => {
    const page = await ff.browser.newPage();
    await page.goto(`${URLS.fixtures}/unlock-room.html`);
    // The e2e background points the extension at the origin in this hash: the fixtures origin becomes our site.
    await page.evaluate((h) => {
      location.hash = h;
    }, `${OPEN_POPUP_HASH}=${encodeURIComponent(URLS.fixtures)}`);
    await expect.poll(async () => {
      await page.goto(`${URLS.fixtures}/unlock-room.html`);
      return text(page, "present");
    }).toMatch(/^present \d/);

    await load(page);
    expect(await played(page)).toBe(false);

    await page.click("#unlock");
    await page.waitForFunction((t) => document.querySelector("#result")?.textContent === t, {}, `${XFO_HOST} unlocked`);
    await load(page);
    await expect.poll(() => played(page)).toBe(true);
  });
});
