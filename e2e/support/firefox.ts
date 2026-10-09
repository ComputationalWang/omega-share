// Headless Firefox with the unpacked Firefox e2e build installed (OME-593). Playwright can't load WebExtensions in
// Firefox, so this lane drives Firefox through Puppeteer over WebDriver BiDi (R-M7c, OME-546).
import { homedir } from "node:os";
import { join } from "node:path";
import { Browser as BrowserName, computeExecutablePath, detectBrowserPlatform, install } from "@puppeteer/browsers";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer-core";
import { ROOT, URLS } from "./apps";

/** Pinned: the lane relies on BiDi details (extension tabs, `-remote-allow-system-access`) that may change between releases. */
export const FIREFOX_BUILD_ID = "stable_157.0.1";
const CACHE_DIR = process.env["OMEGA_FIREFOX_CACHE"] ?? join(homedir(), ".cache", "omega-share", "firefox");
/** The Firefox build with the e2e host permissions (Firefox can't grant `activeTab` to an automated popup either). */
export const FIREFOX_EXTENSION_DIR = process.env["OMEGA_FIREFOX_EXTENSION_DIR"] ?? join(ROOT, "apps/extension/.output/firefox-mv3-e2e");
/** The hash the e2e build's background watches for: it opens `popup.html?tabId=<that tab>` (no moz-extension:// goto over BiDi). */
export const OPEN_POPUP_HASH = "omega-e2e-popup";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Downloads the pinned Firefox once into the cache, then returns its binary. */
async function firefoxExecutable(): Promise<string> {
  const platform = detectBrowserPlatform();
  if (platform === undefined) throw new Error("no Firefox build for this platform");
  const options = { browser: BrowserName.FIREFOX, buildId: FIREFOX_BUILD_ID, cacheDir: CACHE_DIR, platform };
  await install(options);
  return computeExecutablePath(options);
}

export interface FirefoxExtension {
  readonly browser: Browser;
  /** The add-on ID `installExtension` reports: the gecko ID from the manifest. */
  readonly extensionId: string;
}

export async function launchFirefoxWithExtension(): Promise<FirefoxExtension> {
  const browser = await puppeteer.launch({
    browser: "firefox",
    executablePath: await firefoxExecutable(),
    headless: true,
    // Without it Firefox hides extension tabs from BiDi, so the popup tab can't be found.
    args: ["-remote-allow-system-access"],
  });
  try {
    return { browser, extensionId: await browser.installExtension(FIREFOX_EXTENSION_DIR) };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/** Fixture pages embed real provider URLs; the scan only reads their `src`, so external requests get an empty page. */
async function stubExternal(request: HTTPRequest): Promise<void> {
  const url = new URL(request.url());
  if ((url.protocol === "http:" || url.protocol === "https:") && !LOCAL.has(url.hostname)) await request.respond({ status: 200, contentType: "text/html", body: "" });
  else await request.continue();
}

export async function openFixture(browser: Browser, name: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (request) => void stubExternal(request));
  // The scan reads iframe `src` attributes only, so the parsed document is enough; stubbed subframes may never "load".
  await page.goto(`${URLS.fixtures}/${name}.html`, { waitUntil: "domcontentloaded" });
  return page;
}

let opens = 0;
/** Hash changes that opened no popup and were retried (see openPopup). */
export const missedOpens = { count: 0 };

/**
 * Opens the popup as a tab pointed at `target`, like the Chromium harness's `?tabId=`. Setting the hash makes the
 * e2e background open it and point the extension at this run's server. Resolves once the popup page exists.
 * Firefox now and then drops the tabs.onUpdated event for a fragment change (about 1 in 20 here), so a hash that
 * opens nothing within 2 s is set again. Timing is unaffected: the perf row is measured from the popup's own start.
 */
export async function openPopup(browser: Browser, target: Page): Promise<Page> {
  const before = new Set(await browser.pages());
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) missedOpens.count += 1;
    opens += 1;
    const hash = `${OPEN_POPUP_HASH}=${encodeURIComponent(URLS.server)}&n=${String(opens)}`;
    await target.evaluate((h) => {
      location.hash = h;
    }, hash);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      for (const page of await browser.pages()) {
        if (before.has(page)) continue;
        const href = await page.evaluate(() => location.href).catch(() => "");
        if (href.startsWith("moz-extension://") && href.includes("/popup.html?tabId=")) return page;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`popup did not open for ${target.url()} — is ${FIREFOX_EXTENSION_DIR} the Firefox e2e build?`);
}

/** Embed item labels in the popup, once at least `count` are listed. */
export async function embedLabels(popup: Page, count: number): Promise<string[]> {
  await popup.waitForFunction((n) => document.querySelectorAll('[data-testid="embed-item"]').length >= n, { polling: "mutation", timeout: 10_000 }, count);
  return popup.$$eval('[data-testid="embed-item"]', (items) => items.map((item) => item.textContent.trim()));
}

/**
 * When the popup listed `count` embeds, in ms since its navigation start (`performance.now()`), seen by a
 * MutationObserver in the page, so BiDi round trips don't count. If they are already listed, it is "now": an upper bound.
 */
export async function embedsListedAt(popup: Page, count: number): Promise<number> {
  return popup.evaluate(
    (n) =>
      new Promise<number>((resolve, reject) => {
        const listed = (): boolean => document.querySelectorAll('[data-testid="embed-item"]').length >= n;
        if (listed()) {
          resolve(performance.now());
          return;
        }
        const observer = new MutationObserver(() => {
          if (!listed()) return;
          observer.disconnect();
          resolve(performance.now());
        });
        observer.observe(document, { subtree: true, childList: true });
        setTimeout(() => {
          reject(new Error(`fewer than ${String(n)} embeds listed after 10 s`));
        }, 10_000);
      }),
    count,
  );
}
