import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

// Event-driven background with no listeners in store builds: the popup does all the work. Chrome runs it as a
// service worker, Firefox as a non-persistent event page. It exists so the extension has a stable worker
// (Playwright uses it to find tab ids).
export default defineBackground(() => {
  // e2e builds only (compiled out of store builds; the manifest test checks): Firefox's BiDi can't open a
  // moz-extension:// URL, so the Firefox lane (OME-593, e2e/support/firefox.ts) sets `#omega-e2e-popup=<server URL>`
  // on the target tab and this opens the popup for it, like the Chromium harness's `?tabId=`. The key is settings.ts's
  // SERVER_BASE_URL_KEY, written out: importing settings.ts would bundle valibot into every build's background.
  if (import.meta.env.MODE === "e2e") {
    browser.tabs.onUpdated.addListener((tabId, change) => {
      if (change.url === undefined) return;
      const server = new URLSearchParams(new URL(change.url).hash.slice(1)).get("omega-e2e-popup");
      if (server === null) return;
      void browser.storage.local.set({ serverBaseUrl: server }).then(() => browser.tabs.create({ url: `${browser.runtime.getURL("/popup.html")}?tabId=${String(tabId)}` }));
    });
  }
});
