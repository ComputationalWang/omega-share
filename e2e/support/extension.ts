// Chromium persistent context with the unpacked extension loaded, plus a popup opener.
import { test as base, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { EXTENSION_DIR, URLS } from "./apps";
import { stubExternalNetwork } from "./network";

// `chrome` exists inside the extension's service worker; these are the only bits the harness uses.
interface ChromeTab { readonly id?: number; readonly url?: string }
declare const chrome: { tabs: { query(q: Record<string, never>): Promise<ChromeTab[]> } };

export interface ExtensionFixtures {
  readonly context: BrowserContext;
  readonly serviceWorker: Worker;
  readonly extensionId: string;
  /**
   * Opens the popup page as a tab, pointed at `target` via `?tabId=`.
   * A popup opened as a tab can't use "active tab", so the extension must honour `tabId` (see e2e/README.md).
   */
  readonly openPopup: (target: Page) => Promise<Page>;
}

export const test = base.extend<ExtensionFixtures>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium", // new headless mode, which supports extensions
      baseURL: URLS.fixtures,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    await stubExternalNetwork(context);
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await use(sw);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
  openPopup: async ({ context, serviceWorker, extensionId }, use) => {
    await use(async (target) => {
      const targetUrl = target.url();
      const tabId = await serviceWorker.evaluate(
        async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id,
        targetUrl,
      );
      if (tabId === undefined) throw new Error(`no tab found for ${targetUrl}`);
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${String(tabId)}`);
      return popup;
    });
  },
});

export { expect } from "@playwright/test";
