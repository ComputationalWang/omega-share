// ADR 0047 (OME-1040): "Unlock with extension" lets one generic host that refuses framing by X-Frame-Options play in
// the room tab. The fixtures origin stands in for our site; xfo.omega-fixture.net (mapped to this machine) sends
// `X-Frame-Options: DENY`. The e2e build holds that host and the DNR permission already, like a viewer who allowed it once.
import type { Page } from "@playwright/test";
import { URLS } from "./support/apps";
import { expect, test } from "./support/extension";

const XFO_HOST = "xfo.omega-fixture.net";
const UNGRANTED_HOST = "other.omega-fixture.net";

// `chrome` inside the extension's service worker: only what this spec uses.
declare const chrome: {
  storage: { local: { set(items: Record<string, string>): Promise<void> } };
  declarativeNetRequest: { getSessionRules(): Promise<{ id: number; condition: { tabIds?: number[] } }[]> };
  scripting: { getRegisteredContentScripts(): Promise<{ id: string; matches?: string[] }[]> };
};

test.use({ extraArgs: ["--host-resolver-rules=MAP *.omega-fixture.net 127.0.0.1"] });

test.beforeEach(async ({ context, serviceWorker }) => {
  // The fixture host is served by the local fixtures server, not the offline stub.
  await context.route((url) => url.hostname.endsWith(".omega-fixture.net"), (route) => route.continue());
  // Our site, for this spec, is the fixtures origin: the bridge goes where the server base URL points.
  await serviceWorker.evaluate((url) => chrome.storage.local.set({ serverBaseUrl: url }), URLS.fixtures);
  await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).flatMap((s) => s.matches ?? []))).toContain("http://localhost/*");
});

async function openRoom(page: Page, host = XFO_HOST): Promise<void> {
  await page.goto(`${URLS.fixtures}/unlock-room.html?host=${host}`);
  await expect(page.locator("#present")).toHaveText(/^present \d/);
}

async function load(page: Page): Promise<void> {
  const before = Number(await page.locator("#loads").textContent());
  await page.locator("#load").click();
  await expect(page.locator("#loads")).toHaveText(String(before + 1));
}

const played = (page: Page) => page.frameLocator("#tv iframe").locator("#framed");

test("an XFO host is blank without the unlock, plays with it, and is blank again after relock", async ({ page }) => {
  await openRoom(page);
  await load(page);
  await expect(played(page)).toHaveCount(0);

  await page.locator("#unlock").click();
  await expect(page.locator("#result")).toHaveText(`${XFO_HOST} unlocked`);
  await load(page);
  await expect(played(page)).toHaveText("xfo host played");

  await page.locator("#relock").click();
  await expect.poll(async () => {
    await load(page);
    return played(page).count();
  }).toBe(0);
});

test("closing the room tab removes its rules", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await openRoom(page);
  await page.locator("#unlock").click();
  await expect(page.locator("#result")).toHaveText(`${XFO_HOST} unlocked`);
  expect(await serviceWorker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).not.toEqual([]);
  await page.close();
  await expect.poll(() => serviceWorker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).toEqual([]);
});

test("leaving our origin removes the tab's rules", async ({ page, serviceWorker }) => {
  await openRoom(page);
  await page.locator("#unlock").click();
  await expect(page.locator("#result")).toHaveText(`${XFO_HOST} unlocked`);
  await page.goto(`http://${XFO_HOST}:${new URL(URLS.fixtures).port}/xfo-frame.html`);
  await expect.poll(() => serviceWorker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).toEqual([]);
});

test("an ungranted host asks on the consent page first; Deny tells the room and adds no rules", async ({ context, page, serviceWorker }) => {
  await openRoom(page, UNGRANTED_HOST);
  const consentOpened = context.waitForEvent("page");
  await page.locator("#unlock").click();
  const consent = await consentOpened;
  await expect(consent.getByRole("heading")).toHaveText(`Let ${UNGRANTED_HOST} play in your omega-share room?`);
  await consent.getByRole("button", { name: "Not now" }).click();
  await expect(page.locator("#result")).toHaveText(`${UNGRANTED_HOST} denied`);
  expect(await serviceWorker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).toEqual([]);
});

test("a page on another origin can't unlock: the bridge isn't there and nothing answers", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.goto(`http://${XFO_HOST}:${new URL(URLS.fixtures).port}/unlock-room.html`);
  await page.locator("#unlock").click();
  await page.waitForTimeout(300);
  await expect(page.locator("#present")).toHaveText("absent");
  await expect(page.locator("#result")).toHaveText("");
  expect(await serviceWorker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).toEqual([]);
});
